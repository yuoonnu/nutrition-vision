import { prepareImage, blurScore, BLUR_THRESHOLD, EDGE_PRIMARY, EDGE_RETRY } from "./preprocess.js";
import { extractNutrition } from "./extract.js";
import { buildRetryPrompt } from "./prompt.js";
import { validate, retakeHint } from "./validate.js";
import { normalize } from "./normalize.js";
import { REQUIRED_NUTRIENTS, NUTRIENT_LABELS_KO, NUTRIENT_UNITS } from "./schema.js";

/**
 * 전체 흐름:
 *   사진 -> 전처리 -> (흐림 사전차단) -> 1차 추출 -> 검증
 *        -> 실패 시 고해상도 재시도 -> 재검증
 *        -> 여전히 부족하면 수동 보정 요청서(reviewFields) 반환
 *
 * 절대 예외를 던지지 않고 항상 같은 모양의 객체를 반환한다.
 * 프론트가 분기할 지점은 status 하나뿐이다: "ok" | "needs_review" | "failed"
 */
export async function recognizeProduct(imageBuffers, opts = {}) {
  const startedAt = Date.now();

  try {
    if (!imageBuffers?.length) {
      return failure("사진이 없습니다.", "no_image");
    }

    // 1. 사전 품질 체크 — 명백히 흐리면 API를 부르지 않는다
    const [scores, images] = await Promise.all([
      Promise.all(imageBuffers.map((b) => blurScore(b).catch(() => null))),
      Promise.all(imageBuffers.map((b) => prepareImage(b, { maxEdge: EDGE_PRIMARY }))),
    ]);
    const bestScore = Math.max(...scores.filter((s) => s !== null), 0);
    if (bestScore && bestScore < BLUR_THRESHOLD * 0.5) {
      return {
        ...failure("사진이 너무 흐려 판독할 수 없습니다.", "too_blurry"),
        retakeHint: "표에 초점을 맞추고 다시 찍어주세요.",
        debug: { blurScore: bestScore, apiCalled: false },
      };
    }

// 2. 1차 추출 (재시도용 고해상도 이미지도 동시에 준비 시작 — 응답을 기다리는 동안 병행)
let data = await extractNutrition(images, { model: process.env.MODEL_PRIMARY });
const retryImagesPromise = Promise.all(
  imageBuffers.map((b) => prepareImage(b, { maxEdge: EDGE_RETRY, sharpen: true }))
);
let result = validate(data);
let attempts = 1;

// 3. 재시도 — 고해상도 + 선명화 + 더 정확한 모델
const worthRetrying =
  result.status !== "ok" && data?.is_nutrition_label !== false && !opts.noRetry;

if (worthRetrying) {
  const retryImages = await retryImagesPromise; // 이미 준비돼 있을 가능성이 높음
  const retryData = await extractNutrition(retryImages, {
    model: process.env.MODEL_RETRY ?? process.env.MODEL_PRIMARY,
    userPrompt: buildRetryPrompt(data),
  });
      const retryResult = validate(retryData);
      attempts = 2;

      // 두 번의 결과 중 더 나은 쪽을 채택하고, 부족한 필드는 서로 메운다
      const merged = mergeAttempts(data, retryData);
      const mergedResult = validate(merged);

      if (score(mergedResult) >= Math.max(score(result), score(retryResult))) {
        data = merged;
        result = mergedResult;
      } else if (score(retryResult) > score(result)) {
        data = retryData;
        result = retryResult;
      }
    }

    // 4. 응답 조립
    return {
      status: result.status,
      confidence: result.confidence,
      product: {
        name: data.product_name,
        manufacturer: data.manufacturer,
        allergens: data.allergens ?? [],
      },
      raw: data,
      normalized: normalize(data),
      issues: result.issues,
      reviewFields: buildReviewFields(data, result),
      retakeHint: retakeHint(data, result),
      debug: {
        attempts,
        blurScore: bestScore,
        energyCheck: result.energyCheck,
        elapsedMs: Date.now() - startedAt,
        cached: !!data._cached,
      },
    };
  } catch (err) {
    console.error("[pipeline]", err);
    return {
      ...failure(
        err?.status === 429
          ? "요청이 몰려 잠시 후 다시 시도해주세요."
          : "인식 중 오류가 발생했습니다.",
        err?.status === 429 ? "rate_limited" : "internal_error"
      ),
      debug: { elapsedMs: Date.now() - startedAt, message: err?.message },
    };
  }
}

/**
 * 수동 보정 입력 폼을 그릴 수 있도록, 무엇을 물어봐야 하는지 구조화해 넘긴다.
 * 프론트는 이 배열만 보고 입력창을 렌더링하면 된다.
 */
