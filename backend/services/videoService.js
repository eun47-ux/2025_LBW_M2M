// backend/services/videoService.js
import fs from "fs";
import path from "path";
import axios from "axios";
import FormData from "form-data";
import { SESSIONS_DIR, COMFY_URL, COMFY_API_KEY, VIDEO_WORKFLOW_PATH, COMFY_STATIC_BASE } from "../config.js";
import { patchVideoWorkflow, loadWorkflowTemplate, uploadImageToComfy, runComfyPrompt } from "../comfyRun.js";
import { waitForVideoOutput, downloadComfyFile, downloadComfyStaticFile } from "./comfyVideo.js";

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

/**
 * 비디오 생성 실행 (모든 씬)
 */
export async function runVideoScenes(sessionId) {
  const sessionDir = path.join(SESSIONS_DIR, sessionId);
  const scenesPath = path.join(sessionDir, "scenes.json");

  if (!fs.existsSync(scenesPath)) throw new Error("scenes.json not found: " + scenesPath);

  const scenesJson = loadJson(scenesPath);
  const { items } = collectScenes(scenesJson);
  if (!items.length) throw new Error("No scenes to run (video stage)");

  // 이미지 결과 로드
  const imageResultsPath = path.join(sessionDir, "image_results.json");
  const imageResults = fs.existsSync(imageResultsPath) ? loadJson(imageResultsPath) : [];
  const imageByScene = new Map(
    Array.isArray(imageResults)
      ? imageResults.map((r) => [String(r.scene_id || ""), r])
      : []
  );

  const results = [];
  const videosDir = path.join(sessionDir, "videos");
  fs.mkdirSync(videosDir, { recursive: true });

  // 비디오 워크플로우 템플릿 로드
  const videoWorkflowTemplate = loadWorkflowTemplate(VIDEO_WORKFLOW_PATH);

  for (const item of items) {
    try {
      // 이미지 경로 찾기
      const imageResult = imageByScene.get(String(item.scene_id));
      let imagePath = imageResult?.image_path;
      
      if (!imagePath || !fs.existsSync(imagePath)) {
        // image_results.json에 경로가 없거나 파일이 없으면
        // images 폴더에서 scene_id로 시작하는 파일 찾기
        const imagesDir = path.join(sessionDir, "images");
        if (fs.existsSync(imagesDir)) {
          const files = fs.readdirSync(imagesDir);
          const matchingFile = files.find(f => 
            f.startsWith(`${item.scene_id}_`) || f.startsWith(`${item.scene_id}.`)
          );
          if (matchingFile) {
            imagePath = path.join(imagesDir, matchingFile);
          }
        }
      }
      
      if (!imagePath || !fs.existsSync(imagePath)) {
        // 여전히 없으면 기본 경로 시도
        imagePath = path.join(sessionDir, "images", `${item.scene_id}.png`);
      }
      
      if (!fs.existsSync(imagePath)) {
        throw new Error(`image not found: ${imagePath}`);
      }

      // 이미지를 ComfyUI에 업로드
      const uploadedImageFilename = await uploadImageToComfy(imagePath, path.basename(imagePath));

      // 비디오 워크플로우 패치
      const workflow = patchVideoWorkflow({
        workflowTemplate: videoWorkflowTemplate,
        inputFilename: uploadedImageFilename,
        promptText: item.promptText,
        filenamePrefix: `M2M/${sessionId}/videos/${item.scene_id}`,
      });

      // ComfyUI에 워크플로우 실행
      const promptResult = await runComfyPrompt(workflow);
      const videoPromptId = promptResult?.prompt_id;
      if (!videoPromptId) {
        throw new Error(`Video run missing prompt_id for scene ${item.scene_id}`);
      }

      // ComfyUI 결과 대기
      const videos = await waitForVideoOutput(COMFY_URL, videoPromptId, 900000);
      if (!videos.length) {
        throw new Error(`No video output for scene ${item.scene_id} (prompt ${videoPromptId})`);
      }

      // 비디오 다운로드
      const videoInfo = videos[0];
      const localVideoPath = path.join(videosDir, `${item.scene_id}.mp4`);

      if (COMFY_STATIC_BASE) {
        await downloadComfyStaticFile(COMFY_STATIC_BASE, videoInfo, localVideoPath);
      } else {
        await downloadComfyFile(COMFY_URL, videoInfo, localVideoPath);
      }

      results.push({
        scene_id: item.scene_id,
        pair: item.pair,
        prompt_text: item.promptText,
        image_prompt_id: imageResult?.image_prompt_id,
        video_prompt_id: videoPromptId,
        image_path: imagePath,
        video_path: localVideoPath,
        comfy_video: videoInfo,
      });

      console.log(`✅ video ${item.scene_id} → ${videoPromptId} (downloaded)`);
    } catch (err) {
      const message = err?.message || String(err);
      console.warn(`⚠️ video failed for scene ${item.scene_id}: ${message}`);
      results.push({
        scene_id: item.scene_id,
        pair: item.pair,
        prompt_text: item.promptText,
        error: message,
      });
    }
  }

  const outPath = path.join(sessionDir, "comfy_results.json");
  fs.writeFileSync(outPath, JSON.stringify(results, null, 2), "utf-8");
  return { outPath, results };
}
