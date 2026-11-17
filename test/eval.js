// test/eval.js — 영양성분표 OCR 성능 평가
//
// 준비:
//   npm install --save-dev xlsx
//   test/dataset/ 에 정답 엑셀(.xlsx)과 사진을 넣는다. 사진 파일명 = 사진정보 시트의 image_id (예: k001_1.jpg)
//
// 실행 예:
//   node test/eval.js --split=dev                (사진 1장씩 인식 → 촬영 조건별 정확도)
//   node test/eval.js --split=dev --mode=session (제품별로 사진을 프레임처럼 연속 투입 → 다중 프레임 합의 효과)
//   옵션: --labels=파일.xlsx  --concurrency=2  --cache=true
//         --only=Y007,M010_1          (일부 제품·사진만)
//         --rerun=test/results/폴더    (이전 실행에서 ✅+ok가 아니었던 것만)
//         --rescore=test/results/폴더  (API 호출 없이, 저장된 모델 답을 지금 정답지로 다시 채점)

import "dotenv/config";
import fs from "node:fs/promises";
import path from "node:path";

const args = Object.fromEntries(
  process.argv.slice(2).map((a) => {
    const [k, v = "true"] = a.replace(/^--/, "").split("=");
    return [k, v];
  })
);
const DATASET = path.resolve(args.dataset ?? "test/dataset");
const MODE = args.mode ?? "single"; // single | session
const CONCURRENCY = Number(args.concurrency ?? 2);
const OUT = path.resolve(
  args.out ?? `test/results/${MODE}-${args.split ?? "all"}${args.rescore ? "-rescored" : ""}-${new Date().toISOString().replace(/[:.]/g, "-")}`
);

// extract.js가 import 시점에 USE_CACHE를 읽기 때문에, 반드시 import 전에 설정해야 한다.
// 캐시가 켜져 있으면 두 번째 실행부터 API를 안 불러서 지연시간·모델 비교가 왜곡된다.
if (args.cache !== "true") process.env.USE_CACHE = "0";

// 프로젝트 루트/test/eval.js 에서 src/ 폴더의 소스를 불러온다
const { recognizeProduct } = await import("../src/pipeline.js");
const { createSession, pushFrame } = await import("../src/session.js");
const { blurScore } = await import("../src/preprocess.js");

const NUTRIENTS = [
  "calorie", "carb", "sugar", "protein", "fat",
  "saturated_fat", "trans_fat", "cholesterol", "sodium",
];

/* ── 정답 엑셀 불러오기 ─────────────────────────────
 * 제품정답 시트: 제품당 1행 (정답 값)
 * 사진정보 시트: 사진당 1행 (어느 제품의 사진인지 + 촬영 조건)
 * 두 시트 모두 1행 = 영문 키, 2행 = 한글 설명이라 2행은 건너뛴다.
 */

const IMAGE_EXT = /\.(jpe?g|png|webp)$/i;
const NA = /^(n\/?a|-|없음)$/i;

async function findWorkbook() {
  if (args.labels) return path.resolve(args.labels);
  const xlsx = (await fs.readdir(DATASET)).filter((f) => /\.xlsx$/i.test(f) && !f.startsWith("~$"));
  if (xlsx.length === 1) return path.join(DATASET, xlsx[0]);
  if (!xlsx.length) throw new Error(`${DATASET} 안에 정답 엑셀(.xlsx)이 없습니다.`);
  throw new Error(`엑셀이 여러 개 있습니다. --labels=파일명 으로 지정하세요: ${xlsx.join(", ")}`);
}

