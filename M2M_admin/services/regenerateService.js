// M2M_admin/services/regenerateService.js
import fs from "fs";
import path from "path";
import axios from "axios";
import FormData from "form-data";
import { COMFY_URL, COMFY_API_KEY, COMFY_STATIC_BASE, VIDEO_WORKFLOW_PATH, ADMIN_SESSIONS_DIR } from "../config.js";
import { getComfyResults, updateVideoUrl, updateComfyResults } from "./firestoreService.js";
import { waitForVideoOutput, downloadComfyStaticFile, downloadComfyFile } from "./comfyVideoService.js";

function loadJson(p) {
  return JSON.parse(fs.readFileSync(p, "utf-8"));
}

function loadWorkflowTemplate() {
  return loadJson(VIDEO_WORKFLOW_PATH);
}

/**
 * 이미지를 ComfyUI에 업로드
 */
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
 * 비디오 워크플로우 패치
 */
function patchVideoWorkflow({ workflowTemplate, inputFilename, promptText, filenamePrefix }) {
  const wf = JSON.parse(JSON.stringify(workflowTemplate));

  const loadIds = Object.keys(wf)
    .filter((id) => wf[id]?.class_type === "LoadImage")
    .sort((a, b) => Number(a) - Number(b));
  if (!loadIds.length) {
    throw new Error("LoadImage node not found in video workflow");
  }
  wf[loadIds[0]].inputs.image = inputFilename;

  const clipIds = Object.keys(wf).filter((id) => wf[id]?.class_type === "CLIPTextEncode");
  if (clipIds.length) {
    const positiveId =
      clipIds.find((id) => /positive/i.test(wf[id]?._meta?.title || "")) ||
      clipIds.find((id) => {
        const text = wf[id]?.inputs?.text || "";
        return text && !/low quality|blurry|negative/i.test(text.toLowerCase());
      }) ||
      clipIds[0];
    wf[positiveId].inputs.text = promptText;
  }

  const saveVideoId = Object.keys(wf).find((id) => wf[id]?.class_type === "SaveVideo");
  if (saveVideoId && filenamePrefix) {
    wf[saveVideoId].inputs.filename_prefix = filenamePrefix;
  }

  // KSamplerAdvanced 노드들의 noise_seed를 랜덤으로 설정 (randomize seed)
  const ksamplerIds = Object.keys(wf).filter((id) => wf[id]?.class_type === "KSamplerAdvanced");
  for (const id of ksamplerIds) {
    if (wf[id]?.inputs && typeof wf[id].inputs.noise_seed === "number") {
      // 랜덤 seed 생성 (0 이상의 정수)
      wf[id].inputs.noise_seed = Math.floor(Math.random() * Number.MAX_SAFE_INTEGER);
    }
  }

  return wf;
}

/**
 * ComfyUI에 프롬프트 실행
 */
async function runComfyPrompt(workflow) {
  const payload = { prompt: workflow };
  if (COMFY_API_KEY) {
    payload.extra_data = { api_key_comfy_org: COMFY_API_KEY };
  }

  const res = await axios.post(`${COMFY_URL}/prompt`, payload, { timeout: 600000 });
  return res.data;
}

/**
 * 비디오 파일명에서 버전 번호 추출 및 증가
 * 예: "24_02_00001_.mp4" → "24_02_00002"
 * comfy_video 구조: { filename: "24_02_00001_.mp4", subfolder: "M2M\\P1\\videos", type: "output" }
 */
