import path from "path";
import { loadWorkflowTemplate, patchWorkflow, runComfyPrompt, getComfyHistory } from "./comfyRun.js";

/**
 * labelMap 예:
 * { "B": "crop_03.png", "A": "crop_01.png", "C":"crop_02.png" ... }
 * 여기서는 label -> comfy filename 으로 정리돼있다고 가정.
 */
export async function generateAllPairs({
  templatePath,
  labelToFilename,
  scenesJson, // LLM이 만든 { owner_label:"B", scenes:[{scene_id,pair,scene_text,...}] }
}) {
  const ownerLabel = "A";
  const ownerFilename = labelToFilename[ownerLabel];
  if (!ownerFilename) throw new Error(`owner filename missing for label ${ownerLabel}`);

  const wfTemplate = loadWorkflowTemplate(templatePath);

  // partner labels = labelMap keys except owner
  const partners = Object.keys(labelToFilename).filter((l) => l !== ownerLabel);

  const results = [];

  for (const partnerLabel of partners) {
    const partnerFilename = labelToFilename[partnerLabel];
    if (!partnerFilename) continue;

    // 이 pair의 scene만 골라서(2개) 실행
    const pairKeyA = [ownerLabel, partnerLabel].join("");
    const pairKeyB = [partnerLabel, ownerLabel].join("");

    const scenesForPair = (scenesJson.scenes || []).filter((s) => {
      const p = (s.pair || []).join("");
      return p === pairKeyA || p === pairKeyB;
    });

    for (const scene of scenesForPair) {
      const promptText = scene.scene_text; // 여기 들어가는 문장이 "음성 STT 기반 분석 결과"여야 함 (너 요구사항)

      const wf = patchWorkflow({
        workflowTemplate: wfTemplate,
        ownerFilename,
        partnerFilename,
        promptText,
      });

      const run = await runComfyPrompt(wf);

      // (선택) 결과를 history로 추적
      const history = await getComfyHistory(run.prompt_id);

      results.push({
        pair: [ownerLabel, partnerLabel],
        scene_id: scene.scene_id,
        prompt_id: run.prompt_id,
        history,
      });
    }
  }

  return results;
}