async function loadCases() {
  const XLSX = (await import("xlsx")).default;
  const file = await findWorkbook();
  const wb = XLSX.read(await fs.readFile(file));
  const rowsOf = (name) => {
    const ws = wb.Sheets[name];
    if (!ws) throw new Error(`엑셀에 '${name}' 시트가 없습니다.`);
    return XLSX.utils.sheet_to_json(ws, { defval: "", raw: true }).slice(1); // 한글 설명 행 제외
  };

  // 제품 정답
  const products = new Map();
  for (const row of rowsOf("제품정답")) {
    const id = String(row.product_id ?? "").trim();
    if (!id || id.toUpperCase().startsWith("EX")) continue; // 빈 행, 예시 행 제외
    const basis = basisFromText(row.basis_text, cell(row.package_amount));
    if (basis === undefined && String(row.basis_text).trim()) {
      console.warn(`⚠️  ${id}: 표시 기준 "${row.basis_text}"를 해석하지 못해 basis는 채점에서 뺍니다`);
    }
    products.set(id, {
      id,
      split: String(row.split ?? "").trim() || null,
      category: String(row.category ?? "").trim(),
      layout: String(row.label_layout ?? "").trim(),
      expected: {
        basis,
        serving_amount: cell(row.serving_amount),
        package_amount: cell(row.package_amount),
        servings_per_package: cell(row.servings_per_package),
        nutrients: Object.fromEntries(NUTRIENTS.map((k) => [k, cell(row[k])])),
      },
    });
  }

  // 사진 → 파일 연결
  const all = await fs.readdir(DATASET);
  const heic = all.filter((f) => /\.hei[cf]$/i.test(f));
  if (heic.length) console.warn(`⚠️  HEIC 사진 ${heic.length}장은 읽을 수 없습니다. jpg로 변환하세요.`);
  const fileByStem = new Map(all.filter((f) => IMAGE_EXT.test(f)).map((f) => [f.replace(IMAGE_EXT, ""), f]));

  const photos = [];
  const missing = [];
  for (const row of rowsOf("사진정보")) {
    const imageId = String(row.image_id ?? "").trim();
    if (!imageId) continue;
    const pid = String(row.product_id ?? "").trim();
    if (pid.toUpperCase().startsWith("EX")) continue; // 예시 행의 사진
    const product = products.get(pid);
    if (!product) {
      console.warn(`⚠️  사진 ${imageId}: 제품정답 시트에 없는 제품(${row.product_id})이라 건너뜁니다`);
      continue;
    }
    const file = fileByStem.get(imageId);
    if (!file) { missing.push(imageId); continue; }
    photos.push({
      imageId, file, product,
      conditions: {
        조명: row.lighting, 각도: row.angle, 표면: row.surface, 블러: row.blur, 포장: row.packaging,
      },
    });
  }
  if (missing.length) {
    console.warn(`⚠️  사진 파일이 없는 사진 ID ${missing.length}개는 건너뜁니다: ${missing.slice(0, 10).join(", ")}${missing.length > 10 ? " ..." : ""}`);
  }

  const productTags = (p) => [`카테고리:${p.category}`, `표형식:${p.layout}`].filter((t) => !t.endsWith(":"));

  // single: 사진 1장 = 평가 1건 / session: 제품 1개 = 평가 1건 (사진을 ID 순서대로 프레임처럼 투입)
  if (MODE === "session") {
    const byProduct = new Map();
    for (const ph of photos) {
      if (!byProduct.has(ph.product.id)) byProduct.set(ph.product.id, []);
      byProduct.get(ph.product.id).push(ph);
    }
    return [...byProduct.values()].map((list) => {
      list.sort((a, b) => a.imageId.localeCompare(b.imageId, undefined, { numeric: true }));
      const p = list[0].product;
      return { id: p.id, productId: p.id, split: p.split, images: list.map((x) => x.file), tags: productTags(p), expected: p.expected };
    });
  }

  return photos.map((ph) => ({
    id: ph.imageId,
    productId: ph.product.id,
    split: ph.product.split,
    images: [ph.file],
    tags: [
      ...Object.entries(ph.conditions).filter(([, v]) => v).map(([k, v]) => `${k}:${v}`),
      ...productTags(ph.product),
    ],
    expected: ph.product.expected,
  }));
}

// 빈칸 = 채점 제외 / N/A = 라벨에 없음(모델도 null을 내야 정답) / 그 외 숫자
function cell(v) {
  if (typeof v === "number") return v;
  const s = String(v ?? "").trim();
  if (!s) return undefined;
  if (NA.test(s)) return null;
  const n = parseFloat(s.replace(/,/g, ""));
  return Number.isFinite(n) ? n : undefined;
}

