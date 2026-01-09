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
 * @param {Object} params
 * @param {string} params.transcript   - STT 결과 텍스트
 * @param {string[]} params.participants - ["A","B","C"]
 * @param {string} params.ownerLabel     - 항상 "A"
 * @param {string} params.sessionPath    - data/sessions/<sessionId>
 */
export async function transcriptToScenes({
  transcript,
  participants,
  ownerLabel = "A",
  sessionPath,
}) {
  if (!transcript || !sessionPath) {
    throw new Error("transcript and sessionPath are required");
  }

  const systemPrompt = `
You are a strict information extractor.

Your task is NOT to summarize or interpret the conversation.
Your task is to extract only scene candidates that are explicitly mentioned.

Do NOT infer emotions, relationships, or intentions.
Do NOT add details that are not explicitly stated.
If information is missing, use neutral placeholders.

You must follow the output JSON schema exactly.
  `.trim();

  const userPrompt = `
Conversation transcript:
---
${transcript}
---

Participants: ${JSON.stringify(participants)}
Owner label: "${ownerLabel}"

Instructions:
1. Extract scene candidates ONLY when an action and a place are explicitly mentioned.
2. Each scene must be based on direct evidence from the transcript.
3. Do NOT invent emotions, relationships, or context.
4. Limit the number of scenes to a maximum of 4.
5. Use neutral, documentary-style language suitable for image generation.
6. Output must be valid JSON following the schema below.

JSON schema:
{
  "owner_label": "${ownerLabel}",
  "scenes": [
    {
      "scene_id": "AB_01",
      "pair": ["${ownerLabel}", "B"],
      "evidence_quotes": ["exact quote from transcript"],
      "scene_text": "Neutral visual description suitable for image generation",
      "do_not_include": ["assumptions", "invented emotions"]
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

  const raw = res.choices[0].message.content;

  let scenesJson;
  try {
    scenesJson = JSON.parse(raw);
  } catch (e) {
    throw new Error("LLM output is not valid JSON:\n" + raw);
  }

  // 파일 저장
  const outPath = path.join(sessionPath, "scenes.json");
  fs.writeFileSync(outPath, JSON.stringify(scenesJson, null, 2), "utf-8");

  return {
    scenesPath: outPath,
    scenesJson,
  };
}
