// backend/services/firestoreService.js
import admin from "firebase-admin";
import { FIRESTORE_PROJECT_ID, FIRESTORE_KEY_PATH } from "../config.js";
import fs from "fs";

// Firestore 초기화
let db = null;

export function initFirestore() {
  if (db) return db;

  if (!FIRESTORE_PROJECT_ID) {
    console.warn("⚠️ FIRESTORE_PROJECT_ID가 설정되지 않았습니다. Firestore 업로드가 비활성화됩니다.");
    return null;
  }

  try {
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
    console.log("✅ Firestore 초기화 완료");
    return db;
  } catch (e) {
    console.error("❌ Firestore 초기화 실패:", e.message);
    return null;
  }
}

/**
 * comfy_results.json 업로드
 * Firestore 구조: SessionID/prompts/comfy_results (필드)
 */
export async function uploadComfyResults(sessionId, comfyResults) {
  const firestore = initFirestore();
  if (!firestore) {
    console.warn("⚠️ Firestore가 초기화되지 않아 comfy_results.json 업로드를 건너뜁니다.");
    return { ok: false, skipped: true };
  }

  try {
    const promptsRef = firestore.collection(sessionId).doc("prompts");
    await promptsRef.set(
      {
        comfy_results: comfyResults,
        updatedAt: admin.firestore.FieldValue.serverTimestamp(),
      },
      { merge: true }
    );

    console.log(`✅ comfy_results.json 업로드 완료: ${sessionId}`);
    return { ok: true };
  } catch (e) {
    console.error(`❌ comfy_results.json 업로드 실패 (${sessionId}):`, e.message);
    return { ok: false, error: e.message };
  }
}

/**
 * 이미지 URL 업로드
 * Firestore 구조: SessionID/generatedImages/{scene_id}/imageUrl (필드)
 */
export async function uploadImageUrl(sessionId, sceneId, imageUrl) {
  const firestore = initFirestore();
  if (!firestore) {
    console.warn("⚠️ Firestore가 초기화되지 않아 이미지 URL 업로드를 건너뜁니다.");
    return { ok: false, skipped: true };
  }

  try {
    const imagesRef = firestore.collection(sessionId).doc("generatedImages");
    await imagesRef.set(
      {
        [sceneId]: {
          imageUrl: imageUrl,
          updatedAt: admin.firestore.FieldValue.serverTimestamp(),
        },
      },
      { merge: true }
    );

    console.log(`✅ 이미지 URL 업로드 완료: ${sessionId}/${sceneId}`);
    return { ok: true };
  } catch (e) {
    console.error(`❌ 이미지 URL 업로드 실패 (${sessionId}/${sceneId}):`, e.message);
    return { ok: false, error: e.message };
  }
}

/**
 * 비디오 URL 업로드
 * Firestore 구조: SessionID/generatedVideos/{scene_id}/videoUrl (필드)
 */
export async function uploadVideoUrl(sessionId, sceneId, videoUrl) {
  const firestore = initFirestore();
  if (!firestore) {
    console.warn("⚠️ Firestore가 초기화되지 않아 비디오 URL 업로드를 건너뜁니다.");
    return { ok: false, skipped: true };
  }

  try {
    const videosRef = firestore.collection(sessionId).doc("generatedVideos");
    await videosRef.set(
      {
        [sceneId]: {
          videoUrl: videoUrl,
          updatedAt: admin.firestore.FieldValue.serverTimestamp(),
        },
      },
      { merge: true }
    );

    console.log(`✅ 비디오 URL 업로드 완료: ${sessionId}/${sceneId}`);
    return { ok: true };
  } catch (e) {
    console.error(`❌ 비디오 URL 업로드 실패 (${sessionId}/${sceneId}):`, e.message);
    return { ok: false, error: e.message };
  }
}

/**
 * 세션의 비디오 URL 가져오기
 * Firestore 구조: SessionID/generatedVideos/{scene_id}/videoUrl (필드)
 */
export async function getVideoUrls(sessionId) {
  const firestore = initFirestore();
  if (!firestore) {
    console.warn("⚠️ Firestore가 초기화되지 않아 비디오 URL을 가져올 수 없습니다.");
    return {};
  }

  try {
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
  } catch (e) {
    console.error(`❌ 비디오 URL 가져오기 실패 (${sessionId}):`, e.message);
    return {};
  }
}
