// backend/services/movieService.js
import fs from "fs";
import path from "path";
import axios from "axios";
import { spawn } from "child_process";
import { SESSIONS_DIR, COMFY_URL, COMFY_STATIC_BASE } from "../config.js";
import { waitForVideoOutput, downloadComfyFile, downloadComfyStaticFile, safeSceneFilename } from "./comfyVideo.js";

// ---- Intro/Outro config (original.png zoom) ----
const INTRO_OUTRO_DURATION_SEC = 1.5;
const INTRO_ZOOM_START = 1.0;
const INTRO_ZOOM_END = 1.2;
const OUTRO_ZOOM_START = 1.2;
const OUTRO_ZOOM_END = 1.0;

function loadJson(p) {
  return JSON.parse(fs.readFileSync(p, "utf-8"));
}

function joinUrl(base, subpath) {
  const cleanBase = (base || "").replace(/\/+$/, "");
  const cleanPath = (subpath || "").replace(/^\/+/, "");
  return `${cleanBase}/${cleanPath}`;
}

// ---- Helpers: original image + video meta ----
function findOriginalImage(sessionPath) {
  const candidates = [
    "original.png",
    "original.jpg",
    "original.jpeg",
    "photo.png",
    "photo.jpg",
    "photo.jpeg",
  ];

  const sessionJsonPath = path.join(sessionPath, "session.json");
  if (fs.existsSync(sessionJsonPath)) {
    try {
      const session = JSON.parse(fs.readFileSync(sessionJsonPath, "utf-8"));
      if (session.originalSavedName) {
        const p = path.join(sessionPath, session.originalSavedName);
        if (fs.existsSync(p)) return p;
      }
    } catch {
      // ignore malformed session.json
    }
  }

  for (const c of candidates) {
    const p = path.join(sessionPath, c);
    if (fs.existsSync(p)) return p;
  }

  return null;
}

function parseFps(rate) {
  if (!rate) return 30;
  if (typeof rate === "number") return rate;
  const [num, den] = String(rate).split("/").map(Number);
  if (!den || Number.isNaN(num) || Number.isNaN(den)) return Number(rate) || 30;
  return num / den;
}

async function getVideoMeta(videoPath) {
  const args = [
    "-v",
    "error",
    "-select_streams",
    "v:0",
    "-show_entries",
    "stream=width,height,r_frame_rate",
    "-of",
    "json",
    videoPath,
  ];

  const stdout = await new Promise((resolve, reject) => {
    const proc = spawn("ffprobe", args, { stdio: ["ignore", "pipe", "pipe"] });
    let out = "";
    let err = "";
    proc.stdout.on("data", (d) => {
      out += d.toString();
    });
    proc.stderr.on("data", (d) => {
      err += d.toString();
    });
    proc.on("close", (code) => {
      if (code === 0) resolve(out);
      else reject(new Error(`ffprobe failed: ${err || "unknown error"}`));
    });
    proc.on("error", reject);
  });

  const json = JSON.parse(stdout);
  const stream = (json.streams || [])[0] || {};
  const width = Number(stream.width) || 640;
  const height = Number(stream.height) || 360;
  const fps = parseFps(stream.r_frame_rate) || 30;
  return { width, height, fps };
}

