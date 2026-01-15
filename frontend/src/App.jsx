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

// ---- YouTube music helpers (final.mp4 sync) ----
function parseYoutubeId(input) {
  if (!input) return "";
  try {
    const url = new URL(input.trim());
    const host = url.hostname.replace(/^www\./, "");

    if (host === "youtu.be") {
      return url.pathname.split("/")[1] || "";
    }

    if (host.endsWith("youtube.com")) {
      if (url.searchParams.get("v")) return url.searchParams.get("v");
      const parts = url.pathname.split("/").filter(Boolean);
      const embedIdx = parts.indexOf("embed");
      const shortsIdx = parts.indexOf("shorts");
      if (embedIdx >= 0 && parts[embedIdx + 1]) return parts[embedIdx + 1];
      if (shortsIdx >= 0 && parts[shortsIdx + 1]) return parts[shortsIdx + 1];
    }
  } catch {
    return "";
  }
  return "";
}

let ytApiPromise = null;
const YT_START_SECONDS = 45;
const FADE_DURATION_MS = 500; // 0.5초

/**
 * YouTube 오디오 페이드 인 (0 -> 100)
 */
function fadeInYouTube(player, onComplete) {
  if (!player) return;
  
  // 기존 페이드 중단
  if (window.ytFadeInterval) {
    clearInterval(window.ytFadeInterval);
  }
  
  player.setVolume(0);
  let volume = 0;
  const steps = 20; // 20단계로 나눔
  const stepSize = 100 / steps;
  const stepDuration = FADE_DURATION_MS / steps;
  
  window.ytFadeInterval = setInterval(() => {
    volume += stepSize;
    if (volume >= 100) {
      volume = 100;
      player.setVolume(100);
      if (window.ytFadeInterval) {
        clearInterval(window.ytFadeInterval);
        window.ytFadeInterval = null;
      }
      if (onComplete) onComplete();
    } else {
      player.setVolume(Math.round(volume));
    }
  }, stepDuration);
}

/**
 * YouTube 오디오 페이드 아웃 (100 -> 0)
 */
function fadeOutYouTube(player, onComplete) {
  if (!player) return;
  
  // 기존 페이드 중단
  if (window.ytFadeInterval) {
    clearInterval(window.ytFadeInterval);
  }
  
  let volume = 100;
  const steps = 20; // 20단계로 나눔
  const stepSize = 100 / steps;
  const stepDuration = FADE_DURATION_MS / steps;
  
  window.ytFadeInterval = setInterval(() => {
    volume -= stepSize;
    if (volume <= 0) {
      volume = 0;
      player.setVolume(0);
      if (window.ytFadeInterval) {
        clearInterval(window.ytFadeInterval);
        window.ytFadeInterval = null;
      }
      if (onComplete) onComplete();
    } else {
      player.setVolume(Math.round(volume));
    }
  }, stepDuration);
}

function loadYoutubeApi() {
  if (ytApiPromise) return ytApiPromise;
  ytApiPromise = new Promise((resolve) => {
    if (window.YT && window.YT.Player) {
      resolve(window.YT);
      return;
    }
    const existing = document.querySelector('script[src="https://www.youtube.com/iframe_api"]');
    if (existing) {
      const prev = window.onYouTubeIframeAPIReady;
      window.onYouTubeIframeAPIReady = () => {
        if (prev) prev();
        resolve(window.YT);
      };
      return;
    }
    const script = document.createElement("script");
    script.src = "https://www.youtube.com/iframe_api";
    document.body.appendChild(script);
    window.onYouTubeIframeAPIReady = () => resolve(window.YT);
  });
  return ytApiPromise;
}

/**
 * YouTube 검색 (백엔드 API 사용)
 */
