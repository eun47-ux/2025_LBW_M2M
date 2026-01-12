"""
Flask 웹 애플리케이션 - M2M 이미지 생성
ComfyUI API 노드를 사용한 이미지 생성 워크플로우 실행
"""
from flask import Flask, request, jsonify, render_template_string
import json
import os
from urllib import request as urllib_request
from pathlib import Path
from werkzeug.utils import secure_filename
import tempfile

app = Flask(__name__)
app.config['MAX_CONTENT_LENGTH'] = 16 * 1024 * 1024  # 16MB max file size
app.config['UPLOAD_FOLDER'] = tempfile.gettempdir()

SERVER_URL = "http://143.248.107.38:8188"

# 워크플로우 파일 경로
WORKFLOW_PATH = Path(__file__).parent.parent / "M2M_image_api.json"

# ComfyUI Platform API 키 (환경 변수에서 읽기)
API_KEY = os.getenv("COMFY_API_KEY", "")

def load_workflow():
    """M2M_image_api.json 워크플로우 파일 로드"""
    if not WORKFLOW_PATH.exists():
        raise FileNotFoundError(f"워크플로우 파일을 찾을 수 없습니다: {WORKFLOW_PATH}")
    
    with open(WORKFLOW_PATH, "r", encoding="utf-8") as f:
        return json.load(f)

def upload_image_to_comfy(file_path, filename):
    """
    이미지를 ComfyUI 서버에 업로드
    
    Args:
        file_path: 업로드할 파일 경로
        filename: 파일명
    
    Returns:
        업로드된 파일명 (서브폴더 포함 가능)
    """
    with open(file_path, 'rb') as f:
        data = f.read()
    
    # multipart/form-data로 업로드
    boundary = '----WebKitFormBoundary7MA4YWxkTrZu0gW'
    body = []
    body.append(f'--{boundary}'.encode())
    body.append(f'Content-Disposition: form-data; name="image"; filename="{filename}"'.encode())
    body.append(b'Content-Type: image/png')
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
    """
    ComfyUI에 워크플로우 전송
    
    Args:
        workflow_json: 워크플로우 딕셔너리
    
    Returns:
        응답 결과 딕셔너리
    """
    payload = {
        "prompt": workflow_json,
        # Add the `api_key_comfy_org` to the payload.
        # You can first get the key from the associated user if handling multiple clients.
    }
    
    # API 키가 있으면 extra_data에 추가
    if API_KEY:
        payload["extra_data"] = {
            "api_key_comfy_org": API_KEY  # replace with actual key
        }
    
    data = json.dumps(payload).encode("utf-8")
    req = urllib_request.Request(f"{SERVER_URL}/prompt", data=data)
    response = urllib_request.urlopen(req)
    return json.loads(response.read().decode("utf-8"))

def find_loadimage_nodes(workflow):
    """워크플로우에서 LoadImage 노드 ID 목록을 반환"""
    load_nodes = [
        node_id
        for node_id, node in workflow.items()
        if node.get("class_type") == "LoadImage"
    ]
    return sorted(load_nodes, key=lambda x: int(x) if str(x).isdigit() else str(x))

@app.route("/")
def index():
    """메인 페이지"""
    html = """
    <!DOCTYPE html>
    <html lang="ko">
    <head>
        <meta charset="UTF-8">
        <meta name="viewport" content="width=device-width, initial-scale=1.0">
        <title>M2M 이미지 생성 (Flask)</title>
        <style>
            * { box-sizing: border-box; }
            body {
                font-family: system-ui, -apple-system, sans-serif;
                max-width: 900px;
                margin: 0 auto;
                padding: 20px;
                background: #f5f5f5;
            }
            h1 {
                color: #333;
                border-bottom: 3px solid #4CAF50;
                padding-bottom: 10px;
            }
            .section {
                margin: 20px 0;
                padding: 20px;
                background: white;
                border-radius: 8px;
                box-shadow: 0 2px 4px rgba(0,0,0,0.1);
            }
            button {
                padding: 12px 24px;
                margin: 5px;
                cursor: pointer;
                border: none;
                border-radius: 4px;
                background: #4CAF50;
                color: white;
                font-weight: 600;
                font-size: 16px;
            }
            button:hover { background: #45a049; }
            button:disabled { background: #ccc; cursor: not-allowed; }
            pre {
                background: #f5f5f5;
                padding: 15px;
                border-radius: 4px;
                overflow-x: auto;
                font-size: 12px;
                max-height: 400px;
                overflow-y: auto;
            }
            .success { color: #4CAF50; }
            .error { color: #f44336; }
            input[type="file"] {
                padding: 8px;
                border: 1px solid #ddd;
                border-radius: 4px;
                width: 100%;
                max-width: 400px;
            }
            img {
                max-width: 200px;
                max-height: 200px;
                border-radius: 8px;
                margin-top: 10px;
            }
        </style>
    </head>
    <body>
        <h1>🎨 M2M 이미지 생성 (Flask)</h1>
        
        <div class="section">
            <h2>이미지 업로드 및 생성</h2>
            <p>크롭 이미지 2개를 업로드하면 이미지가 생성됩니다.</p>
            
            <div style="margin: 20px 0;">
                <label>크롭 이미지 1:</label>
                <input type="file" id="crop1" accept="image/*" style="margin: 10px 0; display: block;">
                <div id="crop1-preview" style="margin-top: 10px;"></div>
            </div>
            
            <div style="margin: 20px 0;">
                <label>크롭 이미지 2:</label>
                <input type="file" id="crop2" accept="image/*" style="margin: 10px 0; display: block;">
                <div id="crop2-preview" style="margin-top: 10px;"></div>
            </div>
            
            <button onclick="generateImage()" id="generate-btn" disabled>이미지 생성 시작</button>
            <pre id="result"></pre>
        </div>
        
        <script>
            let crop1File = null;
            let crop2File = null;
            
            // 이미지 미리보기
            document.getElementById('crop1').addEventListener('change', (e) => {
                if (e.target.files[0]) {
                    crop1File = e.target.files[0];
                    const reader = new FileReader();
                    reader.onload = (ev) => {
                        document.getElementById('crop1-preview').innerHTML = 
                            `<img src="${ev.target.result}" alt="Crop 1">`;
                        updateGenerateButton();
                    };
                    reader.readAsDataURL(crop1File);
                }
            });
            
            document.getElementById('crop2').addEventListener('change', (e) => {
                if (e.target.files[0]) {
                    crop2File = e.target.files[0];
                    const reader = new FileReader();
                    reader.onload = (ev) => {
                        document.getElementById('crop2-preview').innerHTML = 
                            `<img src="${ev.target.result}" alt="Crop 2">`;
                        updateGenerateButton();
                    };
                    reader.readAsDataURL(crop2File);
                }
            });
            
            function updateGenerateButton() {
                document.getElementById('generate-btn').disabled = !(crop1File && crop2File);
            }
            
            async function generateImage() {
                if (!crop1File || !crop2File) {
                    alert('크롭 이미지 2개를 모두 선택하세요');
                    return;
                }
                
                const result = document.getElementById('result');
                const btn = document.getElementById('generate-btn');
                result.textContent = '이미지 업로드 및 생성 중...';
                btn.disabled = true;
                
                try {
                    const formData = new FormData();
                    formData.append('crop1', crop1File);
                    formData.append('crop2', crop2File);
                    
                    const res = await fetch('/api/generate', {
                        method: 'POST',
                        body: formData
                    });
                    
                    const data = await res.json();
                    result.textContent = JSON.stringify(data, null, 2);
                    result.className = data.ok ? 'success' : 'error';
                } catch (e) {
                    result.textContent = '에러: ' + e.message;
                    result.className = 'error';
                } finally {
                    btn.disabled = false;
                }
            }
        </script>
    </body>
    </html>
    """
    return render_template_string(html)

