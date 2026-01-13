// backend/scripts/runAllScenes.js
import fs from "fs";
import path from "path";
import axios from "axios";
import FormData from "form-data";
import dotenv from "dotenv";
import { fileURLToPath } from "url";
import { downloadComfyFile, waitForImageOutput, waitForVideoOutput } from "../services/comfyVideo.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

dotenv.config({ path: path.resolve(__dirname, "..", ".env") });

const COMFY = process.env.COMFY_URL || "http://143.248.107.38:8188";
const M2M_FLASK_URL = process.env.M2M_FLASK_URL || "http://localhost:5000";

function loadJson(p) {
  return JSON.parse(fs.readFileSync(p, "utf-8"));
}

function collectScenes(scenesJson) {
  const ownerLabel = String(scenesJson.owner_label || "1");
  const items = [];

  if (Array.isArray(scenesJson.pairs) && scenesJson.pairs.length) {
    for (const pairItem of scenesJson.pairs) {
      const pair = pairItem.pair || [];
      const [p1, p2] = pair;
      if (!p1 || !p2) continue;
      if (p1 !== ownerLabel && p2 !== ownerLabel) continue;
      const partnerLabel = p1 === ownerLabel ? p2 : p1;

      const scenesForPair = Array.isArray(pairItem.scenes) ? pairItem.scenes : [];
      for (const scene of scenesForPair) {
        const promptText = scene.image_prompt || scene.scene_text;
        if (!promptText) continue;
        items.push({
          scene_id: scene.scene_id,
          pair,
          partnerLabel,
          promptText,
        });
      }
    }
  } else if (Array.isArray(scenesJson.scenes)) {
    for (const scene of scenesJson.scenes) {
      const pair = scene.pair || [];
      const [p1, p2] = pair;
      if (!p1 || !p2) continue;
      if (p1 !== ownerLabel && p2 !== ownerLabel) continue;
      const partnerLabel = p1 === ownerLabel ? p2 : p1;
      const promptText = scene.image_prompt || scene.scene_text;
      if (!promptText) continue;
      items.push({
        scene_id: scene.scene_id,
        pair,
        partnerLabel,
        promptText,
      });
    }
  }

  return { ownerLabel, items };
}

function resolveSessionDir(sessionId) {
  return path.join(__dirname, "..", "..", "data", "sessions", sessionId);
}

function resolveCropPath(sessionDir, label, labelToFilename) {
  const cropsDir = path.join(sessionDir, "crops");
  const mapped = labelToFilename?.[label];
  const candidates = [];

  if (mapped) {
    candidates.push(path.join(cropsDir, path.basename(mapped)));
  }
  candidates.push(path.join(cropsDir, `${label}.png`));
  candidates.push(path.join(cropsDir, `${label}.jpg`));
  candidates.push(path.join(cropsDir, `${label}.jpeg`));

  for (const p of candidates) {
    if (fs.existsSync(p)) return p;
  }

  if (fs.existsSync(cropsDir)) {
    const files = fs.readdirSync(cropsDir);
    const hit = files.find((f) => f.split(".")[0] === String(label));
    if (hit) return path.join(cropsDir, hit);
  }

  return null;
}

async function requestFlask(endpoint, form) {
  const url = `${M2M_FLASK_URL}${endpoint}`;
  const res = await axios.post(url, form, {
    headers: form.getHeaders(),
    maxBodyLength: Infinity,
    timeout: 600000,
  });
  return res.data;
}

export async function runImageScenes(sessionId) {
  const sessionDir = resolveSessionDir(sessionId);
  const scenesPath = path.join(sessionDir, "scenes.json");
  const labelsPath = path.join(sessionDir, "labels.json");

  if (!fs.existsSync(scenesPath)) throw new Error("scenes.json not found: " + scenesPath);
  if (!fs.existsSync(labelsPath)) throw new Error("labels.json not found: " + labelsPath);

  const scenesJson = loadJson(scenesPath);
  const labelToFilename = loadJson(labelsPath);
  const { ownerLabel, items } = collectScenes(scenesJson);
  if (!items.length) throw new Error("No scenes to run (image stage)");

  const ownerCropPath = resolveCropPath(sessionDir, ownerLabel, labelToFilename);
  if (!ownerCropPath) {
    throw new Error(`crop file not found for owner label "${ownerLabel}"`);
  }

  const imagesDir = path.join(sessionDir, "images");
  fs.mkdirSync(imagesDir, { recursive: true });

  const results = [];
  const videosDir = path.join(sessionDir, "videos");
  fs.mkdirSync(videosDir, { recursive: true });

  for (const item of items) {
    const partnerCropPath = resolveCropPath(sessionDir, item.partnerLabel, labelToFilename);
    if (!partnerCropPath) {
      console.warn(`⚠️ partner crop missing: ${item.partnerLabel}`);
      continue;
    }

    const form = new FormData();
    form.append("crop1", fs.createReadStream(ownerCropPath), path.basename(ownerCropPath));
    form.append("crop2", fs.createReadStream(partnerCropPath), path.basename(partnerCropPath));
    form.append("prompt", item.promptText);
    form.append("filename_prefix", `M2M/${sessionId}/images/${item.scene_id}`);

    const imageRun = await requestFlask("/api/generate-image", form);
    const imagePromptId = imageRun?.prompt_id;
    if (!imagePromptId) {
      throw new Error(`Flask image run missing prompt_id for scene ${item.scene_id}`);
    }

    const images = await waitForImageOutput(COMFY, imagePromptId, 300000);
    if (!images.length) {
      throw new Error(`No image output for scene ${item.scene_id} (prompt ${imagePromptId})`);
    }

    const imageInfo = images[0];
    const localImagePath = path.join(imagesDir, `${item.scene_id}.png`);
    await downloadComfyFile(COMFY, imageInfo, localImagePath);

    results.push({
      scene_id: item.scene_id,
      pair: item.pair,
      prompt_text: item.promptText,
      image_prompt_id: imagePromptId,
      image_path: localImagePath,
    });

    console.log(`✅ image ${item.scene_id} → ${imagePromptId}`);
  }

  const outPath = path.join(sessionDir, "image_results.json");
  fs.writeFileSync(outPath, JSON.stringify(results, null, 2), "utf-8");
  return { outPath, results };
}

