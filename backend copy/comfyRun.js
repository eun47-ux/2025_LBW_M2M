// backend/comfyRun.js
import fs from "fs";
import axios from "axios";
import FormData from "form-data";
import dotenv from "dotenv";
import path from "path";
import { fileURLToPath } from "url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
dotenv.config({ path: path.resolve(__dirname, ".env") });

// ✅ ComfyUI 서버 주소
const COMFY = "http://143.248.107.38:8188";
const COMFY_API_KEY = process.env.COMFY_API_KEY || "";

// 템플릿 로드
export function loadWorkflowTemplate(templatePath) {
  return JSON.parse(fs.readFileSync(templatePath, "utf-8"));
}

/**
 * workflowTemplate: 템플릿 JSON(객체)
 * ownerFilename: labels.json["A"] 같은 값 (예: "A.png" 또는 "crop_01.png")
 * partnerFilename: labels.json["B"] 같은 값
 * promptText: scene_text
 */
export function patchWorkflow({ workflowTemplate, ownerFilename, partnerFilename, promptText, seed }) {
  const wf = JSON.parse(JSON.stringify(workflowTemplate)); // deep copy

  // 1) LoadImage 노드 2개를 찾아서 첫 번째=owner, 두 번째=partner로 세팅
  const loadIds = Object.keys(wf)
    .filter((id) => wf[id]?.class_type === "LoadImage")
    .sort((a, b) => Number(a) - Number(b)); // 보통 13,14 순

  if (loadIds.length < 2) {
    throw new Error(`Need at least 2 LoadImage nodes. Found: ${loadIds.length}`);
  }

  wf[loadIds[0]].inputs.image = ownerFilename;
  wf[loadIds[1]].inputs.image = partnerFilename;

  // 2) Gemini/NanoBanana 노드 찾아서 prompt 세팅
  const geminiId = Object.keys(wf).find((id) => wf[id]?.class_type === "GeminiImageNode");
  if (!geminiId) throw new Error("GeminiImageNode not found in workflow");

  wf[geminiId].inputs.prompt = promptText;

  // (선택) seed를 장면마다 바꾸고 싶으면
  if (typeof seed === "number") {
    wf[geminiId].inputs.seed = seed;
  }

  // 3) Wan2.2 (CLIP positive) 프롬프트도 동일하게 세팅
  const clipIds = Object.keys(wf).filter((id) => wf[id]?.class_type === "CLIPTextEncode");
  if (clipIds.length) {
    const positiveId =
      clipIds.find((id) => {
        const title = wf[id]?._meta?.title || "";
        return /positive/i.test(title);
      }) ||
      clipIds.find((id) => {
        const text = wf[id]?.inputs?.text || "";
        return text && !/low quality|blurry|negative/i.test(text.toLowerCase());
      }) ||
      clipIds[0];

    if (wf[positiveId]?.inputs) {
      wf[positiveId].inputs.text = promptText;
    }
  }

  return wf;
}

export function uploadImageToComfy(localPath, filename) {
  const form = new FormData();
  form.append("image", fs.createReadStream(localPath), filename);
  form.append("overwrite", "true");

  return axios
    .post(`${COMFY}/upload/image`, form, {
      headers: form.getHeaders(),
      maxBodyLength: Infinity,
    })
    .then((res) => {
      const data = res.data || {};
      if (data.subfolder && data.subfolder.length > 0) {
        return `${data.subfolder}/${data.name}`;
      }
      return data.name || filename;
    });
}

export function patchImageWorkflow({
  workflowTemplate,
  ownerFilename,
  partnerFilename,
  promptText,
  filenamePrefix,
}) {
  const wf = JSON.parse(JSON.stringify(workflowTemplate));

  const loadIds = Object.keys(wf)
    .filter((id) => wf[id]?.class_type === "LoadImage")
    .sort((a, b) => Number(a) - Number(b));
  if (loadIds.length < 2) {
    throw new Error(`Need at least 2 LoadImage nodes. Found: ${loadIds.length}`);
  }
  wf[loadIds[0]].inputs.image = ownerFilename;
  wf[loadIds[1]].inputs.image = partnerFilename;

  const geminiId = Object.keys(wf).find((id) => wf[id]?.class_type === "GeminiImageNode");
  if (!geminiId) throw new Error("GeminiImageNode not found in image workflow");
  wf[geminiId].inputs.prompt = promptText;

  const saveImageId = Object.keys(wf).find((id) => wf[id]?.class_type === "SaveImage");
  if (saveImageId && filenamePrefix) {
    wf[saveImageId].inputs.filename_prefix = filenamePrefix;
  }

  return wf;
}

export function patchVideoWorkflow({ workflowTemplate, inputFilename, promptText, filenamePrefix }) {
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

  return wf;
}

// ComfyUI /prompt 실행
export async function runComfyPrompt(workflow) {
  const payload = { prompt: workflow };
  if (COMFY_API_KEY) {
    payload.extra_data = { api_key_comfy_org: COMFY_API_KEY };
  }

  const res = await axios.post(`${COMFY}/prompt`, payload, { timeout: 600000 });
  return res.data; // {prompt_id: "..."}
}
