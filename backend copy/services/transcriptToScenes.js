// backend/services/transcriptToScenes.js
import dotenv from "dotenv";
import fs from "fs";
import OpenAI from "openai";
import path from "path";
import { fileURLToPath } from "url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// NOTE: your .env is expected at backend/.env (one level up from /services)
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
 * - The transcript contains an explicit time-period phrase (e.g., "1980년대")  ✅ (TIME MUST exist)
 * - Country may be missing; default to "한국"
 *
 * Output:
 * - Flat "scenes": [ ... ]
 * - Each scene: { scene_id, pair, evidence_quotes, scene_text }
 *
 * Critical constraints (enforced):
 * - Generate scenes ONLY for owner+other pairs
 * - For EACH pair, LLM must output EXACTLY 2 scenes (prompt-enforced)
 * - If evidence_quotes is empty OR action is missing, we drop that scene (do not send to ComfyUI)
 * - scene_text must be an IMAGE-GEN SCENE PROMPT (location + activity + optional mood if explicit)
 * - scene_text must NOT contain pair labels (A/B/1/2 etc.)
 * - scene_text should follow: "<TIME> <COUNTRY> 친구와 함께 ...하고 있다."
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
You are a strict transcript-to-scenes extractor for IMAGE GENERATION prompts.

ABSOLUTE RULES:
- Do NOT interpret or infer unstated details.
- Do NOT add cinematic/style keywords (no "cinematic", "vintage", "high quality", etc.).
- Use ONLY what is explicitly stated in the transcript.
- Every scene MUST include 1–3 verbatim evidence quotes.
- Never use participant labels (A/B/1/2 etc.) in scene_text.

TIME + COUNTRY PREFIX:
- Extract a time-period phrase that is explicitly stated in the transcript (e.g., "1980년대", "1990년대").
- TIME MUST exist in the transcript.
- Country: if explicitly stated, use it; otherwise use "한국".
- Prefix must be: "<TIME> <COUNTRY>" (no extra punctuation).
- Do NOT include city/region/place in the prefix.

PAIRING + COUNT:
- Generate scenes ONLY for (owner + each other participant).
- For EACH pair, output EXACTLY 2 scenes.
- Distribute activities across pairs to minimize duplication:
  - Do NOT reuse the same activity across pairs until all distinct activities are used at least once.
  - Within a pair, the two scenes must be different.
  - If activities are insufficient, split broad activities into explicit sub-activities mentioned (떡볶이/팥빙수/돈까스, 명동/이대, 사진 찍기/구경하기 등).

PLACE:
- "place" may be a region OR a concrete place type (공원, 떡볶이집, 카페, 길거리, 옷가게 등).
- Use only what is explicitly stated; if none, use "UNKNOWN_PLACE".
- If the transcript is uncertain (e.g., "한림공원인가 한림농원인가"), keep that uncertainty literally.

CRITICAL: scene_text MUST be a SCENE DESCRIPTION (NOT a summary)
- scene_text is an image-generation prompt that must be visually scene-able.
- It must include:
  1) location/background (where) if available
  2) activity/action (what they are doing)
  3) mood/feeling ONLY if explicitly stated; otherwise omit mood.
- scene_text must NOT be abstract like "성차별에 대해 이야기하고 있다".
  Instead it must be grounded in an activity + setting, e.g.:
  "1990년대 한국 친구와 함께 떡볶이집에서 떡볶이를 먹으며 성차별 이야기를 나누고 있다."
- Prefer concrete present progressive verbs: 먹고 있다 / 걷고 있다 / 산책하고 있다 / 구경하고 있다 / 사진을 찍고 있다 / 공유하고 있다
- If including conversation content, attach it to an activity (e.g., "떡볶이를 먹으며 ~ 이야기를 나누고 있다").