function buildReviewFields(data, result) {
  if (result.status === "ok") return [];
  const fields = [];
  const n = data?.nutrients ?? {};

  if (!data?.basis || data.basis === "unknown" || result.suspectFields.includes("basis")) {
    fields.push({
      key: "basis",
      label: "영양성분 표시 기준",
      type: "select",
      options: [
        { value: "per_serving", label: "1회 제공량당" },
        { value: "per_package", label: "총 내용량당" },
        { value: "per_100g", label: "100g당" },
        { value: "per_100ml", label: "100ml당" },
      ],
      current: data?.basis === "unknown" ? null : data?.basis,
      hint: data?.basis_text ?? "라벨 표 맨 윗줄을 확인해주세요.",
    });
  }

  if (!data?.serving_amount) {
    fields.push({ key: "serving_amount", label: "1회 제공량", type: "number", unit: "g/ml", current: null });
  }
  if (!data?.package_amount) {
    fields.push({ key: "package_amount", label: "총 내용량", type: "number", unit: "g/ml", current: null });
  }
  if (!data?.product_name) {
    fields.push({ key: "product_name", label: "제품명", type: "text", current: null });
  }

  const need = new Set([
    ...REQUIRED_NUTRIENTS.filter((k) => n[k] === null || n[k] === undefined),
    ...result.suspectFields.filter((k) => k in NUTRIENT_LABELS_KO),
  ]);

  for (const key of need) {
    fields.push({
      key: `nutrients.${key}`,
      label: NUTRIENT_LABELS_KO[key],
      type: "number",
      unit: NUTRIENT_UNITS[key],
      current: n[key] ?? null,
      reason:
        result.issues.find((i) => i.field === key)?.message ??
        "라벨에서 값을 읽지 못했습니다.",
    });
  }
  return fields;
}

/**
 * 사용자가 보정한 값을 병합하고 다시 검증한다.
 * 사람이 넣은 값은 모델 값보다 항상 우선한다.
 */
export function applyCorrections(data, corrections = {}) {
  const next = structuredClone(data);
  next.nutrients ??= {};

  for (const [key, value] of Object.entries(corrections)) {
    if (value === null || value === "") continue;
    if (key.startsWith("nutrients.")) {
      next.nutrients[key.slice("nutrients.".length)] = toNumber(value);
    } else if (["serving_amount", "package_amount", "servings_per_package"].includes(key)) {
      next[key] = toNumber(value);
    } else {
      next[key] = value;
    }
  }

  next.unreadable_fields = (next.unreadable_fields ?? []).filter(
    (k) => !(`nutrients.${k}` in corrections) && !(k in corrections)
  );
  next.corrected_by_user = true;
  next.confidence = 1;

  const result = validate(next);
  return {
    status: result.status,
    confidence: result.confidence,
    product: {
      name: next.product_name,
      manufacturer: next.manufacturer,
      allergens: next.allergens ?? [],
    },
    raw: next,
    normalized: normalize(next),
    issues: result.issues,
    reviewFields: buildReviewFields(next, result),
    retakeHint: null,
  };
}

/** 1차·2차 결과를 필드 단위로 합친다. 한쪽만 읽은 값도 살린다. */
function mergeAttempts(a, b) {
  const out = structuredClone(b ?? {});
  out.nutrients ??= {};
  for (const [k, v] of Object.entries(a?.nutrients ?? {})) {
    if (out.nutrients[k] === null || out.nutrients[k] === undefined) out.nutrients[k] = v;
  }
  for (const k of ["product_name", "manufacturer", "basis_text", "serving_amount",
                   "serving_unit", "package_amount", "package_unit", "servings_per_package"]) {
    if (out[k] === null || out[k] === undefined) out[k] = a?.[k] ?? null;
  }
  if (!out.basis || out.basis === "unknown") out.basis = a?.basis ?? "unknown";
  out.confidence = Math.max(a?.confidence ?? 0, b?.confidence ?? 0);
  return out;
}

/** 결과 품질 점수 — 어느 시도를 채택할지 고르는 기준 */
function score(result) {
  const rank = { ok: 2, needs_review: 1, failed: 0 }[result.status] ?? 0;
  return rank * 10 + result.confidence;
}

function toNumber(v) {
  const n = typeof v === "number" ? v : parseFloat(String(v).replace(/,/g, ""));
  return Number.isFinite(n) ? n : null;
}

function failure(message, code) {
  return {
    status: "failed",
    confidence: 0,
    product: { name: null, manufacturer: null, allergens: [] },
    raw: null,
    normalized: null,
    issues: [{ field: null, severity: "fatal", message, code }],
    reviewFields: [],
    retakeHint: null,
  };
}
