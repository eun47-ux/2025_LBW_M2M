// backend/services/imageService.js
import fs from "fs";
import path from "path";
import { spawn } from "child_process";
import { SESSIONS_DIR, PYTHON_SCRIPT_PATH, COMFY_URL, COMFY_API_KEY } from "../config.js";
import { waitForImageOutput, downloadComfyFile, downloadComfyStaticFile } from "./comfyVideo.js";
import { COMFY_STATIC_BASE } from "../config.js";

function loadJson(p) {
  return JSON.parse(fs.readFileSync(p, "utf-8"));
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

/**
 * Python CLI를 통해 이미지 생성 실행
 */
function runPythonImageGeneration(crop1Path, crop2Path, prompt, filenamePrefix) {
  return new Promise((resolve, reject) => {
    const inputData = JSON.stringify({
      command: "image",
      crop1_path: crop1Path,
      crop2_path: crop2Path,
      prompt: prompt,
      filename_prefix: filenamePrefix,
    });

    const pythonProcess = spawn("python", [PYTHON_SCRIPT_PATH], {
      env: {
        ...process.env,
        COMFY_URL: COMFY_URL,
        COMFY_API_KEY: COMFY_API_KEY,
      },
      stdio: ["pipe", "pipe", "pipe"],
    });

    let stdout = "";
    let stderr = "";

    pythonProcess.stdout.on("data", (data) => {
      stdout += data.toString();
    });

    pythonProcess.stderr.on("data", (data) => {
      stderr += data.toString();
    });

    pythonProcess.on("close", (code) => {
      if (code !== 0) {
        reject(new Error(`Python script exited with code ${code}: ${stderr}`));
        return;
      }

      try {
        const result = JSON.parse(stdout);
        if (!result.ok) {
          reject(new Error(result.error || "Python script returned error"));
          return;
        }
        resolve(result);
      } catch (e) {
        reject(new Error(`Failed to parse Python output: ${stdout}`));
      }
    });

    pythonProcess.on("error", (err) => {
      reject(new Error(`Failed to start Python process: ${err.message}`));
    });

    // 입력 전송
    pythonProcess.stdin.write(inputData);
    pythonProcess.stdin.end();
  });
}

/**
 * 이미지 생성 실행 (모든 씬)
 */
export async function runImageScenes(sessionId) {
  const sessionDir = path.join(SESSIONS_DIR, sessionId);
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

  for (const item of items) {
    const partnerCropPath = resolveCropPath(sessionDir, item.partnerLabel, labelToFilename);
    if (!partnerCropPath) {
      console.warn(`⚠️ partner crop missing: ${item.partnerLabel}`);
      continue;
    }

    try {
      // Python CLI로 이미지 생성
      const pythonResult = await runPythonImageGeneration(
        ownerCropPath,
        partnerCropPath,
        item.promptText,
        `M2M/${sessionId}/images/${item.scene_id}`
      );

      const imagePromptId = pythonResult?.prompt_id;
      if (!imagePromptId) {
        throw new Error(`Python image run missing prompt_id for scene ${item.scene_id}`);
      }

      // ComfyUI 결과 대기
      const images = await waitForImageOutput(COMFY_URL, imagePromptId, 300000);
      if (!images.length) {
        throw new Error(`No image output for scene ${item.scene_id} (prompt ${imagePromptId})`);
      }

      // 이미지 다운로드
      const imageInfo = images[0];
      const localImagePath = path.join(imagesDir, `${item.scene_id}.png`);

      if (COMFY_STATIC_BASE) {
        await downloadComfyStaticFile(COMFY_STATIC_BASE, imageInfo, localImagePath);
      } else {
        await downloadComfyFile(COMFY_URL, imageInfo, localImagePath);
      }

      results.push({
        scene_id: item.scene_id,
        pair: item.pair,
        prompt_text: item.promptText,
        image_prompt_id: imagePromptId,
        image_path: localImagePath,
      });

      console.log(`✅ image ${item.scene_id} → ${imagePromptId}`);
    } catch (err) {
      const message = err?.message || String(err);
      console.warn(`⚠️ image failed for scene ${item.scene_id}: ${message}`);
      results.push({
        scene_id: item.scene_id,
        pair: item.pair,
        prompt_text: item.promptText,
        error: message,
      });
    }
  }

  const outPath = path.join(sessionDir, "image_results.json");
  fs.writeFileSync(outPath, JSON.stringify(results, null, 2), "utf-8");
  return { outPath, results };
}