@app.route("/api/generate", methods=["POST"])
def generate_image():
    """이미지 업로드 및 생성"""
    try:
        # 크롭 이미지 2개 확인
        if 'crop1' not in request.files or 'crop2' not in request.files:
            return jsonify({
                "ok": False,
                "error": "크롭 이미지 2개가 필요합니다 (crop1, crop2)"
            }), 400
        
        crop1_file = request.files['crop1']
        crop2_file = request.files['crop2']
        
        if crop1_file.filename == '' or crop2_file.filename == '':
            return jsonify({
                "ok": False,
                "error": "파일을 선택하세요"
            }), 400
        
        # 임시 파일로 저장
        crop1_path = os.path.join(app.config['UPLOAD_FOLDER'], secure_filename(crop1_file.filename))
        crop2_path = os.path.join(app.config['UPLOAD_FOLDER'], secure_filename(crop2_file.filename))
        crop1_file.save(crop1_path)
        crop2_file.save(crop2_path)
        
        try:
            # ComfyUI에 이미지 업로드
            crop1_filename = upload_image_to_comfy(crop1_path, crop1_file.filename)
            crop2_filename = upload_image_to_comfy(crop2_path, crop2_file.filename)
            
            # 워크플로우 로드
            workflow = load_workflow()
            
            # LoadImage 노드에 업로드한 이미지 파일명 설정
            load_nodes = find_loadimage_nodes(workflow)
            if len(load_nodes) < 2:
                return jsonify({
                    "ok": False,
                    "error": f"LoadImage 노드를 2개 이상 찾지 못했습니다 (found: {load_nodes})"
                }), 500
            
            workflow[load_nodes[0]]["inputs"]["image"] = crop1_filename
            workflow[load_nodes[1]]["inputs"]["image"] = crop2_filename
            
            # 워크플로우 실행
            result = send_workflow(workflow)
            
            return jsonify({
                "ok": True,
                "message": "이미지 생성 워크플로우 실행 시작",
                "prompt_id": result.get("prompt_id", "N/A"),
                "crop1_filename": crop1_filename,
                "crop2_filename": crop2_filename,
                "hint": f"ComfyUI 웹 인터페이스에서 결과를 확인하세요: {SERVER_URL}"
            })
        finally:
            # 임시 파일 삭제
            if os.path.exists(crop1_path):
                os.remove(crop1_path)
            if os.path.exists(crop2_path):
                os.remove(crop2_path)
                
    except Exception as e:
        return jsonify({
            "ok": False,
            "error": str(e)
        }), 500

if __name__ == "__main__":
    print("=" * 60)
    print("M2M 이미지 생성 Flask 앱")
    print("=" * 60)
    print(f"서버: {SERVER_URL}")
    print(f"워크플로우: {WORKFLOW_PATH}")
    if API_KEY:
        print(f"✅ API 키 사용: {API_KEY[:20]}...")
    else:
        print("⚠️  API 키가 설정되지 않았습니다. 환경 변수 COMFY_API_KEY를 설정하세요.")
    print("=" * 60)
    print("서버 시작: http://localhost:5000")
    print("=" * 60)
    app.run(debug=True, port=5000)