async function searchYouTube(query, setResults, setLoading, setError) {
  if (!query.trim()) {
    setResults([]);
    return;
  }

  setLoading(true);
  setError("");

  try {
    // Vite에서는 import.meta.env 사용 (또는 기본값 사용)
    const API_BASE = import.meta.env.VITE_API_BASE || "http://localhost:3001";
    const response = await fetch(
      `${API_BASE}/api/youtube/search?q=${encodeURIComponent(query)}`
    );

    if (!response.ok) {
      throw new Error("YouTube 검색 실패");
    }

    const data = await response.json();
    if (!data.ok) {
      throw new Error(data.error || "검색 실패");
    }

    setResults(data.results || []);
  } catch (error) {
    setError("검색 중 오류가 발생했습니다.");
    console.error("YouTube search error:", error);
  } finally {
    setLoading(false);
  }
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
  const [currentStep, setCurrentStep] = useState(1);
  const [step2Ready, setStep2Ready] = useState(false);
  const [step3Ready, setStep3Ready] = useState(false);
  const [runAllLoading, setRunAllLoading] = useState(false);
  const [audioFile, setAudioFile] = useState(null);
  const [audioUploading, setAudioUploading] = useState(false);
  const [audioUploadProgress, setAudioUploadProgress] = useState(0);
  const [audioUploadDone, setAudioUploadDone] = useState(false);
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
  // ---- YouTube music state (synced with final.mp4) ----
  const finalVideoRef = useRef(null);
  const ytPlayerRef = useRef(null);
  const ytReadyRef = useRef(false);
  const ytHasStartedRef = useRef(false);
  const ytPendingPlayRef = useRef(false);
  const ytFadeIntervalRef = useRef(null);
  const ytContainerIdRef = useRef(`yt-music-${Math.random().toString(36).slice(2, 10)}`);
  const [ytUrlInput, setYtUrlInput] = useState("");
  const [ytVideoId, setYtVideoId] = useState("");
  const [ytStatus, setYtStatus] = useState("idle");
  const [ytError, setYtError] = useState("");
  const [playlistLoading, setPlaylistLoading] = useState(false);
  const [playlistItems, setPlaylistItems] = useState([]);
  const [playlistIndex, setPlaylistIndex] = useState(0);
  const [playlistMode, setPlaylistMode] = useState("");
  const playlistVideoRef = useRef(null);
  // YouTube 검색 관련 state
  const [ytSearchQuery, setYtSearchQuery] = useState("");
  const [ytSearchResults, setYtSearchResults] = useState([]);
  const [ytSearchLoading, setYtSearchLoading] = useState(false);
  const [ytSearchError, setYtSearchError] = useState("");
  const step1Ready = !!sessionId;
  const step4Ready = !!finalVideoPath;

  // cleanup object urls
  useEffect(() => {
    return () => {
      if (imageURL) URL.revokeObjectURL(imageURL);
      cropsSaved.forEach((c) => URL.revokeObjectURL(c.previewUrl));
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // 검색 실행 함수
  const handleSearch = () => {
    if (ytSearchQuery.trim()) {
      searchYouTube(ytSearchQuery, setYtSearchResults, setYtSearchLoading, setYtSearchError);
    } else {
      setYtSearchResults([]);
      setYtSearchError("");
    }
  };

  // Enter 키로 검색
  const handleSearchKeyPress = (e) => {
    if (e.key === "Enter") {
      handleSearch();
    }
  };

  // ---- Sync final.mp4 play/pause with YouTube audio ----
  useEffect(() => {
    if (!finalVideoUrl) return undefined;

    let timeoutId = null;
    let cleanupFn = null;
    let retryCount = 0;
    const MAX_RETRIES = 50; // 최대 5초 (50 * 100ms)

    // 비디오 요소가 마운트될 때까지 기다리는 함수
    const setupEventListeners = () => {
      const video = finalVideoRef.current;
      if (!video) {
        retryCount++;
        if (retryCount < MAX_RETRIES) {
          // 비디오 요소가 아직 없으면 100ms 후 재시도
          timeoutId = setTimeout(setupEventListeners, 100);
        }
        return;
      }

      const handlePlay = () => {
        if (!ytPlayerRef.current) return;
        if (!ytReadyRef.current) {
          ytPendingPlayRef.current = true;
          return;
        }
        // 페이드 상태 리셋
        ytFadeIntervalRef.current = null;
        if (!ytHasStartedRef.current) {
          ytPlayerRef.current.seekTo(YT_START_SECONDS, true);
          ytHasStartedRef.current = true;
        }
        // 페이드 인과 함께 재생
        ytPlayerRef.current.playVideo();
        fadeInYouTube(ytPlayerRef.current);
      };
      const handlePause = () => {
        if (!ytPlayerRef.current || !ytReadyRef.current) return;
        // 페이드 아웃 후 일시정지
        fadeOutYouTube(ytPlayerRef.current, () => {
          if (ytPlayerRef.current && ytReadyRef.current) {
            ytPlayerRef.current.pauseVideo();
          }
        });
      };
      const handleEnded = () => {
        if (!ytPlayerRef.current || !ytReadyRef.current) return;
        // 페이드 상태 리셋
        ytFadeIntervalRef.current = null;
        // 페이드 아웃 후 초기화
        fadeOutYouTube(ytPlayerRef.current, () => {
          if (ytPlayerRef.current && ytReadyRef.current) {
            ytPlayerRef.current.pauseVideo();
            ytPlayerRef.current.seekTo(YT_START_SECONDS, true);
          }
        });
      };
      
      // 비디오 종료 0.5초 전에 페이드 아웃 시작
      const handleTimeUpdate = () => {
        if (!ytPlayerRef.current || !ytReadyRef.current) return;
        if (!video.duration) return;
        
        const remaining = video.duration - video.currentTime;
        if (remaining <= FADE_DURATION_MS / 1000 && remaining > 0.1) {
          // 페이드 아웃 시작 (한 번만)
          if (!ytFadeIntervalRef.current) {
            fadeOutYouTube(ytPlayerRef.current);
            ytFadeIntervalRef.current = true;
          }
        }
      };

      video.addEventListener("play", handlePlay);
      video.addEventListener("pause", handlePause);
      video.addEventListener("ended", handleEnded);
      video.addEventListener("timeupdate", handleTimeUpdate);

      cleanupFn = () => {
        video.removeEventListener("play", handlePlay);
        video.removeEventListener("pause", handlePause);
        video.removeEventListener("ended", handleEnded);
        video.removeEventListener("timeupdate", handleTimeUpdate);
        // 페이드 인터벌 정리
        if (window.ytFadeInterval) {
          clearInterval(window.ytFadeInterval);
          window.ytFadeInterval = null;
        }
      };
    };

    // 이벤트 리스너 설정 시작
    setupEventListeners();
    
    return () => {
      // timeout 정리
      if (timeoutId) {
        clearTimeout(timeoutId);
      }
      // cleanup 함수 실행
      if (cleanupFn) {
        cleanupFn();
      }
      // 페이드 인터벌 정리
      if (window.ytFadeInterval) {
        clearInterval(window.ytFadeInterval);
        window.ytFadeInterval = null;
      }
    };
  }, [finalVideoUrl]);

  // ---- Load/attach YouTube player when a URL is applied ----
  useEffect(() => {
    if (!ytVideoId) return;

    let cancelled = false;
    let timeoutId = null;
    setYtStatus("loading");
    setYtError("");
    ytHasStartedRef.current = false;
    ytPendingPlayRef.current = false;
    ytFadeIntervalRef.current = null;

    loadYoutubeApi().then((YT) => {
      if (cancelled) return;

      const onReady = () => {
        ytReadyRef.current = true;
        setYtStatus("ready");
        // 초기 볼륨을 0으로 설정 (페이드 인을 위해)
        if (ytPlayerRef.current) {
          ytPlayerRef.current.setVolume(0);
        }
        if (timeoutId) clearTimeout(timeoutId);
        if (ytPendingPlayRef.current) {
          if (!ytHasStartedRef.current) {
            ytPlayerRef.current?.seekTo(YT_START_SECONDS, true);
            ytHasStartedRef.current = true;
          }
          ytPlayerRef.current?.playVideo();
          fadeInYouTube(ytPlayerRef.current);
          ytPendingPlayRef.current = false;
        }
      };

      if (ytPlayerRef.current) {
        if (ytReadyRef.current) {
          ytPlayerRef.current.cueVideoById({
            videoId: ytVideoId,
            startSeconds: YT_START_SECONDS,
          });
          ytHasStartedRef.current = false;
          setYtStatus("ready");
          if (timeoutId) clearTimeout(timeoutId);
        } else {
          setYtStatus("loading");
        }
        return;
      }

      const container = document.getElementById(ytContainerIdRef.current);
      if (!container) {
        setYtStatus("error");
        setYtError("유튜브 플레이어 영역을 찾을 수 없어요.");
        return;
      }

      ytPlayerRef.current = new YT.Player(ytContainerIdRef.current, {
        videoId: ytVideoId,
        playerVars: {
          autoplay: 0,
          controls: 0,
          disablekb: 1,
          modestbranding: 1,
          playsinline: 1,
          rel: 0,
          enablejsapi: 1,
          origin: window.location.origin,
          start: YT_START_SECONDS,
        },
        events: { onReady },
      });
    });

    timeoutId = setTimeout(() => {
      if (cancelled || ytReadyRef.current) return;
      setYtStatus("error");
      setYtError("유튜브 로딩 실패. 링크를 확인하거나 네트워크를 점검하세요.");
    }, 15000);

    return () => {
      cancelled = true;
      if (timeoutId) clearTimeout(timeoutId);
    };
  }, [ytVideoId]);

  useEffect(() => {
    if (finalVideoPath) return;
    if (ytPlayerRef.current) {
      // 페이드 인터벌 정리
      if (window.ytFadeInterval) {
        clearInterval(window.ytFadeInterval);
        window.ytFadeInterval = null;
      }
      ytFadeIntervalRef.current = null;
      ytPlayerRef.current.destroy();
      ytPlayerRef.current = null;
      ytReadyRef.current = false;
      setYtStatus("idle");
    }
  }, [finalVideoPath]);

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
    // setSessionId(null);
    setAudioFile(null);
    setAudioUploading(false);
    setAudioUploadProgress(0);
    setAudioUploadDone(false);
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
    setStep2Ready(false);
    setStep3Ready(false);
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
    setStep2Ready(false);
  };

  const removeCrop = (id) => {
    setCropsSaved((prev) => {
      const target = prev.find((c) => c.id === id);
      if (target) URL.revokeObjectURL(target.previewUrl);
      return prev.filter((c) => c.id !== id);
    });
    if (ownerId === id) setOwnerId(null);
    setStep2Ready(false);
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
  // 2단계 저장: 오리지널 이미지, 크롭 사진 업로드 + session.json 업데이트 + labels.json 생성
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
    form.append("photo", imageFile); // 오리지널 이미지
    form.append("ownerId", ownerId);
    form.append("labelMap", JSON.stringify(labelMap));

    cropsSaved.forEach((c, idx) => {
      // 크롭 파일들
      form.append("crops", c.blob, `crop_${idx + 1}.png`);
      form.append("cropMeta", JSON.stringify({ id: c.id, rect: c.rect })); // repeated fields are ok
    });

    try {
      // 1. 오리지널 이미지, 크롭 사진 업로드 + session.json 업데이트
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

      // 2. labels.json 생성 (크롭 추출 + ComfyUI 업로드)
      const labelsRes = await fetch(`http://localhost:3001/api/session/${sessionId}/build-labels`, {
        method: "POST",
      });
      const labelsJson = await labelsRes.json();
      console.log("build-labels:", labelsJson);
      if (!labelsJson.ok) {
        alert("labels 생성 실패: " + (labelsJson.error || ""));
        return;
      }

      // 상태 초기화
      setSttPreview("");
      setScenesPreview(null);
      setRunImagesResults(null);
      setRunVideosResults(null);
      setFinalVideoPath("");
      setFinalVideoUrl("");
      setStep2Ready(true);
      setStep3Ready(false);
      
      alert("세션이 업데이트되었습니다! 오리지널 이미지, 크롭 사진이 업로드되고 session.json과 labels.json이 생성되었습니다.");
    } catch (e) {
      console.error(e);
      alert("저장 실패: " + (e?.message || String(e)));
    }
  };

  // 세션 생성 (1단계: ID만 생성)
  const createSession = async () => {
    if (!sessionIdInput.trim()) {
      alert("세션 ID를 입력해주세요.");
      return;
    }

    // 이미 세션이 있으면 생성하지 않음
    if (sessionId) {
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
      setCurrentStep(1);
      setStep2Ready(false);
      setStep3Ready(false);
      setAudioUploadDone(false);
      // 팝업 제거 (한 번만 눌러도 되므로)
    } catch (e) {
      console.error(e);
      alert("세션 생성 실패: " + (e?.message || String(e)));
    } finally {
      setSessionCreating(false);
    }
  };

  return (
    <div
      style={{
        width: "100%",
        display: "flex",
        flexDirection: "column",
        alignItems: "center",
        gap: 16,
        color: "#0f172a",
        fontFamily: "system-ui, -apple-system, Segoe UI, Roboto",
      }}
    >
      <h2 style={{ margin: 10, fontSize: 32, textAlign: "center" }}>Moments to Memories</h2>
      <div
        style={{
          width: "100%",
          maxWidth: 920,
          margin: 0,
          padding: 24,
          background: "#f8fafc",
          border: "1px solid #e5e7eb",
          borderRadius: 16,
          boxShadow: "0 10px 30px rgba(15, 23, 42, 0.06)",
        }}
      >
      
      {/* 1단계: 세션 ID 입력 */}
      {currentStep === 1 && (
        <div style={{ marginTop: 12, padding: 16, background: "#ffffff", borderRadius: 12, border: "1px solid #e5e7eb" }}>
          <h3 style={{ margin: "0 0 15px 0", fontSize: 25 }}>1단계: 세션 ID 입력</h3>
          <div style={{ display: "flex", gap: 12, alignItems: "center" }}>
            <input
              value={sessionIdInput}
              onChange={(e) => setSessionIdInput(e.target.value)}
              placeholder="연구자가 사전에 안내한 세션 ID를 입력해주세요 (예:T1)"
              style={{ padding: 20, border: "1px solid #cbd5e1", borderRadius: 8, minWidth: 220, flex: 1 }}
              disabled={!!sessionId}
            />
            <button
              onClick={createSession}
              disabled={!sessionIdInput.trim() || sessionCreating || !!sessionId}
              style={{
                padding: "20px 20px",
                borderRadius: 10,
                border: "1px solid #1d4ed8",
                background: sessionId ? "#1d4ed8" : "#2563eb",
                color: "white",
                cursor: sessionId || !sessionIdInput.trim() ? "not-allowed" : "pointer",
              }}
            >
              {sessionCreating ? "생성 중..." : sessionId ? "✅ 생성 완료" : "확인"}
            </button>
          </div>
          {sessionId && (
          <p style={{ marginTop: 8, fontSize: 12, color: "#1d4ed8" }}>
              ✅ 세션 ID: <strong>{sessionId}</strong>
            </p>
          )}
          <div style={{ display: "flex", justifyContent: "flex-end", marginTop: 12 }}>
            <button
              onClick={() => setCurrentStep(2)}
              disabled={!step1Ready}
              style={{
                padding: "10px 16px",
                borderRadius: 10,
                border: "1px solid #1d4ed8",
                background: step1Ready ? "#2563eb" : "#e5e7eb",
                color: step1Ready ? "#fff" : "#94a3b8",
                cursor: step1Ready ? "pointer" : "not-allowed",
                fontWeight: 700,
              }}
            >
              다음 단계
            </button>
          </div>
        </div>
      )}

      {/* 2단계: 인물 크롭 + 사진 주인 지정 */}
      {currentStep === 2 && (
        <div style={{ marginTop: 12 }}>
          <h3 style={{ margin: "0 0 15px 0", fontSize: 25 }}>2단계: 사진 등록하고 인물별로 사진 자르기</h3>
          {!sessionId && (
            <p style={{ color: "orange", fontSize: 14 }}>
              ⚠️ 먼저 세션 ID를 입력하고 확인 버튼을 클릭해주세요.
            </p>
          )}
          <div style={{ display: "flex", gap: 16, flexWrap: "wrap", alignItems: "center", marginBottom: 16 }}>
            <input
              type="file"
              accept="image/*"
              onChange={onSelectImage}
              disabled={!sessionId}
              style={{ padding: 20, border: "1px solid #cbd5e1", borderRadius: 8 }}
            />
          </div>

          {/* Cropper */}
          {imageURL && (
            <div style={{ marginTop: 16, display: "grid", gridTemplateColumns: "1fr 360px", gap: 16 }}>
              <div style={{ position: "relative", width: "100%", height: 520, background: "#0f172a", borderRadius: 16, overflow: "hidden" }}>
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
                <div style={{ padding: 12, border: "1px solid #e5e7eb", borderRadius: 16, background: "#ffffff" }}>
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
                      style={{ width: "100%", padding: 8, borderRadius: 10, border: "1px solid #cbd5e1" }}
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
                      border: "1px solid #1d4ed8",
                      background: "#2563eb",
                      color: "#fff",
                      cursor: "pointer",
                      fontWeight: 700,
                    }}
                  >
                    ➕ 이 크롭 저장
                  </button>

                  <div style={{ marginTop: 10, fontSize: 15, color: "#666", lineHeight: 1.4 }}>
                    저장 시 자동으로 <b>머리/어깨/옷</b>이 조금 더 포함되도록 여백을 추가합니다.
                  </div>
                </div>

                {/* Summary */}
                <div style={{ marginTop: 12, padding: 12, border: "1px solid #e5e7eb", borderRadius: 16, background: "#ffffff" }}>
                  <div style={{ fontWeight: 700 }}>현재 상태</div>
                  <div style={{ marginTop: 6, fontSize: 15, color: "#444" }}>
                    저장된 크롭: <b>{cropsSaved.length}</b>개
                    <br />
                    사진 주인: <b>{ownerId ? `선택됨 (#${ownerLabel || "?"})` : "미선택"}</b>
                  </div>

                  {/*
                    [DEBUG] 2단계 상태 요약(JSON) - 사용자 버전에서는 숨김
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
                  */}
                </div>
              </div>
            </div>
          )}

          {/* Saved crops list */}
          {cropsSaved.length > 0 && (
            <div style={{ marginTop: 18 }}>
              <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between" }}>
                <h3 style={{ margin: 0 }}>저장된 크롭</h3>
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
                        border: isOwner ? "2px solid #2563eb" : "1px solid #e2e8f0",
                        borderRadius: 14,
                        overflow: "hidden",
                        background: "#ffffff",
                      }}
                    >
                      <div style={{ position: "relative" }}>
                        <img src={c.previewUrl} alt={`crop-${idx}`} style={{ width: "100%", display: "block" }} />
                        <div
                          style={{
                            position: "absolute",
                            left: 8,
                            top: 8,
                            background: isOwner ? "#2563eb" : "rgba(255,255,255,0.9)",
                            color: isOwner ? "white" : "#0f172a",
                            padding: "4px 6px",
                            borderRadius: 10,
                            fontSize: 12,
                            fontWeight: 800,
                          }}
                        >
                          {isOwner ? `사진 주인 (#${label})` : `#${label}`}
                        </div>
                      </div>

                      <div style={{ padding: 10, display: "flex", gap: 8 }}>
                        <button
                          onClick={() => {
                            setOwnerId(c.id);
                            setStep2Ready(false);
                          }}
                          style={{
                            flex: 1,
                            padding: "8px 10px",
                            borderRadius: 10,
                            border: "1px solid #1d4ed8",
                            background: isOwner ? "#2563eb" : "#ffffff",
                            color: isOwner ? "white" : "#1d4ed8",
                            cursor: "pointer",
                            fontWeight: 700,
                          }}
                        >
                          {isOwner ? "사진 주인" : "사진 주인으로"}
                        </button>
                        <button
                          onClick={() => removeCrop(c.id)}
                          style={{
                            padding: "8px 10px",
                            borderRadius: 10,
                            border: "1px solid #e2e8f0",
                            background: "#ffffff",
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
          <div style={{ marginTop: 24, padding: 16, border: "1px dashed #cbd5e1", borderRadius: 16, color: "#64748b" }}>
              먼저 사진을 업로드하세요. 그 다음 사람별로 크롭을 저장하고 사진 주인을 선택하면 됩니다.
            </div>
          )}

          {/* 2단계 저장 버튼 - 크롭 인터페이스 아래 가로로 길게 */}
          <button
            onClick={uploadSessionToBackend}
            style={{
              width: "100%",
              marginTop: 24,
              padding: "14px 20px",
              borderRadius: 12,
              border: step2Ready ? "1px solid #cbd5e1" : "1px solid #1d4ed8",
              background: step2Ready
                ? "#e5e7eb"
                : ownerId && sessionId
                ? "#2563eb"
                : "#e5e7eb",
              color: step2Ready ? "#94a3b8" : ownerId && sessionId ? "white" : "#94a3b8",
              cursor: step2Ready || !ownerId || !sessionId ? "not-allowed" : "pointer",
              fontWeight: 700,
              fontSize: 16,
            }}
            disabled={!ownerId || !sessionId || step2Ready}
            title="크롭 저장 및 백엔드 업로드 (labels.json 생성)"
          >
            {step2Ready ? "저장완료" : "저장"}
          </button>
          <div style={{ display: "flex", justifyContent: "flex-end", gap: 8, marginTop: 12 }}>
            <button
              onClick={() => {
                setStep2Ready(true);
                setCurrentStep(3);
              }}
              style={{
                padding: "10px 16px",
                borderRadius: 10,
                border: "1px solid #f59e0b",
                background: "#f59e0b",
                color: "#fff",
                cursor: "pointer",
                fontWeight: 700,
                fontSize: 12,
              }}
              title="디버깅용: 사진 업로드 없이 다음 단계로"
            >
              🔧 건너뛰기 (디버깅)
            </button>
            <button
              onClick={() => setCurrentStep(3)}
              disabled={!step2Ready}
              style={{
                padding: "10px 16px",
                borderRadius: 10,
                border: "1px solid #1d4ed8",
                background: step2Ready ? "#2563eb" : "#e5e7eb",
                color: step2Ready ? "#fff" : "#94a3b8",
                cursor: step2Ready ? "pointer" : "not-allowed",
                fontWeight: 700,
              }}
            >
              다음 단계
            </button>
          </div>
        </div>
      )}

      {/* 3단계: 오디오 업로드 + 씬 생성 */}
      {currentStep === 3 && (
      <div style={{ marginTop: 12 }}>
        <h3 style={{ margin: "0 0 15px 0", fontSize: 25 }}>3단계: 대화 녹음 파일을 업로드해주세요</h3>
        <h4 style={{ margin: "8px 0", fontSize: 21, color: "#555" }}>🎙️ 대화 녹음 업로드</h4>

      <input
        type="file"
        accept="audio/*"
        onChange={(e) => {
          setAudioFile(e.target.files?.[0] || null);
          setAudioUploading(false);
          setAudioUploadProgress(0);
          setAudioUploadDone(false);
          setStep3Ready(false);
        }}
        style={{ padding: 20, border: "1px solid #cbd5e1", borderRadius: 8 }}
      />

      <button
        disabled={!sessionId || !audioFile || audioUploading || sttLoading}
        onClick={async () => {
          if (!sessionId || !audioFile) return;

          const fd = new FormData();
          fd.append("audio", audioFile);

          setAudioUploadDone(false);
          setAudioUploading(true);
          setAudioUploadProgress(0);
          setSttLoading(true);

          const xhr = new XMLHttpRequest();
          xhr.open("POST", `http://localhost:3001/api/session/${sessionId}/upload-audio`);

          xhr.upload.onprogress = (e) => {
            if (!e.lengthComputable) return;
            const percent = Math.round((e.loaded / e.total) * 100);
            setAudioUploadProgress(percent);
          };

          xhr.onload = async () => {
            setAudioUploading(false);
            try {
              const json = JSON.parse(xhr.responseText || "{}");
              console.log("upload-audio:", json);
              if (!json.ok || xhr.status >= 400) {
                alert("오디오 업로드 실패: " + (json.error || xhr.statusText || "unknown error"));
                setSttLoading(false);
                return;
              }
              setAudioUploadProgress(100);
              setSttPreview("");
              setAudioUploadDone(true);
              alert("오디오 업로드 성공! STT를 실행합니다.");

              try {
                const sttRes = await fetch(`http://localhost:3001/api/session/${sessionId}/stt`, {
                  method: "POST",
                });
                const sttJson = await sttRes.json();
                console.log("stt:", sttJson);

                if (!sttJson.ok) {
                  alert("STT 실패: " + (sttJson.error || ""));
                } else {
                  setSttPreview(sttJson.preview || "");
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
            } catch (err) {
              console.error(err);
              setSttLoading(false);
              setAudioUploadDone(false);
              alert("오디오 업로드 실패: 응답 파싱 오류");
            }
          };

          xhr.onerror = () => {
            setAudioUploading(false);
            setSttLoading(false);
            setAudioUploadDone(false);
            alert("오디오 업로드 실패: 네트워크 오류");
          };

          xhr.send(fd);
        }}
        style={{
          marginLeft: 10,
          padding: "20px 18px",
          borderRadius: 8,
          border: audioUploadDone ? "1px solid #cbd5e1" : "1px solid #1d4ed8",
          background: audioUploadDone ? "#e5e7eb" : "#2563eb",
          color: audioUploadDone ? "#94a3b8" : "#fff",
          fontWeight: 600,
          cursor: audioUploadDone ? "pointer" : "pointer",
        }}
      >
        {audioUploading || sttLoading
          ? "업로드 + STT 진행 중..."
          : audioUploadDone
          ? "오디오 업로드 완료!"
          : "오디오 업로드"}
      </button>

      {audioUploading && (
        <div style={{ marginTop: 8, display: "flex", alignItems: "center", gap: 8 }}>
          <progress value={audioUploadProgress} max="100" style={{ width: 240 }} />
          <span style={{ fontSize: 12, color: "#555" }}>{audioUploadProgress}%</span>
        </div>
      )}

      {/*
        [DEBUG] STT 단독 실행 버튼 (사용자 버전에서는 숨김)
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
          style={{
            marginLeft: 10,
            padding: "8px 14px",
            borderRadius: 8,
            border: "1px solid #1d4ed8",
            background: "#2563eb",
            color: "#fff",
            fontWeight: 600,
          }}
        >
          {sttLoading ? "STT 실행 중..." : "STT 실행"}
        </button>
      */}

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
              setStep3Ready(true);
              alert("Scenes 생성 완료! scenes.json 생성됨");
            }
          } catch (e) {
            console.error(e);
            alert("Scenes 생성 실패: " + (e?.message || String(e)));
          } finally {
            setScenesLoading(false);
          }
        }}
        style={{
          marginLeft: 10,
          padding: "8px 14px",
          borderRadius: 8,
          border: "1px solid #1d4ed8",
          background: "#2563eb",
          color: "#fff",
          fontWeight: 600,
        }}
      >
        {scenesLoading ? "대화 분석 중..." : "대화 분석하기"}
      </button>
        <div style={{ display: "flex", justifyContent: "flex-end", gap: 8, marginTop: 12 }}>
          <button
            onClick={() => {
              setStep3Ready(true);
              setCurrentStep(4);
            }}
            style={{
              padding: "10px 16px",
              borderRadius: 10,
              border: "1px solid #f59e0b",
              background: "#f59e0b",
              color: "#fff",
              cursor: "pointer",
              fontWeight: 700,
              fontSize: 12,
            }}
            title="디버깅용: 음성 파일 업로드 없이 다음 단계로"
          >
            🔧 건너뛰기 (디버깅)
          </button>
          <button
            onClick={() => setCurrentStep(4)}
            disabled={!step3Ready}
            style={{
              padding: "10px 16px",
              borderRadius: 10,
              border: "1px solid #1d4ed8",
              background: step3Ready ? "#2563eb" : "#e5e7eb",
              color: step3Ready ? "#fff" : "#94a3b8",
              cursor: step3Ready ? "pointer" : "not-allowed",
              fontWeight: 700,
            }}
          >
            다음 단계
          </button>
        </div>
      </div>
      )}


      {/* 4단계: 영상 생성 */}
      {currentStep === 4 && (
      <div style={{ marginTop: 12 }}>
        <h3 style={{ margin: "0 0 15px 0", fontSize: 25 }}>4단계: 영상 생성</h3>
        <div style={{ display: "flex", gap: 12, flexWrap: "wrap", alignItems: "center", marginBottom: 12 }}>
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
              padding: "12px 22px",
              borderRadius: 10,
              border: "1px solid #1d4ed8",
              background: "#2563eb",
              color: "white",
              fontWeight: 700,
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
              padding: "12px 22px",
              borderRadius: 10,
              border: "1px solid #1d4ed8",
              background: "#2563eb",
              color: "white",
              fontWeight: 700,
            }}
          >
            {runVideosLoading ? "영상 생성 중..." : "영상 생성"}
          </button>

          <button
            disabled={!sessionId || concatLoading || scenesLoading || sttLoading || audioUploading}
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
            style={{
              padding: "12px 22px",
              borderRadius: 10,
              border: "1px solid #1d4ed8",
              background: "#2563eb",
              color: "white",
              fontWeight: 700,
            }}
          >
            {concatLoading ? "영상 합치는 중..." : "영상 합치기"}
          </button>
        </div>
        
        {/* 한 번에 모든 작업 수행하는 버튼 (선택사항) */}
        <button
          disabled={
            !sessionId ||
            runAllLoading ||
            concatLoading ||
            runVideosLoading ||
            runImagesLoading ||
            scenesLoading ||
            sttLoading ||
            audioUploading
          }
          onClick={async () => {
            if (!sessionId) return;
            setRunAllLoading(true);
            setFinalVideoPath("");
            setFinalVideoUrl("");
            try {
              try {
                setRunImagesLoading(true);
                const imageRes = await fetch(`http://localhost:3001/api/session/${sessionId}/run-images`, {
                  method: "POST",
                });
                const imageJson = await imageRes.json();
                console.log("run-images:", imageJson);
                if (!imageJson.ok) {
                  alert("이미지 생성 실패: " + (imageJson.error || ""));
                  return;
                }
                setRunImagesResults(imageJson.results || []);
                setRunVideosResults(null);
              } catch (e) {
                console.error(e);
                alert("이미지 생성 실패: " + (e?.message || String(e)));
                return;
              } finally {
                setRunImagesLoading(false);
              }

              try {
                setRunVideosLoading(true);
                const videoRes = await fetch(`http://localhost:3001/api/session/${sessionId}/run-videos`, {
                  method: "POST",
                });
                const videoJson = await videoRes.json();
                console.log("run-videos:", videoJson);
                if (!videoJson.ok) {
                  alert("영상 생성 실패: " + (videoJson.error || ""));
                  return;
                }
                setRunVideosResults(videoJson.results || []);
              } catch (e) {
                console.error(e);
                alert("영상 생성 실패: " + (e?.message || String(e)));
                return;
              } finally {
                setRunVideosLoading(false);
              }

              try {
                setConcatLoading(true);
                const res = await fetch(`http://localhost:3001/api/session/${sessionId}/concat-videos`, {
                  method: "POST",
                });
                const json = await res.json();
                console.log("concat-videos:", json);

                if (!json.ok) {
                  alert("영상 합치기 실패: " + (json.error || ""));
                  return;
                }
                setFinalVideoPath(json.finalPath || "");
                setFinalVideoUrl(
                  json.finalPath ? `http://localhost:3001/sessions/${sessionId}/final.mp4` : ""
                );
                alert("추억 영상 생성 완료! final.mp4 생성됨");
              } catch (e) {
                console.error(e);
                alert("영상 합치기 실패: " + (e?.message || String(e)));
              } finally {
                setConcatLoading(false);
              }
            } finally {
              setRunAllLoading(false);
            }
          }}
          style={{
            marginTop: 12,
            padding: "12px 22px",
            borderRadius: 10,
            border: "1px solid #1d4ed8",
            background: "#2563eb",
            color: "white",
            fontWeight: 700,
          }}
        >
          {runAllLoading || runImagesLoading || runVideosLoading || concatLoading
            ? "추억 영상 생성 중..."
            : "추억 영상 생성하기 (전체 자동)"}
        </button>
        <div style={{ display: "flex", justifyContent: "flex-end", gap: 8, marginTop: 12 }}>
          <button
            onClick={() => setCurrentStep(5)}
            style={{
              padding: "10px 16px",
              borderRadius: 10,
              border: "1px solid #f59e0b",
              background: "#f59e0b",
              color: "#fff",
              cursor: "pointer",
              fontWeight: 700,
              fontSize: 12,
            }}
            title="디버깅용: 영상 생성 없이 다음 단계로"
          >
            🔧 건너뛰기 (디버깅)
          </button>
          <button
            onClick={() => setCurrentStep(5)}
            disabled={!step4Ready}
            style={{
              padding: "10px 16px",
              borderRadius: 10,
              border: "1px solid #1d4ed8",
              background: step4Ready ? "#2563eb" : "#e5e7eb",
              color: step4Ready ? "#fff" : "#94a3b8",
              cursor: step4Ready ? "pointer" : "not-allowed",
              fontWeight: 700,
            }}
          >
            다음 단계
          </button>
        </div>
      </div>
      )}

      {/*
        [DEBUG] P1 세션 이미지 다운로드 + 비디오 생성 테스트 (사용자 버전에서는 숨김)
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
      */}

      {/*
        [DEBUG] P1 세션 영상 합치기 테스트 (사용자 버전에서는 숨김)
        <div style={{ marginTop: 24, padding: 16, background: "#d1ecf1", borderRadius: 12, border: "2px solid #0c5460" }}>
          <h3 style={{ margin: "0 0 12px 0", fontSize: 16, color: "#0c5460" }}>🔧 디버깅: P1 세션 영상 합치기 테스트</h3>
          <button
            disabled={concatLoading}
            onClick={async () => {
              const testSessionId = "P1";
              setConcatLoading(true);
              try {
                console.log("[DEBUG] 영상 합치기 시작...");
                const res = await fetch(`http://localhost:3001/api/session/${testSessionId}/concat-videos`, {
                  method: "POST",
                });
                const json = await res.json();
                console.log("디버깅 - concat-videos:", json);

                if (!json.ok) {
                  alert("영상 합치기 실패: " + (json.error || ""));
                } else {
                  setFinalVideoPath(json.finalPath || "");
                  setFinalVideoUrl(
                    json.finalPath ? `http://localhost:3001/sessions/${testSessionId}/final.mp4` : ""
                  );
                  alert(`영상 합치기 완료! final.mp4 생성됨 (${json.count || 0}개 비디오)`);
                }
              } catch (e) {
                console.error(e);
                alert("영상 합치기 실패: " + (e?.message || String(e)));
              } finally {
                setConcatLoading(false);
              }
            }}
            style={{
              padding: "10px 20px",
              borderRadius: 10,
              border: "1px solid #0c5460",
              background: "#0c5460",
              color: "#fff",
              fontWeight: "bold",
              cursor: concatLoading ? "not-allowed" : "pointer",
            }}
          >
            {concatLoading ? "영상 합치는 중..." : "P1 영상 합치기 테스트"}
          </button>
        </div>
      */}

      {/*
        [DEBUG] 세부 단계 버튼 (사용자 버전에서는 숨김)
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
      */}


      {/*
        [DEBUG] 단계별 결과 출력 (사용자 버전에서는 숨김)
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
      */}

      {currentStep === 5 && (
        <div style={{ marginTop: 12 }}>
          <h3 style={{ margin: "0 0 15px 0", fontSize: 25 }}>5단계: 음악 입력 및 영상 시청</h3>
          {!finalVideoPath && (
            <p style={{ fontSize: 12, color: "#666" }}>
              ⚠️ 먼저 4단계에서 final.mp4를 생성해주세요.
            </p>
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
                  border: "1px solid #1d4ed8",
                  background: "#ffffff",
                  color: "#1d4ed8",
                  textDecoration: "none",
                  fontSize: 12,
                  fontWeight: 700,
                }}
              >
                final.mp4 다운로드
              </a>
              {/* Custom playback controls (syncs with YouTube audio) */}
              <div style={{ display: "flex", gap: 8, alignItems: "center", marginTop: 8 }}>
                <button
                  disabled={!ytVideoId}
                  onClick={() => {
                    const v = finalVideoRef.current;
                    if (!v) return;
                    v.play().catch(() => {});
                    if (ytPlayerRef.current && ytReadyRef.current) {
                      if (!ytHasStartedRef.current) {
                        ytPlayerRef.current.seekTo(YT_START_SECONDS, true);
                        ytHasStartedRef.current = true;
                      }
                      ytPlayerRef.current.playVideo();
                      fadeInYouTube(ytPlayerRef.current);
                    } else if (ytPlayerRef.current) {
                      ytPendingPlayRef.current = true;
                    }
                  }}
                  style={{
                    width: 36,
                    height: 36,
                    padding: 0,
                    borderRadius: "50%",
                    border: "1px solid #1d4ed8",
                    background: "#2563eb",
                    color: "#fff",
                    display: "inline-flex",
                    alignItems: "center",
                    justifyContent: "center",
                    opacity: ytVideoId ? 1 : 0.5,
                  }}
                  title="재생"
                  aria-label="재생"
                >
                  <svg viewBox="0 0 24 24" width="18" height="18" aria-hidden="true">
                    <path d="M8 5v14l11-7z" fill="currentColor" />
                  </svg>
                </button>
                <button
                  disabled={!ytVideoId}
                  onClick={() => {
                    const v = finalVideoRef.current;
                    if (!v) return;
                    v.pause();
                    if (ytPlayerRef.current && ytReadyRef.current) {
                      fadeOutYouTube(ytPlayerRef.current, () => {
                        if (ytPlayerRef.current && ytReadyRef.current) {
                          ytPlayerRef.current.pauseVideo();
                        }
                      });
                    }
                  }}
                  style={{
                    width: 36,
                    height: 36,
                    padding: 0,
                    borderRadius: "50%",
                    border: "1px solid #1d4ed8",
                    background: "#ffffff",
                    color: "#1d4ed8",
                    display: "inline-flex",
                    alignItems: "center",
                    justifyContent: "center",
                    opacity: ytVideoId ? 1 : 0.5,
                  }}
                  title="일시정지"
                  aria-label="일시정지"
                >
                  <svg viewBox="0 0 24 24" width="18" height="18" aria-hidden="true">
                    <path d="M6 5h4v14H6zM14 5h4v14h-4z" fill="currentColor" />
                  </svg>
                </button>
                <button
                  disabled={!ytVideoId}
                  onClick={() => {
                    const v = finalVideoRef.current;
                    if (!v) return;
                    v.currentTime = 0;
                    ytFadeIntervalRef.current = null; // 페이드 상태 리셋
                    v.play().catch(() => {});
                    if (ytPlayerRef.current && ytReadyRef.current) {
                      ytPlayerRef.current.seekTo(YT_START_SECONDS, true);
                      ytHasStartedRef.current = true;
                      ytPlayerRef.current.playVideo();
                      fadeInYouTube(ytPlayerRef.current);
                    } else if (ytPlayerRef.current) {
                      ytPendingPlayRef.current = true;
                    }
                  }}
                  style={{
                    width: 36,
                    height: 36,
                    padding: 0,
                    borderRadius: "50%",
                    border: "1px solid #1d4ed8",
                    background: "#ffffff",
                    color: "#1d4ed8",
                    display: "inline-flex",
                    alignItems: "center",
                    justifyContent: "center",
                    opacity: ytVideoId ? 1 : 0.5,
                  }}
                  title="처음부터"
                  aria-label="처음부터"
                >
                  <svg viewBox="0 0 24 24" width="18" height="18" aria-hidden="true">
                    <path d="M6 5h2v14H6zM9 12l9-7v14z" fill="currentColor" />
                  </svg>
                </button>
              </div>
              {!ytVideoId && (
                <div style={{ marginTop: 6, fontSize: 11, color: "#888" }}>
                  음악 링크를 적용한 뒤에 영상 재생이 가능해요.
                </div>
              )}
              {/* YouTube Music 검색 및 선택 (only after final.mp4 is rendered) */}
              <div
                style={{
                  marginTop: 12,
                  padding: 12,
                  border: "1px solid #e5e7eb",
                  borderRadius: 12,
                }}
              >
                <div style={{ fontWeight: 700, fontSize: 12, marginBottom: 6 }}>
                  🎵 추억 노래 (YouTube Music)
                </div>
                <div style={{ fontSize: 11, color: "#888", marginBottom: 6 }}>
                  음악은 45초부터 재생돼요. (페이드 인/아웃 1초)
                </div>
                
                {/* 검색 입력 */}
                <div style={{ display: "flex", gap: 8, alignItems: "center", marginBottom: 8 }}>
                  <input
                    type="text"
                    value={ytSearchQuery}
                    onChange={(e) => setYtSearchQuery(e.target.value)}
                    onKeyPress={handleSearchKeyPress}
                    placeholder="노래 제목 또는 아티스트 검색..."
                    style={{
                      flex: 1,
                      padding: 20,
                      borderRadius: 8,
                      border: "1px solid #cbd5e1",
                      fontSize: 12,
                    }}
                  />
                  <button
                    onClick={handleSearch}
                    disabled={ytSearchLoading || !ytSearchQuery.trim()}
                    style={{
                      padding: "20px 18px",
                      borderRadius: 8,
                      border: "1px solid #1d4ed8",
                      background: ytSearchLoading || !ytSearchQuery.trim() ? "#cbd5e1" : "#2563eb",
                      color: "#fff",
                      fontSize: 12,
                      fontWeight: 700,
                      cursor: ytSearchLoading || !ytSearchQuery.trim() ? "not-allowed" : "pointer",
                      whiteSpace: "nowrap",
                    }}
                  >
                    {ytSearchLoading ? "검색 중..." : "검색"}
                  </button>
                </div>

                {/* 검색 결과 목록 */}
                {ytSearchError && (
                  <div style={{ fontSize: 11, color: "#b00020", marginBottom: 8 }}>
                    {ytSearchError}
                  </div>
                )}

                {ytSearchResults.length > 0 && (
                  <div
                    style={{
                      maxHeight: "300px",
                      overflowY: "auto",
                      border: "1px solid #e5e7eb",
                      borderRadius: 8,
                      padding: 8,
                      marginBottom: 8,
                    }}
                  >
                    {ytSearchResults.map((result) => (
                      <div
                        key={result.videoId}
                        onClick={() => {
                          setYtVideoId(result.videoId);
                          setYtUrlInput(`https://www.youtube.com/watch?v=${result.videoId}`);
                          setYtSearchQuery("");
                          setYtSearchResults([]);
                          setYtError("");
                        }}
                        style={{
                          display: "flex",
                          gap: 8,
                          padding: 8,
                          borderRadius: 6,
                          cursor: "pointer",
                          border: "1px solid transparent",
                          marginBottom: 4,
                        }}
                        onMouseEnter={(e) => {
                          e.currentTarget.style.background = "#f5f5f5";
                          e.currentTarget.style.borderColor = "#cbd5e1";
                        }}
                        onMouseLeave={(e) => {
                          e.currentTarget.style.background = "transparent";
                          e.currentTarget.style.borderColor = "transparent";
                        }}
                      >
                        {result.thumbnail && (
                          <img
                            src={result.thumbnail}
                            alt={result.title}
                            style={{
                              width: 60,
                              height: 45,
                              objectFit: "cover",
                              borderRadius: 4,
                            }}
                          />
                        )}
                        <div style={{ flex: 1, minWidth: 0 }}>
                          <div
                            style={{
                              fontSize: 12,
                              fontWeight: 600,
                              marginBottom: 2,
                              overflow: "hidden",
                              textOverflow: "ellipsis",
                              whiteSpace: "nowrap",
                            }}
                          >
                            {result.title}
                          </div>
                          <div
                            style={{
                              fontSize: 10,
                              color: "#888",
                              overflow: "hidden",
                              textOverflow: "ellipsis",
                              whiteSpace: "nowrap",
                            }}
                          >
                            {result.channelTitle}
                          </div>
                        </div>
                      </div>
                    ))}
                  </div>
                )}

                {/* 직접 URL 입력 옵션 (접을 수 있게) */}
                <details style={{ fontSize: 11 }}>
                  <summary style={{ cursor: "pointer", color: "#666", marginBottom: 6 }}>
                    또는 직접 URL 입력
                  </summary>
                  <div style={{ display: "flex", gap: 8, alignItems: "center", marginTop: 6 }}>
                    <input
                      type="text"
                      value={ytUrlInput}
                      onChange={(e) => setYtUrlInput(e.target.value)}
                      placeholder="유튜브 링크 붙여넣기"
                      style={{
                        flex: 1,
                        padding: 20,
                        borderRadius: 8,
                      border: "1px solid #cbd5e1",
                        fontSize: 12,
                      }}
                    />
                    <button
                      onClick={() => {
                        const id = parseYoutubeId(ytUrlInput);
                        if (!id) {
                          setYtError("유효한 유튜브 링크가 아니에요.");
                          return;
                        }
                        setYtVideoId(id);
                        setYtError("");
                      }}
                      style={{
                        padding: "20px 18px",
                        borderRadius: 8,
                        border: "1px solid #1d4ed8",
                        background: "#2563eb",
                        color: "#fff",
                        fontSize: 12,
                        fontWeight: 700,
                        cursor: "pointer",
                      }}
                    >
                      적용
                    </button>
                  </div>
                  {ytError && (
                    <div style={{ marginTop: 6, fontSize: 11, color: "#b00020" }}>
                      {ytError}
                    </div>
                  )}
                </details>

                {ytVideoId && (
                  <div style={{ marginTop: 6, fontSize: 11, color: "#666" }}>
                    상태: {ytStatus === "ready" ? "연결됨" : ytStatus === "error" ? "오류" : "로딩 중"}
                  </div>
                )}
                
                {/* Hidden YouTube player (audio only) */}
                <div
                  id={ytContainerIdRef.current}
                  style={{ width: 1, height: 1, opacity: 0, pointerEvents: "none" }}
                />
              </div>
              <video
                src={finalVideoUrl}
                ref={finalVideoRef}
                controls
                onPlay={() => {
                  if (ytVideoId) return;
                  const v = finalVideoRef.current;
                  if (!v) return;
                  v.pause();
                }}
                style={{ marginTop: 12, width: "100%", maxWidth: 640, borderRadius: 12 }}
              />
            </>
          )}
            </>
          )}
        </div>
      )}

      {/*
        [DEBUG] 연속 재생 플레이어 (사용자 버전에서는 숨김)
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
      */}

      </div>
    </div>
  );
}
