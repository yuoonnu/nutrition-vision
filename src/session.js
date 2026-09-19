import crypto from "node:crypto";

import { prepareImage, EDGE_PRIMARY, EDGE_RETRY } from "./preprocess.js";
import { extractNutrition } from "./extract.js";
import { validate, retakeHint } from "./validate.js";
import { normalize, costMetrics } from "./normalize.js";
import { buildConsensus } from "./consensus.js";
import { scoreRecognition, LOCK_THRESHOLD, RETRY_THRESHOLD } from "./score.js";

/**
 * 제품 슬롯 단위로 프레임을 쌓아가며 점수를 올리는 세션.
 *
 * 흐름:
 *   세션 생성(슬롯 4개) -> 슬롯0에 프레임 전송 -> 점수 반환
 *   -> 90 미만이면 다음 프레임 -> 합의 -> 점수 재계산
 *   -> 90 이상이면 locked, 프론트는 다음 슬롯으로 이동
 *
 * 프레임은 슬롯당 최대 3장. 그 이상은 정확도가 거의 안 오르고 비용만 는다.
 */

const MAX_FRAMES = 3;
const SESSION_TTL_MS = 30 * 60 * 1000;

const sessions = new Map();

setInterval(() => {
  const now = Date.now();
  for (const [id, s] of sessions) {
    if (now - s.updatedAt > SESSION_TTL_MS) sessions.delete(id);
  }
}, 60_000).unref?.();

export function createSession(slotCount = 4) {
  const id = crypto.randomUUID();
  sessions.set(id, {
    id,
    createdAt: Date.now(),
    updatedAt: Date.now(),
    slots: Array.from({ length: slotCount }, (_, i) => emptySlot(i)),
  });
  return publicView(sessions.get(id));
}

export function getSession(id) {
  const s = sessions.get(id);
  return s ? publicView(s) : null;
}

/**
 * 프레임 1장 투입. 항상 현재 점수와 상태를 돌려준다.
 */
export async function pushFrame(sessionId, slotIndex, imageBuffer) {
  const session = sessions.get(sessionId);
  if (!session) throw Object.assign(new Error("세션이 만료되었습니다."), { status: 404 });

  const slot = session.slots[slotIndex];
  if (!slot) throw Object.assign(new Error("잘못된 슬롯 번호입니다."), { status: 400 });
  session.updatedAt = Date.now();

  if (slot.status === "locked") {
    return { ...slotView(slot), note: "이미 확인된 제품입니다." };
  }
  if (slot.frames.length >= MAX_FRAMES) {
    slot.status = slot.score >= RETRY_THRESHOLD ? "needs_review" : "failed";
    return slotView(slot);
  }

  // 2번째 프레임부터는 해상도를 올리고 선명화 — 남은 항목을 잡기 위해
  const attempt = slot.frames.length;
  const image = await prepareImage(imageBuffer, {
    maxEdge: attempt === 0 ? EDGE_PRIMARY : EDGE_RETRY,
    sharpen: attempt > 0,
  });

  const data = await extractNutrition([image], {
    model: attempt === 0 ? process.env.MODEL_PRIMARY : (process.env.MODEL_RETRY ?? process.env.MODEL_PRIMARY),
  });
  slot.frames.push(data);

  const consensus = buildConsensus(slot.frames);
  const merged = consensus.data;
  const validation = validate(merged);
  const scored = scoreRecognition(merged, validation, consensus);

  slot.score = scored.score;
  slot.message = scored.message;
  slot.missing = scored.missing;
  slot.breakdown = scored.breakdown;
  slot.disputed = consensus.disputed ?? [];
  slot.raw = merged;
  slot.normalized = normalize(merged);
  slot.product = {
    name: merged.product_name,
    manufacturer: merged.manufacturer,
    allergens: merged.allergens ?? [],
  };
  slot.issues = validation.issues;
  slot.retakeHint = retakeHint(merged, validation);

  // 가격을 먼저 입력한 뒤 재촬영한 경우 지표를 다시 맞춰준다
  if (slot.cost) slot.costMetrics = costMetrics(slot.normalized, slot.cost);

  if (scored.score >= LOCK_THRESHOLD) {
    slot.status = "locked";
  } else if (slot.frames.length >= MAX_FRAMES) {
    // 더 찍어도 안 오른다. 여기서 멈추고 사람에게 넘긴다.
    slot.status = scored.score >= RETRY_THRESHOLD ? "needs_review" : "failed";
  } else {
    slot.status = "reading";
  }

  return slotView(slot);
}

