// backend/services/comfyVideo.js
import axios from "axios";
import fs from "fs";
import path from "path";

function isVideoFile(name) {
  return /\.(mp4|webm|mov|mkv)$/i.test(name || "");
}

function isImageFile(name) {
  return /\.(png|jpg|jpeg|webp)$/i.test(name || "");
}

export function extractVideoFiles(historyItem) {
  const outputs = historyItem?.outputs || {};
  const videos = [];

  for (const nodeOutput of Object.values(outputs)) {
    if (!nodeOutput || typeof nodeOutput !== "object") continue;
    const pools = [
      ...(Array.isArray(nodeOutput.videos) ? nodeOutput.videos : []),
      ...(Array.isArray(nodeOutput.gifs) ? nodeOutput.gifs : []),
      ...(Array.isArray(nodeOutput.images) ? nodeOutput.images : []),
    ];
    for (const item of pools) {
      if (item?.filename && isVideoFile(item.filename)) {
        videos.push({
          filename: item.filename,
          subfolder: item.subfolder || "",
          type: item.type || "output",
        });
      }
    }
  }

  return videos;
}

export function extractImageFiles(historyItem) {
  const outputs = historyItem?.outputs || {};
  const images = [];

  for (const nodeOutput of Object.values(outputs)) {
    if (!nodeOutput || typeof nodeOutput !== "object") continue;
    const pools = [
      ...(Array.isArray(nodeOutput.images) ? nodeOutput.images : []),
      ...(Array.isArray(nodeOutput.gifs) ? nodeOutput.gifs : []),
    ];
    for (const item of pools) {
      if (item?.filename && isImageFile(item.filename)) {
        images.push({
          filename: item.filename,
          subfolder: item.subfolder || "",
          type: item.type || "output",
        });
      }
    }
  }

  return images;
}

export async function fetchPromptHistory(comfyBase, promptId) {
  const res = await axios.get(`${comfyBase}/history/${promptId}`, { timeout: 120000 });
  return res.data?.[promptId] || null;
}

export async function waitForVideoOutput(comfyBase, promptId, timeoutMs = 300000) {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    const history = await fetchPromptHistory(comfyBase, promptId);
    const videos = extractVideoFiles(history);
    if (videos.length) return videos;
    await new Promise((r) => setTimeout(r, 2000));
  }
  return [];
}

export async function waitForImageOutput(comfyBase, promptId, timeoutMs = 300000) {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    const history = await fetchPromptHistory(comfyBase, promptId);
    const images = extractImageFiles(history);
    if (images.length) return images;
    await new Promise((r) => setTimeout(r, 2000));
  }
  return [];
}

export async function downloadComfyFile(comfyBase, fileInfo, destPath) {
  const params = new URLSearchParams({
    filename: fileInfo.filename,
    type: fileInfo.type || "output",
    subfolder: fileInfo.subfolder || "",
  });
  const url = `${comfyBase}/view?${params.toString()}`;

  const res = await axios.get(url, { responseType: "stream", timeout: 120000 });
  await new Promise((resolve, reject) => {
    const out = fs.createWriteStream(destPath);
    res.data.pipe(out);
    out.on("finish", resolve);
    out.on("error", reject);
  });

  return destPath;
}

function joinUrl(base, subpath) {
  const cleanBase = (base || "").replace(/\/+$/, "");
  const cleanPath = (subpath || "").replace(/^\/+/, "");
  return `${cleanBase}/${cleanPath}`;
}

export async function downloadComfyStaticFile(comfyStaticBase, fileInfo, destPath) {
  const subfolder = (fileInfo.subfolder || "").replace(/\\/g, "/").replace(/^\/+|\/+$/g, "");
  const filename = (fileInfo.filename || "").replace(/\\/g, "/");
  
  // subfolder와 filename을 조합 (output 제거, 이미 포함되어 있을 수 있음)
  let relPath;
  if (subfolder) {
    // subfolder에 output이 포함되어 있으면 제거
    const cleanSubfolder = subfolder.replace(/^output\//, "");
    relPath = [cleanSubfolder, filename].filter(Boolean).join("/");
  } else {
    relPath = filename;
  }
  
  const url = joinUrl(comfyStaticBase, relPath);
  console.log(`[DEBUG] 다운로드 시도: ${url} (subfolder: "${subfolder}", filename: "${filename}")`);

  try {
    const res = await axios.get(url, { responseType: "stream", timeout: 120000 });
    await new Promise((resolve, reject) => {
      const out = fs.createWriteStream(destPath);
      res.data.pipe(out);
      out.on("finish", resolve);
      out.on("error", reject);
    });
    console.log(`[DEBUG] 다운로드 성공: ${destPath}`);
    return destPath;
  } catch (err) {
    console.error(`[DEBUG] 다운로드 실패: ${url}`, err.message);
    throw err;
  }
}

export function safeSceneFilename(sceneId, fallback) {
  const base = (sceneId || fallback || "scene").toString().replace(/[^a-zA-Z0-9_-]/g, "_");
  return `${base}.mp4`;
}
