"""
Using API nodes when running ComfyUI headless or with alternative frontend

You can execute a ComfyUI workflow that contains API nodes by including an API key in the prompt.

The API key should be added to the `extra_data` field of the payload.

Below we show an example of how to do this.

See more:
- API nodes overview: https://docs.comfy.org/tutorials/partner-nodes/overview
- To generate an API key, login here: https://platform.comfy.org/login
"""
import json
import os
from urllib import request
from pathlib import Path

SERVER_URL = "http://143.248.107.38:8188"

# 워크플로우 파일 경로
WORKFLOW_PATH = Path(__file__).parent / "M2M_image_api.json"

# ComfyUI Platform API 키 (환경 변수에서 읽기)
# 환경 변수 설정: export COMFY_API_KEY="your_api_key_here" (Linux/Mac)
# 또는: set COMFY_API_KEY=your_api_key_here (Windows CMD)
# 또는: $env:COMFY_API_KEY="your_api_key_here" (Windows PowerShell)
API_KEY = os.getenv("COMFY_API_KEY", "")

# 워크플로우 로드
def load_workflow():
    """M2M_image_api.json 워크플로우 파일 로드"""
    if not WORKFLOW_PATH.exists():
        raise FileNotFoundError(f"워크플로우 파일을 찾을 수 없습니다: {WORKFLOW_PATH}")
    
    with open(WORKFLOW_PATH, "r", encoding="utf-8") as f:
        return json.load(f)

# We have a prompt/job (workflow in "API format") that contains API nodes.
# M2M_image_api.json 파일에서 워크플로우 로드
workflow_with_api_nodes = load_workflow()

prompt = workflow_with_api_nodes

payload = {
    "prompt": prompt,
    # Add the `api_key_comfy_org` to the payload.
    # You can first get the key from the associated user if handling multiple clients.
}

# API 키가 있으면 extra_data에 추가
if API_KEY:
    payload["extra_data"] = {
        "api_key_comfy_org": API_KEY  # replace with actual key
    }
    print(f"✅ API 키 사용: {API_KEY[:20]}...")
else:
    print("⚠️  API 키가 설정되지 않았습니다. 환경 변수 COMFY_API_KEY를 설정하세요.")

data = json.dumps(payload).encode("utf-8")
req = request.Request(f"{SERVER_URL}/prompt", data=data)
response = request.urlopen(req)
result = json.loads(response.read().decode("utf-8"))
print(f"✅ 이미지 생성 워크플로우 실행 시작")
print(f"   Prompt ID: {result.get('prompt_id', 'N/A')}")
print(f"   ComfyUI 웹 인터페이스에서 결과를 확인하세요: {SERVER_URL}")

