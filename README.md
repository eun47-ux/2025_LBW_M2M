## 기존 구조

```
backend/
├── index.js                    # 메인 서버 (모든 로직 포함)
├── comfyRun.js                 # ComfyUI 워크플로우 조작
├── generatePairs.js            # (미사용)
├── scripts/
│   ├── runAllScenes.js         # 씬 실행
│   └── runOnce.js              # 단일 실행
└── services/
    ├── comfyVideo.js           # 비디오 다운로드
    ├── concatVideos.js         # 비디오 합치기
    └── transcriptToScenes.js   # STT → 씬 생성
```

### 기존 워크플로우
1. 세션 저장: 팀명으로 세션 ID 저장 (localStorage)
2. 영상의 인물 설정: 사진 업로드 → 사진 크롭 → 인물 설정
3. 영상의 장면 생성: 오디오 업로드 → STT 실행 → 장면 생성
4. 추억 영상 생성: 이미지 생성 → 동영상 생성
5. 추억 영상 재생: 동영상 합성 → 동영상 재생

---

## 리팩토링된 구조

```
backend/
├── index.js                    # Express 서버 (라우트만)
├── config.js                   # 설정 (포트, URL 등)
├── comfyRun.js                 # ComfyUI 워크플로우 유틸리티 (워크플로우 패치, 이미지 업로드, 프롬프트 실행)
├── services/
│   ├── sessionService.js      # 세션 관리 (#1)
│   ├── characterService.js    # 인물 크롭 및 번호 지정 (#2)
│   ├── transcriptService.js    # STT 및 씬 생성 (#3)
│   ├── imageService.js        # 이미지 생성 (#4-1)
│   ├── videoService.js         # 비디오 생성 (#4-2)
│   └── movieService.js        # 비디오 합성 (#5)
├── workflows/
│   ├── M2M_image_api.json     # 이미지 생성 워크플로우
│   └── M2M_video_api.json     # 비디오 생성 워크플로우
└── scripts/
    └── generate_image.py       # 이미지 생성 Python 스크립트
```

---

## 전체 워크플로우

### Frontend 흐름
```
1. 세션 ID 입력 (최상단, 필수)
   ↓ 확인 버튼 클릭
2. 인물 크롭 + Owner 지정
   ↓ 저장 버튼 클릭
3. 오디오 업로드 + 씬 생성
   ↓ 씬 생성 버튼 클릭
4. 영상 생성 버튼 활성화
   + 연구자 확인 버튼 표시 (영상 생성 후 최종 검토용)
```

### Backend 흐름

**1단계: 세션 생성**
- 사용자가 세션 ID 입력 + 확인 버튼
- `sessionService.createSession(sessionId)` 호출
- 빈 세션 폴더 생성, `session.json` 초기화

**2단계: 인물 크롭 저장**
- 프론트엔드에서 크롭 편집 및 owner 지정 (localStorage 캐시)
- 저장 버튼 클릭 시 `sessionService.updateSession(sessionId, cropData)` 호출
- 크롭 파일 및 메타데이터 저장

**3단계: 오디오 처리 및 씬 생성**
- 오디오 업로드 → `transcriptService.runSTT(sessionId)` → `transcript.txt` 생성
- 씬 생성 버튼 클릭 → `transcriptService.generateScenes(sessionId)` → `scenes.json` 생성
- 완료 후 `sessionService.buildLabels(sessionId)` → `labels.json` 생성 (크롭 추출 + ComfyUI 업로드)

**4단계: 영상 생성**
- `imageService.runImageScenes(sessionId)` → 이미지 생성 (Python CLI)
- `videoService.runVideoScenes(sessionId)` → 비디오 생성 (Node.js 직접)
- `movieService.concatVideos(sessionId)` → 비디오 합성

---

## 서비스 상세 설명

### sessionService.js
- `createSession(sessionId)` - 세션 폴더 및 `session.json` 생성
- `getSession(sessionId)` - 세션 정보 조회
- `updateSession(sessionId, data)` - 세션 데이터 업데이트 (크롭 정보 저장)
- `buildLabels(sessionId)` - 크롭 추출 + ComfyUI 업로드 + `labels.json` 생성

### characterService.js
- **프론트엔드 전용** (백엔드 API 없음)
- 크롭 편집, owner 지정
- localStorage에 캐시 저장
- 저장 버튼 클릭 시 `sessionService.updateSession()` 호출

### transcriptService.js
- `runSTT(sessionId)` - 오디오 파일 → `transcript.txt` 생성
- `generateScenes(sessionId)` - `transcript.txt` → `scenes.json` 생성

### imageService.js
- `runImageScenes(sessionId)` - Python CLI를 통해 이미지 생성
- ComfyUI 결과 대기 및 다운로드

### videoService.js
- `runVideoScenes(sessionId)` - Node.js에서 직접 ComfyUI 실행
- 비디오 워크플로우 패치 및 실행
- ComfyUI 결과 대기 및 다운로드

### movieService.js
- `concatVideos(sessionId)` - 생성된 비디오들을 하나로 합성
- `final.mp4` 생성

---

## 실행 방법

### 사전 요구사항

1. **Node.js** (v18 이상)
2. **Python** (3.x)
3. **ffmpeg** (비디오 합성용)
4. **ComfyUI 서버** 실행 중이어야 함

### 환경 변수 설정

`backend/.env` 파일을 생성하고 다음 변수들을 설정하세요:

```env
# ComfyUI 설정
COMFY_URL=http://143.248.107.38:8188
COMFY_STATIC_BASE=http://143.248.107.38:8186
COMFY_API_KEY=your_comfy_api_key_here

# OpenAI 설정 (STT 및 씬 생성용)
OPENAI_API_KEY=your_openai_api_key_here

# 서버 포트 (선택사항, 기본값: 3001)
PORT=3001
```

### Backend 실행

```bash
# backend 폴더로 이동
cd backend

# 의존성 설치
npm install

# 서버 실행
node index.js
```

서버가 `http://localhost:3001`에서 실행됩니다.

### Frontend 실행

```bash
# frontend 폴더로 이동
cd frontend

# 의존성 설치
npm install

# 개발 서버 실행
npm run dev
```

프론트엔드가 `http://localhost:5173` (또는 Vite가 할당한 포트)에서 실행됩니다.

### 전체 실행 순서

1. **ComfyUI 서버 실행** (별도 터미널)
2. **Backend 실행**
   ```bash
   cd backend
   npm install
   node index.js
   ```
3. **Frontend 실행** (새 터미널)
   ```bash
   cd frontend
   npm install
   npm run dev
   ```
4. 브라우저에서 `http://localhost:5173` 접속

### 주의사항

- Python 스크립트 실행을 위해 Python이 PATH에 등록되어 있어야 합니다.
- 이미지 생성 시 ComfyUI API 키가 필요합니다 (유료 토큰).
- 비디오 합성 시 ffmpeg가 설치되어 있어야 합니다.