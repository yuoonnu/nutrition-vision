// test/loadtest.js — 로컬 서버 부하 테스트
//
// 준비: 로컬에서 서버 두 개를 켜 둔다
//   터미널 1 (py 폴더/src):        python server.py          → Flask :5000
//   터미널 2 (nutrition-vision-main): node src/server.js       → Node  :3000
//
// 실행 (nutrition-vision-main 폴더에서, 터미널 3):
//   node test/loadtest.js --target=recommend
//   node test/loadtest.js --target=extract --image=test/dataset/k001_1.jpg
//
// 옵션: --levels=1,5,10 (동시 사용자 수)  --requests=100 (단계별 요청 수)  --base=http://localhost:3000
//
// 비용: recommend는 프리셋 목표만 써서 Gemini를 부르지 않는다 (0원).
//       extract는 캐시를 써서 첫 요청 1번만 Gemini를 부르고, 이후에는 캐시가 답한다.
//       → 서버 자체(이미지 전처리·검증) 처리 능력만 측정한다. Gemini 응답 시간은 eval.js의 단계별 시간을 참고.

import fs from "node:fs/promises";
import path from "node:path";

const args = Object.fromEntries(
  process.argv.slice(2).map((a) => {
    const [k, v = "true"] = a.replace(/^--/, "").split("=");
    return [k, v];
  })
);
const BASE = args.base ?? "http://localhost:3000";
const TARGET = args.target ?? "recommend";
const LEVELS = (args.levels ?? (TARGET === "recommend" ? "1,5,10,25,50" : "1,2,4,8")).split(",").map(Number);
const PER_LEVEL = Number(args.requests ?? (TARGET === "recommend" ? 100 : 24));

// 추천 요청 예시 (과자 4종, 100g당 값)
const RECOMMEND_BODY = {
  goal: "weight_loss",
  products: [
    { name: "과자 A", nutrients: { calorie: 520, sugar: 18, sodium: 450, protein: 6, fat: 28, carb: 60 } },
    { name: "과자 B", nutrients: { calorie: 480, sugar: 9, sodium: 380, protein: 9, fat: 22, carb: 58 } },
    { name: "과자 C", nutrients: { calorie: 545, sugar: 30, sodium: 300, protein: 5, fat: 31, carb: 62 } },
    { name: "과자 D", nutrients: { calorie: 410, sugar: 4, sodium: 520, protein: 12, fat: 15, carb: 55 } },
  ],
};

let imageBuffer = null;
if (TARGET === "extract") {
  if (!args.image) throw new Error("--image=사진경로 를 지정하세요 (예: test/dataset/k001_1.jpg)");
  imageBuffer = await fs.readFile(path.resolve(args.image));
}

async function oneRequest() {
  const t0 = performance.now();
  try {
    let res;
    if (TARGET === "recommend") {
      res = await fetch(`${BASE}/api/recommend`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(RECOMMEND_BODY),
        signal: AbortSignal.timeout(60_000),
      });
    } else {
      const form = new FormData();
      form.append("images", new Blob([imageBuffer], { type: "image/jpeg" }), "label.jpg");
      res = await fetch(`${BASE}/api/extract`, { method: "POST", body: form, signal: AbortSignal.timeout(120_000) });
    }
    const body = await res.json().catch(() => ({}));
    const ms = performance.now() - t0;
    // 인식 API는 200을 돌려주면서 status=failed + internal_error로 실패를 알린다
    const failed = !res.ok || (TARGET === "extract" && body.issues?.some((i) => i.code === "internal_error" || i.code === "rate_limited"));
    return { ms, ok: !failed, status: res.status, cached: body.debug?.cached, error: failed ? (body.error || body.issues?.[0]?.message || res.status) : null };
  } catch (e) {
    return { ms: performance.now() - t0, ok: false, status: 0, error: e.name === "TimeoutError" ? "timeout" : e.message };
  }
}

// 서버 메모리(/health의 rssMB)를 주기적으로 읽어 최대값을 기록
async function watchMemory(stopSignal) {
  let peak = null;
  while (!stopSignal.stop) {
    try {
      const h = await (await fetch(`${BASE}/health`)).json();
      if (typeof h.rssMB === "number") peak = Math.max(peak ?? 0, h.rssMB);
    } catch { /* 무시 */ }
    await new Promise((r) => setTimeout(r, 200));
  }
  return peak;
}

async function runLevel(concurrency) {
  const results = [];
  let issued = 0;
  const stop = { stop: false };
  const memPromise = watchMemory(stop);
  const started = performance.now();
  await Promise.all(
    Array.from({ length: concurrency }, async () => {
      while (issued < PER_LEVEL) {
        issued++;
        results.push(await oneRequest());
      }
    })
  );
  const wallSec = (performance.now() - started) / 1000;
  stop.stop = true;
  const peakMB = await memPromise;

  const lat = results.map((r) => r.ms).sort((a, b) => a - b);
  const q = (p) => Math.round(lat[Math.min(lat.length - 1, Math.floor(lat.length * p))]);
  const fails = results.filter((r) => !r.ok);
  return {
    동시사용자: concurrency,
    요청: results.length,
    실패: fails.length,
    에러율: `${((fails.length / results.length) * 100).toFixed(1)}%`,
    p50ms: q(0.5),
    p95ms: q(0.95),
    최대ms: Math.round(lat[lat.length - 1]),
    "처리량(req/s)": +(results.length / wallSec).toFixed(1),
    서버메모리최대MB: peakMB,
    실패예시: fails[0]?.error ?? "",
  };
}

// ── main ───────────────────────────────────────────────

console.log(`\n부하 테스트: ${TARGET} (${BASE}) / 동시 사용자 ${LEVELS.join(", ")} / 단계별 요청 ${PER_LEVEL}개\n`);

// 연결 확인 + 워밍업 (extract는 이 요청으로 캐시가 채워진다)
const warm = await oneRequest();
if (!warm.ok) {
  console.error("첫 요청이 실패했습니다. 서버가 켜져 있는지 확인하세요:", warm.error);
  if (TARGET === "recommend") console.error("  - Flask(:5000)도 켜져 있어야 합니다. 401이면 두 서버의 INTERNAL_API_TOKEN이 다른 것입니다.");
  process.exit(1);
}
if (TARGET === "extract") {
  const check = await oneRequest();
  if (!check.cached) {
    console.error("캐시가 동작하지 않습니다. 이대로 진행하면 요청마다 Gemini 비용이 듭니다.");
    console.error("  Node 서버를 USE_CACHE=1 로 켰는지(.env에 USE_CACHE=0이 없는지) 확인하세요.");
    process.exit(1);
  }
  console.log("캐시 동작 확인 → 이후 요청은 Gemini를 부르지 않습니다.\n");
}

const rows = [];
for (const c of LEVELS) {
  process.stdout.write(`동시 사용자 ${c}명 측정 중... `);
  const row = await runLevel(c);
  rows.push(row);
  console.log(`p95 ${row.p95ms}ms, 에러율 ${row.에러율}`);
}

console.log("\n=== 결과 ===");
console.table(rows);

const out = path.resolve(`test/results/loadtest-${TARGET}-${new Date().toISOString().replace(/[:.]/g, "-")}.json`);
await fs.mkdir(path.dirname(out), { recursive: true });
await fs.writeFile(out, JSON.stringify({ target: TARGET, base: BASE, perLevel: PER_LEVEL, rows }, null, 2));
console.log(`결과 저장 → ${out}`);
