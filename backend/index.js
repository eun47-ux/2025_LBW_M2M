// backend/index.js - Express 서버 (라우트만)
import "dotenv/config";
import express from "express";
import cors from "cors";
import multer from "multer";
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import { PORT, SESSIONS_DIR } from "./config.js";
import { createSession, getSession, updateSession, buildLabels } from "./services/sessionService.js";
import { runSTT, generateScenes } from "./services/transcriptService.js";
import { runImageScenes } from "./services/imageService.js";
import { runVideoScenes } from "./services/videoService.js";
import { concatVideos } from "./services/movieService.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// Express app
const app = express();
app.use(cors());
app.use(express.json());
app.use("/sessions", express.static(SESSIONS_DIR));

// multer 설정
const upload = multer({ dest: "tmp/" });
const uploadAudio = multer({
  dest: "tmp/",
  limits: { fileSize: 300 * 1024 * 1024 }, // 300MB
});

// 유틸리티 함수
function safeSessionName(name) {
  const s = (name || "").trim();
  if (!s) return `session-${Date.now()}`;
  return s.replace(/[^a-zA-Z0-9-_]/g, "_");
}

function joinUrl(base, subpath) {
  const cleanBase = (base || "").replace(/\/+$/, "");
  const cleanPath = (subpath || "").replace(/^\/+/, "");
  return `${cleanBase}/${cleanPath}`;
}

// ===============================
// Routes
// ===============================

app.get("/api/health", (req, res) => {
  res.json({ ok: true, SESSIONS_DIR });
});

/**
 * 세션 생성
 * POST /api/session/create
 * Body: { sessionId: string }
 */
app.post("/api/session/create", (req, res) => {
  try {
    const { sessionId } = req.body;
    if (!sessionId) {
      return res.status(400).json({ ok: false, error: "sessionId is required" });
    }

    const safeId = safeSessionName(sessionId);
    const result = createSession(safeId);
    return res.json({ ok: true, ...result });
  } catch (e) {
    console.error(e);
    return res.status(500).json({ ok: false, error: "create session failed", detail: e.message });
  }
});

/**
 * 세션 조회
 * GET /api/session/:sessionId
 */
app.get("/api/session/:sessionId", (req, res) => {
  try {
    const { sessionId } = req.params;
    const result = getSession(sessionId);
    return res.json({ ok: true, ...result });
  } catch (e) {
    console.error(e);
    return res.status(404).json({ ok: false, error: e.message });
  }
});

/**
 * 인물 크롭 저장
 * POST /api/session/:sessionId/update-crops
 * FormData:
 * - photo: File (옵션)
 * - crops: File[] (필수)
 * - ownerId: string (필수)
 * - labelMap: JSON string
 * - cropMeta: JSON string[] (여러 개)
 */
app.post(
  "/api/session/:sessionId/update-crops",
  upload.fields([
    { name: "photo", maxCount: 1 },
    { name: "crops", maxCount: 50 },
  ]),
  (req, res) => {
    try {
      const { sessionId } = req.params;
      const { ownerId, labelMap, cropMeta } = req.body;

      if (!ownerId) {
        return res.status(400).json({ ok: false, error: "ownerId is required" });
      }

      const cropFiles = req.files?.crops || [];
      if (!cropFiles.length) {
        return res.status(400).json({ ok: false, error: "crops[] is required (at least 1)" });
      }

      let labelMapObj = {};
      try {
        labelMapObj = labelMap ? JSON.parse(labelMap) : {};
      } catch {
        labelMapObj = {};
      }

      let cropMetaArr = [];
      if (cropMeta) {
        if (Array.isArray(cropMeta)) {
          cropMetaArr = cropMeta
            .map((s) => {
              try {
                return JSON.parse(s);
              } catch {
                return null;
              }
            })
            .filter(Boolean);
        } else {
          try {
            cropMetaArr = [JSON.parse(cropMeta)];
          } catch {
            cropMetaArr = [];
          }
        }
      }

      const photoFile = req.files?.photo?.[0] || null;

      const result = updateSession(sessionId, {
        ownerId,
        labelMap: labelMapObj,
        cropMetaArr,
        photoFile,
        cropFiles,
      });

      return res.json({ ok: true, ...result });
    } catch (e) {
      console.error(e);
      return res.status(500).json({ ok: false, error: "update-crops failed", detail: e.message });
    }
  }
);

/**
 * 크롭 추출 + ComfyUI 업로드 + labels.json 생성
 * POST /api/session/:sessionId/build-labels
 */
