// M2M_admin/services/downloadService.js
import fs from "fs";
import path from "path";
import axios from "axios";
import { ADMIN_SESSIONS_DIR } from "../config.js";
import { getComfyResults, getImageUrls, getVideoUrls, getScenes } from "./firestoreService.js";

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
 * comfy_results.json은 로딩하지 않고 이미지/비디오 URL만 로딩
 */
export async function loadSessionFromDB(sessionId) {
  const sessionDir = ensureSessionDir(sessionId);

  // 1. scenes.json 다운로드
  let scenesJson = null;
  try {
    scenesJson = await getScenes(sessionId);
    if (scenesJson) {
      const scenesPath = path.join(sessionDir, "scenes.json");
      fs.writeFileSync(scenesPath, JSON.stringify(scenesJson, null, 2), "utf-8");
      console.log(`✅ scenes.json 다운로드 완료: ${scenesPath}`);
    } else {
      console.warn(`⚠️ scenes.json이 DB에 없습니다.`);
    }
  } catch (err) {
    console.warn(`⚠️ scenes.json 다운로드 실패: ${err.message}`);
  }

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

  // scenes.json, 이미지, 비디오 중 하나라도 있어야 함
  if (!scenesJson && downloadedImages.length === 0 && Object.keys(videoUrls).length === 0) {
    throw new Error(`세션 ${sessionId}에 로딩할 데이터가 없습니다. (scenes.json, 이미지, 비디오 모두 없음)`);
  }

  return {
    sessionId,
    sessionDir,
    scenesJson,
    imageUrls,
    videoUrls,
    downloadedImages,
  };
}
