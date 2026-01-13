// M2M_test/server.js - 영상 생성 앱 (API 형식 워크플로우)
import express from "express";
import axios from "axios";
import FormData from "form-data";
import multer from "multer";
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import dotenv from "dotenv";

dotenv.config();

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const app = express();
const PORT = 3003;
const COMFY = "http://143.248.107.38:8188";
const COMFY_API_KEY = process.env.COMFY_API_KEY;

// 워크플로우 템플릿 경로 (이미 API 형식)
const VIDEO_WORKFLOW_PATH = path.join(__dirname, "M2M_video_api.json");
const IMAGE_WORKFLOW_PATH = path.join(__dirname, "M2M_image_api.json");

app.use(express.json());
app.use(express.static("public"));

const upload = multer({ dest: "uploads/" });
const uploadFields = multer({ dest: "uploads/" });

// ===============================
// 1. ComfyUI 서버 상태 확인
// ===============================
app.get("/api/comfy/status", async (req, res) => {
  try {
    const response = await axios.get(`${COMFY}/system_stats`);
    res.json({ ok: true, status: "connected", data: response.data });
  } catch (error) {
    res.status(500).json({ 
      ok: false, 
      error: error.message,
      hint: "ComfyUI 서버가 실행 중인지 확인하세요"
    });
  }
});

// ===============================
// 2. 이미지 업로드
// ===============================
app.post("/api/comfy/upload", upload.single("image"), async (req, res) => {
  try {
    if (!req.file) {
      return res.status(400).json({ ok: false, error: "이미지 파일이 필요합니다" });
    }

    const form = new FormData();
    form.append("image", fs.createReadStream(req.file.path), req.file.originalname);
    form.append("overwrite", "true");

    const response = await axios.post(`${COMFY}/upload/image`, form, {
      headers: form.getHeaders(),
      maxBodyLength: Infinity,
    });

    // 업로드한 임시 파일 삭제
    if (fs.existsSync(req.file.path)) {
      try {
        fs.unlinkSync(req.file.path);
      } catch (e) {
        // 무시
      }
    }

    res.json({
      ok: true,
      message: "이미지 업로드 성공",
      filename: response.data.name,
      fullPath: response.data.subfolder 
        ? `${response.data.subfolder}/${response.data.name}`
        : response.data.name
    });
  } catch (error) {
    if (req.file && fs.existsSync(req.file.path)) {
      try {
        fs.unlinkSync(req.file.path);
      } catch (e) {
        // 무시
      }
    }
    res.status(500).json({ 
      ok: false, 
      error: error.message,
      detail: error.response?.data 
    });
  }
});