// 표시 기준 원문 → 스키마의 basis 값
// packageAmount: 같은 행의 총 내용량. "1포장(36g)당"처럼 괄호 중량이 총 내용량과 같으면 총 내용량 기준으로 본다.
function basisFromText(t, packageAmount) {
  const raw = String(t ?? "").trim();
  if (!raw) return undefined;
  if (NA.test(raw)) return null; // 라벨에 기준 문구가 없음 → 모델이 unknown을 내면 정답
  const s = raw.replace(/\s/g, "");

  if (/총내용량|totalcontent|perpackage|perpack/i.test(s)) return "per_package";
  if (/100ml(당|$)|per100ml/i.test(s)) return "per_100ml";
  if (/100g(당|$)|per100g/i.test(s)) return "per_100g";

  // "1인분(20g)당", "1매(18g) 당", "3/4컵(30g) 당", "1포장(36g)당" 처럼 "단위(중량)당" 형태
  const grams = s.match(/\(([\d.]+)(g|ml)\)/i);
  if (grams && typeof packageAmount === "number" && Math.abs(parseFloat(grams[1]) - packageAmount) < 1e-6) {
    return "per_package";
  }
  if (/(1회|섭취참고량|제공량|표시기준분량|perserving|serving)/i.test(s)) return "per_serving";
  if (grams || /당$/.test(s)) return "per_serving";
  return undefined;
}

/* ── 실행 ─────────────────────────────────────────── */

async function runSingle(buffers) {
  const r = await recognizeProduct(buffers);
  return {
    status: r.status,
    raw: r.raw,
    attempts: r.debug?.attempts ?? 0,
    score: null,
    frames: buffers.length,
    modelConfidence: r.raw?.confidence ?? null,
    timing: r.debug?.timing ?? null,
    error: r.issues?.find((i) => i.code)?.code ?? null,
    issues: (r.issues ?? []).map((i) => `[${i.severity}] ${i.message}`),
  };
}

async function runSession(buffers) {
  const s = createSession(1);
  let view = null;
  let error = null;
  try {
    for (const b of buffers) {
      view = await pushFrame(s.sessionId, 0, b);
      if (view.status !== "reading") break; // locked / needs_review / failed면 종료 (슬롯당 최대 3장)
    }
  } catch (e) {
    error = e.message;
  }
  const status =
    !view ? "failed"
    : view.status === "locked" ? "ok"
    : view.status === "reading" ? "needs_review"
    : view.status;
  return {
    status,
    raw: view?.raw ?? null,
    attempts: view?.frameCount ?? 0,
    score: view?.score ?? null,
    frames: view?.frameCount ?? 0,
    modelConfidence: view?.raw?.confidence ?? null,
    error,
    issues: (view?.issues ?? []).map((i) => `[${i.severity}] ${i.message}`),
  };
}

/* ── 채점 ─────────────────────────────────────────── */

// correct: 정답 / abstain: 못 읽어서 null / wrong: 틀린 값을 냄
//   wrong 중 invented=true 는 "라벨에 없는 값을 지어낸" 환각이다.
//   extra=true 항목(제공 횟수)은 따로 집계하고 핵심 지표(정확도·완전정답률)에는 넣지 않는다.
function compare(expected, raw) {
  const rows = [];
  const check = (field, gt, pred, extra = false) => {
    if (gt === undefined) return; // 정답지에 없는 필드는 채점 제외
    pred = pred ?? null;
    let result;
    if (gt === null) result = pred === null ? "correct" : "wrong"; // 라벨에 없는데 값을 지어냄
    else if (pred === null) result = "abstain";
    else if (typeof gt === "number") result = Math.abs(gt - Number(pred)) < 1e-6 ? "correct" : "wrong";
    else result = gt === pred ? "correct" : "wrong";
    const row = { field, expected: gt, predicted: pred, result };
    if (gt === null && pred !== null) row.invented = true;
    if (extra) row.extra = true;
    rows.push(row);
  };

  // "1포장(36g)당"처럼 1회 제공량 = 총 내용량이면 per_serving과 per_package는 같은 숫자를 가리키므로 둘 다 정답
  let predBasis = raw?.basis === "unknown" ? null : raw?.basis;
  const pair = ["per_serving", "per_package"];
  const pkg = expected.package_amount;
  if (typeof pkg === "number" && pair.includes(expected.basis) && pair.includes(predBasis) && predBasis !== expected.basis) {
    const servingG = typeof raw?.serving_amount === "number" ? raw.serving_amount : expected.serving_amount;
    if (typeof servingG === "number" && Math.abs(servingG - pkg) < 1e-6) predBasis = expected.basis;
  }
  check("basis", expected.basis, predBasis);
  check("serving_amount", expected.serving_amount, raw?.serving_amount);
  check("package_amount", expected.package_amount, raw?.package_amount);
  for (const k of NUTRIENTS) check(k, expected.nutrients?.[k], raw?.nutrients?.[k]);
  check("servings_per_package", expected.servings_per_package, raw?.servings_per_package, true);
  return rows;
}