function incrementVideoVersion(sceneId, comfyVideo) {
  // comfy_video에서 파일명 추출
  const filename = comfyVideo?.filename || `${sceneId}_00001_.mp4`;
  
  // 파일명에서 버전 번호 추출 (예: "24_02_00001_.mp4" → "00001")
  // 패턴: sceneId_버전번호_.mp4 또는 sceneId_버전번호.mp4
  const versionMatch = filename.match(/_(\d{5})(_?\.|$)/);
  
  if (versionMatch) {
    const currentVersion = parseInt(versionMatch[1], 10);
    const nextVersion = currentVersion + 1;
    const versionStr = String(nextVersion).padStart(5, "0");
    
    // 파일명에서 버전 부분만 교체 (확장자 포함)
    const newFilename = filename.replace(/_(\d{5})(_?\.)/, `_${versionStr}_`);
    // filename_prefix는 확장자 없이 사용
    return newFilename.replace(/\.(mp4|webm|mov)$/i, "");
  }
  
  // 버전 번호가 없으면 _00001 추가
  const base = sceneId;
  return `${base}_00001`;
}

/**
 * 특정 씬의 비디오 재생성
 */
export async function regenerateVideo(sessionId, sceneId) {
  // 1. DB에서 comfy_results.json 가져오기
  const comfyResults = await getComfyResults(sessionId);
  if (!Array.isArray(comfyResults)) {
    throw new Error("comfy_results.json is not an array");
  }

  const sceneData = comfyResults.find((r) => r.scene_id === sceneId);
  if (!sceneData) {
    throw new Error(`Scene ${sceneId} not found in comfy_results.json`);
  }

  // 2. 이미지 경로 확인
  const sessionDir = path.join(ADMIN_SESSIONS_DIR, sessionId);
  let imagePath = sceneData.image_path;

  // 로컬 세션 폴더에서 이미지 찾기
  if (!imagePath || !fs.existsSync(imagePath)) {
    const localImagePath = path.join(sessionDir, "images", `${sceneId}.png`);
    if (fs.existsSync(localImagePath)) {
      imagePath = localImagePath;
    } else {
      throw new Error(`Image not found for scene ${sceneId}`);
    }
  }

  // 3. 이미지를 ComfyUI에 업로드
  const uploadedImageFilename = await uploadImageToComfy(imagePath, path.basename(imagePath));

  // 4. 비디오 버전 증가 (filenamePrefix)
  const newPrefix = incrementVideoVersion(sceneId, sceneData.comfy_video);
  
  // 5. 워크플로우 패치 및 실행
  // filenamePrefix에 경로 포함: M2M/${sessionId}/videos/${newPrefix}
  const workflowTemplate = loadWorkflowTemplate();
  const workflow = patchVideoWorkflow({
    workflowTemplate,
    inputFilename: uploadedImageFilename,
    promptText: sceneData.prompt_text,
    filenamePrefix: `M2M/${sessionId}/videos/${newPrefix}`,
  });

  const promptResult = await runComfyPrompt(workflow);
  const videoPromptId = promptResult?.prompt_id;
  if (!videoPromptId) {
    throw new Error(`Video regeneration missing prompt_id for scene ${sceneId}`);
  }

  // 6. ComfyUI 결과 대기
  const videos = await waitForVideoOutput(COMFY_URL, videoPromptId, 900000);
  if (!videos.length) {
    throw new Error(`No video output for scene ${sceneId} (prompt ${videoPromptId})`);
  }

  // 7. 새 비디오 URL 생성
  const videoInfo = videos[0];
  const newVideoUrl = COMFY_STATIC_BASE
    ? `${COMFY_STATIC_BASE}/${videoInfo.subfolder}/${videoInfo.filename}`.replace(/\\/g, "/")
    : `${COMFY_URL}/view?filename=${videoInfo.filename}&type=${videoInfo.type}&subfolder=${videoInfo.subfolder}`;

  // 8. DB 업데이트
  await updateVideoUrl(sessionId, sceneId, newVideoUrl);

  // 9. comfy_results.json 업데이트
  const updatedResults = comfyResults.map((r) => {
    if (r.scene_id === sceneId) {
      return {
        ...r,
        video_prompt_id: videoPromptId,
        comfy_video: videoInfo,
      };
    }
    return r;
  });
  await updateComfyResults(sessionId, updatedResults);

  return {
    ok: true,
    sessionId,
    sceneId,
    videoPromptId,
    newVideoUrl,
    videoInfo,
  };
}
