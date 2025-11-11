import os
os.environ["OMP_NUM_THREADS"] = "1"
import json
import math
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

def _confidence_from_segments(segments):
    """
    Compute a duration-weighted confidence in [0,1] from Whisper's avg_logprob per segment.
    confidence = exp(avg_logprob). Higher is better (closer to 1).
    """
    if not segments:
        return None
    num = 0.0
    den = 0.0
    for seg in segments:
        avg_lp = seg.get("avg_logprob", None)
        if avg_lp is None:
            continue
        # duration weight; fall back to 1e-3 to avoid zero division
        dur = max(1e-3, float(seg.get("end", 0.0)) - float(seg.get("start", 0.0)))
        conf = math.exp(float(avg_lp))  # maps negative logprobs to (0,1)
        # clamp to [0,1] just in case
        conf = max(0.0, min(1.0, conf))
        num += conf * dur
        den += dur
    if den == 0.0:
        return None
    return max(0.0, min(1.0, num / den))

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
        # Decide device safely
        import torch
        device = "cuda" if torch.cuda.is_available() else "cpu"
        print(json.dumps({"debug": f"Using device: {device}"}))

        base_en_path = os.path.join(MODEL_DIR, "base-en.pt")
        if os.path.exists(base_en_path):
            model = whisper.load_model("base.en", download_root=MODEL_DIR).to(device)
            model_name = "base.en (local)"
        else:
            chosen_model = get_gpu_load_simulated()
            model = whisper.load_model(chosen_model).to(device)
            model_name = chosen_model

        # Ask Whisper to return segments (default) with avg_logprob available
        result = model.transcribe(wav_file, verbose=False)
        text = result.get("text", "") or ""
        segments = result.get("segments", []) or []

        overall_conf = _confidence_from_segments(segments)
        # Fallback: if no segments confidence, provide a neutral 0.5
        if overall_conf is None:
            overall_conf = 0.5

        out = {
            "text": text,
            "model": model_name,
            "confidence": round(float(overall_conf), 4),
            "confidence_percent": int(round(overall_conf * 100.0)),
        }
        print(json.dumps(out))
    except Exception as e:
        print(json.dumps({"error": f"Whisper failed: {str(e)}"}))

if __name__ == "__main__":
    import sys
    if len(sys.argv) < 2:
        print(json.dumps({"error": "WAV file path not provided."}))
        sys.exit(1)

    wav_file = sys.argv[1]
    transcribe_audio(wav_file)
