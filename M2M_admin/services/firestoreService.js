// M2M_admin/services/firestoreService.js
import admin from "firebase-admin";
import { FIRESTORE_PROJECT_ID, FIRESTORE_KEY_PATH } from "../config.js";
import fs from "fs";

// Firestore 초기화
let db = null;

export function initFirestore() {
  if (db) return db;

  if (!FIRESTORE_PROJECT_ID) {
    throw new Error("FIRESTORE_PROJECT_ID가 설정되지 않았습니다");
  }

  if (FIRESTORE_KEY_PATH && fs.existsSync(FIRESTORE_KEY_PATH)) {
    const serviceAccount = JSON.parse(fs.readFileSync(FIRESTORE_KEY_PATH, "utf-8"));
    admin.initializeApp({
      credential: admin.credential.cert(serviceAccount),
      projectId: FIRESTORE_PROJECT_ID,
    });
  } else {
    // 환경 변수에서 직접 인증 정보 사용
    admin.initializeApp({
      projectId: FIRESTORE_PROJECT_ID,
    });
  }

  db = admin.firestore();
  return db;
}

/**
 * 세션의 comfy_results.json 가져오기
 * Firestore 구조: SessionID/prompts/comfy_results (필드)
 */
export async function getComfyResults(sessionId) {
  const firestore = initFirestore();
  const doc = await firestore.collection(sessionId).doc("prompts").get();
  
  if (!doc.exists) {
    throw new Error(`comfy_results.json not found for session ${sessionId}`);
  }

  const data = doc.data();
  return data.comfy_results || null;
}

/**
 * 세션의 이미지 URL 가져오기
 * Firestore 구조: SessionID/generatedImages/{scene_id}/imageUrl (필드)
 */
export async function getImageUrls(sessionId) {
  const firestore = initFirestore();
  const imagesRef = firestore.collection(sessionId).doc("generatedImages");
  const doc = await imagesRef.get();

  if (!doc.exists) {
    return {};
  }

  const data = doc.data();
  const imageUrls = {};

  // generatedImages 문서의 필드에서 가져오기
  // 구조: { scene_id: { imageUrl: "..." }, ... }
  for (const [key, value] of Object.entries(data)) {
    if (value && typeof value === "object" && value.imageUrl) {
      imageUrls[key] = value.imageUrl;
    } else if (typeof value === "string") {
      // 직접 URL인 경우도 처리
      imageUrls[key] = value;
    }
  }

  return imageUrls;
}

/**
 * 세션의 비디오 URL 가져오기
 * Firestore 구조: SessionID/generatedVideos/{scene_id}/videoUrl (필드)
 */
export async function getVideoUrls(sessionId) {
  const firestore = initFirestore();
  const videosRef = firestore.collection(sessionId).doc("generatedVideos");
  const doc = await videosRef.get();

  if (!doc.exists) {
    return {};
  }

  const data = doc.data();
  const videoUrls = {};

  // generatedVideos 문서의 필드에서 가져오기
  // 구조: { scene_id: { videoUrl: "..." }, ... }
  for (const [key, value] of Object.entries(data)) {
    if (value && typeof value === "object" && value.videoUrl) {
      videoUrls[key] = value.videoUrl;
    } else if (typeof value === "string") {
      // 직접 URL인 경우도 처리
      videoUrls[key] = value;
    }
  }

  return videoUrls;
}

/**
 * 비디오 URL 업데이트 (재생성 후)
 */
export async function updateVideoUrl(sessionId, sceneId, newVideoUrl) {
  const firestore = initFirestore();
  const videosRef = firestore.collection(sessionId).doc("generatedVideos");
  
  await videosRef.set(
    {
      [sceneId]: {
        videoUrl: newVideoUrl,
        updatedAt: admin.firestore.FieldValue.serverTimestamp(),
      },
    },
    { merge: true }
  );

  return { ok: true, sceneId, newVideoUrl };
}

/**
 * comfy_results.json 업데이트 (재생성 후)
 */
export async function updateComfyResults(sessionId, comfyResults) {
  const firestore = initFirestore();
  const promptsRef = firestore.collection(sessionId).doc("prompts");
  
  await promptsRef.set(
    {
      comfy_results: comfyResults,
      updatedAt: admin.firestore.FieldValue.serverTimestamp(),
    },
    { merge: true }
  );

  return { ok: true };
}
