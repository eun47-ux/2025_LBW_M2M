// backend/services/transcriptToScenes.js
import dotenv from "dotenv";
import fs from "fs";
import OpenAI from "openai";
import path from "path";
import { fileURLToPath } from "url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
dotenv.config({ path: path.resolve(__dirname, "..", ".env") });

console.log("ENV CHECK:", process.env.OPENAI_API_KEY?.slice(0, 7));

const openai = new OpenAI({
  apiKey: process.env.OPENAI_API_KEY,
});

/**
 * transcript(string) → scenes.json 생성
 *
 * Transcript convention (expected in transcript):
 * - People labels are listed in `participants` (e.g., ["A","B","C"] or ["1","2","3"])
 * - The transcript declares which label is the photo owner
 * - The transcript contains an explicit era/background phrase (mandatory in prompts),
 *   otherwise we will use UNKNOWN_ERA_BACKGROUND.
 *
 * Output:
 * - Flat "scenes": [ ... ]
 * - Each scene: { scene_id, pair, evidence_quotes, scene_text, do_not_include }
 *
 * Critical constraints (enforced):
 * - Generate scenes ONLY for owner+other pairs
 * - For EACH pair, we aim for 2 scenes, BUT:
 *   - If evidence_quotes is empty, DO NOT include that scene in final output (do not send to ComfyUI)
 * - scene_text MUST include era phrase (e.g., "1980년대 대한민국 서울") always
 * - scene_text must NOT contain pair labels (A/B/1/2 etc.)
 */
