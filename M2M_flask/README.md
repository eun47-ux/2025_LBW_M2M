# M2M 이미지 생성 Flask 앱

Flask로 작성된 웹 인터페이스를 제공하는 이미지 생성 앱입니다. ComfyUI API 노드(NanoBanana)를 사용하여 이미지를 생성합니다.

## 설치 및 실행

### 1. 의존성 설치

```bash
cd M2M_flask
pip install -r requirements.txt
```

### 2. 환경 변수 설정

**Windows PowerShell:**
```powershell
$env:COMFY_API_KEY="comfyui-7a9902d7a1258b8565bf5dccf7d16461b082245ae6e0f7e740fc4bcc8d775f8c"
```

**Windows CMD:**
```cmd
set COMFY_API_KEY=your_comfy_api_key_here
```

**Linux/Mac:**
```bash
export COMFY_API_KEY="comfyui-7a9902d7a1258b8565bf5dccf7d16461b082245ae6e0f7e740fc4bcc8d775f8c"
```

### 3. 실행

```bash
python app.py
```

브라우저에서 `http://localhost:5000` 접속

## 기능

1. **기본 워크플로우 실행** - `M2M_image_api.json` 워크플로우를 그대로 실행
2. **커스텀 워크플로우 실행** - 워크플로우를 수정해서 실행 가능
3. **워크플로우 로드** - 기본 워크플로우를 에디터에 로드

## API 엔드포인트

- `GET /` - 웹 인터페이스
- `GET /api/workflow` - 워크플로우 템플릿 로드
- `POST /api/generate` - 기본 워크플로우 실행
- `POST /api/generate-custom` - 커스텀 워크플로우 실행
  - 요청 본문: `{ "workflow": {...} }`

## 코드 구조

기존 `generate_image.py` 코드를 그대로 사용:
- `load_workflow()` - 워크플로우 로드 함수
- `send_workflow()` - ComfyUI에 워크플로우 전송 함수
- `extra_data.api_key_comfy_org` - API 키 전달 방식

## 주의사항

- ComfyUI 서버가 `http://143.248.107.38:8188`에서 실행 중이어야 합니다.
- 워크플로우 템플릿 파일(`M2M_image_api.json`)이 상위 폴더에 있어야 합니다.
- API 키가 없으면 유료 노드(NanoBanana) 사용 시 인증 오류가 발생할 수 있습니다.

