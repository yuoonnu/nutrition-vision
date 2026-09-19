/**
 * 영양성분표 추출 스키마.
 *
 * 설계 원칙 3가지:
 *  1) 못 읽은 값은 "추측"이 아니라 반드시 null. (틀린 숫자가 빈 값보다 100배 위험함)
 *  2) 모든 필드를 required로 두고 타입에 "null"을 허용한다.
 *     -> structured outputs는 optional 파라미터 개수에 제한이 있어서,
 *        optional을 남발하면 스키마 컴파일이 거부된다. nullable-required가 안전.
 *  3) basis(기준 단위)는 최상위 필수 필드. 이게 없으면 제품 간 비교가 불가능하다.
 */

const num = { type: ["number", "null"] };
const str = { type: ["string", "null"] };

export const NUTRIENT_KEYS = [
  "calorie",
  "carb",
  "sugar",
  "protein",
  "fat",
  "saturated_fat",
  "trans_fat",
  "cholesterol",
  "sodium",
];

// 한국 식약처 의무표시 9종 = 열량, 나트륨, 탄수화물, 당류, 지방, 트랜스지방, 포화지방, 콜레스테롤, 단백질
export const REQUIRED_NUTRIENTS = [
  "calorie",
  "carb",
  "sugar",
  "protein",
  "fat",
  "saturated_fat",
  "trans_fat",
  "cholesterol",
  "sodium",
];

/**
 * 각 항목의 단위.
 *
 * 키 이름을 짧게 줄이면서 단위 정보가 빠졌기 때문에, 단위는 여기서 관리한다.
 * 나트륨과 콜레스테롤만 mg이고 나머지는 g, 열량은 kcal다.
 * 이 표를 프롬프트·검증·화면 표시에서 모두 공유해서 어긋날 여지를 없앤다.
 */
export const NUTRIENT_UNITS = {
  calorie: "kcal",
  carb: "g",
  sugar: "g",
  protein: "g",
  fat: "g",
  saturated_fat: "g",
  trans_fat: "g",
  cholesterol: "mg",
  sodium: "mg",
};

export const NUTRIENT_LABELS_KO = {
  calorie: "열량",
  carb: "탄수화물",
  sugar: "당류",
  protein: "단백질",
  fat: "지방",
  saturated_fat: "포화지방",
  trans_fat: "트랜스지방",
  cholesterol: "콜레스테롤",
  sodium: "나트륨",
};

export const NUTRITION_SCHEMA = {
  type: "object",
  properties: {
    is_nutrition_label: {
      type: "boolean",
      description: "사진에 영양성분표가 실제로 보이면 true. 아니면 false.",
    },
    product_name: {
      ...str,
      description: "제품명. 라벨에 안 보이면 null. 절대 추측하지 말 것.",
    },
    manufacturer: { ...str, description: "제조사. 안 보이면 null." },

    basis: {
      type: "string",
      enum: ["per_serving", "per_100g", "per_100ml", "per_package", "unknown"],
      description:
        "영양성분 수치가 어느 기준으로 표시됐는지. '1회 제공량당'=per_serving, '총 내용량당'=per_package, '100g당'=per_100g. 표에 명시된 문구를 그대로 근거로 판단. 판단 불가면 unknown.",
    },
    basis_text: {
      ...str,
      description: "기준 단위를 판단한 근거가 된 라벨 원문 (예: '총 내용량 90g당').",
    },

    serving_amount: { ...num, description: "1회 제공량 수치. 없으면 null." },
    serving_unit: {
      type: ["string", "null"],
      enum: ["g", "ml", null],
      description: "1회 제공량 단위.",
    },
    servings_per_package: {
      ...num,
      description: "총 제공 횟수 (예: '총 2회 제공량'이면 2). 없으면 null.",
    },
    package_amount: { ...num, description: "총 내용량 수치. 없으면 null." },
    package_unit: {
      type: ["string", "null"],
      enum: ["g", "ml", null],
      description: "총 내용량 단위.",
    },

    nutrients: {
      type: "object",
      description:
        "basis 기준의 영양성분 값. 단위는 calorie=kcal, sodium/cholesterol=mg, 나머지=g. 라벨에서 읽을 수 없으면 null.",
      properties: Object.fromEntries(NUTRIENT_KEYS.map((k) => [k, num])),
      required: NUTRIENT_KEYS,
      additionalProperties: false,
    },

    allergens: {
      type: "array",
      items: { type: "string" },
      description: "알레르기 유발물질 표시 문구에서 읽은 항목들. 없으면 빈 배열.",
    },

    unreadable_fields: {
      type: "array",
      items: { type: "string" },
      description:
        "표에 분명히 존재하지만 흐림/잘림/반사 때문에 값을 읽지 못한 항목의 키 이름 목록.",
    },
    image_issues: {
      type: "array",
      items: {
        type: "string",
        enum: [
          "blurry",
          "glare",
          "cropped",
          "angled",
          "low_resolution",
          "obstructed",
          "not_a_label",
        ],
      },
      description: "사진 품질 문제. 문제 없으면 빈 배열.",
    },
    confidence: {
      type: "number",
      description: "전체 추출 신뢰도 0.0~1.0. 한 글자라도 애매하면 과감히 낮출 것.",
    },
  },
  required: [
    "is_nutrition_label",
    "product_name",
    "manufacturer",
    "basis",
    "basis_text",
    "serving_amount",
    "serving_unit",
    "servings_per_package",
    "package_amount",
    "package_unit",
    "nutrients",
    "allergens",
    "unreadable_fields",
    "image_issues",
    "confidence",
  ],
  additionalProperties: false,
};

/**
 * 우리 JSON Schema를 Gemini의 responseSchema 형식으로 변환한다.
 *
 * Gemini는 OpenAPI 3.0 스키마의 부분집합만 받는다. 차이점 세 가지:
 *  1) type에 배열을 못 쓴다. ["number","null"] 대신 { type:"number", nullable:true }
 *  2) additionalProperties를 모른다 (있으면 무시되거나 거부된다)
 *  3) propertyOrdering으로 필드 생성 순서를 지정할 수 있다.
 *     JSON 키 순서가 출력 품질에 영향을 주기 때문에, 판독 순서대로 놓으면
 *     모델이 "표를 위에서 아래로 읽는" 흐름을 따라가게 된다.
 */
export function toGeminiSchema(node) {
  if (!node || typeof node !== "object") return node;

  const out = {};
  let nullable = false;

  if (Array.isArray(node.type)) {
    const types = node.type.filter((t) => t !== "null");
    nullable = node.type.length !== types.length;
    out.type = types[0] ?? "string";
  } else if (node.type) {
    out.type = node.type;
  }

  if (node.description) out.description = node.description;

  if (node.enum) {
    const vals = node.enum.filter((v) => v !== null);
    if (vals.length !== node.enum.length) nullable = true;
    out.enum = vals;
    out.type = out.type ?? "string";
  }

  if (nullable) out.nullable = true;

  if (node.properties) {
    out.properties = Object.fromEntries(
      Object.entries(node.properties).map(([k, v]) => [k, toGeminiSchema(v)])
    );
    // 스키마에 적은 순서대로 생성하게 한다
    out.propertyOrdering = Object.keys(node.properties);
  }
  if (node.required) out.required = node.required;
  if (node.items) out.items = toGeminiSchema(node.items);

  return out;
}
