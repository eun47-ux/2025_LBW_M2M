// backend/index.js (Node 18+/22, ESM)
import "dotenv/config";
import express from "express";
import cors from "cors";
import multer from "multer";
import fs from "fs";
import path from "path";
import axios from "axios";
import FormData from "form-data";
import sharp from "sharp";
import OpenAI from "openai";
import { fileURLToPath } from "url";
import { transcriptToScenes } from "./services/transcriptToScenes.js";
import { runAllScenes, runImageScenes, runVideoScenes } from "./scripts/runAllScenes.js";
import { concatVideos } from "./services/concatVideos.js";
import { downloadComfyFile, safeSceneFilename, waitForVideoOutput } from "./services/comfyVideo.js";



// ===============================
// 0) ESM __dirname
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// ===============================
// 1) Config
const PORT = 3001;
const COMFY = "http://143.248.107.38:8188";
const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

// ✅ 너 프로젝트 구조: 루트에 data/sessions
// backend/.. -> mvp-service/ , 거기서 data/sessions
const SESSIONS_DIR = path.join(__dirname, "..", "data", "sessions");
fs.mkdirSync(SESSIONS_DIR, { recursive: true });

// ===============================
// 2) Express app (🔥 app 먼저!)
const app = express();
app.use(cors());
app.use(express.json());
app.use("/sessions", express.static(SESSIONS_DIR));

// multer temp upload
const upload = multer({ dest: "tmp/" });
// 오디오용: 파일이 커질 수 있으니 디스크로 받기
const uploadAudio = multer({
  dest: "tmp/",
  limits: { fileSize: 300 * 1024 * 1024 }, // 300MB
});


// ===============================
// 3) Utils
function ensureDir(p) {
  fs.mkdirSync(p, { recursive: true });
}

function safeSessionName(name) {
  const s = (name || "").trim();
  if (!s) return `session-${Date.now()}`;
  return s.replace(/[^a-zA-Z0-9-_]/g, "_");
}

function clamp(v, min, max) {
  return Math.max(min, Math.min(max, v));
}

// 세션 폴더에서 원본 이미지 파일 자동 탐색
function findOriginalImage(sessionPath) {
  const candidates = [
    "original.jpg",
    "original.jpeg",
    "original.png",
    "photo.jpg",
    "photo.jpeg",
    "photo.png",
  ];

  for (const c of candidates) {
    const p = path.join(sessionPath, c);
    if (fs.existsSync(p)) return p;
  }

  // 혹시 이름이 달라도 이미지가 1개라도 있으면 그걸 사용
  const files = fs.readdirSync(sessionPath);
  const anyImg = files.find((f) => /\.(jpg|jpeg|png)$/i.test(f));
  if (anyImg) return path.join(sessionPath, anyImg);

  return null;
}

// ===============================
// 4) Comfy upload (✅ 단 1개만 존재해야 함)
async function uploadImageToComfy(localPath, filename) {
  const form = new FormData();
  form.append("image", fs.createReadStream(localPath), filename);
  form.append("overwrite", "true");

  const res = await axios.post(`${COMFY}/upload/image`, form, {
    headers: form.getHeaders(),
    maxBodyLength: Infinity,
  });

  // 보통 { name, subfolder:"", type:"input" }
  return res.data;
}

// ===============================
// 5) Routes
app.get("/api/health", (req, res) => {
  res.json({ ok: true, COMFY, SESSIONS_DIR });
});

/**
 * (A) 프론트에서 "수동 크롭 이미지들 + owner 선택" 업로드
 * - 세션 폴더 생성
 * - session.json 저장
 * - (선택) 원본 사진 저장
 *
 * FormData:
 * - sessionName: string (옵션)
 * - photo: File (옵션/원본)
 * - crops: File[] (필수: 크롭 이미지들)
 * - ownerId: string (필수)  ← 프론트에서 owner crop의 id
 * - labelMap: JSON string   (예: {"A":"<idA>","B":"<idB>",...})
 * - cropMeta: JSON string   (여러 번 append됨) {id, rect:{x,y,width,height}}
 */



/**
 * ✅ 세션에 음성 업로드
 * POST /api/session/:sessionId/upload-audio
 * FormData:
 * - audio: File
 *
 * 저장:
 * data/sessions/<sessionId>/audio/recording.<ext>
 */
