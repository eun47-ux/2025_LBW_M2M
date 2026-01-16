// M2M_admin/index.js - Express 서버
import "dotenv/config";
import express from "express";
import cors from "cors";
import path from "path";
import fs from "fs";
import { fileURLToPath } from "url";
import { PORT, ADMIN_SESSIONS_DIR } from "./config.js";
import { loadSessionFromDB } from "./services/downloadService.js";
import { regenerateVideo, regenerateImage } from "./services/regenerateService.js";
import { updateScenes, getScenes } from "./services/firestoreService.js";

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
 * Query: ?refresh=true (DB에서 최신 정보 가져오기)
 * comfy_results.json은 사용하지 않고 DB의 videoUrls에서만 비디오 목록 생성
 */
app.get("/api/session/:sessionId/videos", async (req, res) => {
      try {
        const { sessionId } = req.params;
        const { refresh } = req.query;

        let videos = [];

        // DB의 videoUrls에서 비디오 목록 생성
        try {
          const { getVideoUrls } = await import("./services/firestoreService.js");
          const videoUrls = refresh === "true" 
            ? await getVideoUrls(sessionId) 
            : await getVideoUrls(sessionId);
          
          for (const [sceneId, videoUrl] of Object.entries(videoUrls)) {
            if (!videoUrl) continue;
            
            // URL 정규화: http:/ 또는 https:/를 http:// 또는 https://로 변환
            let normalizedUrl = videoUrl.replace(/^https?:\//, (match) => match + "/");
            
            // URL이 절대 URL인지 확인 (http:// 또는 https://로 시작)
            let absoluteUrl = normalizedUrl;
            const isAbsolute = normalizedUrl.match(/^https?:\/\//);
            if (!isAbsolute) {
              // 상대 경로인 경우에만 COMFY_STATIC_BASE 사용
              const base = process.env.COMFY_STATIC_BASE || "http://143.248.107.38:8186";
              absoluteUrl = normalizedUrl.startsWith("/") 
                ? `${base}${normalizedUrl}`
                : `${base}/${normalizedUrl}`;
            }
            
            videos.push({
              scene_id: sceneId,
              prompt_text: "",
              video_prompt_id: null,
              video_url: absoluteUrl,
              comfy_video: null,
            });
          }
        } catch (e) {
          console.warn("DB에서 videoUrls 가져오기 실패:", e.message);
        }

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

/**
 * 씬 파일 업데이트
 * POST /api/scenes/update
 * Body: { sessionId: string, scenesJson: object }
 */
app.post("/api/scenes/update", async (req, res) => {
  try {
    const { sessionId, scenesJson } = req.body;
    if (!sessionId || !scenesJson) {
      return res.status(400).json({ ok: false, error: "sessionId and scenesJson are required" });
    }

    // Firestore 업데이트
    await updateScenes(sessionId, scenesJson);

    // 로컬 파일 저장
    const sessionDir = path.join(ADMIN_SESSIONS_DIR, sessionId);
    const scenesPath = path.join(sessionDir, "scenes.json");
    fs.writeFileSync(scenesPath, JSON.stringify(scenesJson, null, 2), "utf-8");

    return res.json({ ok: true, sessionId, scenesPath });
  } catch (e) {
    console.error(e);
    return res.status(500).json({
      ok: false,
      error: "scenes update failed",
      detail: e?.message || String(e),
    });
  }
});

/**
 * 이미지 재생성
 * POST /api/regenerate/image
 * Body: { sessionId: string, sceneId: string }
 */
app.post("/api/regenerate/image", async (req, res) => {
  try {
    const { sessionId, sceneId } = req.body;
    if (!sessionId || !sceneId) {
      return res.status(400).json({ ok: false, error: "sessionId and sceneId are required" });
    }

    const result = await regenerateImage(sessionId, sceneId);
    return res.json({ ok: true, ...result });
  } catch (e) {
    console.error(e);
    return res.status(500).json({
      ok: false,
      error: "image regenerate failed",
      detail: e?.message || String(e),
    });
  }
});

// ===============================
// Start server
// ===============================
app.listen(PORT, "0.0.0.0", () => {
  console.log(`✅ M2M Admin server running on http://0.0.0.0:${PORT}`);
});
