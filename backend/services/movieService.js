// backend/services/movieService.js
import fs from "fs";
import path from "path";
import axios from "axios";
import { spawn } from "child_process";
import { SESSIONS_DIR, COMFY_URL, COMFY_STATIC_BASE } from "../config.js";
import { waitForVideoOutput, downloadComfyFile, downloadComfyStaticFile, safeSceneFilename } from "./comfyVideo.js";

function loadJson(p) {
  return JSON.parse(fs.readFileSync(p, "utf-8"));
}

function joinUrl(base, subpath) {
  const cleanBase = (base || "").replace(/\/+$/, "");
  const cleanPath = (subpath || "").replace(/^\/+/, "");
  return `${cleanBase}/${cleanPath}`;
}

/**
 * 비디오 파일들을 하나로 합성 (ffmpeg 사용)
 */
async function concatVideoFiles(videoPaths, outPath) {
  if (!Array.isArray(videoPaths) || videoPaths.length === 0) {
    throw new Error("videoPaths must be a non-empty array");
  }

  const concatListPath = path.join(path.dirname(outPath), "concat.txt");
  const listContent = videoPaths
    .map((p) => `file '${p.replace(/'/g, "'\\''")}'`)
    .join("\n");
  fs.writeFileSync(concatListPath, listContent, "utf-8");

  await new Promise((resolve, reject) => {
    const proc = spawn(
      "ffmpeg",
      ["-y", "-f", "concat", "-safe", "0", "-i", concatListPath, "-c", "copy", outPath],
      { stdio: "inherit" }
    );
    proc.on("close", (code) => {
      if (code === 0) resolve();
      else reject(new Error(`ffmpeg exited with code ${code}`));
    });
    proc.on("error", reject);
  });

  return { outPath, concatListPath };
}

/**
 * 비디오 합성: 생성된 비디오들을 하나로 합성
 */
export async function concatVideos(sessionId) {
  const sessionPath = path.join(SESSIONS_DIR, sessionId);
  if (!fs.existsSync(sessionPath)) {
    throw new Error(`Session folder not found: ${sessionPath}`);
  }

  const resultsPath = path.join(sessionPath, "comfy_results.json");
  if (!fs.existsSync(resultsPath)) {
    throw new Error("comfy_results.json not found");
  }

  const results = loadJson(resultsPath);
  if (!Array.isArray(results) || results.length === 0) {
    throw new Error("No results in comfy_results.json");
  }

  const videosDir = path.join(sessionPath, "videos");
  fs.mkdirSync(videosDir, { recursive: true });

  // Firestore에서 최신 비디오 URL 가져오기
  let firestoreVideoUrls = {};
  try {
    const { getVideoUrls } = await import("./firestoreService.js");
    firestoreVideoUrls = await getVideoUrls(sessionId);
    console.log(`✅ Firestore에서 비디오 URL ${Object.keys(firestoreVideoUrls).length}개 로드`);
  } catch (e) {
    console.warn(`⚠️ Firestore에서 비디오 URL 가져오기 실패: ${e.message}`);
  }

  const downloaded = [];
  for (const item of results) {
    const promptId = item.video_prompt_id || item.prompt_id;
    if (!promptId) continue;

    // 이미 다운로드된 비디오가 있으면 사용
    if (item.video_path && fs.existsSync(item.video_path)) {
      downloaded.push({
        scene_id: item.scene_id,
        prompt_id: promptId,
        filename: path.basename(item.video_path),
        path: item.video_path,
        source: "existing",
      });
      continue;
    }

    // Firestore에 최신 비디오 URL이 있으면 우선 사용
    const firestoreUrl = firestoreVideoUrls[item.scene_id];
    if (firestoreUrl) {
      try {
        const filename = safeSceneFilename(item.scene_id, promptId);
        const localPath = path.join(videosDir, filename);
        
        // Firestore URL에서 직접 다운로드
        const response = await axios.get(firestoreUrl, { responseType: "stream", timeout: 120000 });
        await new Promise((resolve, reject) => {
          const writer = fs.createWriteStream(localPath);
          response.data.pipe(writer);
          writer.on("finish", resolve);
          writer.on("error", reject);
        });
        
        console.log(`✅ Firestore URL에서 비디오 다운로드: ${item.scene_id} → ${localPath}`);
        downloaded.push({
          scene_id: item.scene_id,
          prompt_id: promptId,
          filename,
          path: localPath,
          source: "firestore",
        });
        continue;
      } catch (err) {
        console.warn(`⚠️ Firestore URL 다운로드 실패 (${item.scene_id}): ${err.message}, comfy_video로 fallback`);
      }
    }

    // Firestore URL이 없거나 실패하면 comfy_video 사용
    let videoInfo = item.comfy_video;
    if (!videoInfo) {
      // comfy_video가 없으면 history에서 조회
      const videos = await waitForVideoOutput(COMFY_URL, promptId, 300000);
      if (!videos.length) {
        console.warn(`⚠️ No video output found for prompt ${promptId}`);
        continue;
      }
      videoInfo = videos[0];
    }

    // 비디오 다운로드
    const filename = safeSceneFilename(item.scene_id, promptId);
    const localPath = path.join(videosDir, filename);

    if (COMFY_STATIC_BASE) {
      await downloadComfyStaticFile(COMFY_STATIC_BASE, videoInfo, localPath);
    } else {
      await downloadComfyFile(COMFY_URL, videoInfo, localPath);
    }

    downloaded.push({
      scene_id: item.scene_id,
      prompt_id: promptId,
      filename,
      path: localPath,
      source: videoInfo,
    });
  }

  if (downloaded.length === 0) {
    throw new Error("No videos to concatenate");
  }

  // 비디오 합성
  const finalPath = path.join(sessionPath, "final.mp4");
  await concatVideoFiles(
    downloaded.map((d) => d.path),
    finalPath
  );

  return {
    sessionId,
    videosDir,
    finalPath,
    count: downloaded.length,
    videos: downloaded,
    downloadBase: COMFY_STATIC_BASE || COMFY_URL,
  };
}
