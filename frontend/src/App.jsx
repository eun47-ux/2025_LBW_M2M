// frontend/src/App.jsx
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import Cropper from "react-easy-crop";

/**
 * Utilities
 */
function clamp(v, min, max) {
  return Math.max(min, Math.min(max, v));
}

function uid() {
  return Math.random().toString(36).slice(2, 10);
}

/**
 * Convert an image URL to a loaded HTMLImageElement
 */
function createImage(url) {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.addEventListener("load", () => resolve(img));
    img.addEventListener("error", (e) => reject(e));
    img.crossOrigin = "anonymous";
    img.src = url;
  });
}

/**
 * Crop from source image using pixel rect (x,y,width,height)
 * return Blob (image/png)
 */
async function getCroppedBlob(imageSrc, pixelCrop) {
  const image = await createImage(imageSrc);
  const canvas = document.createElement("canvas");
  const ctx = canvas.getContext("2d");

  canvas.width = Math.max(1, Math.floor(pixelCrop.width));
  canvas.height = Math.max(1, Math.floor(pixelCrop.height));

  ctx.drawImage(
    image,
    pixelCrop.x,
    pixelCrop.y,
    pixelCrop.width,
    pixelCrop.height,
    0,
    0,
    canvas.width,
    canvas.height
  );

  return new Promise((resolve) => {
    canvas.toBlob((blob) => resolve(blob), "image/png", 0.95);
  });
}

/**
 * Expand crop rect by padding ratios (hair + shoulders + clothes)
 * padding is applied in pixel space based on rect size.
 */
function expandPixelRect(rect, imgW, imgH, pad = { left: 0.12, right: 0.12, top: 0.18, bottom: 0.35 }) {
  const padL = rect.width * pad.left;
  const padR = rect.width * pad.right;
  const padT = rect.height * pad.top;
  const padB = rect.height * pad.bottom;

  const x1 = clamp(Math.floor(rect.x - padL), 0, imgW - 1);
  const y1 = clamp(Math.floor(rect.y - padT), 0, imgH - 1);
  const x2 = clamp(Math.ceil(rect.x + rect.width + padR), 0, imgW);
  const y2 = clamp(Math.ceil(rect.y + rect.height + padB), 0, imgH);

  return { x: x1, y: y1, width: x2 - x1, height: y2 - y1 };
}

/**
 * Assign numeric labels left-to-right: 1,2,3...
 */
function assignLabelsLeftToRight(crops) {
  const sorted = [...crops].sort((a, b) => a.rect.x + a.rect.width / 2 - (b.rect.x + b.rect.width / 2));
  const labels = {};
  for (let i = 0; i < sorted.length; i++) {
    labels[String(i + 1)] = sorted[i].id;
  }
  return labels;
}