async function runCase(c) {
  const buffers = await Promise.all(c.images.map((f) => fs.readFile(path.join(DATASET, f))));
  const blur = await Promise.all(buffers.map((b) => blurScore(b).catch(() => null)));

  const t0 = Date.now();
  const r = MODE === "session" ? await runSession(buffers) : await runSingle(buffers);
  const ms = Date.now() - t0;

  const { fields, nWrong, allCorrect } = grade(c.expected, r.raw);

  console.log(
    `${allCorrect ? "✅" : nWrong ? "❌" : "⚪"} ${c.id.padEnd(10)} status=${r.status.padEnd(12)}` +
      ` wrong=${nWrong} ${ms}ms${r.score !== null ? ` score=${r.score}` : ""}${r.error ? ` err=${r.error}` : ""}`
  );

  // 모델 답(raw)도 저장해 둔다 → 정답지를 고쳐도 --rescore로 API 없이 다시 채점 가능
  return { id: c.id, productId: c.productId, tags: c.tags, ...r, raw: compactRaw(r.raw), ms, blur, fields, nWrong, allCorrect };
}

function grade(expected, raw) {
  const fields = compare(expected, raw);
  const core = fields.filter((f) => !f.extra);
  return {
    fields,
    nWrong: core.filter((f) => f.result === "wrong").length,
    allCorrect: core.every((f) => f.result === "correct"),
  };
}

function compactRaw(raw) {
  if (!raw) return null;
  const { basis, basis_text, serving_amount, package_amount, servings_per_package, nutrients, confidence, image_issues } = raw;
  return { basis, basis_text, serving_amount, package_amount, servings_per_package, nutrients, confidence, image_issues };
}

/* ── 집계 ─────────────────────────────────────────── */

const pct = (a, b) => (b ? +((100 * a) / b).toFixed(1) : null);

function summarize(results) {
  const all = results.flatMap((r) => r.fields);
  const f = all.filter((x) => !x.extra);
  const spp = all.filter((x) => x.field === "servings_per_package");
  const count = (res) => f.filter((x) => x.result === res).length;
  const ok = results.filter((r) => r.status === "ok");
  const withWrong = results.filter((r) => r.nWrong > 0);
  const perfect = results.filter((r) => r.allCorrect);
  const basis = f.filter((x) => x.field === "basis");
  const lat = results.map((r) => r.ms).sort((a, b) => a - b);

  return {
    평가건수: results.length,
    필드정확도: pct(count("correct"), f.length),
    필드오답률: pct(count("wrong"), f.length),
    필드무응답률: pct(count("abstain"), f.length),
    환각률: pct(f.filter((x) => x.invented).length, f.length),
    기준단위정확도: pct(basis.filter((x) => x.result === "correct").length, basis.length),
    완전정답률: pct(perfect.length, results.length),
    자동통과율: pct(ok.length, results.length),
    자동통과_오답포함률: pct(ok.filter((r) => r.nWrong > 0).length, ok.length),
    검증기_오답탐지율: pct(withWrong.filter((r) => r.status !== "ok").length, withWrong.length),
    검증기_오탐률: pct(perfect.filter((r) => r.status !== "ok").length, perfect.length),
    평균API호출: +(results.reduce((a, r) => a + (r.attempts ?? 0), 0) / results.length).toFixed(2),
    평균지연ms: Math.round(lat.reduce((a, b) => a + b, 0) / lat.length),
    p95지연ms: lat[Math.min(lat.length - 1, Math.floor(lat.length * 0.95))],
    오류건수: results.filter((r) => r.error).length,
    제공횟수정확도: pct(spp.filter((x) => x.result === "correct").length, spp.length),
  };
}

// 모델이 스스로 낸 confidence와 실제 정답 여부의 관계 (높을수록 정말 잘 맞는가?)
function byConfidence(results) {
  const buckets = [["0.6 미만", 0, 0.6], ["0.6~0.8", 0.6, 0.8], ["0.8~0.9", 0.8, 0.9], ["0.9 이상", 0.9, 1.01]];
  const out = {};
  for (const [label, lo, hi] of buckets) {
    const rs = results.filter((r) => typeof r.modelConfidence === "number" && r.modelConfidence >= lo && r.modelConfidence < hi);
    out[label] = { n: rs.length, 완전정답률: pct(rs.filter((r) => r.allCorrect).length, rs.length), 오답포함률: pct(rs.filter((r) => r.nWrong > 0).length, rs.length) };
  }
  return out;
}

