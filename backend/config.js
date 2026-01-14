// backend/config.js
import "dotenv/config";
import path from "path";
import fs from "fs";
import { fileURLToPath } from "url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// 서버 설정
export const PORT = process.env.PORT || 3001;

// ComfyUI 설정
export const COMFY_URL = process.env.COMFY_URL || "http://143.248.107.38:8188";
export const COMFY_STATIC_BASE = process.env.COMFY_STATIC_BASE || "http://143.248.107.38:8186";
export const COMFY_API_KEY = process.env.COMFY_API_KEY || "";

// OpenAI 설정
export const OPENAI_API_KEY = process.env.OPENAI_API_KEY || "";

// 세션 디렉토리
export const SESSIONS_DIR = path.join(__dirname, "..", "data", "sessions");
fs.mkdirSync(SESSIONS_DIR, { recursive: true });

// 워크플로우 경로
export const IMAGE_WORKFLOW_PATH = path.join(__dirname, "workflows", "M2M_image_api.json");
export const VIDEO_WORKFLOW_PATH = path.join(__dirname, "workflows", "M2M_video_api.json");

// Python 스크립트 경로
export const PYTHON_SCRIPT_PATH = path.join(__dirname, "scripts", "generate_image.py");

// Firestore 설정
export const FIRESTORE_PROJECT_ID = process.env.FIRESTORE_PROJECT_ID || "";
export const FIRESTORE_KEY_PATH = process.env.FIRESTORE_KEY_PATH || path.join(__dirname, "serviceAccountKey.json");
