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

**바뀐 구조**

backend/
├── index.js                    # Express 서버 (라우트만)
├── config.js                   # 설정
├── services/
│   ├── sessionService.js     # 세션 관리 (#1)
│   ├── characterService.js   # 인물 크롭 및 인물 번호(owner, 1, 2, 3) 지정 (#2)
│   ├── sceneService.js       # 씬 생성 및 labels.json 생성 (#3)
│   ├── imageService.js       # 사진 생성 (CLI 통해 Python 실행) (#4-1)
│   ├── videoService.js       # 영상 생성 (Node.js애서 직접 ComfyUI 실행) (#4-2)
│   └── movieService.js       # 영상 합성 (#5)
├── workflows/
│   ├── M2M_image_api.json
│   └── M2M_image_api.json
└── scripts/
    └── generate_image.py     # 이미지 생성 (ComfyUI 실행)

Frontend 수정: (최상단부터 차례대로) 가장 먼저 세션 ID 입력, 확인 버튼 누르기 -> 인물 크롭하고 owner 지정, 저장 버튼 누르기 -> 대화 녹음파일 업로드, 씬 생성 버튼 누르기 -> 최하단 '영상 생성' 버튼 활성화, 우측에 '연구자 확인' 버튼 추가