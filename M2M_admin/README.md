# M2M Admin

영상 생성 모니터링 및 재생성 관리 앱

## 기능

1. **세션 관리**: 세션 ID 입력으로 빈 세션 생성
2. **DB 로드**: Firestore에서 세션 데이터 다운로드
   - `comfy_results.json` 다운로드
   - 이미지 URL fetch 및 로컬 저장
   - 비디오 URL fetch (미리보기용)
3. **비디오 재생성**: 특정 씬의 비디오를 재생성하고 DB 업데이트

## 설치

```bash
cd M2M_admin
npm install
```

## 환경 변수 설정

`.env` 파일을 생성하고 다음 변수를 설정하세요:

```env
ADMIN_PORT=3002
FIRESTORE_PROJECT_ID=your-project-id
FIRESTORE_KEY_PATH=./path/to/serviceAccountKey.json
COMFY_URL=http://143.248.107.38:8188
COMFY_STATIC_BASE=http://143.248.107.38:8186
COMFY_API_KEY=your-comfy-api-key
```

## 실행

```bash
npm start
```

서버가 `http://localhost:3002`에서 실행됩니다.

## Firestore 구조

```
SessionID/
  ├── prompts/
  │   └── comfy_results (필드: JSON 배열)
  ├── generatedImages/
  │   └── {scene_id}/imageUrl (필드)
  └── generatedVideos/
      └── {scene_id}/videoUrl (필드)
```

## API 엔드포인트

- `POST /api/session/create` - 세션 생성
- `POST /api/session/:sessionId/load-from-db` - DB에서 데이터 로드
- `GET /api/session/:sessionId/videos` - 비디오 목록 조회
- `POST /api/session/:sessionId/regenerate/:sceneId` - 비디오 재생성

## 워크플로우

1. 세션 ID 입력 → 빈 세션 폴더 생성
2. "DB 로드" 버튼 클릭 → Firestore에서 데이터 다운로드
3. 비디오 미리보기 및 재생성 버튼으로 개별 비디오 재생성
