// backend/services/sessionService.js
import fs from "fs";
import path from "path";
import sharp from "sharp";
import axios from "axios";
import FormData from "form-data";
import { SESSIONS_DIR, COMFY_URL } from "../config.js";
import { fileURLToPath } from "url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// 유틸리티 함수
function ensureDir(p) {
  fs.mkdirSync(p, { recursive: true });
}

function clamp(v, min, max) {
  return Math.max(min, Math.min(max, v));
}

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

async function uploadImageToComfy(localPath, filename) {
  const form = new FormData();
  form.append("image", fs.createReadStream(localPath), filename);
  form.append("overwrite", "true");

  const res = await axios.post(`${COMFY_URL}/upload/image`, form, {
    headers: form.getHeaders(),
    maxBodyLength: Infinity,
  });

  const data = res.data || {};
  if (data.subfolder && data.subfolder.length > 0) {
    return `${data.subfolder}/${data.name}`;
  }
  return data.name || filename;
}

/**
 * 세션 생성
 */
export function createSession(sessionId) {
  const sessionPath = path.join(SESSIONS_DIR, sessionId);
  ensureDir(sessionPath);
  ensureDir(path.join(sessionPath, "uploads"));

  const sessionJson = {
    sessionId,
    createdAt: new Date().toISOString(),
  };

  const sessionJsonPath = path.join(sessionPath, "session.json");
  fs.writeFileSync(sessionJsonPath, JSON.stringify(sessionJson, null, 2), "utf-8");

  return { sessionId, sessionPath, sessionJson };
}

/**
 * 세션 조회
 */
export function getSession(sessionId) {
  const sessionPath = path.join(SESSIONS_DIR, sessionId);
  const sessionJsonPath = path.join(sessionPath, "session.json");

  if (!fs.existsSync(sessionPath)) {
    throw new Error(`Session folder not found: ${sessionPath}`);
  }

  if (!fs.existsSync(sessionJsonPath)) {
    return { sessionId, sessionPath, data: {} };
  }

  try {
    const data = JSON.parse(fs.readFileSync(sessionJsonPath, "utf-8"));
    return { sessionId, sessionPath, data };
  } catch (e) {
    return { sessionId, sessionPath, data: {} };
  }
}

/**
 * 세션 업데이트 (크롭 정보 저장)
 */
export function updateSession(sessionId, { ownerId, labelMap, cropMetaArr, photoFile, cropFiles }) {
  const sessionPath = path.join(SESSIONS_DIR, sessionId);
  if (!fs.existsSync(sessionPath)) {
    throw new Error(`Session folder not found: ${sessionPath}`);
  }

  ensureDir(path.join(sessionPath, "uploads"));

  // 원본 이미지 저장
  let originalSavedName = null;
  if (photoFile) {
    const ext = path.extname(photoFile.originalname || ".jpg") || ".jpg";
    const dst = path.join(sessionPath, `original${ext}`);
    fs.copyFileSync(photoFile.path, dst);
    originalSavedName = path.basename(dst);
  }

  // 크롭 파일들 저장
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

  session.ownerId = ownerId;
  session.labelMap = labelMap || {};
  session.cropMetaArr = cropMetaArr || [];
  session.originalSavedName = originalSavedName;
  session.updatedAt = new Date().toISOString();

  fs.writeFileSync(sessionJsonPath, JSON.stringify(session, null, 2), "utf-8");

  // 임시 파일 삭제
  if (photoFile?.path && fs.existsSync(photoFile.path)) fs.unlinkSync(photoFile.path);
  for (const f of cropFiles) {
    if (f?.path && fs.existsSync(f.path)) fs.unlinkSync(f.path);
  }

  return { sessionId, sessionPath, session };
}

/**
 * 크롭 추출 + ComfyUI 업로드 + labels.json 생성
 */
export async function buildLabels(sessionId) {
  const { sessionPath, data: session } = getSession(sessionId);

  const labelMap = session.labelMap || {};
  const cropMetaArr = session.cropMetaArr || [];

  if (!Object.keys(labelMap).length || !cropMetaArr.length) {
    throw new Error("labelMap or cropMetaArr missing in session.json");
  }

  // 원본 이미지 찾기
  const originalPath = findOriginalImage(sessionPath);
  if (!originalPath) {
    throw new Error("Original image file not found in session folder");
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
    throw new Error("Cannot read original image metadata");
  }

  // 출력 폴더
  const cropsDir = path.join(sessionPath, "crops");
  ensureDir(cropsDir);

  const labels = {}; // { "1": "1.png", "2": "2.png", ... } (Comfy input filename)

  // 라벨별로 크롭 -> Comfy 업로드
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
    const comfyFilename = await uploadImageToComfy(outPath, outName);
    labels[label] = comfyFilename;
  }

  // labels.json 저장
  const labelsPath = path.join(sessionPath, "labels.json");
  fs.writeFileSync(labelsPath, JSON.stringify(labels, null, 2), "utf-8");

  // session.json 업데이트
  const sessionJsonPath = path.join(sessionPath, "session.json");
  session.labels = {
    filename: "labels.json",
    path: labelsPath,
    createdAt: new Date().toISOString(),
  };
  fs.writeFileSync(sessionJsonPath, JSON.stringify(session, null, 2), "utf-8");

  return {
    sessionId,
    labelsPath,
    labels,
  };
}
