**기존 구조**

backend/
├── index.js              # 메인 서버 (API 라우트)
├── comfyRun.js           # ComfyUI 관련 (워크플로우, 업로드)
├── generatePairs.js      # 사용 안 함?
├── scripts/
│   ├── runAllScenes.js   # 씬 실행
│   └── runOnce.js        # 단일 실행?
└── services/
    ├── comfyVideo.js     # 비디오 다운로드
    ├── concatVideos.js   # 비디오 합치기
    └── transcriptToScenes.js  # STT → 씬

1. 세션 저장: 팀명으로 세션 ID 저장(local storage)
2. 영상의 인물 설정: 사진 업로드 - 사진 크롭 - 인물 설정 
3. 영상의 장면 생성: 오디오 업로드 - STT 실행(transcript.txt) - 장면 생성
4. 추억 영상 생성: 이미지 생성 - 동영상 생성
5. 추억 영상 재생: 동영상 합성 - 동영상 재생

**리팩토링된 구조**

backend/
├── index.js                    # Express 서버 (라우트만)
├── config.js                   # 설정
├── services/
│   ├── characterService.js   # 인물 크롭 및 인물 번호(owner, 1, 2, 3) 지정 (#2)
│   ├── transcriptService.js  # STT에서 씬 생성 (#3)
│   ├── sessionService.js     # 세션 관리. 2, 3번 과정 완료 후 자동으로 최상단에 입력된 ID의 세션 생성, labels.json 파일 생성 (#1)
│   ├── imageService.js       # 사진 생성 (CLI 통해 Python 실행) (#4-1)
│   ├── videoService.js       # 영상 생성 (Node.js애서 직접 ComfyUI 실행) (#4-2)
│   └── movieService.js       # 영상 합성 (#5)
├── workflows/
│   ├── M2M_image_api.json
│   └── M2M_video_api.json
└── scripts/
    └── generate_image.py     # 이미지 생성 (ComfyUI 실행)

Frontend 수정: (최상단부터 차례대로) 가장 먼저 세션 ID 입력(필수) -> 인물 크롭하고 owner 지정, 저장 버튼 누르기 -> 대화 녹음파일 업로드, 씬 생성 버튼 누르기 -> 최하단 '영상 생성' 버튼 활성화, 우측에 '연구자 확인' 버튼 추가 (영상 생성 후 사용자가 재생하기 전 최종 검토)

1. 세션 ID 입력 (최상단)
   ↓ 완료
2. 인물 크롭 + Owner 지정
   ↓ 완료
3. 오디오 업로드 + 씬 생성
   ↓ 완료
4. 영상 생성 버튼 활성화
   + 연구자 확인 버튼 표시

Backend Flow(ComfyUI로 생성하기 전까지)

1. 사용자가 세션 ID 입력 + 확인 버튼
   → sessionService.createSession(sessionId) 호출
   → 빈 세션 폴더 생성, session.json 초기화

2. 인물 크롭 + Owner 지정
   → characterService에서 localStorage에만 저장
   → 저장 버튼 클릭 시 sessionService.updateSession()으로 저장

3. 오디오 업로드 + 씬 생성
   → transcriptService.runSTT() + generateScenes()
   → 완료 후 sessionService에서 labels.json 생성

characterService.js:
  - 프론트엔드에서만 사용 (백엔드 API 없음)
  - 크롭 편집, owner 지정
  - localStorage에 캐시 저장
  - 저장 버튼 클릭 시 sessionService.updateSession() 호출

sessionService.js:
  - createSession(sessionId) - 세션 ID 입력 시점
  - updateSession(sessionId, data) - 인물 크롭 저장
  - buildLabels(sessionId) - 2, 3번 완료 후 labels.json 생성
  - getSession(sessionId)

transcriptService.js:
  - runSTT(sessionId) - 오디오 → transcript.txt
  - generateScenes(sessionId) - transcript.txt → scenes.json