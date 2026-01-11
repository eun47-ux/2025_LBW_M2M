// backend/scripts/runAllScenes.js
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import { runOnceForPair } from "./runOnce.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

export async function runAllScenes(sessionId) {
  const sessionDir = path.join(__dirname, "..", "..", "data", "sessions", sessionId);

  const scenesPath = path.join(sessionDir, "scenes.json");
  if (!fs.existsSync(scenesPath)) throw new Error("scenes.json not found: " + scenesPath);

  const scenesJson = JSON.parse(fs.readFileSync(scenesPath, "utf-8"));
  const ownerLabel = scenesJson.owner_label || "1";
  const scenes = scenesJson.scenes || [];
  const pairs = scenesJson.pairs || [];
  if (!scenes.length && !pairs.length) throw new Error("No scenes in scenes.json");

  const results = [];

  if (pairs.length) {
    for (const pairItem of pairs) {
      const pair = pairItem.pair || [];
      const [p1, p2] = pair;
      if (!p1 || !p2) continue;
      if (p1 !== ownerLabel && p2 !== ownerLabel) continue;
      const partnerLabel = p1 === ownerLabel ? p2 : p1;

      const scenesForPair = Array.isArray(pairItem.scenes) ? pairItem.scenes : [];
      for (const scene of scenesForPair) {
        const promptText = scene.image_prompt || scene.scene_text;
        if (!promptText) continue;

        const r = await runOnceForPair({
          sessionDir,
          ownerLabel,
          partnerLabel,
          promptText,
        });

        results.push({
          scene_id: scene.scene_id,
          pair,
          prompt_id: r.prompt_id,
        });

        console.log(`✅ ${scene.scene_id} done → prompt_id=${r.prompt_id}`);
      }
    }
  } else {
    for (const scene of scenes) {
      const [p1, p2] = scene.pair || [];
      if (!p1 || !p2) continue;

      if (p1 !== ownerLabel && p2 !== ownerLabel) continue;
      const partnerLabel = p1 === ownerLabel ? p2 : p1;
      const promptText = scene.image_prompt || scene.scene_text;
      if (!promptText) continue;

      const r = await runOnceForPair({
        sessionDir,
        ownerLabel,
        partnerLabel,
        promptText,
      });

      results.push({
        scene_id: scene.scene_id,
        pair: scene.pair,
        prompt_id: r.prompt_id,
      });

      console.log(`✅ ${scene.scene_id} done → prompt_id=${r.prompt_id}`);
    }
  }

  const outPath = path.join(sessionDir, "comfy_results.json");
  fs.writeFileSync(outPath, JSON.stringify(results, null, 2), "utf-8");

  return { outPath, results };
}

// CLI
async function main() {
  const sessionId = process.argv[2];
  if (!sessionId) {
    console.log("Usage: node runAllScenes.js <sessionId>");
    process.exit(1);
  }
  const out = await runAllScenes(sessionId);
  console.log("✅ saved:", out.outPath);
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((e) => {
    console.error("❌ runAllScenes failed:", e?.response?.data || e.message);
    process.exit(1);
  });
}