/**
 * 가격 입력. 라벨이 아니라 매대 가격표에 있는 정보라 사용자가 직접 넣는다.
 * 인식 전에 넣어도 되고 후에 넣어도 되도록, 영양 정보 유무와 독립적으로 저장한다.
 */
export function setCost(sessionId, slotIndex, cost) {
  const session = sessions.get(sessionId);
  const slot = session?.slots?.[slotIndex];
  if (!slot) throw Object.assign(new Error("슬롯을 찾을 수 없습니다."), { status: 404 });
  session.updatedAt = Date.now();

  const won = typeof cost === "number" ? cost : parseFloat(String(cost ?? "").replace(/[,\s원]/g, ""));
  if (!Number.isFinite(won) || won <= 0) {
    slot.cost = null;
    slot.costMetrics = null;
  } else {
    slot.cost = Math.round(won);
    slot.costMetrics = costMetrics(slot.normalized, slot.cost);
  }
  return slotView(slot);
}

/** 점수가 90에 못 미쳐도 사용자가 "이대로 진행" 하면 확정 */
export function forceLock(sessionId, slotIndex) {
  const slot = sessions.get(sessionId)?.slots?.[slotIndex];
  if (!slot) throw Object.assign(new Error("슬롯을 찾을 수 없습니다."), { status: 404 });
  slot.status = "locked";
  slot.lockedManually = true;
  return slotView(slot);
}

export function resetSlot(sessionId, slotIndex) {
  const session = sessions.get(sessionId);
  if (!session?.slots?.[slotIndex]) {
    throw Object.assign(new Error("슬롯을 찾을 수 없습니다."), { status: 404 });
  }
  session.slots[slotIndex] = emptySlot(slotIndex);
  return slotView(session.slots[slotIndex]);
}

/** 수동 보정값을 슬롯에 반영 */
export function correctSlot(sessionId, slotIndex, corrections) {
  const slot = sessions.get(sessionId)?.slots?.[slotIndex];
  if (!slot?.raw) throw Object.assign(new Error("보정할 결과가 없습니다."), { status: 400 });

  for (const [key, value] of Object.entries(corrections ?? {})) {
    if (value === null || value === "") continue;
    const num = typeof value === "number" ? value : parseFloat(String(value).replace(/,/g, ""));
    if (key.startsWith("nutrients.")) {
      slot.raw.nutrients[key.slice(10)] = Number.isFinite(num) ? num : null;
    } else if (["serving_amount", "package_amount", "servings_per_package"].includes(key)) {
      slot.raw[key] = Number.isFinite(num) ? num : null;
    } else {
      slot.raw[key] = value;
    }
  }

  const validation = validate(slot.raw);
  const scored = scoreRecognition(slot.raw, validation, { frameCount: 2, agreementRatio: 1 });
  slot.score = scored.score;
  slot.missing = scored.missing;
  slot.message = "직접 입력 반영됨";
  slot.normalized = normalize(slot.raw);
  slot.issues = validation.issues;
  slot.status = scored.missing.length === 0 ? "locked" : "needs_review";
  slot.correctedByUser = true;
  if (slot.cost) slot.costMetrics = costMetrics(slot.normalized, slot.cost);
  return slotView(slot);
}

function emptySlot(index) {
  return {
    index,
    status: "empty", // empty | reading | locked | needs_review | failed
    score: 0,
    message: "라벨을 비춰주세요",
    frames: [],
    missing: [],
    breakdown: {},
    disputed: [],
    raw: null,
    normalized: null,
    product: null,
    cost: null,
    costMetrics: null,
    issues: [],
    retakeHint: null,
  };
}

function slotView(slot) {
  const { frames, ...rest } = slot;
  return { ...rest, frameCount: frames.length, maxFrames: MAX_FRAMES };
}

function publicView(session) {
  return {
    sessionId: session.id,
    slots: session.slots.map(slotView),
    comparable: session.slots
      .filter((s) => s.status === "locked")
      .every((s) => s.normalized?.per100),
    priceComparable: session.slots
      .filter((s) => s.status === "locked")
      .every((s) => s.costMetrics?.comparable),
    lockedCount: session.slots.filter((s) => s.status === "locked").length,
  };
}
