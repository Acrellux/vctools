import os
os.environ["OMP_NUM_THREADS"] = "1"
import json
import whisper
import subprocess
import psutil

BASE_DIR = os.path.abspath(os.path.dirname(__file__))
FFMPEG_PATH = os.path.abspath(os.path.join(BASE_DIR, "..", "..", "ffmpeg", "ffmpeg.exe"))
MODEL_DIR = os.path.join(BASE_DIR, "models")  # Optional: change this to wherever your .pt file is

if not os.path.exists(FFMPEG_PATH):
    print(json.dumps({"error": f"FFmpeg not found at {FFMPEG_PATH}"}))
    exit(1)

os.environ["PATH"] = os.path.dirname(FFMPEG_PATH) + os.pathsep + os.environ["PATH"]

def get_gpu_load_simulated():
    """Stub: Simulate load by checking CPU load and estimating queue length."""
    load = psutil.cpu_percent(interval=0.3)
    return "tiny.en" if load > 60 else "small.en"

def transcribe_audio(wav_file):
    print(json.dumps({"debug": f"Transcribe.py received file: {wav_file}"}))

    if not os.path.exists(wav_file):
        print(json.dumps({"error": f"WAV file not found at {wav_file}"}))
        return

    try:
        subprocess.run([FFMPEG_PATH, "-version"], check=True, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
    except Exception as e:
        print(json.dumps({"error": f"FFmpeg execution failed: {str(e)}"}))
        return

    try:
        base_en_path = os.path.join(MODEL_DIR, "base-en.pt")
        if os.path.exists(base_en_path):
            model = whisper.load_model("base.en", download_root=MODEL_DIR).to("cuda")
            model_name = "base.en (local)"
        else:
            chosen_model = get_gpu_load_simulated()
            model = whisper.load_model(chosen_model).to("cuda")
            model_name = chosen_model

        result = model.transcribe(wav_file)
        print(json.dumps({"text": result["text"], "model": model_name}))
    except Exception as e:
        print(json.dumps({"error": f"Whisper failed: {str(e)}"}))

if __name__ == "__main__":
    import sys
    if len(sys.argv) < 2:
        print(json.dumps({"error": "WAV file path not provided."}))
        sys.exit(1)

    wav_file = sys.argv[1]
    transcribe_audio(wav_file)
