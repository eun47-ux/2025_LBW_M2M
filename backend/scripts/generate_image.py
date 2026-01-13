"""
이미지 생성 Python 스크립트 (CLI 버전)
Node.js에서 child_process로 실행
"""
import json
import sys
import os
import mimetypes
from urllib import request as urllib_request
from pathlib import Path

# 환경 변수에서 설정 읽기
SERVER_URL = os.getenv("COMFY_URL", "http://143.248.107.38:8188")
API_KEY = os.getenv("COMFY_API_KEY", "")

# 워크플로우 파일 경로
BASE_DIR = Path(__file__).resolve().parent.parent
IMAGE_WORKFLOW_PATH = BASE_DIR / "workflows" / "M2M_image_api.json"
VIDEO_WORKFLOW_PATH = BASE_DIR / "workflows" / "M2M_video_api.json"


def load_workflow(path_obj):
    """워크플로우 파일 로드"""
    if not path_obj.exists():
        raise FileNotFoundError(f"워크플로우 파일을 찾을 수 없습니다: {path_obj}")
    with open(path_obj, "r", encoding="utf-8") as f:
        return json.load(f)


def upload_image_to_comfy(file_path, filename):
    """이미지를 ComfyUI 서버에 업로드"""
    with open(file_path, 'rb') as f:
        data = f.read()
    
    # multipart/form-data로 업로드
    mime_type = mimetypes.guess_type(filename)[0] or "application/octet-stream"
    boundary = '----WebKitFormBoundary7MA4YWxkTrZu0gW'
    body = []
    body.append(f'--{boundary}'.encode())
    body.append(f'Content-Disposition: form-data; name="image"; filename="{filename}"'.encode())
    body.append(f'Content-Type: {mime_type}'.encode())
    body.append(b'')
    body.append(data)
    body.append(f'--{boundary}--'.encode())
    body.append(b'')
    
    req_data = b'\r\n'.join(body)
    
    req = urllib_request.Request(
        f"{SERVER_URL}/upload/image",
        data=req_data,
        headers={
            'Content-Type': f'multipart/form-data; boundary={boundary}',
            'Content-Length': str(len(req_data))
        }
    )
    
    response = urllib_request.urlopen(req)
    result = json.loads(response.read().decode("utf-8"))
    
    # 파일명 반환 (서브폴더가 있으면 포함)
    if result.get('subfolder'):
        return f"{result['subfolder']}/{result['name']}"
    return result.get('name', filename)


def send_workflow(workflow_json):
    """ComfyUI에 워크플로우 전송"""
    payload = {"prompt": workflow_json}
    
    # API 키가 있으면 extra_data에 추가
    if API_KEY:
        payload["extra_data"] = {
            "api_key_comfy_org": API_KEY
        }
    
    data = json.dumps(payload).encode("utf-8")
    req = urllib_request.Request(f"{SERVER_URL}/prompt", data=data)
    response = urllib_request.urlopen(req)
    return json.loads(response.read().decode("utf-8"))


def find_nodes(workflow, class_type):
    return [
        node_id
        for node_id, node in workflow.items()
        if node.get("class_type") == class_type
    ]


def find_loadimage_nodes(workflow):
    """워크플로우에서 LoadImage 노드 ID 목록을 반환"""
    load_nodes = find_nodes(workflow, "LoadImage")
    return sorted(load_nodes, key=lambda x: int(x) if str(x).isdigit() else str(x))


def find_first_node(workflow, class_type):
    ids = find_nodes(workflow, class_type)
    return ids[0] if ids else None


def build_image_workflow(crop1_filename, crop2_filename, prompt=None, filename_prefix=None):
    """이미지 생성 워크플로우 빌드"""
    workflow = load_workflow(IMAGE_WORKFLOW_PATH)
    
    load_nodes = find_loadimage_nodes(workflow)
    if len(load_nodes) < 2:
        raise RuntimeError(f"LoadImage 노드를 2개 이상 찾지 못했습니다 (found: {load_nodes})")
    
    workflow[load_nodes[0]]["inputs"]["image"] = crop1_filename
    workflow[load_nodes[1]]["inputs"]["image"] = crop2_filename
    
    gemini_id = find_first_node(workflow, "GeminiImageNode")
    if gemini_id and prompt:
        workflow[gemini_id]["inputs"]["prompt"] = prompt
    
    save_id = find_first_node(workflow, "SaveImage")
    if save_id:
        if filename_prefix:
            workflow[save_id]["inputs"]["filename_prefix"] = filename_prefix
    
    return workflow


def generate_image(crop1_path, crop2_path, prompt=None, filename_prefix=None):
    """이미지 생성 함수"""
    # ComfyUI에 이미지 업로드
    crop1_filename = upload_image_to_comfy(crop1_path, Path(crop1_path).name)
    crop2_filename = upload_image_to_comfy(crop2_path, Path(crop2_path).name)
    
    # 워크플로우 빌드
    workflow = build_image_workflow(
        crop1_filename,
        crop2_filename,
        prompt=prompt,
        filename_prefix=filename_prefix
    )
    
    # 워크플로우 실행
    result = send_workflow(workflow)
    
    return {
        "ok": True,
        "prompt_id": result.get("prompt_id", "N/A"),
        "crop1_filename": crop1_filename,
        "crop2_filename": crop2_filename,
    }


if __name__ == "__main__":
    # JSON 입력 받기
    try:
        input_data = json.loads(sys.stdin.read())
        command = input_data.get("command")  # "image"
        
        if command == "image":
            result = generate_image(
                crop1_path=input_data["crop1_path"],
                crop2_path=input_data["crop2_path"],
                prompt=input_data.get("prompt"),
                filename_prefix=input_data.get("filename_prefix")
            )
        else:
            result = {"ok": False, "error": f"Unknown command: {command}"}
        
        # JSON 출력
        print(json.dumps(result))
        
    except Exception as e:
        error_result = {
            "ok": False,
            "error": str(e)
        }
        print(json.dumps(error_result))
        sys.exit(1)