SCENE_TEXT FORMAT (must follow):
- ONE Korean sentence.
- Present progressive.
- Must follow:
  "<TIME> <COUNTRY> 친구와 함께 <PLACE_PHRASE><ACTIVITY_PHRASE><MOOD_PHRASE>."
  where:
  - <PLACE_PHRASE>:
     - if place known: "<PLACE>에서 " (or "<PLACE> 근처에서 ")
     - if UNKNOWN_PLACE: "" (empty)
  - <ACTIVITY_PHRASE>: concrete action in present progressive
  - <MOOD_PHRASE>: only if explicitly stated; keep it short

OUTPUT:
- Output valid JSON only.
- Follow the schema exactly.
`.trim();

  const userPrompt = `
Conversation transcript:
---
${transcript}
---

Participants: ${JSON.stringify(normalizedParticipants)}
Owner label: "${owner}"

TASK (follow steps in order):

Step 1) Extract TIME and COUNTRY:
- TIME: extract the exact time-period phrase present in the transcript (e.g., "1980년대"). TIME MUST exist.
- COUNTRY: extract if explicitly stated; otherwise set to "한국".

Step 2) Build an ACTIVITY BANK:
- Extract distinct activities mentioned in the transcript.
- If a broad activity lists explicit items, split into explicit sub-activities
  (e.g., 떡볶이 / 팥빙수 / 돈까스; 명동 쇼핑 / 이대 쇼핑; 사진 찍기 / 구경하기).
- Each activity/sub-activity must include:
  - action (concrete)
  - place (explicit, or UNKNOWN_PLACE)
  - evidence_quotes (1–3 verbatim quotes)

Step 3) Create owner-only pairs: (owner + each other participant).

Step 4) Assign EXACTLY 2 scenes per pair with minimum duplication:
- Distribute activities so different pairs get different activities first.
- Within the same pair, the two scenes must be different.

Step 5) Write scene_text as an image generation prompt:
- Must be ONE Korean sentence, present progressive.
- Must start with "<TIME> <COUNTRY> 친구와 함께 "
- If place is known: include "<PLACE>에서 "
- If place is UNKNOWN_PLACE: do not mention a place
- Must include action/activity (and attach conversation content only if it helps scene-ability)
- Mood only if explicitly stated

OUTPUT JSON schema (MUST match exactly):
{
  "owner_label": "${owner}",
  "pairs": [
    {
      "pair": ["${owner}", "X"],
      "scenes": [
        {
          "source_scope": "PAIR_EXPLICIT or GROUP_ACTIVITY",
          "evidence_quotes": ["exact quote 1", "exact quote 2"],
          "action": "string",
          "place": "string",
          "scene_text": "string"
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
  // LLM is instructed to output exactly 2 scenes per pair,
  // but we still drop scenes without evidence/action to avoid sending garbage to image gen.
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

        const evidence_quotes = Array.isArray(s.evidence_quotes)
          ? s.evidence_quotes.map(String).map((q) => q.trim()).filter(Boolean).slice(0, 3)
          : [];

        // Drop if no evidence
        if (evidence_quotes.length === 0) return;

        const action =
          typeof s.action === "string" && s.action.trim() ? s.action.trim() : "UNKNOWN_ACTION";
        if (action === "UNKNOWN_ACTION") return;

        const place =
          typeof s.place === "string" && s.place.trim() ? s.place.trim() : "UNKNOWN_PLACE";

        let scene_text =
          typeof s.scene_text === "string" && s.scene_text.trim() ? s.scene_text.trim() : "";

        // strip accidental "pair:" drift
        scene_text = scene_text.replace(/^pair\s*:\s*.*?\/\s*/i, "").trim();

        // Last safety: ensure it doesn't contain labels like "A", "B", "1", "2" as standalone tokens.
        // (We avoid aggressive removal to not break Korean text; just basic token check.)
        // If it fails, keep it (you can choose to drop instead).
        // Example drop behavior:
        // if (/(^|\s)(A|B|C|D|E|\d+)(\s|$)/.test(scene_text)) return;

        const scene_id = `${sa}${sb}_${pad2(idx + 1)}`;

        flatScenes.push({
          scene_id,
          pair: [sa, sb],
          evidence_quotes,
          scene_text,
        });
      });
  }

  // final output schema: flat scenes array
  const scenesJson = {
    owner_label: owner,
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