// ===============================
// 3. 영상 생성 워크플로우 실행
// ===============================
app.post("/api/generate-video", upload.single("image"), async (req, res) => {
  try {
    let imageFilename = null;

    // 이미지가 업로드되었으면 먼저 ComfyUI에 업로드
    if (req.file) {
      const form = new FormData();
      form.append("image", fs.createReadStream(req.file.path), req.file.originalname);
      form.append("overwrite", "true");

      const uploadResponse = await axios.post(`${COMFY}/upload/image`, form, {
        headers: form.getHeaders(),
        maxBodyLength: Infinity,
      });

      imageFilename = uploadResponse.data.subfolder && uploadResponse.data.subfolder.length > 0
        ? `${uploadResponse.data.subfolder}/${uploadResponse.data.name}`
        : uploadResponse.data.name;

      // 임시 파일 삭제
      if (fs.existsSync(req.file.path)) {
        try {
          fs.unlinkSync(req.file.path);
        } catch (e) {
          // 무시
        }
      }
    } else if (req.body.imageFilename) {
      // 이미 업로드된 이미지 파일명 사용
      imageFilename = req.body.imageFilename;
    } else {
      return res.status(400).json({ 
        ok: false, 
        error: "이미지 파일 또는 imageFilename이 필요합니다" 
      });
    }

    // 워크플로우 템플릿 로드 (이미 API 형식)
    if (!fs.existsSync(VIDEO_WORKFLOW_PATH)) {
      return res.status(404).json({ 
        ok: false, 
        error: "워크플로우 템플릿을 찾을 수 없습니다",
        path: VIDEO_WORKFLOW_PATH
      });
    }

    const workflow = JSON.parse(fs.readFileSync(VIDEO_WORKFLOW_PATH, "utf-8"));

    // 노드 97 (LoadImage)의 image 필드에 업로드한 이미지 파일명 설정
    if (!workflow["97"]) {
      return res.status(500).json({ 
        ok: false, 
        error: "LoadImage 노드(id: 97)를 찾을 수 없습니다" 
      });
    }

    if (!workflow["97"].inputs) {
      workflow["97"].inputs = {};
    }
    workflow["97"].inputs.image = imageFilename;

    // ComfyUI API 호출
    try {
      const payload = {
        prompt: workflow
      };
      
      // API 키가 있으면 extra_data에 추가 (Python 스크립트와 동일한 방식)
      if (COMFY_API_KEY) {
        payload.extra_data = {
          api_key_comfy_org: COMFY_API_KEY
        };
      }

      const response = await axios.post(`${COMFY}/prompt`, 
        payload, 
        { timeout: 600000 }
      );

      res.json({
        ok: true,
        message: "영상 생성 워크플로우 실행 시작",
        prompt_id: response.data.prompt_id,
        imageFilename,
        hint: "ComfyUI 웹 인터페이스에서 결과를 확인하세요"
      });
    } catch (apiError) {
      // API 에러 상세 정보 로깅
      console.error("ComfyUI API 에러:", {
        status: apiError.response?.status,
        statusText: apiError.response?.statusText,
        data: apiError.response?.data,
        message: apiError.message
      });

      // HTML 응답인 경우 에러 메시지 개선
      if (apiError.response?.data && typeof apiError.response.data === 'string' && apiError.response.data.includes('<!DOCTYPE')) {
        return res.status(500).json({
          ok: false,
          error: "ComfyUI 서버가 HTML을 반환했습니다. 서버가 실행 중인지 확인하세요.",
          hint: "ComfyUI 서버 URL을 확인하거나 서버가 정상적으로 실행 중인지 확인하세요.",
          url: `${COMFY}/prompt`
        });
      }

      throw apiError;
    }
  } catch (error) {
    // 임시 파일 삭제 (안전하게)
    if (req.file && fs.existsSync(req.file.path)) {
      try {
        fs.unlinkSync(req.file.path);
      } catch (unlinkError) {
        // 무시
      }
    }
    
    res.status(500).json({ 
      ok: false, 
      error: error.message,
      detail: error.response?.data,
      status: error.response?.status
    });
  }
});