app.post("/api/session/:sessionId/build-labels", async (req, res) => {
  try {
    const { sessionId } = req.params;
    const result = await buildLabels(sessionId);
    return res.json({ ok: true, ...result });
  } catch (e) {
    console.error(e);
    return res.status(500).json({ ok: false, error: "build-labels failed", detail: e.message });
  }
});

/**
 * 오디오 업로드
 * POST /api/session/:sessionId/upload-audio
 * FormData: audio: File
 */
app.post("/api/session/:sessionId/upload-audio", uploadAudio.single("audio"), async (req, res) => {
  try {
    const { sessionId } = req.params;

    if (!req.file) {
      return res.status(400).json({ ok: false, error: "audio file is required (field name: audio)" });
    }

    const sessionPath = path.join(SESSIONS_DIR, sessionId);
    if (!fs.existsSync(sessionPath)) {
      return res.status(404).json({ ok: false, error: "Session folder not found", sessionPath });
    }

    // audio 폴더 만들기
    const audioDir = path.join(sessionPath, "audio");
    fs.mkdirSync(audioDir, { recursive: true });

    // 확장자 추정
    const original = req.file.originalname || "recording";
    const ext = path.extname(original) || ".wav";
    const outPath = path.join(audioDir, `recording${ext}`);

    // 저장
    try {
      fs.renameSync(req.file.path, outPath);
    } catch {
      fs.copyFileSync(req.file.path, outPath);
      fs.unlinkSync(req.file.path);
    }

    // session.json 업데이트
    const sessionJsonPath = path.join(sessionPath, "session.json");
    let session = {};
    if (fs.existsSync(sessionJsonPath)) {
      try {
        session = JSON.parse(fs.readFileSync(sessionJsonPath, "utf-8"));
      } catch {
        session = {};
      }
    }
    session.audio = {
      filename: path.basename(outPath),
      path: outPath,
      uploadedAt: new Date().toISOString(),
      mimetype: req.file.mimetype,
      size: req.file.size,
    };
    fs.writeFileSync(sessionJsonPath, JSON.stringify(session, null, 2), "utf-8");

    return res.json({
      ok: true,
      sessionId,
      saved: {
        filename: path.basename(outPath),
        path: outPath,
        mimetype: req.file.mimetype,
        size: req.file.size,
      },
    });
  } catch (e) {
    console.error(e);
    return res.status(500).json({ ok: false, error: "upload-audio failed", detail: e.message });
  }
});

app.use((err, req, res, next) => {
  if (err instanceof multer.MulterError) {
    return res.status(400).json({
      ok: false,
      error: "upload failed",
      detail: err.message,
      code: err.code,
    });
  }
  return next(err);
});

/**
 * STT 실행
 * POST /api/session/:sessionId/stt
 */
app.post("/api/session/:sessionId/stt", async (req, res) => {
  try {
    const { sessionId } = req.params;
    const result = await runSTT(sessionId);
    return res.json({ ok: true, ...result });
  } catch (e) {
    console.error(e);
    return res.status(500).json({
      ok: false,
      error: "STT failed",
      detail: e?.message || String(e),
    });
  }
});

/**
 * 씬 생성
 * POST /api/session/:sessionId/scenes
 */
app.post("/api/session/:sessionId/scenes", async (req, res) => {
  try {
    const { sessionId } = req.params;
    const result = await generateScenes(sessionId);
    return res.json({ ok: true, ...result });
  } catch (e) {
    console.error(e);
    return res.status(500).json({
      ok: false,
      error: "scenes generation failed",
      detail: e?.message || String(e),
    });
  }
});

/**
 * 이미지 생성
 * POST /api/session/:sessionId/run-images
 */
app.post("/api/session/:sessionId/run-images", async (req, res) => {
  try {
    const { sessionId } = req.params;
    const out = await runImageScenes(sessionId);
    return res.json({
      ok: true,
      sessionId,
      resultsPath: out.outPath,
      resultsCount: out.results.length,
      results: out.results,
    });
  } catch (e) {
    console.error(e);
    return res.status(500).json({
      ok: false,
      error: "run-images failed",
      detail: e?.message || String(e),
    });
  }
});

/**
 * 비디오 생성
 * POST /api/session/:sessionId/run-videos
 */
app.post("/api/session/:sessionId/run-videos", async (req, res) => {
  try {
    const { sessionId } = req.params;
    const out = await runVideoScenes(sessionId);
    return res.json({
      ok: true,
      sessionId,
      resultsPath: out.outPath,
      resultsCount: out.results.length,
      results: out.results,
    });
  } catch (e) {
    console.error(e);
    return res.status(500).json({
      ok: false,
      error: "run-videos failed",
      detail: e?.message || String(e),
    });
  }
});

