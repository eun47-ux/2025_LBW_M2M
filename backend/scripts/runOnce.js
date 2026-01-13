// backend/scripts/runOnce.js
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import { loadWorkflowTemplate, patchWorkflow, runComfyPrompt } from "../comfyRun.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// ✅ 템플릿 JSON 경로 (workflows 폴더)
const preferredTemplatePath = path.join(__dirname, "..", "workflows", "m2m_image.json");
const fallbackTemplatePath = path.join(__dirname, "..", "workflows", "jieun_m2m image+wan2.2.json");
const templatePath = fs.existsSync(preferredTemplatePath) ? preferredTemplatePath : fallbackTemplatePath;

// ✅ 핵심: 함수로 만들기
export async function runOnceForPair({
  sessionDir,
  ownerLabel = "A",
  partnerLabel,
  promptText,
  seed,
}) {
  const template = loadWorkflowTemplate(templatePath);

  const labelsPath = path.join(sessionDir, "labels.json");
  if (!fs.existsSync(labelsPath)) throw new Error("labels.json not found: " + labelsPath);

  const labelToFilename = JSON.parse(fs.readFileSync(labelsPath, "utf-8"));

  const ownerFilename = labelToFilename[ownerLabel];
  const partnerFilename = labelToFilename[partnerLabel];

  if (!ownerFilename || !partnerFilename) {
    throw new Error(
      `labels.json must contain ${ownerLabel} and ${partnerLabel}. Got: ${JSON.stringify(labelToFilename, null, 2)}`
    );
  }

  console.log("▶ Comfy inputs:", {
    ownerLabel,
    partnerLabel,
    ownerFilename,
    partnerFilename,
    promptPreview: String(promptText || "").slice(0, 160),
  });

  const wf = patchWorkflow({
    workflowTemplate: template,
    ownerFilename,
    partnerFilename,
    promptText,
    seed,
  });

  const run = await runComfyPrompt(wf);
  return run; // {prompt_id: ...}
}

// ✅ CLI 실행도 유지 (터미널에서 테스트할 때 유용)
async function main() {
  const sessionId = process.argv[2];
  const partnerLabel = process.argv[3] || "B";
  const promptText = process.argv[4] || "A and B eating tteokbokki in Seoul, candid documentary photo.";

  if (!sessionId) {
    console.log("Usage: node runOnce.js <sessionId> <partnerLabel=B> <promptText(optional)>");
    process.exit(1);
  }

  const sessionDir = path.join(__dirname, "..", "..", "data", "sessions", sessionId);

  const run = await runOnceForPair({
    sessionDir,
    ownerLabel: "A",
    partnerLabel,
    promptText,
  });

  console.log("✅ prompt_id:", run.prompt_id);
  console.log("Check ComfyUI UI output (SaveImage).");
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((e) => {
    console.error("❌ runOnce failed:", e?.response?.data || e.message);
    process.exit(1);
  });
}
