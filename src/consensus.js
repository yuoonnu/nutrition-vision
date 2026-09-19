import { NUTRIENT_KEYS } from "./schema.js";

/**
 * 여러 프레임의 판독 결과를 필드별로 다수결 처리한다.
 *
 * QR코드에는 오류정정부호가 있어서 한 번에 정답을 복원한다.
 * 인쇄된 글씨에는 그런 게 없으니, 대신 "다른 순간에 찍힌 프레임들이
 * 같은 값을 말하는가"를 검증 장치로 쓴다.
 * 흔들림이나 반사로 인한 오독은 프레임마다 다르게 나타나서 소수로 밀려난다.
 */

const FIELD_TOLERANCE = 0.02; // 2% 이내면 같은 값으로 본다 (반올림 표기 차이 흡수)

export function buildConsensus(frames) {
  const valid = frames.filter((f) => f?.is_nutrition_label);
  if (!valid.length) {
    return { data: frames[frames.length - 1] ?? null, frameCount: 0, agreementRatio: 0, fields: {} };
  }
  if (valid.length === 1) {
    return { data: valid[0], frameCount: 1, agreementRatio: 0, fields: {} };
  }

  const merged = structuredClone(valid[valid.length - 1]);
  merged.nutrients ??= {};
  const fields = {};
  let agreed = 0;
  let compared = 0;

  // 숫자 영양소: 근사값끼리 묶어 최빈값
  for (const key of NUTRIENT_KEYS) {
    const values = valid
      .map((f) => f.nutrients?.[key])
      .filter((v) => typeof v === "number");
    if (!values.length) {
      merged.nutrients[key] = null;
      continue;
    }
    const { value, support } = vote(values);
    merged.nutrients[key] = value;
    fields[key] = { value, support, total: valid.length, candidates: unique(values) };

    compared++;
    if (support >= 2) agreed++;
  }

  // 범주형/문자 필드: 정확히 같은 값끼리 최빈값
  for (const key of ["basis", "product_name", "manufacturer", "serving_unit", "package_unit"]) {
    const values = valid
      .map((f) => f[key])
      .filter((v) => v !== null && v !== undefined && v !== "unknown");
    if (values.length) {
      const { value, support } = voteExact(values);
      merged[key] = value;
      fields[key] = { value, support, total: valid.length };
    }
  }

  for (const key of ["serving_amount", "package_amount", "servings_per_package"]) {
    const values = valid.map((f) => f[key]).filter((v) => typeof v === "number");
    if (values.length) merged[key] = vote(values).value;
  }

  // 알레르기는 합집합 (한 프레임에서만 보였어도 유효한 정보)
  merged.allergens = unique(valid.flatMap((f) => f.allergens ?? []));
  merged.image_issues = unique(valid.flatMap((f) => f.image_issues ?? []));
  merged.confidence = Math.max(...valid.map((f) => f.confidence ?? 0));

  return {
    data: merged,
    frameCount: valid.length,
    agreementRatio: compared ? agreed / compared : 0,
    fields,
    // 프레임마다 값이 갈린 항목 — 수동 확인 우선순위가 높다
    disputed: Object.entries(fields)
      .filter(([, v]) => v.candidates && v.candidates.length > 1 && v.support < 2)
      .map(([k]) => k),
  };
}

/** 허용 오차 내 값끼리 묶어서 최빈값 */
function vote(values) {
  let best = { value: values[0], support: 0 };
  for (const v of values) {
    const support = values.filter((o) => close(o, v)).length;
    if (support > best.support) best = { value: v, support };
  }
  return best;
}

function voteExact(values) {
  const counts = new Map();
  for (const v of values) counts.set(v, (counts.get(v) ?? 0) + 1);
  let best = { value: values[0], support: 0 };
  for (const [value, support] of counts) {
    if (support > best.support) best = { value, support };
  }
  return best;
}

function close(a, b) {
  if (a === b) return true;
  const scale = Math.max(Math.abs(a), Math.abs(b), 1);
  return Math.abs(a - b) / scale <= FIELD_TOLERANCE;
}

function unique(arr) {
  return [...new Set(arr)];
}