export default function App() {
  // image
  const [imageFile, setImageFile] = useState(null);
  const [imageURL, setImageURL] = useState(null);
  const [imgNatural, setImgNatural] = useState({ w: 0, h: 0 });

  // cropper state (current editing crop)
  const [crop, setCrop] = useState({ x: 0, y: 0 }); // react-easy-crop "crop"
  const [zoom, setZoom] = useState(1);
  const [aspect, setAspect] = useState(3 / 4); // portrait-ish
  const [croppedAreaPixels, setCroppedAreaPixels] = useState(null);

  // saved crops list
  // each: {id, previewUrl, blob, rect(pixel rect), createdAt}
  const [cropsSaved, setCropsSaved] = useState([]);
  const [ownerId, setOwnerId] = useState(null);

  // session ID (required, input first)
  const [sessionIdInput, setSessionIdInput] = useState("");
  const [sessionId, setSessionId] = useState(null);
  const [sessionCreating, setSessionCreating] = useState(false);
  const [audioFile, setAudioFile] = useState(null);
  const [audioUploading, setAudioUploading] = useState(false);
  const [audioUploadProgress, setAudioUploadProgress] = useState(0);
  const [sttLoading, setSttLoading] = useState(false);
  const [sttPreview, setSttPreview] = useState("");
  const [scenesLoading, setScenesLoading] = useState(false);
  const [scenesPreview, setScenesPreview] = useState(null);
  const [runImagesLoading, setRunImagesLoading] = useState(false);
  const [runImagesResults, setRunImagesResults] = useState(null);
  const [runVideosLoading, setRunVideosLoading] = useState(false);
  const [runVideosResults, setRunVideosResults] = useState(null);
  const [concatLoading, setConcatLoading] = useState(false);
  const [finalVideoPath, setFinalVideoPath] = useState("");
  const [finalVideoUrl, setFinalVideoUrl] = useState("");
  const [playlistLoading, setPlaylistLoading] = useState(false);
  const [playlistItems, setPlaylistItems] = useState([]);
  const [playlistIndex, setPlaylistIndex] = useState(0);
  const [playlistMode, setPlaylistMode] = useState("");
  const playlistVideoRef = useRef(null);

  // cleanup object urls
  useEffect(() => {
    return () => {
      if (imageURL) URL.revokeObjectURL(imageURL);
      cropsSaved.forEach((c) => URL.revokeObjectURL(c.previewUrl));
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    if (!playlistItems.length) return;
    const video = playlistVideoRef.current;
    if (!video) return;
    video.load();
    video.play().catch(() => {});
  }, [playlistIndex, playlistItems]);

  const onSelectImage = async (e) => {
    const f = e.target.files?.[0];
    if (!f) return;

    // cleanup previous
    if (imageURL) URL.revokeObjectURL(imageURL);
    cropsSaved.forEach((c) => URL.revokeObjectURL(c.previewUrl));

    setImageFile(f);
    const url = URL.createObjectURL(f);
    setImageURL(url);
    setCropsSaved([]);
    setOwnerId(null);
    setSessionId(null);
    setAudioFile(null);
    setAudioUploading(false);
    setAudioUploadProgress(0);
    setSttLoading(false);
    setSttPreview("");
    setScenesLoading(false);
    setScenesPreview(null);
    setRunImagesLoading(false);
    setRunImagesResults(null);
    setRunVideosLoading(false);
    setRunVideosResults(null);
    setConcatLoading(false);
    setFinalVideoPath("");
    setFinalVideoUrl("");
    setCrop({ x: 0, y: 0 });
    setZoom(1);

    // read natural size
    const img = await createImage(url);
    setImgNatural({ w: img.naturalWidth, h: img.naturalHeight });
  };

  const onCropComplete = useCallback((_, croppedPixels) => {
    setCroppedAreaPixels(croppedPixels);
  }, []);

  const saveCurrentCrop = async () => {
    if (!imageURL || !croppedAreaPixels) return;
    if (!imgNatural.w || !imgNatural.h) return;

    // Expand for hair/shoulders/clothes
    const expanded = expandPixelRect(croppedAreaPixels, imgNatural.w, imgNatural.h);

    const blob = await getCroppedBlob(imageURL, expanded);
    if (!blob) return;

    const previewUrl = URL.createObjectURL(blob);

    const item = {
      id: uid(),
      blob,
      previewUrl,
      rect: expanded, // pixel rect in original image coordinates
      createdAt: Date.now(),
    };

    setCropsSaved((prev) => [...prev, item]);
  };

  const removeCrop = (id) => {
    setCropsSaved((prev) => {
      const target = prev.find((c) => c.id === id);
      if (target) URL.revokeObjectURL(target.previewUrl);
      return prev.filter((c) => c.id !== id);
    });
    if (ownerId === id) setOwnerId(null);
  };

  const labelMap = useMemo(() => assignLabelsLeftToRight(cropsSaved), [cropsSaved]);

  const ownerLabel = useMemo(() => {
    if (!ownerId) return null;
    const entry = Object.entries(labelMap).find(([, id]) => id === ownerId);
    return entry ? entry[0] : null;
  }, [ownerId, labelMap]);

  const cropLabelById = useMemo(() => {
    const map = {};
    for (const [label, id] of Object.entries(labelMap)) {
      map[id] = label;
    }
    return map;
  }, [labelMap]);

  /**
   * Upload to backend (optional endpoint)
   * - photo original
   * - crops as files
   * - ownerId
   * - labelMap
   */
  const uploadSessionToBackend = async () => {
    if (!sessionId) {
      alert("먼저 세션 ID를 입력하고 확인 버튼을 클릭해주세요.");
      return;
    }

    if (!imageFile || !ownerId || cropsSaved.length < 2) {
      alert("이미지 업로드 + 크롭 2개 이상 + Owner 선택이 필요해요.");
      return;
    }

    const form = new FormData();
    form.append("photo", imageFile); // optional: original
    form.append("ownerId", ownerId);
    form.append("labelMap", JSON.stringify(labelMap));

    cropsSaved.forEach((c, idx) => {
      // create a filename that helps comfy/ui
      form.append("crops", c.blob, `crop_${idx + 1}.png`);
      form.append("cropMeta", JSON.stringify({ id: c.id, rect: c.rect })); // repeated fields are ok
    });

    try {
      // 크롭 정보 업데이트
      const res = await fetch(`http://localhost:3001/api/session/${sessionId}/update-crops`, {
        method: "POST",
        body: form,
      });

      const data = await res.json();
      if (!data.ok) {
        console.error(data);
        alert("업로드 실패. 콘솔 확인!");
        return;
      }

      // labels.json 생성 (크롭 추출 + ComfyUI 업로드)
      const labelsRes = await fetch(`http://localhost:3001/api/session/${sessionId}/build-labels`, {
        method: "POST",
      });
      const labelsJson = await labelsRes.json();
      console.log("build-labels:", labelsJson);
      if (!labelsJson.ok) {
        alert("labels 생성 실패: " + (labelsJson.error || ""));
        return;
      }

      setSttPreview("");
      setScenesPreview(null);
      setRunImagesResults(null);
      setRunVideosResults(null);
      setFinalVideoPath("");
      setFinalVideoUrl("");
      alert("저장 완료! 크롭 정보가 업로드되고 labels.json이 생성되었습니다.");
    } catch (e) {
      console.error(e);
      alert("저장 실패: " + (e?.message || String(e)));
    }
  };

  // 세션 생성
  const createSession = async () => {
    if (!sessionIdInput.trim()) {
      alert("세션 ID를 입력해주세요.");
      return;
    }

    setSessionCreating(true);
    try {
      const res = await fetch("http://localhost:3001/api/session/create", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ sessionId: sessionIdInput.trim() }),
      });
      const json = await res.json();
      if (!json.ok) {
        alert("세션 생성 실패: " + (json.error || ""));
        return;
      }
      setSessionId(json.sessionId);
      alert(`세션 생성 완료! sessionId=${json.sessionId}`);
    } catch (e) {
      console.error(e);
      alert("세션 생성 실패: " + (e?.message || String(e)));
    } finally {
      setSessionCreating(false);
    }
  };

  return (
    <div style={{ padding: 16, fontFamily: "system-ui, -apple-system, Segoe UI, Roboto" }}>
      <h2 style={{ margin: 0 }}>🧩 Manual Crop + Owner Select (MVP)</h2>
      
      {/* 1단계: 세션 ID 입력 */}
      <div style={{ marginTop: 16, padding: 16, background: "#f9f9f9", borderRadius: 12, border: "2px solid #ddd" }}>
        <h3 style={{ margin: "0 0 12px 0", fontSize: 16 }}>1단계: 세션 ID 입력 (필수)</h3>
        <div style={{ display: "flex", gap: 12, alignItems: "center" }}>
          <input
            value={sessionIdInput}
            onChange={(e) => setSessionIdInput(e.target.value)}
            placeholder="세션 ID 입력 (예: test01)"
            style={{ padding: 10, border: "1px solid #ddd", borderRadius: 8, minWidth: 220, flex: 1 }}
            disabled={!!sessionId}
          />
          <button
            onClick={createSession}
            disabled={!sessionIdInput.trim() || sessionCreating || !!sessionId}
            style={{
              padding: "10px 20px",
              borderRadius: 10,
              border: "1px solid #ddd",
              background: sessionId ? "#4CAF50" : "#111",
              color: "white",
              cursor: sessionId || !sessionIdInput.trim() ? "not-allowed" : "pointer",
            }}
          >
            {sessionCreating ? "생성 중..." : sessionId ? "✅ 생성 완료" : "확인"}
          </button>
        </div>
        {sessionId && (
          <p style={{ marginTop: 8, fontSize: 12, color: "#4CAF50" }}>
            ✅ 세션 ID: <strong>{sessionId}</strong>
          </p>
        )}
      </div>

      {/* 2단계: 인물 크롭 + Owner 지정 */}
      <div style={{ marginTop: 24 }}>
        <h3 style={{ margin: "0 0 12px 0", fontSize: 16 }}>2단계: 인물 크롭 + Owner 지정</h3>
        {!sessionId && (
          <p style={{ color: "orange", fontSize: 14 }}>
            ⚠️ 먼저 세션 ID를 입력하고 확인 버튼을 클릭해주세요.
          </p>
        )}
        <div style={{ display: "flex", gap: 16, flexWrap: "wrap", alignItems: "center" }}>
          <input type="file" accept="image/*" onChange={onSelectImage} disabled={!sessionId} />

          <button
            onClick={uploadSessionToBackend}
            style={{
              padding: "10px 12px",
              borderRadius: 10,
              border: "1px solid #ddd",
              background: ownerId && sessionId ? "#111" : "#eee",
              color: ownerId && sessionId ? "white" : "#777",
              cursor: ownerId && sessionId ? "pointer" : "not-allowed",
            }}
            disabled={!ownerId || !sessionId}
            title="크롭 저장 및 백엔드 업로드"
          >
            저장
          </button>
        </div>
      </div>

      <hr style={{ margin: "20px 0" }} />

      {/* 3단계: 오디오 업로드 + 씬 생성 */}
      <div>
        <h3 style={{ margin: "0 0 12px 0", fontSize: 16 }}>3단계: 오디오 업로드 + 씬 생성</h3>
        <h4 style={{ margin: "8px 0", fontSize: 14, color: "#555" }}>🎙️ 대화 녹음 업로드</h4>

      <input
        type="file"
        accept="audio/*"
        onChange={(e) => {
          setAudioFile(e.target.files?.[0] || null);
          setAudioUploading(false);
          setAudioUploadProgress(0);
        }}
      />

      <button
        disabled={!sessionId || !audioFile || audioUploading}
        onClick={async () => {
          const fd = new FormData();
          fd.append("audio", audioFile);

          setAudioUploading(true);
          setAudioUploadProgress(0);

          const xhr = new XMLHttpRequest();
          xhr.open("POST", `http://localhost:3001/api/session/${sessionId}/upload-audio`);

          xhr.upload.onprogress = (e) => {
            if (!e.lengthComputable) return;
            const percent = Math.round((e.loaded / e.total) * 100);
            setAudioUploadProgress(percent);
          };

          xhr.onload = () => {
            setAudioUploading(false);
            try {
              const json = JSON.parse(xhr.responseText || "{}");
              console.log("upload-audio:", json);
              if (!json.ok || xhr.status >= 400) {
                alert("오디오 업로드 실패: " + (json.error || xhr.statusText || "unknown error"));
                return;
              }
              setAudioUploadProgress(100);
              setSttPreview("");
              alert("오디오 업로드 성공!");
            } catch (err) {
              console.error(err);
              alert("오디오 업로드 실패: 응답 파싱 오류");
            }
          };

          xhr.onerror = () => {
            setAudioUploading(false);
            alert("오디오 업로드 실패: 네트워크 오류");
          };

          xhr.send(fd);
        }}
        style={{ marginLeft: 10 }}
      >
        {audioUploading ? "업로드 중..." : "오디오 업로드"}
      </button>

      {audioUploading && (
        <div style={{ marginTop: 8, display: "flex", alignItems: "center", gap: 8 }}>
          <progress value={audioUploadProgress} max="100" style={{ width: 240 }} />
          <span style={{ fontSize: 12, color: "#555" }}>{audioUploadProgress}%</span>
        </div>
      )}

      <button
        disabled={!sessionId || sttLoading || audioUploading}
        onClick={async () => {
          setSttLoading(true);
          try {
            const res = await fetch(`http://localhost:3001/api/session/${sessionId}/stt`, {
              method: "POST",
            });
            const json = await res.json();
          console.log("stt:", json);

            if (!json.ok) alert("STT 실패: " + (json.error || ""));
            else {
              setSttPreview(json.preview || "");
              setScenesPreview(null);
              setRunImagesResults(null);
              setRunVideosResults(null);
              setFinalVideoPath("");
              setFinalVideoUrl("");
              alert("STT 완료! transcript.txt 생성됨");
            }
          } catch (e) {
            console.error(e);
            alert("STT 실패: " + (e?.message || String(e)));
          } finally {
          setSttLoading(false);
        }
      }}
      style={{ marginLeft: 10 }}
    >
      {sttLoading ? "STT 실행 중..." : "STT 실행"}
    </button>

      <button
        disabled={!sessionId || scenesLoading || sttLoading || audioUploading}
        onClick={async () => {
          setScenesLoading(true);
          try {
            const res = await fetch(`http://localhost:3001/api/session/${sessionId}/scenes`, {
              method: "POST",
            });
            const json = await res.json();
            console.log("scenes:", json);

            if (!json.ok) alert("Scenes 생성 실패: " + (json.error || ""));
            else {
              setScenesPreview(json.scenesPreviewFirst || null);
              setRunImagesResults(null);
              setRunVideosResults(null);
              setFinalVideoPath("");
              setFinalVideoUrl("");
              alert("Scenes 생성 완료! scenes.json 생성됨");
            }
          } catch (e) {
            console.error(e);
            alert("Scenes 생성 실패: " + (e?.message || String(e)));
          } finally {
            setScenesLoading(false);
          }
        }}
        style={{ marginLeft: 10 }}
      >
        {scenesLoading ? "Scenes 생성 중..." : "Scenes 생성"}
      </button>
      </div>

      {/* 4단계: 영상 생성 */}
      <div style={{ marginTop: 24 }}>
        <h3 style={{ margin: "0 0 12px 0", fontSize: 16 }}>4단계: 영상 생성</h3>
        <div style={{ display: "flex", gap: 12, flexWrap: "wrap", alignItems: "center" }}>
          <button
            disabled={!sessionId || runImagesLoading || scenesLoading || sttLoading || audioUploading}
            onClick={async () => {
              setRunImagesLoading(true);
              try {
                const res = await fetch(`http://localhost:3001/api/session/${sessionId}/run-images`, {
                  method: "POST",
                });
                const json = await res.json();
                console.log("run-images:", json);

                if (!json.ok) alert("이미지 생성 실패: " + (json.error || ""));
                else {
                  setRunImagesResults(json.results || []);
                  setRunVideosResults(null);
                  setFinalVideoPath("");
                  setFinalVideoUrl("");
                  alert("이미지 생성 완료!");
                }
              } catch (e) {
                console.error(e);
                alert("이미지 생성 실패: " + (e?.message || String(e)));
              } finally {
                setRunImagesLoading(false);
              }
            }}
            style={{
              padding: "10px 20px",
              borderRadius: 10,
              border: "1px solid #ddd",
              background: "#111",
              color: "white",
            }}
          >
            {runImagesLoading ? "이미지 생성 중..." : "이미지 생성"}
          </button>

          <button
            disabled={!sessionId || runVideosLoading || scenesLoading || sttLoading || audioUploading}
            onClick={async () => {
              setRunVideosLoading(true);
              try {
                const res = await fetch(`http://localhost:3001/api/session/${sessionId}/run-videos`, {
                  method: "POST",
                });
                const json = await res.json();
                console.log("run-videos:", json);

                if (!json.ok) alert("영상 생성 실패: " + (json.error || ""));
                else {
                  setRunVideosResults(json.results || []);
                  setFinalVideoPath("");
                  setFinalVideoUrl("");
                  alert("영상 생성 완료!");
                }
              } catch (e) {
                console.error(e);
                alert("영상 생성 실패: " + (e?.message || String(e)));
              } finally {
                setRunVideosLoading(false);
              }
            }}
            style={{
              padding: "10px 20px",
              borderRadius: 10,
              border: "1px solid #ddd",
              background: "#111",
              color: "white",
            }}
          >
            {runVideosLoading ? "영상 생성 중..." : "영상 생성"}
          </button>
        </div>
      </div>

      {/* 디버깅: P1 세션 이미지 다운로드 + 비디오 생성 테스트 */}
      <div style={{ marginTop: 24, padding: 16, background: "#fff3cd", borderRadius: 12, border: "2px solid #ffc107" }}>
        <h3 style={{ margin: "0 0 12px 0", fontSize: 16, color: "#856404" }}>🔧 디버깅: P1 세션 이미지 다운로드 + 비디오 생성 테스트</h3>
        <button
          disabled={runImagesLoading || runVideosLoading}
          onClick={async () => {
            const testSessionId = "P1";
            
            // 1단계: 이미지 다운로드
            setRunImagesLoading(true);
            try {
              console.log("[DEBUG] 이미지 다운로드 시작...");
              const imageRes = await fetch(`http://localhost:3001/api/session/${testSessionId}/run-images`, {
                method: "POST",
              });
              const imageJson = await imageRes.json();
              console.log("디버깅 - run-images:", imageJson);

              if (!imageJson.ok) {
                alert("이미지 다운로드 실패: " + (imageJson.error || ""));
                setRunImagesLoading(false);
                return;
              }
              
              setRunImagesResults(imageJson.results || []);
              alert(`이미지 다운로드 완료! (${imageJson.resultsCount || 0}개)`);
            } catch (e) {
              console.error(e);
              alert("이미지 다운로드 실패: " + (e?.message || String(e)));
              setRunImagesLoading(false);
              return;
            } finally {
              setRunImagesLoading(false);
            }

            // 2단계: 비디오 생성
            setRunVideosLoading(true);
            try {
              console.log("[DEBUG] 비디오 생성 시작...");
              const videoRes = await fetch(`http://localhost:3001/api/session/${testSessionId}/run-videos`, {
                method: "POST",
              });
              const videoJson = await videoRes.json();
              console.log("디버깅 - run-videos:", videoJson);

              if (!videoJson.ok) {
                alert("비디오 생성 실패: " + (videoJson.error || ""));
              } else {
                setRunVideosResults(videoJson.results || []);
                setFinalVideoPath("");
                setFinalVideoUrl("");
                alert(`비디오 생성 완료! (${videoJson.resultsCount || 0}개)`);
              }
            } catch (e) {
              console.error(e);
              alert("비디오 생성 실패: " + (e?.message || String(e)));
            } finally {
              setRunVideosLoading(false);
            }
          }}
          style={{
            padding: "10px 20px",
            borderRadius: 10,
            border: "1px solid #ffc107",
            background: "#ffc107",
            color: "#000",
            fontWeight: "bold",
            cursor: runImagesLoading || runVideosLoading ? "not-allowed" : "pointer",
          }}
        >
          {runImagesLoading
            ? "이미지 다운로드 중..."
            : runVideosLoading
            ? "비디오 생성 중..."
            : "P1 이미지 다운로드 + 비디오 생성 테스트"}
        </button>
      </div>

      <button
        disabled={!sessionId || concatLoading || runVideosLoading || scenesLoading || sttLoading || audioUploading}
        onClick={async () => {
          setConcatLoading(true);
          try {
            const res = await fetch(`http://localhost:3001/api/session/${sessionId}/concat-videos`, {
              method: "POST",
            });
            const json = await res.json();
            console.log("concat-videos:", json);

            if (!json.ok) alert("영상 합치기 실패: " + (json.error || ""));
            else {
              setFinalVideoPath(json.finalPath || "");
              setFinalVideoUrl(
                json.finalPath ? `http://localhost:3001/sessions/${sessionId}/final.mp4` : ""
              );
              alert("영상 합치기 완료! final.mp4 생성됨");
            }
          } catch (e) {
            console.error(e);
            alert("영상 합치기 실패: " + (e?.message || String(e)));
          } finally {
            setConcatLoading(false);
          }
        }}
        style={{ marginLeft: 10 }}
      >
        {concatLoading ? "영상 합치는 중..." : "영상 합치기"}
      </button>

      <button
        disabled={!sessionId || playlistLoading || runVideosLoading || scenesLoading || sttLoading || audioUploading}
        onClick={async () => {
          setPlaylistLoading(true);
          try {
            const res = await fetch(
              `http://localhost:3001/api/session/${sessionId}/videos-playlist`
            );
            const json = await res.json();
            console.log("videos-playlist:", json);

            if (!json.ok) {
              alert("연속 재생 불러오기 실패: " + (json.error || ""));
              return;
            }

            setPlaylistItems(json.items || []);
            setPlaylistIndex(0);
            setPlaylistMode(json.mode || "");
            alert(`연속 재생 준비 완료! (${(json.items || []).length}개)`);
          } catch (e) {
            console.error(e);
            alert("연속 재생 불러오기 실패: " + (e?.message || String(e)));
          } finally {
            setPlaylistLoading(false);
          }
        }}
        style={{ marginLeft: 10 }}
      >
        {playlistLoading ? "연속 재생 불러오는 중..." : "연속 재생 불러오기"}
      </button>


      {sttPreview && (
        <pre
          style={{
            marginTop: 10,
            background: "#f6f6f6",
            padding: 10,
            borderRadius: 12,
            fontSize: 12,
            whiteSpace: "pre-wrap",
          }}
        >
          {sttPreview}
        </pre>
      )}

      {scenesPreview && (
        <pre
          style={{
            marginTop: 10,
            background: "#f6f6f6",
            padding: 10,
            borderRadius: 12,
            fontSize: 12,
            whiteSpace: "pre-wrap",
          }}
        >
{JSON.stringify(scenesPreview, null, 2)}
        </pre>
      )}

      {runImagesResults && runImagesResults.length > 0 && (
        <pre
          style={{
            marginTop: 10,
            background: "#f6f6f6",
            padding: 10,
            borderRadius: 12,
            fontSize: 12,
            whiteSpace: "pre-wrap",
          }}
        >
{JSON.stringify(runImagesResults, null, 2)}
        </pre>
      )}

      {runVideosResults && runVideosResults.length > 0 && (
        <pre
          style={{
            marginTop: 10,
            background: "#f6f6f6",
            padding: 10,
            borderRadius: 12,
            fontSize: 12,
            whiteSpace: "pre-wrap",
          }}
        >
{JSON.stringify(runVideosResults, null, 2)}
        </pre>
      )}

      {finalVideoPath && (
        <>
          <p style={{ marginTop: 8, fontSize: 12, color: "#555" }}>
            ✅ final.mp4 생성됨: {finalVideoPath}
          </p>
          {finalVideoUrl && (
            <>
              <a
                href={finalVideoUrl}
                download="final.mp4"
                style={{
                  display: "inline-block",
                  marginTop: 6,
                  padding: "8px 12px",
                  borderRadius: 10,
                  border: "1px solid #ddd",
                  background: "#fff",
                  color: "#111",
                  textDecoration: "none",
                  fontSize: 12,
                  fontWeight: 700,
                }}
              >
                final.mp4 다운로드
              </a>
              <video
                src={finalVideoUrl}
                controls
                style={{ marginTop: 8, width: "100%", maxWidth: 640, borderRadius: 12 }}
              />
            </>
          )}
        </>
      )}

      {playlistItems.length > 0 && (
        <>
          <p style={{ marginTop: 8, fontSize: 12, color: "#555" }}>
            🎬 연속 재생({playlistMode || "auto"}): {playlistIndex + 1}/{playlistItems.length}
          </p>
          {playlistMode === "manifest" && (
            <p style={{ marginTop: 4, fontSize: 11, color: "#888" }}>
              videos_manifest.json 우선 사용 중
            </p>
          )}
          <div style={{ display: "flex", gap: 8, alignItems: "center", marginTop: 6 }}>
            <button
              disabled={playlistIndex === 0}
              onClick={() => setPlaylistIndex((i) => Math.max(0, i - 1))}
              style={{
                padding: "6px 10px",
                borderRadius: 8,
                border: "1px solid #ddd",
                background: "#fff",
                fontSize: 12,
                fontWeight: 700,
              }}
            >
              이전
            </button>
            <button
              disabled={playlistIndex >= playlistItems.length - 1}
              onClick={() => setPlaylistIndex((i) => Math.min(playlistItems.length - 1, i + 1))}
              style={{
                padding: "6px 10px",
                borderRadius: 8,
                border: "1px solid #ddd",
                background: "#fff",
                fontSize: 12,
                fontWeight: 700,
              }}
            >
              다음
            </button>
          </div>
          <video
            ref={playlistVideoRef}
            src={playlistItems[playlistIndex]?.url || ""}
            controls
            onEnded={() => {
              setPlaylistIndex((i) => (i < playlistItems.length - 1 ? i + 1 : i));
            }}
            style={{ marginTop: 8, width: "100%", maxWidth: 640, borderRadius: 12 }}
          />
        </>
      )}

      {/* Cropper */}
      {imageURL && (
        <div style={{ marginTop: 16, display: "grid", gridTemplateColumns: "1fr 360px", gap: 16 }}>
          <div style={{ position: "relative", width: "100%", height: 520, background: "#111", borderRadius: 16, overflow: "hidden" }}>
            <Cropper
              image={imageURL}
              crop={crop}
              zoom={zoom}
              aspect={aspect}
              onCropChange={setCrop}
              onZoomChange={setZoom}
              onCropComplete={onCropComplete}
              objectFit="contain"
            />
          </div>

          <div>
            <div style={{ padding: 12, border: "1px solid #eee", borderRadius: 16 }}>
              <div style={{ fontWeight: 700, marginBottom: 8 }}>크롭 설정</div>

              <label style={{ display: "block", marginBottom: 8 }}>
                Zoom: {zoom.toFixed(2)}
                <input
                  type="range"
                  min={1}
                  max={4}
                  step={0.01}
                  value={zoom}
                  onChange={(e) => setZoom(Number(e.target.value))}
                  style={{ width: "100%" }}
                />
              </label>

              <label style={{ display: "block", marginBottom: 8 }}>
                Aspect:
                <select
                  value={aspect}
                  onChange={(e) => setAspect(Number(e.target.value))}
                  style={{ width: "100%", padding: 8, borderRadius: 10, border: "1px solid #ddd" }}
                >
                  <option value={1}>1:1 (정사각)</option>
                  <option value={3 / 4}>3:4 (인물)</option>
                  <option value={2 / 3}>2:3 (전신)</option>
                  <option value={9 / 16}>9:16 (세로)</option>
                </select>
              </label>

              <button
                onClick={saveCurrentCrop}
                style={{
                  width: "100%",
                  padding: "10px 12px",
                  borderRadius: 12,
                  border: "1px solid #ddd",
                  background: "#fff",
                  cursor: "pointer",
                  fontWeight: 700,
                }}
              >
                ➕ 이 크롭 저장
              </button>

              <div style={{ marginTop: 10, fontSize: 12, color: "#666", lineHeight: 1.4 }}>
                저장 시 자동으로 <b>머리/어깨/옷</b>이 조금 더 포함되도록 여백을 추가합니다.
              </div>
            </div>

            {/* Summary */}
            <div style={{ marginTop: 12, padding: 12, border: "1px solid #eee", borderRadius: 16 }}>
              <div style={{ fontWeight: 700 }}>현재 상태</div>
              <div style={{ marginTop: 6, fontSize: 13, color: "#444" }}>
                저장된 크롭: <b>{cropsSaved.length}</b>개
                <br />
                Owner: <b>{ownerId ? `선택됨 (#${ownerLabel || "?"})` : "미선택"}</b>
              </div>

              {ownerId && (
                <pre style={{ marginTop: 10, background: "#f6f6f6", padding: 10, borderRadius: 12, fontSize: 12 }}>
{JSON.stringify(
  {
    owner_label: ownerLabel,
    label_map: labelMap,
    crops_count: cropsSaved.length,
  },
  null,
  2
)}
                </pre>
              )}
            </div>
          </div>
        </div>
      )}

      {/* Saved crops list */}
      {cropsSaved.length > 0 && (
        <div style={{ marginTop: 18 }}>
          <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between" }}>
            <h3 style={{ margin: 0 }}>저장된 크롭</h3>
            <div style={{ color: "#666", fontSize: 13 }}>
              클릭해서 Owner로 지정 (라벨은 왼쪽부터 1,2,3...)
            </div>
          </div>

          <div style={{ display: "flex", gap: 12, flexWrap: "wrap", marginTop: 10 }}>
            {cropsSaved.map((c, idx) => {
              const isOwner = c.id === ownerId;
              const label = cropLabelById[c.id] || String(idx + 1);
              return (
                <div
                  key={c.id}
                  style={{
                    width: 160,
                    border: isOwner ? "2px solid #ff3b30" : "1px solid #ddd",
                    borderRadius: 14,
                    overflow: "hidden",
                    background: "#fff",
                  }}
                >
                  <div style={{ position: "relative" }}>
                    <img src={c.previewUrl} alt={`crop-${idx}`} style={{ width: "100%", display: "block" }} />
                      <div
                        style={{
                          position: "absolute",
                          left: 8,
                          top: 8,
                          background: isOwner ? "#ff3b30" : "rgba(255,255,255,0.9)",
                          color: isOwner ? "white" : "#111",
                          padding: "4px 6px",
                          borderRadius: 10,
                          fontSize: 12,
                          fontWeight: 800,
                        }}
                      >
                      {isOwner ? `OWNER (#${label})` : `#${label}`}
                    </div>
                  </div>

                  <div style={{ padding: 10, display: "flex", gap: 8 }}>
                    <button
                      onClick={() => setOwnerId(c.id)}
                      style={{
                        flex: 1,
                        padding: "8px 10px",
                        borderRadius: 10,
                        border: "1px solid #ddd",
                        background: isOwner ? "#111" : "#fff",
                        color: isOwner ? "white" : "#111",
                        cursor: "pointer",
                        fontWeight: 700,
                      }}
                    >
                      {isOwner ? "Owner" : "Owner로"}
                    </button>
                    <button
                      onClick={() => removeCrop(c.id)}
                      style={{
                        padding: "8px 10px",
                        borderRadius: 10,
                        border: "1px solid #ddd",
                        background: "#fff",
                        cursor: "pointer",
                      }}
                      title="삭제"
                    >
                      🗑️
                    </button>
                  </div>
                </div>
              );
            })}
          </div>
        </div>
      )}

      {!imageURL && (
        <div style={{ marginTop: 24, padding: 16, border: "1px dashed #ddd", borderRadius: 16, color: "#666" }}>
          먼저 사진을 업로드하세요. 그 다음 사람별로 크롭을 저장하고 Owner를 선택하면 됩니다.
        </div>
      )}
    </div>
  );
}
