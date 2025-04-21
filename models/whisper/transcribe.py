import os
import json
import whisper
import subprocess

# Get base directory
BASE_DIR = os.path.abspath(os.path.dirname(__file__))

# Update FFmpeg path to match new location
FFMPEG_PATH = os.path.abspath(os.path.join(BASE_DIR, "..", "..", "ffmpeg", "ffmpeg.exe"))

# Ensure FFmpeg is accessible
if not os.path.exists(FFMPEG_PATH):
    print(json.dumps({"error": f"FFmpeg not found at {FFMPEG_PATH}"}))
    exit(1)

# Add FFmpeg path to system PATH for this process
os.environ["PATH"] = os.path.dirname(FFMPEG_PATH) + os.pathsep + os.environ["PATH"]

def transcribe_audio(wav_file):
    """Loads a WAV file and transcribes it using Whisper."""
    
    # Debugging log
    print(json.dumps({"debug": f"Transcribe.py received file: {wav_file}"}))

    if not os.path.exists(wav_file):
        print(json.dumps({"error": f"WAV file not found at {wav_file}"}))
        return

    # Ensure FFmpeg is working
    try:
        subprocess.run([FFMPEG_PATH, "-version"], check=True, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
    except Exception as e:
        print(json.dumps({"error": f"FFmpeg execution failed: {str(e)}"}))
        return

    # Whisper Transcription
    try:
        model = whisper.load_model("base")
        result = model.transcribe(wav_file)
        print(json.dumps({"text": result["text"]}))  # ✅ JSON OUTPUT ONLY
    except Exception as e:
        print(json.dumps({"error": f"Whisper failed: {str(e)}"}))

if __name__ == "__main__":
    import sys
    if len(sys.argv) < 2:
        print(json.dumps({"error": "WAV file path not provided."}))
        sys.exit(1)
    
    wav_file = sys.argv[1]
    transcribe_audio(wav_file)
