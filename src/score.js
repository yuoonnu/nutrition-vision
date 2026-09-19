import { REQUIRED_NUTRIENTS, NUTRIENT_LABELS_KO } from "./schema.js";
import { portionGrams } from "./validate.js";

/**
 * 인식 완성도 0~100.
 *
 * 중요: 이 점수는 "글자를 몇 % 정확히 읽었는가"가 아니다.
 * 그건 정답지 없이는 계산이 불가능하다.
 *
 * 여기서 100의 정의는:
 *   "비교에 필요한 항목을 전부 확보했고 + 기준 단위를 알며
 *    + 열량 검산을 통과했고 + 서로 다른 프레임에서 같은 값이 나왔다"
 *
 * 검증 가능한 것만 점수에 넣는다. 그래야 100이 거짓말이 되지 않는다.
 */

const WEIGHTS = {
  nutrients: 63, // 의무 9항목, 항목당 7점
  basis: 12, // 표시 기준 (없으면 비교 자체가 불가능)
  portion: 8, // 제공량/내용량 중량
  energyCheck: 10, // 열량 = 탄4+단4+지9 검산
  agreement: 7, // 프레임 간 값 일치
};

export const LOCK_THRESHOLD = 90; // 이 이상이면 자동 확정
export const RETRY_THRESHOLD = 68; // 이 아래면 재촬영 권유

/**
 * @param {object} data 추출 결과 (합의 후)
 * @param {object} validation validate() 결과
 * @param {object} [consensus] buildConsensus() 결과
 */
export function scoreRecognition(data, validation, consensus) {
  if (!data?.is_nutrition_label) {
    return {
      score: 0,
      phase: "searching",
      missing: [],
      breakdown: {},
      message: "영양성분표를 찾는 중",
    };
  }

  const n = data.nutrients ?? {};
  const missing = [];
  const breakdown = {};

  // 1. 의무 9항목
  const got = REQUIRED_NUTRIENTS.filter((k) => typeof n[k] === "number");
  breakdown.nutrients = (got.length / REQUIRED_NUTRIENTS.length) * WEIGHTS.nutrients;
  for (const k of REQUIRED_NUTRIENTS) {
    if (!got.includes(k)) missing.push({ key: k, label: NUTRIENT_LABELS_KO[k] });
  }

  // 2. 표시 기준
  const hasBasis = data.basis && data.basis !== "unknown";
  breakdown.basis = hasBasis ? WEIGHTS.basis : 0;
  if (!hasBasis) missing.push({ key: "basis", label: "표시 기준" });

  // 3. 중량 (100g 기준이면 이미 알고 있는 셈)
  const hasPortion = portionGrams(data) !== null;
  breakdown.portion = hasPortion ? WEIGHTS.portion : 0;
  if (!hasPortion) missing.push({ key: "portion", label: "제공량" });

  // 4. 열량 검산 — 통과하면 만점, 어긋나면 감점, 계산 불가면 절반
  const dev = validation?.energyCheck?.deviation;
  breakdown.energyCheck =
    dev === undefined || dev === null
      ? WEIGHTS.energyCheck * 0.5
      : dev <= 0.12
      ? WEIGHTS.energyCheck
      : dev <= 0.25
      ? WEIGHTS.energyCheck * 0.4
      : 0;

  // 5. 프레임 합의 — 2개 이상 프레임에서 같은 값이 나온 항목의 비율
  if (consensus && consensus.frameCount > 1) {
    breakdown.agreement = consensus.agreementRatio * WEIGHTS.agreement;
  } else {
    // 프레임이 1장뿐이면 교차 검증이 불가능하므로 만점을 줄 수 없다
    breakdown.agreement = 0;
  }

  // 프레임마다 값이 다르게 읽힌 항목 — 아직 다수결이 성립하지 않은 상태다.
  // 두 프레임이 서로 다른 값을 말하면 어느 쪽이 맞는지 알 수 없으므로,
  // 확정선 아래로 눌러서 프레임을 한 장 더 받게 만든다.
  const disputed = consensus?.disputed ?? [];
  if (disputed.length) {
    breakdown.disputePenalty = -Math.min(20, 8 + disputed.length * 4);
    for (const key of disputed) {
      if (!missing.some((m) => m.key === key)) {
        missing.push({ key, label: NUTRIENT_LABELS_KO[key] ?? key, reason: "프레임마다 값이 다릅니다" });
      }
    }
  }

  // 치명적 문제는 점수 자체를 눌러버린다
  const fatal = validation?.issues?.some((i) => i.severity === "fatal");
  let score = Object.values(breakdown).reduce((a, b) => a + b, 0);
  if (fatal) score = Math.min(score, 40);
  if (disputed.length) score = Math.min(score, LOCK_THRESHOLD - 1);

  score = Math.max(0, Math.min(100, Math.round(score)));

  return {
    score,
    phase: score >= LOCK_THRESHOLD ? "locked" : "reading",
    missing,
    breakdown: Object.fromEntries(
      Object.entries(breakdown).map(([k, v]) => [k, Math.round(v)])
    ),
    message: buildMessage(score, missing, consensus),
  };
}

function buildMessage(score, missing, consensus) {
  if (consensus?.disputed?.length) {
    const labels = consensus.disputed.map((k) => NUTRIENT_LABELS_KO[k] ?? k);
    return `${labels.join(", ")} 다시 확인하는 중`;
  }
  if (score >= LOCK_THRESHOLD) return "확인 완료";
  if (missing.length === 0 && consensus?.frameCount === 1) return "한 번 더 확인하는 중";
  if (missing.length === 0) return "값을 대조하는 중";
  if (missing.length <= 2) {
    return `${missing.map((m) => m.label).join(", ")} 확인 중`;
  }
  return "표를 읽는 중";
}
