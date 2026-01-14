// M2M_admin/index.js - Express 서버
import "dotenv/config";
import express from "express";
import cors from "cors";
import path from "path";
import fs from "fs";
import { fileURLToPath } from "url";
import { PORT, ADMIN_SESSIONS_DIR } from "./config.js";
import { loadSessionFromDB } from "./services/downloadService.js";
import { regenerateVideo } from "./services/regenerateService.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const app = express();
app.use(cors());
app.use(express.json());
app.use("/sessions", express.static(ADMIN_SESSIONS_DIR));
app.use(express.static(path.join(__dirname, "public")));

// ===============================
// Routes
// ===============================

app.get("/api/health", (req, res) => {
  res.json({ ok: true, ADMIN_SESSIONS_DIR });
});

/**
 * 세션 생성 (빈 세션 폴더)
 * POST /api/session/create
 * Body: { sessionId: string }
 */
app.post("/api/session/create", async (req, res) => {
      try {
        const { sessionId } = req.body;
        if (!sessionId) {
          return res.status(400).json({ ok: false, error: "sessionId is required" });
        }

        const sessionDir = path.join(ADMIN_SESSIONS_DIR, sessionId);
        if (!fs.existsSync(sessionDir)) {
          fs.mkdirSync(sessionDir, { recursive: true });
          fs.mkdirSync(path.join(sessionDir, "images"), { recursive: true });
          fs.mkdirSync(path.join(sessionDir, "videos"), { recursive: true });
        }

    return res.json({ ok: true, sessionId, sessionDir });
  } catch (e) {
    console.error(e);
    return res.status(500).json({ ok: false, error: "create session failed", detail: e.message });
  }
});

/**
 * DB에서 세션 데이터 로드
 * POST /api/session/:sessionId/load-from-db
 */
app.post("/api/session/:sessionId/load-from-db", async (req, res) => {
  try {
    const { sessionId } = req.params;
    const result = await loadSessionFromDB(sessionId);
    return res.json({ ok: true, ...result });
  } catch (e) {
    console.error(e);
    return res.status(500).json({
      ok: false,
      error: "load-from-db failed",
      detail: e?.message || String(e),
    });
  }
});

/**
 * 비디오 목록 조회
 * GET /api/session/:sessionId/videos
 */
app.get("/api/session/:sessionId/videos", async (req, res) => {
      try {
        const { sessionId } = req.params;
        const sessionDir = path.join(ADMIN_SESSIONS_DIR, sessionId);
        const comfyResultsPath = path.join(sessionDir, "comfy_results.json");

        if (!fs.existsSync(comfyResultsPath)) {
          return res.status(404).json({ ok: false, error: "comfy_results.json not found" });
        }

        const results = JSON.parse(fs.readFileSync(comfyResultsPath, "utf-8"));
    const videos = Array.isArray(results)
      ? results
          .filter((r) => r.video_prompt_id || r.comfy_video)
          .map((r) => {
            const videoUrl = r.comfy_video
              ? `${process.env.COMFY_STATIC_BASE || "http://143.248.107.38:8186"}/${r.comfy_video.subfolder}/${r.comfy_video.filename}`.replace(/\\/g, "/")
              : null;
            return {
              scene_id: r.scene_id,
              prompt_text: r.prompt_text,
              video_prompt_id: r.video_prompt_id,
              video_url: videoUrl,
              comfy_video: r.comfy_video,
            };
          })
      : [];

    return res.json({ ok: true, sessionId, videos });
  } catch (e) {
    console.error(e);
    return res.status(500).json({
      ok: false,
      error: "videos list failed",
      detail: e?.message || String(e),
    });
  }
});

/**
 * 비디오 재생성
 * POST /api/session/:sessionId/regenerate/:sceneId
 */
app.post("/api/session/:sessionId/regenerate/:sceneId", async (req, res) => {
  try {
    const { sessionId, sceneId } = req.params;
    const result = await regenerateVideo(sessionId, sceneId);
    return res.json({ ok: true, ...result });
  } catch (e) {
    console.error(e);
    return res.status(500).json({
      ok: false,
      error: "regenerate failed",
      detail: e?.message || String(e),
    });
  }
});

// ===============================
// Start server
// ===============================
app.listen(PORT, () => {
  console.log(`✅ M2M Admin server running on http://localhost:${PORT}`);
});