export async function runVideoScenes(sessionId) {
  const sessionDir = resolveSessionDir(sessionId);
  const scenesPath = path.join(sessionDir, "scenes.json");
  const labelsPath = path.join(sessionDir, "labels.json");

  if (!fs.existsSync(scenesPath)) throw new Error("scenes.json not found: " + scenesPath);
  if (!fs.existsSync(labelsPath)) throw new Error("labels.json not found: " + labelsPath);

  const scenesJson = loadJson(scenesPath);
  const { items } = collectScenes(scenesJson);
  if (!items.length) throw new Error("No scenes to run (video stage)");

  const imageResultsPath = path.join(sessionDir, "image_results.json");
  const imageResults = fs.existsSync(imageResultsPath) ? loadJson(imageResultsPath) : [];
  const imageByScene = new Map(
    Array.isArray(imageResults)
      ? imageResults.map((r) => [String(r.scene_id || ""), r])
      : []
  );

  const results = [];

  for (const item of items) {
    const imageResult = imageByScene.get(String(item.scene_id));
    const imagePath =
      imageResult?.image_path || path.join(sessionDir, "images", `${item.scene_id}.png`);
    if (!fs.existsSync(imagePath)) {
      console.warn(`⚠️ image not found for scene ${item.scene_id}: ${imagePath}`);
      continue;
    }

    const form = new FormData();
    form.append("image", fs.createReadStream(imagePath), path.basename(imagePath));
    form.append("prompt", item.promptText);
    form.append("filename_prefix", `M2M/${sessionId}/videos/${item.scene_id}`);

    const videoRun = await requestFlask("/api/generate-video", form);
    const videoPromptId = videoRun?.prompt_id;
    if (!videoPromptId) {
      throw new Error(`Flask video run missing prompt_id for scene ${item.scene_id}`);
    }

    const videos = await waitForVideoOutput(COMFY, videoPromptId, 300000);
    if (!videos.length) {
      throw new Error(`No video output for scene ${item.scene_id} (prompt ${videoPromptId})`);
    }

    const videoInfo = videos[0];
    const localVideoPath = path.join(videosDir, `${item.scene_id}.mp4`);
    await downloadComfyFile(COMFY, videoInfo, localVideoPath);

    results.push({
      scene_id: item.scene_id,
      pair: item.pair,
      prompt_text: item.promptText,
      image_prompt_id: imageResult?.image_prompt_id,
      video_prompt_id: videoPromptId,
      image_path: imagePath,
      comfy_image: videoRun?.image_filename || null,
      video_path: localVideoPath,
      comfy_video: videoInfo,
    });

    console.log(`✅ video ${item.scene_id} → ${videoPromptId} (downloaded)`);
  }

  const outPath = path.join(sessionDir, "comfy_results.json");
  fs.writeFileSync(outPath, JSON.stringify(results, null, 2), "utf-8");
  return { outPath, results };
}

export async function runAllScenes(sessionId) {
  await runImageScenes(sessionId);
  return runVideoScenes(sessionId);
}

// CLI
async function main() {
  const sessionId = process.argv[2];
  const mode = process.argv[3] || "all"; // all | image | video
  if (!sessionId) {
    console.log("Usage: node runAllScenes.js <sessionId> [all|image|video]");
    process.exit(1);
  }

  if (mode === "image") {
    const out = await runImageScenes(sessionId);
    console.log("✅ saved:", out.outPath);
  } else if (mode === "video") {
    const out = await runVideoScenes(sessionId);
    console.log("✅ saved:", out.outPath);
  } else {
    const out = await runAllScenes(sessionId);
    console.log("✅ saved:", out.outPath);
  }
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((e) => {
    console.error("❌ runAllScenes failed:", e?.response?.data || e.message);
    process.exit(1);
  });
}