// ===============================
// 4. 이미지 생성 워크플로우 실행
// ===============================
app.post("/api/generate-image", uploadFields.fields([
  { name: "crop1", maxCount: 1 },
  { name: "crop2", maxCount: 1 }
]), async (req, res) => {
  try {
    // scenes.json 경로 확인
    const scenesPath = req.body.scenesPath || path.join(__dirname, "test20-1767942023285", "scenes.json");
    if (!fs.existsSync(scenesPath)) {
      return res.status(404).json({ 
        ok: false, 
        error: "scenes.json을 찾을 수 없습니다",
        path: scenesPath
      });
    }

    // scenes.json 로드
    const scenesData = JSON.parse(fs.readFileSync(scenesPath, "utf-8"));
    const sceneId = req.body.sceneId;
    
    // scene 선택
    let selectedScene = null;
    if (sceneId) {
      selectedScene = scenesData.scenes.find(s => s.scene_id === sceneId);
      if (!selectedScene) {
        return res.status(404).json({ 
          ok: false, 
          error: `scene_id "${sceneId}"를 찾을 수 없습니다` 
        });
      }
    } else {
      // scene_id가 없으면 첫 번째 scene 사용
      selectedScene = scenesData.scenes[0];
      if (!selectedScene) {
        return res.status(400).json({ 
          ok: false, 
          error: "scenes.json에 scene이 없습니다" 
        });
      }
    }

    const sceneText = selectedScene.scene_text;

    // 크롭 이미지 2개 업로드 확인
    if (!req.files || !req.files.crop1 || !req.files.crop2) {
      return res.status(400).json({ 
        ok: false, 
        error: "크롭 이미지 2개가 필요합니다 (crop1, crop2)" 
      });
    }

    // 크롭 이미지들을 ComfyUI에 업로드
    const cropFilenames = [];
    for (const [key, files] of Object.entries(req.files)) {
      const file = Array.isArray(files) ? files[0] : files;
      const form = new FormData();
      form.append("image", fs.createReadStream(file.path), file.originalname || `crop_${key}.png`);
      form.append("overwrite", "true");

      const uploadResponse = await axios.post(`${COMFY}/upload/image`, form, {
        headers: form.getHeaders(),
        maxBodyLength: Infinity,
      });

      const filename = uploadResponse.data.subfolder && uploadResponse.data.subfolder.length > 0
        ? `${uploadResponse.data.subfolder}/${uploadResponse.data.name}`
        : uploadResponse.data.name;
      
      cropFilenames.push(filename);

      // 임시 파일 삭제
      if (fs.existsSync(file.path)) {
        try {
          fs.unlinkSync(file.path);
        } catch (e) {
          // 무시
        }
      }
    }

    // 워크플로우 템플릿 로드
    if (!fs.existsSync(IMAGE_WORKFLOW_PATH)) {
      return res.status(404).json({ 
        ok: false, 
        error: "이미지 생성 워크플로우 템플릿을 찾을 수 없습니다",
        path: IMAGE_WORKFLOW_PATH
      });
    }

    const workflow = JSON.parse(fs.readFileSync(IMAGE_WORKFLOW_PATH, "utf-8"));

    // 노드 4 (GeminiImageNode)의 prompt를 scene_text로 교체
    if (!workflow["4"]) {
      return res.status(500).json({ 
        ok: false, 
        error: "GeminiImageNode 노드(id: 4)를 찾을 수 없습니다" 
      });
    }
    workflow["4"].inputs.prompt = sceneText;

    // 노드 13, 14 (LoadImage)의 image를 업로드한 크롭 이미지로 교체
    if (!workflow["13"] || !workflow["14"]) {
      return res.status(500).json({ 
        ok: false, 
        error: "LoadImage 노드(id: 13 또는 14)를 찾을 수 없습니다" 
      });
    }
    workflow["13"].inputs.image = cropFilenames[0]; // crop1
    workflow["14"].inputs.image = cropFilenames[1]; // crop2

    // ComfyUI API 호출
    try {
      const payload = {
        prompt: workflow
      };
      
      // API 키가 있으면 extra_data에 추가 (Python 스크립트와 동일한 방식)
      if (COMFY_API_KEY) {
        payload.extra_data = {
          api_key_comfy_org: COMFY_API_KEY
        };
      }

      const response = await axios.post(`${COMFY}/prompt`, 
        payload, 
        { timeout: 600000 }
      );

      res.json({
        ok: true,
        message: "이미지 생성 워크플로우 실행 시작",
        prompt_id: response.data.prompt_id,
        scene_id: selectedScene.scene_id,
        scene_text: sceneText,
        crop_filenames: cropFilenames,
        hint: "ComfyUI 웹 인터페이스에서 결과를 확인하세요"
      });
    } catch (apiError) {
      console.error("ComfyUI API 에러:", {
        status: apiError.response?.status,
        statusText: apiError.response?.statusText,
        data: apiError.response?.data,
        message: apiError.message
      });

      if (apiError.response?.data && typeof apiError.response.data === 'string' && apiError.response.data.includes('<!DOCTYPE')) {
        return res.status(500).json({
          ok: false,
          error: "ComfyUI 서버가 HTML을 반환했습니다. 서버가 실행 중인지 확인하세요.",
          hint: "ComfyUI 서버 URL을 확인하거나 서버가 정상적으로 실행 중인지 확인하세요.",
          url: `${COMFY}/prompt`
        });
      }

      throw apiError;
    }
  } catch (error) {
    // 임시 파일 삭제
    if (req.files) {
      for (const files of Object.values(req.files)) {
        const fileArray = Array.isArray(files) ? files : [files];
        for (const file of fileArray) {
          if (file && fs.existsSync(file.path)) {
            try {
              fs.unlinkSync(file.path);
            } catch (unlinkError) {
              // 무시
            }
          }
        }
      }
    }
    
    res.status(500).json({ 
      ok: false, 
      error: error.message,
      detail: error.response?.data,
      status: error.response?.status
    });
  }
});

// ===============================
// 5. scenes.json 로드
// ===============================
app.get("/api/scenes", (req, res) => {
  try {
    const scenesPath = req.query.path || path.join(__dirname, "test20-1767942023285", "scenes.json");
    if (!fs.existsSync(scenesPath)) {
      return res.status(404).json({ 
        ok: false, 
        error: "scenes.json을 찾을 수 없습니다",
        path: scenesPath
      });
    }

    const scenesData = JSON.parse(fs.readFileSync(scenesPath, "utf-8"));
    res.json({
      ok: true,
      scenes: scenesData.scenes,
      owner_label: scenesData.owner_label
    });
  } catch (error) {
    res.status(500).json({ 
      ok: false, 
      error: error.message 
    });
  }
});

