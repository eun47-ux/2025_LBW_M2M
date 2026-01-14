// M2M_admin/config.js
import "dotenv/config";
import path from "path";
import fs from "fs";
import { fileURLToPath } from "url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// 서버 설정
export const PORT = process.env.ADMIN_PORT || 3002;

// Firestore 설정
export const FIRESTORE_PROJECT_ID = process.env.FIRESTORE_PROJECT_ID || "";
export const FIRESTORE_KEY_PATH = process.env.FIRESTORE_KEY_PATH || "";

// ComfyUI 설정 (재생성용)
export const COMFY_URL = process.env.COMFY_URL || "http://143.248.107.38:8188";
export const COMFY_STATIC_BASE = process.env.COMFY_STATIC_BASE || "http://143.248.107.38:8186";
export const COMFY_API_KEY = process.env.COMFY_API_KEY || "";

// 세션 디렉토리 (로컬 저장용)
export const ADMIN_SESSIONS_DIR = path.join(__dirname, "sessions");
fs.mkdirSync(ADMIN_SESSIONS_DIR, { recursive: true });

// 워크플로우 경로 (재생성용)
export const VIDEO_WORKFLOW_PATH = path.join(__dirname, "..", "backend", "workflows", "M2M_video_api.json");
