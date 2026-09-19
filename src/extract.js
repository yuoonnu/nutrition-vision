import crypto from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";

import { NUTRITION_SCHEMA, toGeminiSchema } from "./schema.js";
import { SYSTEM_PROMPT, USER_PROMPT } from "./prompt.js";

/**
 * Gemini API 호출.
 *
 * SDK 없이 fetch만 쓴다. Node 20부터 fetch가 내장이라 의존성이 하나도 안 늘고,
 * SDK 버전이 바뀌어도 코드가 깨지지 않는다.
 */

const API_BASE = "https://generativelanguage.googleapis.com/v1beta";
const GEMINI_SCHEMA = toGeminiSchema(NUTRITION_SCHEMA);

const CACHE_DIR = path.resolve(".cache");
const useCache = process.env.USE_CACHE !== "0";

/**
 * @param {Array<{buffer: Buffer, mediaType: string}>} images
 * @param {{ model?: string, userPrompt?: string }} opts
 */
export async function extractNutrition(images, opts = {}) {
  const model = opts.model ?? process.env.MODEL_PRIMARY ?? "gemini-3.8-flash";
  const userPrompt = opts.userPrompt ?? USER_PROMPT;
  const apiKey = process.env.GEMINI_API_KEY;

  if (!apiKey) {
    throw Object.assign(new Error("GEMINI_API_KEY가 설정되지 않았습니다."), { status: 401 });
  }

  const cacheKey = hashKey(images, model, userPrompt);
  const cached = await readCache(cacheKey);
  if (cached) return { ...cached, _cached: true };

  // 이미지를 텍스트보다 먼저 넣는다. 판독 작업에서는 이 순서가 더 안정적이다.
  const parts = [
    ...images.map((img) => ({
      inline_data: { mime_type: img.mediaType, data: img.buffer.toString("base64") },
    })),
    { text: userPrompt },
  ];

  const body = {
    system_instruction: { parts: [{ text: SYSTEM_PROMPT }] },
    contents: [{ role: "user", parts }],
    generationConfig: {
      temperature: 0, // 판독 작업에 다양성은 손해다
      maxOutputTokens: 2048,
      responseMimeType: "application/json",
      responseSchema: GEMINI_SCHEMA,
    },
  };

  const res = await fetch(`${API_BASE}/models/${model}:generateContent`, {
    method: "POST",
    headers: { "Content-Type": "application/json", "x-goog-api-key": apiKey },
    body: JSON.stringify(body),
  });

  if (!res.ok) {
    const text = await res.text();
    throw Object.assign(new Error(`${res.status} ${text.slice(0, 300)}`), { status: res.status });
  }

  const data = await res.json();
  const parsed = parseJson(textOf(data));
  if (useCache) writeCache(cacheKey, parsed);
  return parsed;
}

/**
 * 응답에서 텍스트만 꺼낸다.
 * 안전 필터에 걸리거나 토큰이 모자라면 candidates가 비어 있을 수 있어서
 * 그 경우를 따로 구분해준다. 그냥 빈 문자열로 넘기면 원인을 못 찾는다.
 */
function textOf(data) {
  const cand = data?.candidates?.[0];
  if (!cand) {
    const block = data?.promptFeedback?.blockReason;
    throw new Error(block ? `요청이 차단되었습니다 (${block})` : "응답이 비어 있습니다.");
  }
  if (cand.finishReason && !["STOP", "MAX_TOKENS"].includes(cand.finishReason)) {
    throw new Error(`생성이 중단되었습니다 (${cand.finishReason})`);
  }
  return (cand.content?.parts ?? []).map((p) => p.text ?? "").join("");
}

/** responseSchema를 쓰면 순수 JSON이 오지만, 혹시 모를 경우를 방어한다 */
function parseJson(text) {
  const cleaned = text.trim().replace(/^```(?:json)?\s*/i, "").replace(/```$/i, "").trim();
  try {
    return JSON.parse(cleaned);
  } catch {
    const start = cleaned.indexOf("{");
    const end = cleaned.lastIndexOf("}");
    if (start !== -1 && end > start) return JSON.parse(cleaned.slice(start, end + 1));
    throw new Error(`모델 응답을 JSON으로 파싱하지 못했습니다: ${cleaned.slice(0, 200)}`);
  }
}

/** 내 API 키로 쓸 수 있는 모델 목록. `npm run models`로 확인 */
export async function listModels() {
  const res = await fetch(`${API_BASE}/models`, {
    headers: { "x-goog-api-key": process.env.GEMINI_API_KEY ?? "" },
  });
  if (!res.ok) throw new Error(`${res.status} ${await res.text()}`);
  const { models = [] } = await res.json();
  return models
    .filter((m) => m.supportedGenerationMethods?.includes("generateContent"))
    .map((m) => m.name.replace(/^models\//, ""));
}

function hashKey(images, model, prompt) {
  const h = crypto.createHash("sha256");
  h.update(model).update(prompt);
  for (const img of images) h.update(img.buffer);
  return h.digest("hex").slice(0, 32);
}

async function readCache(key) {
  if (!useCache) return null;
  try {
    return JSON.parse(await fs.readFile(path.join(CACHE_DIR, `${key}.json`), "utf8"));
  } catch {
    return null;
  }
}

async function writeCache(key, value) {
  try {
    await fs.mkdir(CACHE_DIR, { recursive: true });
    await fs.writeFile(path.join(CACHE_DIR, `${key}.json`), JSON.stringify(value));
  } catch {
    /* 캐시 실패는 무시 */
  }
}