// 단계별 소요 시간 (pipeline.js의 debug.timing, single 모드에서만 기록)
const STAGE_KO = { preprocess: "전처리(흐림판정·축소)", extract: "Gemini 1차 판독", retry: "재시도(Gemini 2차)", validate: "검증·병합", normalize: "100g 환산" };
function byStage(results) {
  const out = {};
  const timed = results.filter((r) => r.timing);
  if (!timed.length) return out;
  const p95 = (arr) => arr.sort((a, b) => a - b)[Math.min(arr.length - 1, Math.floor(arr.length * 0.95))];
  for (const [key, label] of Object.entries(STAGE_KO)) {
    const vals = timed.map((r) => r.timing[key]).filter((v) => typeof v === "number");
    if (!vals.length) continue;
    const avg = vals.reduce((a, b) => a + b, 0) / vals.length;
    out[label] = { n: vals.length, 평균ms: Math.round(avg), p95ms: p95([...vals]) };
  }
  // 전체 중 각 단계 비중 (재시도는 일어난 사진만이 아니라 전체 평균 기준)
  const total = timed.reduce((a, r) => a + Object.values(r.timing).reduce((x, y) => x + y, 0), 0);
  for (const [key, label] of Object.entries(STAGE_KO)) {
    if (!out[label]) continue;
    const sum = timed.reduce((a, r) => a + (r.timing[key] ?? 0), 0);
    out[label].비중 = `${((sum / total) * 100).toFixed(1)}%`;
  }
  return out;
}

// session 모드: 인식 완성도 점수(score)와 실제 정답 여부의 관계
function byScore(results) {
  const buckets = [["80 미만", 0, 80], ["80~89", 80, 90], ["90~94", 90, 95], ["95 이상", 95, 101]];
  const out = {};
  for (const [label, lo, hi] of buckets) {
    const rs = results.filter((r) => typeof r.score === "number" && r.score >= lo && r.score < hi);
    out[label] = { n: rs.length, 완전정답률: pct(rs.filter((r) => r.allCorrect).length, rs.length), 오답포함률: pct(rs.filter((r) => r.nWrong > 0).length, rs.length) };
  }
  return out;
}

function byField(results) {
  const f = results.flatMap((r) => r.fields);
  const fieldNames = [...new Set(f.map((x) => x.field))];
  return Object.fromEntries(
    fieldNames.map((name) => {
      const rows = f.filter((x) => x.field === name);
      const c = (res) => rows.filter((x) => x.result === res).length;
      return [name, { 정답: pct(c("correct"), rows.length), 오답: pct(c("wrong"), rows.length), 무응답: pct(c("abstain"), rows.length) }];
    })
  );
}

function byTag(results) {
  const tags = [...new Set(results.flatMap((r) => r.tags))].sort();
  return Object.fromEntries(
    tags.map((t) => {
      const s = summarize(results.filter((r) => r.tags.includes(t)));
      return [t, { n: s.평가건수, 필드정확도: s.필드정확도, 필드오답률: s.필드오답률, 완전정답률: s.완전정답률, 자동통과_오답포함률: s.자동통과_오답포함률 }];
    })
  );
}

async function pool(items, n, fn) {
  const out = new Array(items.length);
  let i = 0;
  await Promise.all(
    Array.from({ length: n }, async () => {
      while (i < items.length) {
        const k = i++;
        out[k] = await fn(items[k]);
      }
    })
  );
  return out;
}

/* ── main ─────────────────────────────────────────── */

let cases = await loadCases();
if (args.split) cases = cases.filter((c) => c.split === args.split);

// --only=Y007,M010_1 : 제품 ID 또는 사진 ID로 골라서 실행
if (args.only) {
  const want = new Set(args.only.split(",").map((x) => x.trim()).filter(Boolean));
  cases = cases.filter((c) => want.has(c.id) || want.has(c.productId));
}

