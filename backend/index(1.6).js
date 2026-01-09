// backend/index.js
import express from "express";
import cors from "cors";
import multer from "multer";
import fs from "fs";
import path from "path";
import axios from "axios";
import FormData from "form-data";
import sharp from "sharp";
import { fileURLToPath } from "url";

const app = express();
app.use(cors());
app.use(express.json());

// =========================
// ESM: __dirname 만들기
// =========================
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// =========================
// Storage
// =========================
const SESSIONS_DIR = path.join(__dirname, "..", "data", "sessions");
fs.mkdirSync(SESSIONS_DIR, { recursive: true });

const upload = multer({ dest: path.join(__dirname, "tmp") });

// =========================
// ComfyUI
// =========================
const COMFY = "http://143.248.107.38:8188";

// ComfyUI 업로드
async function uploadImageToComfy(localPath, filename) {
  const form = new FormData();
  form.append("image", fs.createReadStream(localPath), filename);
  form.append("overwrite", "true");

  const res = await axios.post(`${COMFY}/upload/image`, form, {
    headers: form.getHeaders(),
    maxBodyLength: Infinity,
  });

  return res.data; // { name, subfolder, type }
}

// =========================
// Helpers
// =========================
function safeSessionName(name) {
  // 공백/한글/특수문자 제거 -> 실험 안정성
  const cleaned = (name || "").replace(/[^a-zA-Z0-9_-]/g, "");
  return cleaned || `session_${Date.now()}`;
}

function clamp(v, min, max) {
  return Math.max(min, Math.min(max, v));
}

function makeLabelMapFromOwner(boxes, ownerBoxIndex) {
  // 좌→우 정렬 (xCenter)
  const indexed = boxes.map((b, i) => ({
    i,
    xCenter: b.x + b.w / 2,
  }));
  indexed.sort((a, b) => a.xCenter - b.xCenter);

  const sortedIds = indexed.map((x) => x.i);

  const labelOrder = ["A", "B", "C", "D", "E", "F"];
  const labelMap = {};

  // owner는 B 고정
  labelMap["B"] = ownerBoxIndex;

  const others = sortedIds.filter((id) => id !== ownerBoxIndex);
  const otherLabels = labelOrder.filter((l) => l !== "B");

  for (let k = 0; k < Math.min(others.length, otherLabels.length); k++) {
    labelMap[otherLabels[k]] = others[k];
  }

  return labelMap;
}

function expandBox(box, imgW, imgH, pad) {
  const { x, y, w, h } = box;

  const padL = w * pad.left;
  const padR = w * pad.right;
  const padT = h * pad.top;
  const padB = h * pad.bottom;

  const x1 = clamp(Math.floor(x - padL), 0, imgW - 1);
  const y1 = clamp(Math.floor(y - padT), 0, imgH - 1);
  const x2 = clamp(Math.ceil(x + w + padR), 0, imgW);
  const y2 = clamp(Math.ceil(y + h + padB), 0, imgH);

  return { left: x1, top: y1, width: x2 - x1, height: y2 - y1 };
}

// =========================
// Routes
// =========================

// 0) 테스트: ComfyUI 업로드만
app.post("/api/test-upload", upload.single("photo"), async (req, res) => {
  try {
    const localPath = req.file.path;
    const originalName = req.file.originalname || "upload.jpg";

    const result = await uploadImageToComfy(localPath, originalName);

    fs.unlinkSync(localPath);
    res.json({ ok: true, comfyUploadResult: result });
  } catch (e) {
    console.error(e?.response?.data || e.message);
    res.status(500).json({
      ok: false,
      error: "Upload to ComfyUI failed",
      detail: e?.response?.data || e.message,
    });
  }
});

// 1) 세션 시작 (프론트에서 이름 지정)
app.post("/api/session/start", (req, res) => {
  const { sessionName } = req.body || {};
  const sessionId = safeSessionName(sessionName);
  const sessionPath = path.join(SESSIONS_DIR, sessionId);

  fs.mkdirSync(sessionPath, { recursive: true });
  res.json({ sessionId });
});

// 2) 사진 + boxes + owner 저장
app.post("/api/session/:sessionId/photo", upload.single("photo"), (req, res) => {
  try {
    const { sessionId } = req.params;
    const sessionPath = path.join(SESSIONS_DIR, sessionId);
    fs.mkdirSync(sessionPath, { recursive: true });

    const photoPath = path.join(sessionPath, "original.jpg");
    fs.renameSync(req.file.path, photoPath);

    const boxesJson = req.body.boxesJson ?? "[]";
    const ownerBoxIndex = Number(req.body.ownerBoxIndex);

    fs.writeFileSync(path.join(sessionPath, "boxes.json"), boxesJson, "utf-8");
    fs.writeFileSync(
      path.join(sessionPath, "owner.json"),
      JSON.stringify({ ownerBoxIndex }, null, 2),
      "utf-8"
    );

    res.json({ ok: true });
  } catch (e) {
    console.error(e);
    res.status(500).json({ ok: false, error: "save photo failed", detail: e.message });
  }
});

// 3) 크롭 생성 (머리+옷 포함 padding)
app.post("/api/session/:sessionId/crops", async (req, res) => {
  try {
    const { sessionId } = req.params;
    const sessionPath = path.join(SESSIONS_DIR, sessionId);

    const photoPath = path.join(sessionPath, "original.jpg");
    const boxesPath = path.join(sessionPath, "boxes.json");
    const ownerPath = path.join(sessionPath, "owner.json");

    if (!fs.existsSync(photoPath)) {
      return res.status(400).json({ ok: false, error: "original.jpg not found" });
    }
    if (!fs.existsSync(boxesPath) || !fs.existsSync(ownerPath)) {
      return res.status(400).json({ ok: false, error: "boxes.json or owner.json not found" });
    }

    const boxes = JSON.parse(fs.readFileSync(boxesPath, "utf-8"));
    const { ownerBoxIndex } = JSON.parse(fs.readFileSync(ownerPath, "utf-8"));

    const meta = await sharp(photoPath).metadata();
    const imgW = meta.width;
    const imgH = meta.height;

    // ✅ 머리+옷 포함 (필요하면 조절)
    const pad = { left: 0.15, right: 0.15, top: 0.20, bottom: 0.35 };

    const labelMap = makeLabelMapFromOwner(boxes, ownerBoxIndex);

    const cropsDir = path.join(sessionPath, "crops");
    fs.mkdirSync(cropsDir, { recursive: true });

    const outputs = [];

    for (const [label, boxIdx] of Object.entries(labelMap)) {
      const b = boxes[boxIdx];
      if (!b) continue;

      const rect = expandBox(b, imgW, imgH, pad);

      const outName = `${label}.png`;
      const outPath = path.join(cropsDir, outName);

      await sharp(photoPath).extract(rect).png().toFile(outPath);

      outputs.push({
        label,
        box_index: boxIdx,
        crop_url: `/sessions/${sessionId}/crops/${outName}`,
        rect,
      });
    }

    fs.writeFileSync(path.join(sessionPath, "label_map.json"), JSON.stringify(labelMap, null, 2));
    res.json({ ok: true, labelMap, crops: outputs });
  } catch (e) {
    console.error(e);
    res.status(500).json({ ok: false, error: "crop generation failed", detail: e.message });
  }
});

// 4) 세션 폴더 안 파일들을 브라우저에서 볼 수 있게 정적 서빙
app.use("/sessions", express.static(SESSIONS_DIR));

// =========================
// Run
// =========================
app.listen(3001, () => console.log("✅ Backend on http://localhost:3001"));
