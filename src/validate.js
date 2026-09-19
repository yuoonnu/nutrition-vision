import { REQUIRED_NUTRIENTS, NUTRIENT_LABELS_KO } from "./schema.js";

/**
 * 모델이 "확신 있게 틀리는" 경우를 잡아내는 계층.
 *
 * 핵심 아이디어: 영양성분표는 내부적으로 수학적 제약이 걸려 있다.
 * 열량 = 탄수화물x4 + 단백질x4 + 지방x9 에서 크게 벗어나면
 * 어느 한 숫자를 잘못 읽은 것이다. 사람 눈으로 검수할 필요 없이
 * 이 검산만으로 오인식의 상당수를 자동으로 걸러낼 수 있다.
 */

const SANITY = {
  calorie: [0, 2000],
  carb: [0, 200],
  sugar: [0, 200],
  protein: [0, 150],
  fat: [0, 150],
  saturated_fat: [0, 100],
  trans_fat: [0, 30],
  cholesterol: [0, 1000],
  sodium: [0, 8000],
};

export function validate(data) {
  const issues = [];
  const suspectFields = new Set();
  const n = data?.nutrients ?? {};

  const flag = (field, severity, message) => {
    issues.push({ field, severity, message });
    if (field) suspectFields.add(field);
  };

  if (!data?.is_nutrition_label) {
    flag(null, "fatal", "사진에서 영양성분표를 찾지 못했습니다.");
  }

  // 1) 기준 단위 누락 — 비교 서비스에서는 치명적
  if (!data?.basis || data.basis === "unknown") {
    flag("basis", "fatal", "영양성분 표시 기준(1회 제공량/총 내용량/100g)을 확인하지 못했습니다.");
  }
  if (data?.basis === "per_serving" && !data?.serving_amount) {
    flag("serving_amount", "error", "1회 제공량 기준인데 제공량(g/ml)을 읽지 못해 다른 제품과 비교할 수 없습니다.");
  }
  if (data?.basis === "per_package" && !data?.package_amount) {
    flag("package_amount", "error", "총 내용량 기준인데 내용량(g/ml)을 읽지 못했습니다.");
  }

  // 2) 의무표시 항목 누락
  for (const key of REQUIRED_NUTRIENTS) {
    if (n[key] === null || n[key] === undefined) {
      flag(key, "error", `${NUTRIENT_LABELS_KO[key]} 값을 읽지 못했습니다.`);
    }
  }

  // 3) 범위 검사
  for (const [key, [lo, hi]] of Object.entries(SANITY)) {
    const v = n[key];
    if (typeof v === "number" && (v < lo || v > hi)) {
      flag(key, "error", `${NUTRIENT_LABELS_KO[key]} 값 ${v}이(가) 비정상 범위입니다.`);
    }
  }

  // 4) 열량 검산 (탄4 / 단4 / 지9)
  const { calorie: kcal, carb: c, protein: p, fat: f } = n;
  let energyCheck = null;
  if ([kcal, c, p, f].every((v) => typeof v === "number") && kcal > 0) {
    const calc = c * 4 + p * 4 + f * 9;
    const dev = Math.abs(calc - kcal) / kcal;
    energyCheck = { declared: kcal, calculated: Math.round(calc), deviation: +dev.toFixed(3) };
    if (dev > 0.25) {
      flag("calorie", "error",
        `표기 열량 ${kcal}kcal과 탄단지 계산값 ${Math.round(calc)}kcal의 차이가 큽니다. 숫자 중 하나를 잘못 읽었을 가능성이 높습니다.`);
      ["carb", "protein", "fat"].forEach((k) => suspectFields.add(k));
    } else if (dev > 0.12) {
      flag("calorie", "warn",
        `열량과 탄단지 계산값이 다소 어긋납니다 (${Math.round(dev * 100)}% 차이).`);
    }
  }

  // 5) 포함 관계 검사 — 물리적으로 불가능한 조합
  if (isNum(n.sugar) && isNum(n.carb) && n.sugar > n.carb + 0.5) {
    flag("sugar", "error", "당류가 탄수화물보다 많을 수 없습니다.");
    suspectFields.add("carb");
  }
  if (isNum(n.saturated_fat) && isNum(n.fat) && n.saturated_fat > n.fat + 0.5) {
    flag("saturated_fat", "error", "포화지방이 총 지방보다 많을 수 없습니다.");
    suspectFields.add("fat");
  }
  if (isNum(n.trans_fat) && isNum(n.fat) && n.trans_fat > n.fat + 0.5) {
    flag("trans_fat", "error", "트랜스지방이 총 지방보다 많을 수 없습니다.");
  }

  // 6) 총량 검사 — 영양소 합이 제공량을 넘을 수 없다
  const portion = portionGrams(data);
  if (portion && [c, p, f].every(isNum)) {
    const solids = c + p + f;
    if (solids > portion * 1.05) {
      flag(null, "error",
        `영양소 합계(${solids.toFixed(1)}g)가 기준 중량(${portion}g)을 초과합니다. 기준 단위를 잘못 인식했을 수 있습니다.`);
      suspectFields.add("basis");
    }
  }

  // 7) 사진 품질 신호
  for (const issue of data?.image_issues ?? []) {
    flag(null, issue === "not_a_label" ? "fatal" : "warn", IMAGE_ISSUE_KO[issue] ?? issue);
  }

  const fatal = issues.some((i) => i.severity === "fatal");
  const errors = issues.filter((i) => i.severity === "error");

  // 모델이 스스로 보고한 confidence와 검산 결과를 결합
  const modelConf = typeof data?.confidence === "number" ? data.confidence : 0.5;
  const penalty = Math.min(0.6, errors.length * 0.12);
  const finalConfidence = fatal ? 0 : Math.max(0, +(modelConf - penalty).toFixed(2));

  const status = fatal
    ? "failed"
    : errors.length > 0 || finalConfidence < 0.6
    ? "needs_review"
    : "ok";

  return {
    status,
    confidence: finalConfidence,
    issues,
    suspectFields: [...suspectFields],
    energyCheck,
  };
}