// --rerun=test/results/폴더 : 그 실행에서 ✅+ok가 아니었던 것만 다시 실행
if (args.rerun) {
  const prev = JSON.parse(await fs.readFile(path.join(path.resolve(args.rerun), "results.json"), "utf8"));
  const redo = new Set(prev.filter((r) => !r.allCorrect || r.status !== "ok").map((r) => r.id));
  cases = cases.filter((c) => redo.has(c.id));
  console.log(`이전 결과에서 다시 볼 ${redo.size}건만 실행합니다 (전체 수치는 전체 실행으로 내야 합니다).`);
}
if (!cases.length) throw new Error("평가할 사진이 없습니다. 사진 파일명(= image_id)과 --split 값을 확인하세요.");
console.log(
  `\n평가 ${cases.length}건 (${MODE === "session" ? "제품" : "사진"} 단위) / split=${args.split ?? "전체"}` +
    ` / model=${process.env.MODEL_PRIMARY ?? "(기본값)"} / cache=${process.env.USE_CACHE !== "0"}\n`
);

let results;
if (args.rescore) {
  // API 호출 없이, 이전 실행에 저장된 모델 답을 지금 정답지로 다시 채점
  const prevDir = path.resolve(args.rescore);
  const prev = JSON.parse(await fs.readFile(path.join(prevDir, "results.json"), "utf8"));
  const byId = new Map(cases.map((c) => [c.id, c]));
  const noRaw = prev.filter((r) => !("raw" in r) || r.raw === undefined).length;
  if (noRaw === prev.length) {
    throw new Error("이 결과 폴더에는 모델 답(raw)이 저장되어 있지 않습니다. 이번 버전의 eval.js로 실행한 결과만 다시 채점할 수 있습니다.");
  }
  results = prev
    .filter((r) => byId.has(r.id))
    .map((r) => {
      const c = byId.get(r.id);
      return { ...r, tags: c.tags, ...grade(c.expected, r.raw) };
    });
  console.log(`${prevDir} 의 ${results.length}건을 다시 채점했습니다 (API 호출 없음).`);
} else {
  results = await pool(cases, CONCURRENCY, runCase);
}
const summary = summarize(results);

console.log("\n=== 전체 ===");
console.table(summary);
console.log("\n=== 항목별 ===");
console.table(byField(results));
console.log("\n=== 조건별 (n이 10 미만이면 참고만) ===");
console.table(byTag(results));
const stages = byStage(results);
if (Object.keys(stages).length) {
  console.log("\n=== 단계별 소요 시간 ===");
  console.table(stages);
}
console.log("\n=== 모델 confidence별 실제 정답률 ===");
console.table(byConfidence(results));
if (MODE === "session") {
  console.log("\n=== 인식 완성도 점수별 실제 정답률 ===");
  console.table(byScore(results));
}

await fs.mkdir(OUT, { recursive: true });
await fs.writeFile(
  path.join(OUT, "summary.json"),
  JSON.stringify({ mode: MODE, split: args.split ?? "all", model: process.env.MODEL_PRIMARY, rescoredFrom: args.rescore ?? null, summary, byField: byField(results), byTag: byTag(results), byConfidence: byConfidence(results), byStage: byStage(results), byScore: MODE === "session" ? byScore(results) : undefined }, null, 2)
);
await fs.writeFile(path.join(OUT, "results.json"), JSON.stringify(results, null, 2));

// 오답 분석용: 틀리거나 못 읽은 필드만 모은 CSV (엑셀로 열어서 보기)
const q = (v) => `"${String(v ?? "").replace(/"/g, '""')}"`;
const csv = [
  "id,product_id,status,field,expected,predicted,result,invented,tags,blur",
  ...results.flatMap((r) =>
    r.fields
      .filter((f) => f.result !== "correct")
      .map((f) => [r.id, r.productId, r.status, f.field, f.expected, f.predicted, f.result, f.invented ? "Y" : "", r.tags.join("|"), (r.blur ?? []).join("|")].map(q).join(","))
  ),
].join("\n");
await fs.writeFile(path.join(OUT, "errors.csv"), "\uFEFF" + csv); // BOM: 엑셀 한글 깨짐 방지

// 검토로 넘어간 이유 분석용: ok가 아닌 사진마다 검증기가 남긴 메시지
// all_correct=true 인 행이 '다 맞혔는데 검토로 넘어간' 검증기 오탐이다
const reviewCsv = [
  "id,product_id,status,all_correct,wrong,issues",
  ...results
    .filter((r) => r.status !== "ok")
    .map((r) => [r.id, r.productId, r.status, r.allCorrect, r.nWrong, (r.issues ?? []).join(" / ") || r.error || ""].map(q).join(",")),
].join("\n");
await fs.writeFile(path.join(OUT, "review.csv"), "\uFEFF" + reviewCsv);

console.log(`\n결과 저장 → ${OUT}`);
