import { NUTRIENT_KEYS } from "./schema.js";
import { portionGrams } from "./validate.js";

/**
 * 이 파일이 B파트의 최종 산출물이다.
 *
 * 서로 다른 기준(1회 제공량당 / 총 내용량당 / 100g당)으로 표시된 제품들을
 * 같은 자로 재서 넘겨야 C파트(비교·추천 로직)가 의미 있는 순위를 낼 수 있다.
 *
 * 세 가지를 모두 제공하는 이유:
 *  - per100: 제품 간 "밀도" 비교용 (영양 효율)
 *  - perServing: 라벨 표기와 일치해 사용자에게 설명할 때 필요
 *  - perPackage: "이거 한 봉지 다 먹으면" — 실제 섭취량. 다이어트 판단에는 이게 제일 정직하다.
 */

export function normalize(data) {
  const base = data?.nutrients ?? {};
  const basisGrams = portionGrams(data);

  const servingG = num(data?.serving_amount);
  let packageG = num(data?.package_amount);

  // 총 내용량이 없어도 (1회 제공량 x 제공 횟수)로 복원 가능한 경우가 많다
  if (!packageG && servingG && num(data?.servings_per_package)) {
    packageG = servingG * data.servings_per_package;
  }

  const scale = (factor) =>
    factor === null
      ? null
      : Object.fromEntries(
          NUTRIENT_KEYS.map((k) => [
            k,
            typeof base[k] === "number" ? round(base[k] * factor) : null,
          ])
        );

  return {
    per100: scale(basisGrams ? 100 / basisGrams : null),
    perServing: scale(basisGrams && servingG ? servingG / basisGrams : null),
    perPackage: scale(basisGrams && packageG ? packageG / basisGrams : null),
    meta: {
      basis: data?.basis ?? "unknown",
      basisGrams,
      servingGrams: servingG,
      packageGrams: packageG,
      // 1회 제공량이 포장 전체가 아닌 경우 사용자가 가장 많이 착각하는 지점
      servingIsWholePackage:
        servingG && packageG ? Math.abs(servingG - packageG) < 1 : null,
    },
  };
}

function num(v) {
  return typeof v === "number" && v > 0 ? v : null;
}

/**
 * 가격을 영양 정보와 묶어 "단위당 가격"을 낸다.
 *
 * 가격표의 숫자만으로는 비교가 안 된다.
 * 500원짜리 30g 과자와 1,500원짜리 150g 과자 중 뭐가 싼지는
 * 100g당으로 환산해야 비로소 보인다.
 *
 * 목표별로 봐야 할 지표가 다르다:
 *  - 체중감량  → per100kcal (같은 돈으로 열량을 덜 사는 쪽)
 *  - 고단백    → perProteinG (단백질 1g을 가장 싸게 얻는 쪽)
 *  - 가성비    → per100g (그냥 양 대비 가격)
 *
 * @param {object} normalized normalize()의 결과
 * @param {number} cost 원 단위 가격
 */
export function costMetrics(normalized, cost) {
  const won = num(cost);
  if (!won || !normalized) return null;

  const pkg = normalized.meta?.packageGrams;
  const serving = normalized.meta?.servingGrams;
  const per100 = normalized.per100 ?? {};
  const perPackage = normalized.perPackage ?? {};

  // 포장 전체 중량을 모르면 100g당 가격을 낼 수 없다
  const per100g = pkg ? round(won / (pkg / 100)) : null;
  const perServing = pkg && serving ? round(won * (serving / pkg)) : null;

  // 단백질·열량당 가격은 포장 전체 기준으로 계산한다
  const totalProtein = perPackage.protein;
  const totalKcal = perPackage.calorie;

  return {
    cost: won,
    per100g,
    perServing,
    perProtein: num(totalProtein) ? round(won / totalProtein) : null,
    per100kcal: num(totalKcal) ? round(won / (totalKcal / 100)) : null,
    // 100g당 가격을 못 내면 다른 제품과 가격 비교가 불가능하다
    comparable: per100g !== null,
  };
}

function round(v) {
  return Math.round(v * 100) / 100;
}