app.post(
  "/api/session/:sessionId/upload-audio",
  uploadAudio.single("audio"),
  async (req, res) => {
    try {
      const { sessionId } = req.params;

      if (!req.file) {
        return res.status(400).json({ ok: false, error: "audio file is required (field name: audio)" });
      }

      // ✅ 세션 폴더 (너는 루트에 data/sessions 쓰는 구조였지)
      // 지금 index.js에서 쓰는 sessions dir 변수를 그대로 사용해야 해.
      // (너가 지금 잘 동작시키고 있는) SESSIONS_DIR 또는 ROOT_SESSIONS_DIR 중
      // "실제 data/sessions"를 가리키는 걸 사용해.
      const sessionPath = path.join(SESSIONS_DIR, sessionId);
      if (!fs.existsSync(sessionPath)) {
        return res.status(404).json({ ok: false, error: "Session folder not found", sessionPath });
      }

      // audio 폴더 만들기
      const audioDir = path.join(sessionPath, "audio");
      fs.mkdirSync(audioDir, { recursive: true });

      // 확장자 추정
      const original = req.file.originalname || "recording";
      const ext = path.extname(original) || ".wav"; // 못 얻으면 wav로
      const outPath = path.join(audioDir, `recording${ext}`);

      // 저장 (tmp → session/audio)
      try {
        fs.renameSync(req.file.path, outPath);
      } catch {
        fs.copyFileSync(req.file.path, outPath);
        fs.unlinkSync(req.file.path);
      }

      // session.json에 오디오 경로 기록(선택)
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
  }
);
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
 * ✅ STT 실행: 세션 audio/recording.* → transcript.txt 생성
 * POST /api/session/:sessionId/stt
 */
app.post("/api/session/:sessionId/stt", async (req, res) => {
  try {
    const { sessionId } = req.params;

    const sessionPath = path.join(SESSIONS_DIR, sessionId);
    if (!fs.existsSync(sessionPath)) {
      return res.status(404).json({ ok: false, error: "Session folder not found", sessionPath });
    }

    // audio 파일 찾기
    const audioDir = path.join(sessionPath, "audio");
    if (!fs.existsSync(audioDir)) {
      return res.status(400).json({ ok: false, error: "audio folder not found", audioDir });
    }

    const audioFiles = fs
      .readdirSync(audioDir)
      .filter((f) => /\.(mp3|m4a|wav|webm|mp4|mpeg|mpga|ogg|flac)$/i.test(f));

    if (!audioFiles.length) {
      return res.status(400).json({ ok: false, error: "No audio file found in session/audio" });
    }

    // 가장 첫 파일을 사용 (우리는 recording.*로 저장했으니 보통 1개)
    const audioPath = path.join(audioDir, audioFiles[0]);

    // ✅ OpenAI Whisper STT
    const result = await openai.audio.transcriptions.create({
      file: fs.createReadStream(audioPath),
      model: "whisper-1",
      // 언어 지정하면 한국어 정확도/속도 도움이 됨 (혼합이면 지워도 됨)
      language: "ko",
      // 출력 포맷: text는 결과가 깔끔
      response_format: "text",
    });

    // result는 string (response_format:text)
    const transcriptText = typeof result === "string" ? result : String(result);

    const transcriptPath = path.join(sessionPath, "transcript.txt");
    fs.writeFileSync(transcriptPath, transcriptText, "utf-8");

    // session.json 업데이트(선택)
    const sessionJsonPath = path.join(sessionPath, "session.json");
    let session = {};
    if (fs.existsSync(sessionJsonPath)) {
      try {
        session = JSON.parse(fs.readFileSync(sessionJsonPath, "utf-8"));
      } catch {
        session = {};
      }
    }
    session.transcript = {
      filename: "transcript.txt",
      path: transcriptPath,
      createdAt: new Date().toISOString(),
      audioUsed: path.basename(audioPath),
    };
    fs.writeFileSync(sessionJsonPath, JSON.stringify(session, null, 2), "utf-8");

    return res.json({
      ok: true,
      sessionId,
      audioUsed: path.basename(audioPath),
      transcriptPath,
      preview: transcriptText.slice(0, 200),
    });
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
 * ✅ transcript.txt → scenes.json 생성
 * POST /api/session/:sessionId/scenes
 */
app.post("/api/session/:sessionId/scenes", async (req, res) => {
  try {
    const { sessionId } = req.params;

    const sessionPath = path.join(SESSIONS_DIR, sessionId);
    if (!fs.existsSync(sessionPath)) {
      return res.status(404).json({ ok: false, error: "Session folder not found", sessionPath });
    }

    const transcriptPath = path.join(sessionPath, "transcript.txt");
    if (!fs.existsSync(transcriptPath)) {
      return res.status(400).json({
        ok: false,
        error: "transcript.txt not found. Run STT first.",
        transcriptPath,
      });
    }

    const transcript = fs.readFileSync(transcriptPath, "utf-8");

    // participants는 labelMap 키에서 가져온다.
    const sessionJsonPath = path.join(sessionPath, "session.json");
    let session = {};
    if (fs.existsSync(sessionJsonPath)) {
      try {
        session = JSON.parse(fs.readFileSync(sessionJsonPath, "utf-8"));
      } catch {
        session = {};
      }
    }

    const labelMap = session.labelMap || {};
    const labels = Object.keys(labelMap); // 예: ["1","2","3"]
    const ownerLabel =
      labels.find((label) => labelMap[label] === session.ownerId) || labels[0] || "1";

    const participants = labels.length
      ? labels.sort((a, b) => Number(a) - Number(b) || a.localeCompare(b))
      : ["1", "2", "3"];

    const out = await transcriptToScenes({
      transcript,
      participants,
      ownerLabel,
      sessionPath,
    });

    // session.json 업데이트(선택)
    session.scenes = {
      filename: "scenes.json",
      path: out.scenesPath,
      createdAt: new Date().toISOString(),
      ownerLabel,
      participants,
    };
    fs.writeFileSync(sessionJsonPath, JSON.stringify(session, null, 2), "utf-8");

    const pairs = out.scenesJson?.pairs || [];
    const flatScenes = out.scenesJson?.scenes || [];
    const scenesPreviewCount = pairs.length
      ? pairs.reduce((acc, p) => acc + ((p.scenes || []).length), 0)
      : flatScenes.length;
    const scenesPreviewFirst = pairs.length
      ? (pairs.find((p) => (p.scenes || []).length)?.scenes || [])[0] || null
      : flatScenes[0] || null;

    return res.json({
      ok: true,
      sessionId,
      scenesPath: out.scenesPath,
      ownerLabel,
      participants,
      scenesPreviewCount,
      scenesPreviewFirst,
    });
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
 * ✅ scenes.json → ComfyUI 전체 실행
 * POST /api/session/:sessionId/run-all-scenes
 */
app.post("/api/session/:sessionId/run-all-scenes", async (req, res) => {
  try {
    const { sessionId } = req.params;

    const out = await runAllScenes(sessionId);

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
      error: "run-all-scenes failed",
      detail: e?.message || String(e),
    });
  }
});

/**
 * ✅ 이미지 생성만 실행 (m2m_image)
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
 * ✅ 영상 생성만 실행 (m2m_video)
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
 * ✅ Comfy mp4 다운로드 + final.mp4 합치기
 * POST /api/session/:sessionId/concat-videos
 */
app.post("/api/session/:sessionId/concat-videos", async (req, res) => {
  try {
    const { sessionId } = req.params;
    const sessionPath = path.join(SESSIONS_DIR, sessionId);
    if (!fs.existsSync(sessionPath)) {
      return res.status(404).json({ ok: false, error: "Session folder not found", sessionPath });
    }

    const resultsPath = path.join(sessionPath, "comfy_results.json");
    if (!fs.existsSync(resultsPath)) {
      return res.status(400).json({ ok: false, error: "comfy_results.json not found" });
    }

    const results = JSON.parse(fs.readFileSync(resultsPath, "utf-8"));
    if (!Array.isArray(results) || results.length === 0) {
      return res.status(400).json({ ok: false, error: "No results in comfy_results.json" });
    }

    const videosDir = path.join(sessionPath, "videos");
    fs.mkdirSync(videosDir, { recursive: true });

    const downloaded = [];
    for (const item of results) {
      const promptId = item.video_prompt_id || item.prompt_id;
      if (!promptId) continue;

      const videos = await waitForVideoOutput(COMFY, promptId, 300000);
      if (!videos.length) {
        return res.status(500).json({
          ok: false,
          error: "No video output found for prompt",
          promptId,
        });
      }

      const videoInfo = videos[0];
      const filename = safeSceneFilename(item.scene_id, promptId);
      const localPath = path.join(videosDir, filename);
      await downloadComfyFile(COMFY, videoInfo, localPath);

      downloaded.push({
        scene_id: item.scene_id,
        prompt_id: promptId,
        filename,
        path: localPath,
        source: videoInfo,
      });
    }

    const finalPath = path.join(sessionPath, "final.mp4");
    await concatVideos(
      downloaded.map((d) => d.path),
      finalPath
    );

    return res.json({
      ok: true,
      sessionId,
      videosDir,
      finalPath,
      count: downloaded.length,
      videos: downloaded,
    });
  } catch (e) {
    console.error(e);
    return res.status(500).json({
      ok: false,
      error: "concat-videos failed",
      detail: e?.message || String(e),
    });
  }
});

app.post(
  "/api/session/manual-crops",
  upload.fields([
    { name: "photo", maxCount: 1 },
    { name: "crops", maxCount: 50 },
  ]),
  async (req, res) => {
    try {
      const sessionName = safeSessionName(req.body.sessionName);
      const sessionId = `${sessionName}-${Date.now()}`;
      const sessionPath = path.join(SESSIONS_DIR, sessionId);

      ensureDir(sessionPath);
      ensureDir(path.join(sessionPath, "uploads"));

      const ownerId = req.body.ownerId || null;

      let labelMap = {};
      try {
        labelMap = req.body.labelMap ? JSON.parse(req.body.labelMap) : {};
      } catch {
        labelMap = {};
      }

      // cropMeta는 여러 개가 올 수 있음
      let cropMetaArr = [];
      if (req.body.cropMeta) {
        if (Array.isArray(req.body.cropMeta)) {
          cropMetaArr = req.body.cropMeta
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
            cropMetaArr = [JSON.parse(req.body.cropMeta)];
          } catch {
            cropMetaArr = [];
          }
        }
      }

      const photoFile = req.files?.photo?.[0] || null;
      const cropFiles = req.files?.crops || [];

      if (!ownerId) {
        return res.status(400).json({ ok: false, error: "ownerId is required" });
      }
      if (!cropFiles.length) {
        return res.status(400).json({ ok: false, error: "crops[] is required (at least 1)" });
      }

      // 1) 원본 저장(있으면)
      let originalSavedName = null;
      if (photoFile) {
        const ext = path.extname(photoFile.originalname || ".jpg") || ".jpg";
        const dst = path.join(sessionPath, `original${ext}`);
        fs.copyFileSync(photoFile.path, dst);
        originalSavedName = path.basename(dst);
      }

      // 2) 크롭 파일들 저장
      const savedCrops = [];
      for (let i = 0; i < cropFiles.length; i++) {
        const f = cropFiles[i];
        const ext = path.extname(f.originalname || ".png") || ".png";
        const dst = path.join(
          sessionPath,
          "uploads",
          `crop_${String(i + 1).padStart(2, "0")}${ext}`
        );
        fs.copyFileSync(f.path, dst);
        savedCrops.push({ idx: i, localPath: dst, filename: path.basename(dst) });
      }

      // 3) session.json 저장
      const sessionJson = {
        sessionId,
        sessionName,
        ownerId,
        labelMap,
        cropMetaArr,
        originalSavedName, // original.jpg/png 파일명
      };

      fs.writeFileSync(
        path.join(sessionPath, "session.json"),
        JSON.stringify(sessionJson, null, 2),
        "utf-8"
      );

      // 4) tmp 삭제
      if (photoFile?.path && fs.existsSync(photoFile.path)) fs.unlinkSync(photoFile.path);
      for (const f of cropFiles) {
        if (f?.path && fs.existsSync(f.path)) fs.unlinkSync(f.path);
      }

      return res.json({
        ok: true,
        sessionId,
        sessionPath,
        sessionJson,
        hint: "Next: POST /api/session/:sessionId/build-labels",
      });
    } catch (e) {
      console.error(e?.response?.data || e.message);
      return res.status(500).json({
        ok: false,
        error: "manual-crops failed",
        detail: e?.response?.data || e.message,
      });
    }
  }
);

/**
 * (B) session.json을 읽어서:
 * - 원본 이미지 + rect로 A/B/C... 크롭 생성
 * - ComfyUI에 업로드
 * - labels.json 생성
 *
 * POST /api/session/:sessionId/build-labels
 */
app.post("/api/session/:sessionId/build-labels", async (req, res) => {
  try {
    const { sessionId } = req.params;

    const sessionPath = path.join(SESSIONS_DIR, sessionId);
    const sessionJsonPath = path.join(sessionPath, "session.json");

    if (!fs.existsSync(sessionPath)) {
      return res.status(404).json({ ok: false, error: "Session folder not found", sessionPath });
    }
    if (!fs.existsSync(sessionJsonPath)) {
      return res.status(404).json({ ok: false, error: "session.json not found", sessionJsonPath });
    }

    const session = JSON.parse(fs.readFileSync(sessionJsonPath, "utf-8"));
    const labelMap = session.labelMap || {};
    const cropMetaArr = session.cropMetaArr || [];

    if (!Object.keys(labelMap).length || !cropMetaArr.length) {
      return res.status(400).json({
        ok: false,
        error: "labelMap or cropMetaArr missing in session.json",
      });
    }

    // 원본 이미지 찾기
    const originalPath = findOriginalImage(sessionPath);
    if (!originalPath) {
      return res.status(400).json({
        ok: false,
        error: "Original image file not found in session folder",
        hint:
          "세션 폴더에 original.jpg/png가 있어야 해요. manual-crops에서 photo를 같이 보내면 자동 저장됩니다.",
        sessionPath,
      });
    }

    // id -> rect map
    const idToRect = {};
    for (const item of cropMetaArr) {
      if (item?.id && item?.rect) idToRect[item.id] = item.rect;
    }

    // 원본 메타
    const meta = await sharp(originalPath).metadata();
    const imgW = meta.width;
    const imgH = meta.height;

    if (!imgW || !imgH) {
      return res.status(400).json({ ok: false, error: "Cannot read original image metadata" });
    }

    // 출력 폴더
    const cropsDir = path.join(sessionPath, "crops");
    ensureDir(cropsDir);

    const labels = {}; // { A: "A.png", B:"B.png", ... } (Comfy input filename)
    const debug = [];

    // 라벨(A/B/C..)별로 크롭 -> Comfy 업로드
    for (const [label, cropId] of Object.entries(labelMap)) {
      const rect = idToRect[cropId];
      if (!rect) continue;

      const left = clamp(Math.floor(rect.x), 0, imgW - 1);
      const top = clamp(Math.floor(rect.y), 0, imgH - 1);
      const width = clamp(Math.floor(rect.width), 1, imgW - left);
      const height = clamp(Math.floor(rect.height), 1, imgH - top);

      const outName = `${label}.png`;
      const outPath = path.join(cropsDir, outName);

      await sharp(originalPath)
        .extract({ left, top, width, height })
        .png()
        .toFile(outPath);

      // Comfy 업로드
      const comfyRes = await uploadImageToComfy(outPath, outName);

      const comfyFilename =
        comfyRes.subfolder && comfyRes.subfolder.length > 0
          ? `${comfyRes.subfolder}/${comfyRes.name}`
          : comfyRes.name;

      labels[label] = comfyFilename;

      debug.push({
        label,
        cropId,
        rect: { left, top, width, height },
        localCrop: `crops/${outName}`,
        comfyFilename,
        comfyRes,
      });
    }

    const labelsPath = path.join(sessionPath, "labels.json");
    fs.writeFileSync(labelsPath, JSON.stringify(labels, null, 2), "utf-8");

    return res.json({
      ok: true,
      sessionId,
      originalPath,
      labelsPath,
      labels,
      debug,
      hint: "Now run runOnce.js (it should read labels.json) and call Comfy /prompt.",
    });
  } catch (e) {
    console.error(e?.response?.data || e.message);
    return res.status(500).json({
      ok: false,
      error: "build-labels failed",
      detail: e?.response?.data || e.message,
    });
  }
});

// ===============================
// 6) Start server
console.log("✅ LOADED INDEX.JS VERSION: build-labels route enabled");
app.listen(PORT, () => {
  console.log(`✅ Backend on http://localhost:${PORT}`);
  console.log(`✅ Sessions dir: ${SESSIONS_DIR}`);
  console.log(`✅ ComfyUI: ${COMFY}`);
});
