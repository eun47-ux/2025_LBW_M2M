// M2M_admin/services/regenerateService.js
import fs from "fs";
import path from "path";
import axios from "axios";
import FormData from "form-data";
import { spawn } from "child_process";
import { COMFY_URL, COMFY_API_KEY, COMFY_STATIC_BASE, VIDEO_WORKFLOW_PATH, ADMIN_SESSIONS_DIR, PYTHON_SCRIPT_PATH, MAIN_SESSIONS_DIR } from "../config.js";
import { getComfyResults, updateVideoUrl, updateComfyResults, getScenes, updateImageUrl } from "./firestoreService.js";
import { waitForVideoOutput, waitForImageOutput, downloadComfyStaticFile, downloadComfyFile } from "./comfyVideoService.js";

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
 * 이미지 파일명에서 버전 번호 추출 및 증가
 * 예: "21_01_00001_.png" → "21_01_00002"
 * imageUrl 또는 기존 파일명에서 추출
 */
function incrementImageVersion(sceneId, imageUrl) {
  if (!imageUrl) {
    return `${sceneId}_00001`;
  }

  // URL에서 파일명 추출
  let filename;
  try {
    const urlObj = new URL(imageUrl);
    const pathParts = urlObj.pathname.split('/').filter(Boolean);
    filename = pathParts.pop() || `${sceneId}_00001_.png`;
  } catch (e) {
    // URL 파싱 실패 시 imageUrl 자체를 파일명으로 사용
    filename = imageUrl.split('/').pop() || `${sceneId}_00001_.png`;
  }

  // 파일명에서 확장자 제거 (확장자 앞의 _ 포함)
  // 예: "21_01_00001_.png" → "21_01_00001_"
  const filenameWithoutExt = filename.replace(/\.(png|jpg|jpeg|webp)$/i, "");

  // 파일명에서 버전 번호 추출 (예: "21_01_00001_" → "00001")
  // 패턴: sceneId_버전번호_ 또는 sceneId_버전번호
  const versionMatch = filenameWithoutExt.match(/_(\d{5})_?$/);
  
  if (versionMatch) {
    const currentVersion = parseInt(versionMatch[1], 10);
    const nextVersion = currentVersion + 1;
    const versionStr = String(nextVersion).padStart(5, "0");
    
    // 파일명에서 버전 부분만 교체 (마지막 _ 포함)
    // 예: "21_01_00001_" → "21_01_00002_"
    const newFilename = filenameWithoutExt.replace(/_(\d{5})_?$/, `_${versionStr}_`);
    return newFilename;
  }
  
  // 버전 번호가 없으면 _00001 추가
  return `${sceneId}_00001`;
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
 * 특정 씬의 이미지 재생성
 */
export async function regenerateImage(sessionId, sceneId) {
  // 1. scenes.json 가져오기
  const scenesJson = await getScenes(sessionId);
  if (!scenesJson) {
    throw new Error(`scenes.json not found for session ${sessionId}`);
  }

  // 2. 씬 정보 찾기
  const scene = scenesJson.scenes?.find((s) => s.scene_id === sceneId);
  if (!scene) {
    throw new Error(`Scene ${sceneId} not found in scenes.json`);
  }

  const ownerLabel = String(scenesJson.owner_label || "1");
  const pair = scene.pair || [];
  const [p1, p2] = pair;
  if (!p1 || !p2) {
    throw new Error(`Invalid pair for scene ${sceneId}`);
  }
  const partnerLabel = p1 === ownerLabel ? p2 : p1;
  const promptText = scene.image_prompt || scene.scene_text;
  if (!promptText) {
    throw new Error(`No prompt text for scene ${sceneId}`);
  }

  // 3. labels.json 로드 (Admin 세션 폴더 또는 메인 백엔드 세션 폴더에서 찾기)
  const sessionDir = path.join(ADMIN_SESSIONS_DIR, sessionId);
  let labelsPath = path.join(sessionDir, "labels.json");
  
  // Admin 세션 폴더에 없으면 메인 백엔드 세션 폴더에서 찾기
  if (!fs.existsSync(labelsPath)) {
    const mainLabelsPath = path.join(MAIN_SESSIONS_DIR, sessionId, "labels.json");
    if (fs.existsSync(mainLabelsPath)) {
      labelsPath = mainLabelsPath;
      console.log(`✅ labels.json을 메인 백엔드 세션 폴더에서 찾음: ${mainLabelsPath}`);
    } else {
      throw new Error(`labels.json not found in both Admin (${path.join(sessionDir, "labels.json")}) and Main (${mainLabelsPath}) session folders`);
    }
  }
  
  const labelToFilename = loadJson(labelsPath);

  // 4. 크롭 경로 찾기 (Admin 세션 폴더 또는 메인 백엔드 세션 폴더에서 찾기)
  function resolveCropPath(sessionDir, label, labelToFilename) {
    const adminCropsDir = path.join(sessionDir, "crops");
    const mainCropsDir = path.join(MAIN_SESSIONS_DIR, sessionId, "crops");
    const mapped = labelToFilename?.[label];
    const candidates = [];

    // Admin 세션 폴더의 크롭 경로 추가
    if (mapped) {
      candidates.push(path.join(adminCropsDir, path.basename(mapped)));
    }
    candidates.push(path.join(adminCropsDir, `${label}.png`));
    candidates.push(path.join(adminCropsDir, `${label}.jpg`));
    candidates.push(path.join(adminCropsDir, `${label}.jpeg`));

    // 메인 백엔드 세션 폴더의 크롭 경로 추가
    if (mapped) {
      candidates.push(path.join(mainCropsDir, path.basename(mapped)));
    }
    candidates.push(path.join(mainCropsDir, `${label}.png`));
    candidates.push(path.join(mainCropsDir, `${label}.jpg`));
    candidates.push(path.join(mainCropsDir, `${label}.jpeg`));

    for (const p of candidates) {
      if (fs.existsSync(p)) return p;
    }

    // Admin 세션 폴더에서 찾기
    if (fs.existsSync(adminCropsDir)) {
      const files = fs.readdirSync(adminCropsDir);
      const hit = files.find((f) => f.split(".")[0] === String(label));
      if (hit) return path.join(adminCropsDir, hit);
    }

    // 메인 백엔드 세션 폴더에서 찾기
    if (fs.existsSync(mainCropsDir)) {
      const files = fs.readdirSync(mainCropsDir);
      const hit = files.find((f) => f.split(".")[0] === String(label));
      if (hit) return path.join(mainCropsDir, hit);
    }

    return null;
  }

  const ownerCropPath = resolveCropPath(sessionDir, ownerLabel, labelToFilename);
  if (!ownerCropPath) {
    throw new Error(`crop file not found for owner label "${ownerLabel}" in both Admin and Main session folders`);
  }

  const partnerCropPath = resolveCropPath(sessionDir, partnerLabel, labelToFilename);
  if (!partnerCropPath) {
    throw new Error(`crop file not found for partner label "${partnerLabel}" in both Admin and Main session folders`);
  }

  // 5. 기존 이미지 URL 가져오기 (버전 증가용)
  const { getImageUrls } = await import("./firestoreService.js");
  const imageUrls = await getImageUrls(sessionId);
  const existingImageUrl = imageUrls[sceneId];

  // 6. 이미지 버전 증가
  const newPrefix = incrementImageVersion(sceneId, existingImageUrl);
  const filenamePrefix = `M2M/${sessionId}/images/${newPrefix}`;

  // 7. Python CLI로 이미지 생성
  const pythonResult = await runPythonImageGeneration(
    ownerCropPath,
    partnerCropPath,
    promptText,
    filenamePrefix
  );

  const imagePromptId = pythonResult?.prompt_id;
  if (!imagePromptId) {
    throw new Error(`Python image run missing prompt_id for scene ${sceneId}`);
  }

  // 8. ComfyUI에서 이미지 생성 완료 대기
  const images = await waitForImageOutput(COMFY_URL, imagePromptId, 300000);
  if (!images.length) {
    throw new Error(`No image output for scene ${sceneId} (prompt ${imagePromptId})`);
  }

  const imageInfo = images[0];

  // 9. 새 이미지 URL 생성
  let newImageUrl = null;
  if (COMFY_STATIC_BASE) {
    const imagesBaseUrl = `${COMFY_STATIC_BASE}/M2M/${sessionId}/images/`;
    const possibleFilenames = [
      `${newPrefix}_00001_.png`,
      `${newPrefix}_00001.png`,
      `${newPrefix}.png`,
    ];

    // 첫 번째 가능한 파일명 사용
    newImageUrl = `${imagesBaseUrl}${possibleFilenames[0]}`;
  } else {
    const params = new URLSearchParams({
      filename: imageInfo.filename,
      type: imageInfo.type || "output",
      subfolder: imageInfo.subfolder || "",
    });
    newImageUrl = `${COMFY_URL}/view?${params.toString()}`;
  }

  // 10. Firestore에 새 이미지 URL 업로드
  await updateImageUrl(sessionId, sceneId, newImageUrl);

  return {
    ok: true,
    sessionId,
    sceneId,
    imagePromptId,
    newImageUrl,
    imageInfo,
  };
}

/**
 * 특정 씬의 비디오 재생성
 */
export async function regenerateVideo(sessionId, sceneId) {
  // 1. scenes.json 가져오기
  const scenesJson = await getScenes(sessionId);
  if (!scenesJson) {
    throw new Error(`scenes.json not found for session ${sessionId}`);
  }

  // 2. 씬 정보 찾기
  const scene = scenesJson.scenes?.find((s) => s.scene_id === sceneId);
  if (!scene) {
    throw new Error(`Scene ${sceneId} not found in scenes.json`);
  }

  const promptText = scene.image_prompt || scene.scene_text;
  if (!promptText) {
    throw new Error(`No prompt text for scene ${sceneId}`);
  }

  // 3. 이미지 경로 확인
  const sessionDir = path.join(ADMIN_SESSIONS_DIR, sessionId);
  let imagePath = path.join(sessionDir, "images", `${sceneId}.png`);

  // 로컬 세션 폴더에서 이미지 찾기
  if (!fs.existsSync(imagePath)) {
    // 다른 버전의 이미지 찾기
    const imagesDir = path.join(sessionDir, "images");
    if (fs.existsSync(imagesDir)) {
      const files = fs.readdirSync(imagesDir);
      const matchingFile = files.find(f => 
        f.startsWith(`${sceneId}_`) || f.startsWith(`${sceneId}.`)
      );
      if (matchingFile) {
        imagePath = path.join(imagesDir, matchingFile);
      }
    }
  }

  if (!fs.existsSync(imagePath)) {
    throw new Error(`Image not found for scene ${sceneId}`);
  }

  // 4. 이미지를 ComfyUI에 업로드
  const uploadedImageFilename = await uploadImageToComfy(imagePath, path.basename(imagePath));

  // 5. 기존 비디오 URL 가져오기 (버전 증가용)
  const { getVideoUrls } = await import("./firestoreService.js");
  const videoUrls = await getVideoUrls(sessionId);
  const existingVideoUrl = videoUrls[sceneId];

  // 6. 비디오 버전 증가 (filenamePrefix)
  let comfyVideo = null;
  if (existingVideoUrl) {
    try {
      const urlObj = new URL(existingVideoUrl);
      const pathParts = urlObj.pathname.split('/').filter(Boolean);
      comfyVideo = {
        filename: pathParts.pop() || `${sceneId}_00001_.mp4`,
        subfolder: pathParts.join('/').replace(/^output\//, ''),
        type: "output",
      };
    } catch (e) {
      console.warn(`⚠️ 기존 비디오 URL 파싱 실패: ${e.message}`);
    }
  }

  const newPrefix = incrementVideoVersion(sceneId, comfyVideo);
  
  // 7. 워크플로우 패치 및 실행
  // filenamePrefix에 경로 포함: M2M/${sessionId}/videos/${newPrefix}
  const workflowTemplate = loadWorkflowTemplate();
  const workflow = patchVideoWorkflow({
    workflowTemplate,
    inputFilename: uploadedImageFilename,
    promptText: promptText,
    filenamePrefix: `M2M/${sessionId}/videos/${newPrefix}`,
  });

  const promptResult = await runComfyPrompt(workflow);
  const videoPromptId = promptResult?.prompt_id;
  if (!videoPromptId) {
    throw new Error(`Video regeneration missing prompt_id for scene ${sceneId}`);
  }

  // 8. ComfyUI 결과 대기
  const videos = await waitForVideoOutput(COMFY_URL, videoPromptId, 900000);
  if (!videos.length) {
    throw new Error(`No video output for scene ${sceneId} (prompt ${videoPromptId})`);
  }

  // 9. 새 비디오 URL 생성
  const videoInfo = videos[0];
  const newVideoUrl = COMFY_STATIC_BASE
    ? `${COMFY_STATIC_BASE}/${videoInfo.subfolder}/${videoInfo.filename}`.replace(/\\/g, "/")
    : `${COMFY_URL}/view?filename=${videoInfo.filename}&type=${videoInfo.type}&subfolder=${videoInfo.subfolder}`;

  // 10. DB 업데이트
  await updateVideoUrl(sessionId, sceneId, newVideoUrl);

  // 11. comfy_results.json 업데이트 (선택적, 있으면 업데이트)
  try {
    const comfyResults = await getComfyResults(sessionId);
    if (Array.isArray(comfyResults)) {
      const updatedResults = comfyResults.map((r) => {
        if (r.scene_id === sceneId) {
          return {
            ...r,
            video_prompt_id: videoPromptId,
            comfy_video: videoInfo,
            prompt_text: promptText,
          };
        }
        return r;
      });
      await updateComfyResults(sessionId, updatedResults);
    }
  } catch (err) {
    console.warn(`⚠️ comfy_results.json 업데이트 실패: ${err.message}`);
  }

  return {
    ok: true,
    sessionId,
    sceneId,
    videoPromptId,
    newVideoUrl,
    videoInfo,
  };
}
