import sharp from "sharp";

/**
 * Claude Vision 입력 제약 (공식 문서 기준):
 *  - 이미지당 최대 5MB (base64 기준 아니라 원본 바이트)
 *  - 긴 변 1568px 초과 시 서버에서 자동 축소됨 -> 미리 줄이는 게 지연시간에 유리
 *  - 200px 미만은 성능 저하
 *  - jpeg / png / gif / webp 만 지원 (아이폰 HEIC는 변환 필요)
 *
 * 영양성분표는 글씨가 작아서, 1차는 1568px로 보내고
 * 실패 시 2차에서 더 큰 해상도로 올려 보내는 2단 전략을 쓴다.
 */

export const EDGE_PRIMARY = 1568;
export const EDGE_RETRY = 2200;
const MAX_BYTES = 4.5 * 1024 * 1024; // 5MB 한도에 여유

/**
 * @param {Buffer} input 원본 이미지 버퍼
 * @param {{ maxEdge?: number, sharpen?: boolean }} opts
 * @returns {Promise<{ buffer: Buffer, mediaType: string, width: number, height: number }>}
 */
export async function prepareImage(input, opts = {}) {
  const maxEdge = opts.maxEdge ?? EDGE_PRIMARY;

  let pipeline = sharp(input, { failOn: "none" })
    .rotate() // EXIF 방향 자동 보정. 이거 빼면 세로 사진이 옆으로 누워서 인식률이 급락한다.
    .resize({
      width: maxEdge,
      height: maxEdge,
      fit: "inside",
      withoutEnlargement: true,
    });

  if (opts.sharpen) {
    // 재시도용: 약한 언샤프 마스크 + 대비 보정. 작은 글씨 판독에 도움.
    pipeline = pipeline.sharpen({ sigma: 1 }).normalize();
  }

  let quality = 88;
  let buffer = await pipeline.jpeg({ quality, mozjpeg: true }).toBuffer();

  // 5MB 넘으면 품질을 낮추며 재압축
  while (buffer.byteLength > MAX_BYTES && quality > 45) {
    quality -= 12;
    buffer = await sharp(input, { failOn: "none" })
      .rotate()
      .resize({ width: maxEdge, height: maxEdge, fit: "inside", withoutEnlargement: true })
      .jpeg({ quality, mozjpeg: true })
      .toBuffer();
  }

  const meta = await sharp(buffer).metadata();
  return {
    buffer,
    mediaType: "image/jpeg",
    width: meta.width ?? 0,
    height: meta.height ?? 0,
  };
}

/**
 * 흐림 감지 (Laplacian variance 근사).
 * API를 호출하기 '전에' 명백히 흐린 사진을 걸러내면
 * 사용자는 즉시 재촬영 안내를 받고, 우리는 토큰을 아낀다.
 *
 * 임계값은 기기/조명마다 달라서, 실제 테스트 사진으로 반드시 튜닝할 것.
 * (test/run.js 가 촬영본별 blurScore를 같이 출력해준다)
 */
export async function blurScore(input) {
  const { data, info } = await sharp(input)
    .rotate()
    .resize({ width: 640, fit: "inside" })
    .grayscale()
    .raw()
    .toBuffer({ resolveWithObject: true });

  const { width: w, height: h } = info;
  const values = [];
  for (let y = 1; y < h - 1; y++) {
    for (let x = 1; x < w - 1; x++) {
      const i = y * w + x;
      // 3x3 Laplacian kernel
      const lap =
        4 * data[i] - data[i - 1] - data[i + 1] - data[i - w] - data[i + w];
      values.push(lap);
    }
  }
  const mean = values.reduce((a, b) => a + b, 0) / values.length;
  const variance =
    values.reduce((a, b) => a + (b - mean) ** 2, 0) / values.length;
  return Math.round(variance);
}

export const BLUR_THRESHOLD = 80; // 이보다 낮으면 "흐릴 가능성 높음"