// ===============================
// 6. 커스텀 워크플로우 실행 (워크플로우 직접 수정 가능)
// ===============================
app.post("/api/generate-custom", express.json(), async (req, res) => {
  try {
    const { workflow } = req.body;
    
    if (!workflow) {
      return res.status(400).json({ 
        ok: false, 
        error: "워크플로우가 필요합니다" 
      });
    }

    const payload = {
      prompt: workflow
    };
    
    // API 키가 있으면 extra_data에 추가 (Python 스크립트와 동일한 방식)
    if (COMFY_API_KEY) {
      payload.extra_data = {
        api_key_comfy_org: COMFY_API_KEY
      };
    }

    const response = await axios.post(`${COMFY}/prompt`, 
      payload, 
      { timeout: 600000 }
    );

    res.json({
      ok: true,
      message: "커스텀 워크플로우 실행 시작",
      prompt_id: response.data.prompt_id,
      hint: "ComfyUI 웹 인터페이스에서 결과를 확인하세요"
    });
  } catch (error) {
    console.error("커스텀 워크플로우 실행 에러:", {
      status: error.response?.status,
      statusText: error.response?.statusText,
      data: error.response?.data,
      message: error.message
    });

    if (error.response?.data && typeof error.response.data === 'string' && error.response.data.includes('<!DOCTYPE')) {
      return res.status(500).json({
        ok: false,
        error: "ComfyUI 서버가 HTML을 반환했습니다. 서버가 실행 중인지 확인하세요.",
        hint: "ComfyUI 서버 URL을 확인하거나 서버가 정상적으로 실행 중인지 확인하세요.",
        url: `${COMFY}/prompt`
      });
    }

    res.status(500).json({ 
      ok: false, 
      error: error.message,
      detail: error.response?.data,
      status: error.response?.status
    });
  }
});

// ===============================
// 7. 워크플로우 템플릿 로드
// ===============================
app.get("/api/workflow/load", (req, res) => {
  try {
    const type = req.query.type || "image"; // "image" or "video"
    const workflowPath = type === "video" ? VIDEO_WORKFLOW_PATH : IMAGE_WORKFLOW_PATH;
    
    if (!fs.existsSync(workflowPath)) {
      return res.status(404).json({ 
        ok: false, 
        error: "워크플로우 템플릿을 찾을 수 없습니다",
        path: workflowPath
      });
    }

    const workflow = JSON.parse(fs.readFileSync(workflowPath, "utf-8"));
    res.json({
      ok: true,
      workflow,
      type
    });
  } catch (error) {
    res.status(500).json({ 
      ok: false, 
      error: error.message 
    });
  }
});

// ===============================
// 8. 실행 중인 작업 확인
// ===============================
app.get("/api/comfy/queue", async (req, res) => {
  try {
    const response = await axios.get(`${COMFY}/queue`);
    res.json({ ok: true, data: response.data });
  } catch (error) {
    res.status(500).json({ ok: false, error: error.message });
  }
});

// ===============================
// 서버 시작
// ===============================
app.listen(PORT, () => {
  console.log(`✅ M2M 영상/이미지 생성 서버: http://localhost:${PORT}`);
  console.log(`✅ ComfyUI 서버: ${COMFY}`);
  console.log(`✅ 영상 워크플로우: ${VIDEO_WORKFLOW_PATH}`);
  console.log(`✅ 이미지 워크플로우: ${IMAGE_WORKFLOW_PATH}`);
  if (COMFY_API_KEY && COMFY_API_KEY !== 'your_comfy_account_api_key_here') {
    console.log(`✅ ComfyUI API Key: ${COMFY_API_KEY.slice(0, 7)}... (설정됨)`);
  } else {
    console.log(`⚠️  ComfyUI API Key: .env 파일에 COMFY_API_KEY를 설정하세요 (NanoBanana 유료 노드 사용 시 필요)`);
  }
  console.log(`\n📝 사용 가능한 엔드포인트:`);
  console.log(`   GET  /api/comfy/status - 서버 상태 확인`);
  console.log(`   POST /api/comfy/upload - 이미지 업로드`);
  console.log(`   POST /api/generate-video - 영상 생성 (이미지 업로드 + 워크플로우 실행)`);
  console.log(`   POST /api/generate-image - 이미지 생성 (크롭 2개 + scene_text)`);
  console.log(`   POST /api/generate-custom - 커스텀 워크플로우 실행 (워크플로우 직접 수정 가능)`);
  console.log(`   GET  /api/workflow/load - 워크플로우 템플릿 로드`);
  console.log(`   GET  /api/scenes - scenes.json 로드`);
  console.log(`   GET  /api/comfy/queue  - 큐 상태 확인`);
});