export async function transcriptToScenes({
  transcript,
  participants, // e.g., ["A","B","C"] OR ["1","2","3","4"]
  ownerLabel, // e.g., "A" OR "1"
  sessionPath,
}) {
  if (!transcript || !sessionPath) {
    throw new Error("transcript and sessionPath are required");
  }
  if (!participants || !Array.isArray(participants) || participants.length < 2) {
    throw new Error("participants must be a non-empty array with at least 2 items");
  }
  if (!ownerLabel) {
    throw new Error("ownerLabel is required (label string, e.g., 'A' or '1')");
  }

  // Ensure owner is in participants
  const normalizedParticipants = participants.map(String);
  const owner = String(ownerLabel);
  if (!normalizedParticipants.includes(owner)) {
    throw new Error(`ownerLabel "${owner}" must be included in participants`);
  }

  const systemPrompt = `
You are a strict, literal information extractor that converts a transcript into scene prompts for downstream image/video generation.

ABSOLUTE RULES (must follow):
- Do NOT interpret the conversation.
- Do NOT infer emotions, relationships, intentions, or unstated context.
- Do NOT add visual details (clothing, weather, facial expression, vibe, camera/style keywords, etc.) unless explicitly stated.
- Extract ONLY what is explicitly mentioned in the transcript.
- If a required piece of information is missing, do NOT invent; omit that scene.

PEOPLE LABELS + OWNER:
- People are labeled in the transcript and provided via the "participants" list.
- The transcript declares which label is the photo owner.
- Use these labels as canonical IDs in the output "pair" field only.

PAIRING RULE:
- Generate scenes ONLY for pairs that include the owner: (owner + every other person).

SCENE ELIGIBILITY (strict):
A scene is eligible ONLY if BOTH are explicitly stated:
1) an action/activity ("what they did")
2) a location/place ("where it happened")
If either is missing, the scene is NOT eligible and must be omitted.

ERA BACKGROUND (mandatory, must be included in scene_text):
- Identify the era/background phrase explicitly stated in the transcript.
- Use the exact phrase as written in the transcript.
- Do NOT invent the era. If not explicitly present, use "UNKNOWN_ERA_BACKGROUND".
- Every "scene_text" MUST include the era/background phrase verbatim.

scene_text content rules:
- scene_text must be ONE literal sentence.
- scene_text must NOT mention any pair labels (no "A와 B", no "1과 2", no "pair:", etc.)
- scene_text must only describe action + place (and other explicitly stated details).
- scene_text must always include the era/background phrase.

EVIDENCE QUOTES (critical):
- Every scene MUST include 1-3 exact quotes (verbatim) supporting that scene.
- If you cannot provide at least 1 exact supporting quote for a scene, omit that scene.

GROUP REUSE EXCEPTION RULE:
- If the transcript explicitly states that the OWNER did something "with friends", "with everyone", "together", or equivalent group expression,
  and the owner is clearly included,
  you MAY reuse the same eligible scene for each owner+other-person pair.
- Do NOT apply group reuse if action/place is missing or membership is unclear.
- Mark reused scenes with: "source_scope": "GROUP_REUSED"
- Pair-specific scenes are: "PAIR_EXPLICIT"

PER-PAIR TARGET:
- Try to produce up to 2 scenes per owner+other pair.
- If fewer than 2 eligible scenes exist for a pair, output fewer (do not invent).

OUTPUT:
- Output MUST be valid JSON only (no markdown, no extra text).
- Follow the provided JSON schema exactly.
`.trim();

  const userPrompt = `
Conversation transcript:
---
${transcript}
---

Participants (labels): ${JSON.stringify(normalizedParticipants)}
Owner label: "${owner}"

Your task:
1) Identify the era/background phrase explicitly stated in the transcript and set "era_background".
   If not found, set "era_background" to "UNKNOWN_ERA_BACKGROUND".
2) Create owner-only pairs: for owner "${owner}", pairs (owner + each other participant).
3) For each pair:
   - Extract eligible scenes only when BOTH action and place are explicitly stated.
   - Every scene MUST have 1-3 exact evidence quotes; otherwise omit it.
   - If pair-specific evidence exists, mark "source_scope": "PAIR_EXPLICIT".
   - If only group evidence exists (owner "with friends/everyone/together"), you MAY reuse it across pairs and mark "source_scope": "GROUP_REUSED".
4) For each pair, output up to 2 scenes (choose the 2 most specific if more exist).
5) For each scene, produce "scene_text" that:
   - MUST include the era/background phrase verbatim
   - MUST be a single literal sentence describing action+place
   - MUST NOT contain any pair labels (no "A", "B", "1", "2", "pair:", etc.)
   Example (good):
   "1980년대 대한민국 서울. 하교 후 분식집에서 떡볶이를 먹고 있다."

Hard constraints:
- Do NOT interpret or infer beyond the transcript.
- Do NOT add style keywords.
- Output valid JSON only.

JSON schema (MUST match exactly):
{
  "owner_label": "${owner}",
  "era_background": "string",
  "pairs": [
    {
      "pair": ["${owner}", "X"],
      "scenes": [
        {
          "source_scope": "PAIR_EXPLICIT or GROUP_REUSED",
          "evidence_quotes": ["exact quote 1", "exact quote 2"],
          "action": "string",
          "place": "string",
          "scene_text": "<era_background> + one literal sentence (no pair labels)",
          "do_not_include": ["assumptions", "invented emotions"]
        }
      ]
    }
  ]
}
`.trim();

  const res = await openai.chat.completions.create({
    model: "gpt-4.1-mini",
    temperature: 0,
    messages: [
      { role: "system", content: systemPrompt },
      { role: "user", content: userPrompt },
    ],
  });

  const raw = res.choices?.[0]?.message?.content ?? "";

  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch (e) {
    throw new Error("LLM output is not valid JSON:\n" + raw);
  }

  // -------------------------
  // Post-parse hard enforcement
  // -------------------------
  if (!parsed || typeof parsed !== "object") {
    throw new Error("LLM output JSON is not an object");
  }

  // enforce owner_label
  parsed.owner_label = owner;

  // ensure era_background
  if (!parsed.era_background || typeof parsed.era_background !== "string") {
    parsed.era_background = "UNKNOWN_ERA_BACKGROUND";
  }
  const era = parsed.era_background.trim() || "UNKNOWN_ERA_BACKGROUND";

  // canonical owner-only pairs
  const others = normalizedParticipants.filter((p) => p !== owner);
  const canonicalPairs = others.map((p) => [owner, p]);
  const pairKey = (a, b) => `${String(a)}+${String(b)}`;

  // index incoming pairs (only owner pairs)
  const incomingPairs = Array.isArray(parsed.pairs) ? parsed.pairs : [];
  const incomingMap = new Map();
  for (const item of incomingPairs) {
    if (!item || !Array.isArray(item.pair) || item.pair.length !== 2) continue;
    const [a, b] = item.pair.map(String);
    if (a !== owner && b !== owner) continue;
    const other = a === owner ? b : a;
    incomingMap.set(pairKey(owner, other), item);
  }

  // Build final flat scenes list.
  // Rule: per pair "should be 2", but we DO NOT emit scenes with empty evidence_quotes.
  // => so output per pair may end up < 2 (that's intended per user's instruction).
  const flatScenes = [];
  const pad2 = (n) => String(n).padStart(2, "0");

  for (const [a, b] of canonicalPairs) {
    const key = pairKey(a, b);
    const found = incomingMap.get(key);

    let scenes = [];
    if (found && Array.isArray(found.scenes)) {
      scenes = found.scenes.slice(0, 2);
    }

    scenes
      .filter((s) => s && typeof s === "object")
      .forEach((s, idx) => {
        const sa = String(a);
        const sb = String(b);

        // sanitize evidence quotes first (since empty evidence => drop)
        const evidence_quotes = Array.isArray(s.evidence_quotes)
          ? s.evidence_quotes.map(String).map((q) => q.trim()).filter(Boolean).slice(0, 3)
          : [];

        // ✅ If evidence is empty, do NOT include this scene at all.
        if (evidence_quotes.length === 0) return;

        const scene_id = `${sa}${sb}_${pad2(idx + 1)}`;

        const action =
          typeof s.action === "string" && s.action.trim() ? s.action.trim() : "UNKNOWN_ACTION";

        const place =
          typeof s.place === "string" && s.place.trim() ? s.place.trim() : "UNKNOWN_PLACE";

        let scene_text =
          typeof s.scene_text === "string" && s.scene_text.trim() ? s.scene_text.trim() : "";

        // strip any accidental "pair:" prefix drift
        scene_text = scene_text.replace(/^pair\s*:\s*.*?\/\s*/i, "").trim();

        // enforce era presence always
        if (!scene_text.startsWith(era)) {
          scene_text = `${era}. ${action} ${place}`.trim();
        }

        // final object in the exact scene schema you want
        flatScenes.push({
          scene_id,
          pair: [sa, sb],
          evidence_quotes,
          scene_text,
          do_not_include: ["assumptions", "invented emotions"],
        });
      });
  }

  // final output schema: flat scenes array
  const scenesJson = {
    owner_label: owner,
    era_background: era,
    scenes: flatScenes,
  };

  // Save
  const outPath = path.join(sessionPath, "scenes.json");
  fs.writeFileSync(outPath, JSON.stringify(scenesJson, null, 2), "utf-8");

  return {
    scenesPath: outPath,
    scenesJson,
  };
}