/**
 * 비디오 합성
 * POST /api/session/:sessionId/concat-videos
 */
app.post("/api/session/:sessionId/concat-videos", async (req, res) => {
  try {
    const { sessionId } = req.params;
    const result = await concatVideos(sessionId);
    return res.json({ ok: true, ...result });
  } catch (e) {
    console.error(e);
    return res.status(500).json({
      ok: false,
      error: "concat-videos failed",
      detail: e?.message || String(e),
    });
  }
});

/**
 * 비디오 플레이리스트 조회
 * GET /api/session/:sessionId/videos-playlist
 */
app.get("/api/session/:sessionId/videos-playlist", (req, res) => {
  try {
    const { sessionId } = req.params;
    const sessionPath = path.join(SESSIONS_DIR, sessionId);
    if (!fs.existsSync(sessionPath)) {
      return res.status(404).json({ ok: false, error: "Session folder not found", sessionPath });
    }

    const manifestPath = path.join(sessionPath, "videos_manifest.json");
    if (fs.existsSync(manifestPath)) {
      const manifest = JSON.parse(fs.readFileSync(manifestPath, "utf-8"));
      const items = Array.isArray(manifest.items) ? manifest.items : [];
      return res.json({
        ok: true,
        sessionId,
        mode: "manifest",
        items,
        manifestPath,
      });
    }

    const resultsPath = path.join(sessionPath, "comfy_results.json");
    if (!fs.existsSync(resultsPath)) {
      return res.status(400).json({ ok: false, error: "comfy_results.json not found" });
    }

    const results = JSON.parse(fs.readFileSync(resultsPath, "utf-8"));
    const items = Array.isArray(results)
      ? results
          .map((r) => {
            const info = r?.comfy_video;
            if (info?.filename) {
              const subfolder = (info.subfolder || "").replace(/\\/g, "/").replace(/^\/+|\/+$/g, "");
              const rel = [subfolder, info.filename].filter(Boolean).join("/");
              return {
                scene_id: r.scene_id,
                url: joinUrl(process.env.COMFY_STATIC_BASE || "http://143.248.107.38:8186", rel),
                source: "comfy_static",
              };
            }

            if (r?.video_path) {
              const filename = path.basename(r.video_path);
              return {
                scene_id: r.scene_id,
                url: `http://localhost:${PORT}/sessions/${sessionId}/videos/${filename}`,
                source: "local",
              };
            }
            return null;
          })
          .filter(Boolean)
      : [];

    return res.json({
      ok: true,
      sessionId,
      mode: "comfy_results",
      items,
      manifestHint: manifestPath,
    });
  } catch (e) {
    console.error(e);
    return res.status(500).json({
      ok: false,
      error: "videos-playlist failed",
      detail: e?.message || String(e),
    });
  }
});

/**
 * YouTube 검색
 * GET /api/youtube/search?q=검색어
 */
app.get("/api/youtube/search", async (req, res) => {
  try {
    const { q } = req.query;
    if (!q || !q.trim()) {
      return res.status(400).json({ ok: false, error: "검색어가 필요합니다" });
    }

    const { YOUTUBE_API_KEY } = await import("./config.js");
    if (!YOUTUBE_API_KEY) {
      return res.status(500).json({ ok: false, error: "YouTube API 키가 설정되지 않았습니다" });
    }

    const response = await fetch(
      `https://www.googleapis.com/youtube/v3/search?part=snippet&type=video&videoCategoryId=10&q=${encodeURIComponent(q.trim())}&maxResults=10&key=${YOUTUBE_API_KEY}`
    );

    if (!response.ok) {
      const errorData = await response.json().catch(() => ({}));
      throw new Error(errorData.error?.message || "YouTube 검색 실패");
    }

    const data = await response.json();
    const results = (data.items || []).map((item) => ({
      videoId: item.id.videoId,
      title: item.snippet.title,
      channelTitle: item.snippet.channelTitle,
      thumbnail: item.snippet.thumbnails?.default?.url || "",
    }));

    return res.json({ ok: true, results });
  } catch (e) {
    console.error("YouTube search error:", e);
    return res.status(500).json({ ok: false, error: e?.message || "검색 중 오류가 발생했습니다" });
  }
});

// ===============================
// Start server
// ===============================
console.log("✅ LOADED INDEX.JS - Refactored version");
app.listen(PORT, () => {
  console.log(`✅ Backend on http://localhost:${PORT}`);
  console.log(`✅ Sessions dir: ${SESSIONS_DIR}`);
});
