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

  // session name (optional)
  const [sessionName, setSessionName] = useState("");
  const [sessionId, setSessionId] = useState(null);
  const [audioFile, setAudioFile] = useState(null);
  const [audioUploading, setAudioUploading] = useState(false);
  const [audioUploadProgress, setAudioUploadProgress] = useState(0);
  const [sttLoading, setSttLoading] = useState(false);
  const [sttPreview, setSttPreview] = useState("");
  const [scenesLoading, setScenesLoading] = useState(false);
  const [scenesPreview, setScenesPreview] = useState(null);
  const [runAllLoading, setRunAllLoading] = useState(false);
  const [runAllResults, setRunAllResults] = useState(null);

  // cleanup object urls
  useEffect(() => {
    return () => {
      if (imageURL) URL.revokeObjectURL(imageURL);
      cropsSaved.forEach((c) => URL.revokeObjectURL(c.previewUrl));
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

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
    setRunAllLoading(false);
    setRunAllResults(null);
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
    if (!imageFile || !ownerId || cropsSaved.length < 2) {
      alert("이미지 업로드 + 크롭 2개 이상 + Owner 선택이 필요해요.");
      return;
    }

    const sid = (sessionName || `session-${Date.now()}`).trim();

    const form = new FormData();
    form.append("sessionName", sid);
    form.append("photo", imageFile); // optional: original

    form.append("ownerId", ownerId);
    form.append("labelMap", JSON.stringify(labelMap));

    cropsSaved.forEach((c, idx) => {
      // create a filename that helps comfy/ui
      form.append("crops", c.blob, `crop_${idx + 1}.png`);
      form.append("cropMeta", JSON.stringify({ id: c.id, rect: c.rect })); // repeated fields are ok
    });

    // NOTE: change to your backend URL
    const res = await fetch("http://localhost:3001/api/session/manual-crops", {
      method: "POST",
      body: form,
    });

    const data = await res.json();
    if (!data.ok) {
      console.error(data);
      alert("업로드 실패. 콘솔 확인!");
      return;
    }
    setSessionId(data.sessionId || sid);
    setSttPreview("");
    setScenesPreview(null);
    setRunAllResults(null);
    alert(`업로드 성공! sessionId=${data.sessionId || sid}`);

    const finalSessionId = data.sessionId || sid;
    try {
      const labelsRes = await fetch(`http://localhost:3001/api/session/${finalSessionId}/build-labels`, {
        method: "POST",
      });
      const labelsJson = await labelsRes.json();
      console.log("build-labels:", labelsJson);
      if (!labelsJson.ok) {
        alert("labels 생성 실패: " + (labelsJson.error || ""));
      }
    } catch (e) {
      console.error(e);
      alert("labels 생성 실패: " + (e?.message || String(e)));
    }
  };

  return (
    <div style={{ padding: 16, fontFamily: "system-ui, -apple-system, Segoe UI, Roboto" }}>
      <h2 style={{ margin: 0 }}>🧩 Manual Crop + Owner Select (MVP)</h2>
      <p style={{ marginTop: 6, color: "#555" }}>
        한 사람씩 박스를 잡고 <b>이 크롭 저장</b>을 눌러 누적하세요. 그 다음 <b>Owner</b>를 선택합니다.
      </p>

      <div style={{ display: "flex", gap: 16, flexWrap: "wrap", alignItems: "center" }}>
        <input type="file" accept="image/*" onChange={onSelectImage} />

        <input
          value={sessionName}
          onChange={(e) => setSessionName(e.target.value)}
          placeholder="세션 이름(옵션) 예: p01"
          style={{ padding: 10, border: "1px solid #ddd", borderRadius: 8, minWidth: 220 }}
        />

        <button
          onClick={uploadSessionToBackend}
          style={{
            padding: "10px 12px",
            borderRadius: 10,
            border: "1px solid #ddd",
            background: ownerId ? "#111" : "#eee",
            color: ownerId ? "white" : "#777",
            cursor: ownerId ? "pointer" : "not-allowed",
          }}
          disabled={!ownerId}
          title="(옵션) 백엔드로 업로드"
        >
          세션 업로드(백엔드)
        </button>
      </div>

      <hr style={{ margin: "20px 0" }} />

      <h3>🎙️ 대화 녹음 업로드</h3>

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
              setRunAllResults(null);
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
              setRunAllResults(null);
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

      <button
        disabled={!sessionId || runAllLoading || scenesLoading || sttLoading || audioUploading}
        onClick={async () => {
          setRunAllLoading(true);
          try {
            const res = await fetch(`http://localhost:3001/api/session/${sessionId}/run-all-scenes`, {
              method: "POST",
            });
            const json = await res.json();
            console.log("run-all-scenes:", json);

            if (!json.ok) alert("이미지 생성 실패: " + (json.error || ""));
            else {
              setRunAllResults(json.results || []);
              alert("이미지 생성 요청 완료!");
            }
          } catch (e) {
            console.error(e);
            alert("이미지 생성 실패: " + (e?.message || String(e)));
          } finally {
            setRunAllLoading(false);
          }
        }}
        style={{ marginLeft: 10 }}
      >
        {runAllLoading ? "이미지 생성 중..." : "이미지 생성"}
      </button>

      {!sessionId && (
        <p style={{ color: "gray" }}>
          ⚠️ 먼저 사진 크롭을 완료해서 sessionId를 만든 뒤 업로드할 수 있어요.
        </p>
      )}

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

      {runAllResults && runAllResults.length > 0 && (
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
{JSON.stringify(runAllResults, null, 2)}
        </pre>
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