const IMAGE_ISSUE_KO = {
  blurry: "사진이 흔들리거나 초점이 맞지 않습니다.",
  glare: "조명 반사로 일부 글자가 가려졌습니다.",
  cropped: "영양성분표 일부가 사진 밖으로 잘렸습니다.",
  angled: "라벨이 기울어져 찍혔습니다.",
  low_resolution: "해상도가 낮아 작은 글자를 읽기 어렵습니다.",
  obstructed: "손가락 등으로 표의 일부가 가려졌습니다.",
  not_a_label: "영양성분표가 아닌 사진으로 보입니다.",
};

function isNum(v) {
  return typeof v === "number";
}

/** 현재 basis 기준의 중량(g). ml은 밀도 1로 근사. */
export function portionGrams(data) {
  if (!data) return null;
  switch (data.basis) {
    case "per_100g":
    case "per_100ml":
      return 100;
    case "per_serving":
      return isNum(data.serving_amount) ? data.serving_amount : null;
    case "per_package":
      return isNum(data.package_amount) ? data.package_amount : null;
    default:
      return null;
  }
}

/** 재촬영 안내 문구 생성 (사용자에게 그대로 보여줄 수 있는 톤) */
export function retakeHint(data, result) {
  const issues = data?.image_issues ?? [];
  if (issues.includes("not_a_label")) return "영양성분표가 보이도록 제품 뒷면을 찍어주세요.";
  if (issues.includes("cropped")) return "영양성분표 전체가 화면에 들어오도록 다시 찍어주세요.";
  if (issues.includes("glare")) return "조명 반사를 피해 각도를 살짝 틀어 다시 찍어주세요.";
  if (issues.includes("blurry") || issues.includes("low_resolution"))
    return "표에 초점을 맞추고 조금 더 가까이에서 다시 찍어주세요.";
  if (result?.suspectFields?.includes("basis"))
    return "표 맨 윗줄(‘1회 제공량’ 또는 ‘총 내용량’ 문구)이 함께 나오도록 찍어주세요.";
  return null;
}