async function createZoomClip({
  imagePath,
  outPath,
  width,
  height,
  fps,
  durationSec,
  zoomStart,
  zoomEnd,
}) {
  const totalFrames = Math.max(1, Math.round(fps * durationSec));
  const totalFramesForExpr = Math.max(1, totalFrames - 1);
  const zoomExpr = `if(lte(on\\,${totalFramesForExpr}),${zoomStart}+(${zoomEnd - zoomStart})*on/${totalFramesForExpr},${zoomEnd})`;
  // Letterbox to target size first, then zoom from center to avoid jitter.
  const filter = [
    `scale=${width}:${height}:force_original_aspect_ratio=decrease`,
    `pad=${width}:${height}:(ow-iw)/2:(oh-ih)/2:color=black`,
    // Round crop coords to avoid sub-pixel jitter while zooming.
    `zoompan=z='${zoomExpr}':x='trunc((iw - iw/zoom)/2)':y='trunc((ih - ih/zoom)/2)':d=${totalFrames}:s=${width}x${height}:fps=${fps}`,
  ].join(",");

  const args = [
    "-y",
    "-loop",
    "1",
    "-i",
    imagePath,
    "-t",
    String(durationSec),
    "-vf",
    filter,
    "-c:v",
    "libopenh264",
    "-pix_fmt",
    "yuv420p",
    outPath,
  ];

  await new Promise((resolve, reject) => {
    const proc = spawn("ffmpeg", args, { stdio: "inherit" });
    proc.on("close", (code) => {
      if (code === 0) resolve();
      else reject(new Error(`ffmpeg (zoom clip) exited with code ${code}`));
    });
    proc.on("error", reject);
  });

  return outPath;
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

// ---- Re-encode concat (used when intro/outro is present) ----
async function concatVideoFilesReencode(videoPaths, outPath, { width, height, fps }) {
  if (!Array.isArray(videoPaths) || videoPaths.length === 0) {
    throw new Error("videoPaths must be a non-empty array");
  }

  const concatListPath = path.join(path.dirname(outPath), "concat.txt");
  const listContent = videoPaths
    .map((p) => `file '${p.replace(/'/g, "'\\''")}'`)
    .join("\n");
  fs.writeFileSync(concatListPath, listContent, "utf-8");

  const filter = [`scale=${width}:${height}`, `fps=${fps}`].join(",");

  await new Promise((resolve, reject) => {
    const proc = spawn(
      "ffmpeg",
      [
        "-y",
        "-f",
        "concat",
        "-safe",
        "0",
        "-i",
        concatListPath,
        "-vf",
        filter,
        "-c:v",
        "libopenh264",
        "-pix_fmt",
        "yuv420p",
        outPath,
      ],
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

  // ---- Intro/Outro (original.png zoom in/out) ----
  let introPath = null;
  let outroPath = null;
  let concatMeta = null;
  let needsReencode = false;
  try {
    const originalPath = findOriginalImage(sessionPath);
    if (originalPath) {
      const meta = await getVideoMeta(downloaded[0].path);
      concatMeta = meta;
      introPath = path.join(videosDir, "intro.mp4");
      outroPath = path.join(videosDir, "outro.mp4");

      await createZoomClip({
        imagePath: originalPath,
        outPath: introPath,
        width: meta.width,
        height: meta.height,
        fps: meta.fps,
        durationSec: INTRO_OUTRO_DURATION_SEC,
        zoomStart: INTRO_ZOOM_START,
        zoomEnd: INTRO_ZOOM_END,
      });

      await createZoomClip({
        imagePath: originalPath,
        outPath: outroPath,
        width: meta.width,
        height: meta.height,
        fps: meta.fps,
        durationSec: INTRO_OUTRO_DURATION_SEC,
        zoomStart: OUTRO_ZOOM_START,
        zoomEnd: OUTRO_ZOOM_END,
      });

      // intro/outro is re-encoded, so concat needs re-encode for compatibility
      needsReencode = true;
    }
  } catch (e) {
    console.warn(`⚠️ intro/outro generation skipped: ${e.message}`);
    introPath = null;
    outroPath = null;
    concatMeta = null;
    needsReencode = false;
  }

  // ---- Video concat order: intro → scenes → outro ----
  const concatPaths = [];
  if (introPath) concatPaths.push(introPath);
  concatPaths.push(...downloaded.map((d) => d.path));
  if (outroPath) concatPaths.push(outroPath);

  // 비디오 합성
  const finalPath = path.join(sessionPath, "final.mp4");
  if (needsReencode && concatMeta) {
    await concatVideoFilesReencode(concatPaths, finalPath, concatMeta);
  } else {
    await concatVideoFiles(concatPaths, finalPath);
  }

  return {
    sessionId,
    videosDir,
    finalPath,
    introPath,
    outroPath,
    count: downloaded.length,
    videos: downloaded,
    downloadBase: COMFY_STATIC_BASE || COMFY_URL,
  };
}
