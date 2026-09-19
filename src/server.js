import "dotenv/config";
import express from "express";
import multer from "multer";
import cors from "cors";
import path from "node:path";

import { recognizeProduct, applyCorrections } from "./pipeline.js";
import {
  createSession, getSession, pushFrame, forceLock, resetSlot, correctSlot, setCost,
} from "./session.js";

const app = express();

app.use(cors({
  origin: process.env.ALLOWED_ORIGIN?.split(",") ?? "*",
  methods: ["GET", "POST"],
}));

app.use(express.json({ limit: "2mb" }));
app.use(express.static(path.resolve("public")));

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 12 * 1024 * 1024, files: 12 },
});

app.get("/health", (_req, res) => res.json({ ok: true }));

/* ── 단발 인식 (사진 업로드 방식) ─────────────────────────── */

app.post("/api/extract", upload.array("images", 3), async (req, res) => {
  if (!req.files?.length) {
    return res.status(400).json({ status: "failed", message: "images 필드에 사진을 첨부하세요." });
  }
  res.json(await recognizeProduct(req.files.map((f) => f.buffer)));
});

app.post("/api/extract/batch", upload.array("images", 8), async (req, res) => {
  if (!req.files?.length) {
    return res.status(400).json({ status: "failed", message: "images 필드에 사진을 첨부하세요." });
  }
  const results = await Promise.all(
    req.files.map(async (f, i) => ({
      productIndex: i,
      filename: f.originalname,
      ...(await recognizeProduct([f.buffer])),
    }))
  );
  res.json({
    products: results,
    summary: {
      total: results.length,
      ok: results.filter((r) => r.status === "ok").length,
      needsReview: results.filter((r) => r.status === "needs_review").length,
      failed: results.filter((r) => r.status === "failed").length,
      comparable: results.every((r) => r.normalized?.per100),
    },
  });
});

app.post("/api/correct", (req, res) => {
  const { raw, corrections } = req.body ?? {};
  if (!raw) return res.status(400).json({ status: "failed", message: "raw가 필요합니다." });
  res.json(applyCorrections(raw, corrections ?? {}));
});

/* ── 스코어링(Flask) 프록시 ───────────────────────────────
 * 브라우저가 Flask(:5000)를 직접 호출하면 CORS 설정이 필요하고,
 * 나중에 배포할 때도 Flask 포트를 외부에 열어야 하는 문제가 생긴다.
 * Node가 대신 호출해서 그대로 전달하면 브라우저는 3000번 포트 하나만 알면 되고,
 * Flask는 내부망(같은 서버)에서만 접근 가능하게 막아둘 수 있다.
 */
const SCORING_URL = process.env.SCORING_URL ?? "http://localhost:5000/recommend";
const INTERNAL_API_TOKEN = process.env.INTERNAL_API_TOKEN;

app.post("/api/recommend", async (req, res) => {
  try {
    const upstream = await fetch(SCORING_URL, {
      method: "POST",
      headers: { 
        "Content-Type": "application/json",
        ...(INTERNAL_API_TOKEN ? { "X-Internal-Token": INTERNAL_API_TOKEN } : {}),
      },
      body: JSON.stringify(req.body ?? {}),
    });
    const data = await upstream.json().catch(() => ({}));
    res.status(upstream.status).json(data);
  } catch (err) {
    console.error("[recommend proxy]", err);
    res.status(502).json({ error: "스코어링 서버(Flask)에 연결할 수 없습니다. 서버가 떠 있는지 확인하세요." });
  }
});

/* ── 라이브 스캔 (카메라 방식) ────────────────────────────── */

app.post("/api/scan/session", (req, res) => {
  const slots = Math.min(Math.max(Number(req.body?.slots ?? 4), 1), 6);
  res.json(createSession(slots));
});

app.get("/api/scan/session/:id", (req, res) => {
  const s = getSession(req.params.id);
  if (!s) return res.status(404).json({ message: "세션이 만료되었습니다." });
  res.json(s);
});

// 프레임 1장 투입 -> 현재 점수 반환. 프론트는 이 응답만 보고 게이지를 그린다.
app.post("/api/scan/frame", upload.single("image"), async (req, res) => {
  try {
    if (!req.file) return res.status(400).json({ message: "image 파일이 필요합니다." });
    const { sessionId, slotIndex } = req.body ?? {};
    res.json(await pushFrame(sessionId, Number(slotIndex ?? 0), req.file.buffer));
  } catch (err) {
    console.error("[scan/frame]", err);
    res.status(err.status ?? 500).json({ message: err.message ?? "인식 중 오류가 발생했습니다." });
  }
});

app.post("/api/scan/lock", (req, res) => {
  try {
    res.json(forceLock(req.body?.sessionId, Number(req.body?.slotIndex ?? 0)));
  } catch (err) {
    res.status(err.status ?? 500).json({ message: err.message });
  }
});

app.post("/api/scan/reset", (req, res) => {
  try {
    res.json(resetSlot(req.body?.sessionId, Number(req.body?.slotIndex ?? 0)));
  } catch (err) {
    res.status(err.status ?? 500).json({ message: err.message });
  }
});

// 가격 입력. body: { sessionId, slotIndex, cost }
// cost를 비우거나 0을 보내면 입력 취소로 처리된다.
app.post("/api/scan/cost", (req, res) => {
  try {
    res.json(setCost(req.body?.sessionId, Number(req.body?.slotIndex ?? 0), req.body?.cost));
  } catch (err) {
    res.status(err.status ?? 500).json({ message: err.message });
  }
});

app.post("/api/scan/correct", (req, res) => {
  try {
    res.json(correctSlot(req.body?.sessionId, Number(req.body?.slotIndex ?? 0), req.body?.corrections));
  } catch (err) {
    res.status(err.status ?? 500).json({ message: err.message });
  }
});

const port = Number(process.env.PORT ?? 3000);
app.listen(port, () => {
  console.log(`서버 실행 중 → http://localhost:${port}`);
  console.log(`스캐너 데모   → http://localhost:${port}/scanner.html`);
  if (!process.env.GEMINI_API_KEY) {
    console.warn("GEMINI_API_KEY 문제");
  }
});
