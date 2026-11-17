// test/normalize.test.js — 100g 환산·가격 지표 검증 (API 호출 없음, 비용 0원)
// 실행: node --test test/normalize.test.js
import { test } from "node:test";
import assert from "node:assert/strict";
import { normalize, costMetrics } from "../src/normalize.js";

// 테스트용 라벨 데이터 (실제 test 데이터셋 제품의 값을 사용)
const label = (basis, { serving = null, pkg = null, servings = null, ...nutrients }) => ({
  basis,
  serving_amount: serving,
  package_amount: pkg,
  servings_per_package: servings,
  nutrients: {
    calorie: null, carb: null, sugar: null, protein: null, fat: null,
    saturated_fat: null, trans_fat: null, cholesterol: null, sodium: null,
    ...nutrients,
  },
});

test("1회 제공량 기준 (k029: 20g당, 총 80g) → 100g당은 ×5, 포장 전체는 ×4", () => {
  const n = normalize(label("per_serving", { serving: 20, pkg: 80, calorie: 56.8, sodium: 30 }));
  assert.equal(n.per100.calorie, 284);
  assert.equal(n.per100.sodium, 150);
  assert.equal(n.perPackage.calorie, 227.2);
  assert.equal(n.perServing.calorie, 56.8);
});

test("100ml 기준 (M012 콜라: 100ml당 44kcal, 총 1500ml) → 포장 전체는 ×15", () => {
  const n = normalize(label("per_100ml", { pkg: 1500, calorie: 44, sugar: 11 }));
  assert.equal(n.per100.calorie, 44);
  assert.equal(n.perPackage.calorie, 660);
  assert.equal(n.perPackage.sugar, 165);
});

test("총 내용량 기준 (k004: 219g당 420kcal) → 100g당은 ÷2.19", () => {
  const n = normalize(label("per_package", { pkg: 219, calorie: 420, protein: 8 }));
  assert.equal(n.per100.calorie, 191.78);
  assert.equal(n.perPackage.calorie, 420);
});

test("못 읽은 영양소(null)는 환산 후에도 null로 남는다 (0이 되면 안 됨)", () => {
  const n = normalize(label("per_100g", { pkg: 100, calorie: 300, sugar: null }));
  assert.equal(n.per100.sugar, null);
  assert.equal(n.perPackage.sugar, null);
});

test("1회 제공량 기준인데 제공량을 못 읽으면 100g당 환산 불가 → per100 = null", () => {
  const n = normalize(label("per_serving", { serving: null, pkg: 80, calorie: 56.8 }));
  assert.equal(n.per100, null);
});

test("기준을 모르면(unknown) 환산 불가", () => {
  const n = normalize(label("unknown", { pkg: 100, calorie: 300 }));
  assert.equal(n.per100, null);
});

test("총 내용량이 없어도 1회 제공량 × 제공 횟수로 복원", () => {
  const n = normalize(label("per_serving", { serving: 30, servings: 3, calorie: 120 }));
  assert.equal(n.meta.packageGrams, 90);
  assert.equal(n.perPackage.calorie, 360);
});

test("가격 지표: 80g 1,600원 → 100g당 2,000원", () => {
  const n = normalize(label("per_serving", { serving: 20, pkg: 80, calorie: 56.8, protein: 1.6 }));
  const c = costMetrics(n, 1600);
  assert.equal(c.per100g, 2000);
  assert.equal(c.perServing, 400);
  assert.equal(c.perProtein, 250); // 포장 전체 단백질 6.4g → 1600 / 6.4
  assert.equal(c.comparable, true);
});

test("가격 지표: 총 내용량을 모르면 100g당 가격을 내지 않는다", () => {
  const n = normalize(label("per_100g", { calorie: 300 }));
  const c = costMetrics(n, 1600);
  assert.equal(c.per100g, null);
  assert.equal(c.comparable, false);
});
