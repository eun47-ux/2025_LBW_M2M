// backend/comfyRun.js
import fs from "fs";
import axios from "axios";

// ✅ ComfyUI 서버 주소
const COMFY = "http://143.248.107.38:8188";

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

  return wf;
}

// ComfyUI /prompt 실행
export async function runComfyPrompt(workflow) {
  const res = await axios.post(`${COMFY}/prompt`, { prompt: workflow }, { timeout: 600000 });
  return res.data; // {prompt_id: "..."}
}
