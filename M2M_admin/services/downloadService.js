// M2M_admin/services/downloadService.js
import fs from "fs";
import path from "path";
import axios from "axios";
import { ADMIN_SESSIONS_DIR } from "../config.js";
import { getComfyResults, getImageUrls, getVideoUrls } from "./firestoreService.js";

/**
 * 세션 폴더 생성
 */
function ensureSessionDir(sessionId) {
  const sessionDir = path.join(ADMIN_SESSIONS_DIR, sessionId);
  fs.mkdirSync(sessionDir, { recursive: true });
  fs.mkdirSync(path.join(sessionDir, "images"), { recursive: true });
  fs.mkdirSync(path.join(sessionDir, "videos"), { recursive: true });
  return sessionDir;
}

/**
 * URL에서 파일 다운로드
 */
async function downloadFile(url, destPath) {
  const response = await axios.get(url, { responseType: "stream", timeout: 120000 });
  await new Promise((resolve, reject) => {
    const writer = fs.createWriteStream(destPath);
    response.data.pipe(writer);
    writer.on("finish", resolve);
    writer.on("error", reject);
  });
  return destPath;
}

/**
 * DB에서 세션 데이터 로드
 */
export async function loadSessionFromDB(sessionId) {
  const sessionDir = ensureSessionDir(sessionId);

  // 1. comfy_results.json 다운로드
  const comfyResults = await getComfyResults(sessionId);
  if (!comfyResults) {
    throw new Error(`comfy_results.json not found in DB for session ${sessionId}`);
  }

  const comfyResultsPath = path.join(sessionDir, "comfy_results.json");
  fs.writeFileSync(comfyResultsPath, JSON.stringify(comfyResults, null, 2), "utf-8");

  // 2. 이미지 URL 가져오기 및 다운로드
  const imageUrls = await getImageUrls(sessionId);
  const downloadedImages = [];
  
  for (const [sceneId, imageUrl] of Object.entries(imageUrls)) {
    if (!imageUrl) continue;
    try {
      const imagePath = path.join(sessionDir, "images", `${sceneId}.png`);
      await downloadFile(imageUrl, imagePath);
      downloadedImages.push({ sceneId, path: imagePath, url: imageUrl });
      console.log(`✅ 이미지 다운로드: ${sceneId} → ${imagePath}`);
    } catch (err) {
      console.warn(`⚠️ 이미지 다운로드 실패 (${sceneId}): ${err.message}`);
    }
  }

  // 3. 비디오 URL 가져오기 (다운로드는 하지 않음, 미리보기용)
  const videoUrls = await getVideoUrls(sessionId);

  return {
    sessionId,
    sessionDir,
    comfyResults,
    comfyResultsPath,
    imageUrls,
    videoUrls,
    downloadedImages,
  };
}
