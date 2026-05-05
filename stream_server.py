"""
stream_server.py
================
Streams the core Video-to-ASCII engine to the web via HTTP/WebSocket.
Dependencies: pip install fastapi uvicorn websockets
"""

import asyncio
import subprocess
import numpy as np
import cv2
from fastapi import FastAPI, WebSocket, WebSocketDisconnect
from fastapi.responses import HTMLResponse, StreamingResponse
from fastapi.staticfiles import StaticFiles
import uvicorn
import os
from websockets.exceptions import ConnectionClosed

# Import the existing engine (ascii_video_player2.py)
from ascii_video_player2 import VideoDecoder, AsciiMapper

app = FastAPI()

# Serve static files (style.css, app.js) from the project directory
BASE_DIR = os.path.dirname(os.path.abspath(__file__))
app.mount("/static", StaticFiles(directory=BASE_DIR), name="static")

def get_html_content():
    html_path = os.path.join(os.path.dirname(__file__), "index.html")
    with open(html_path, "r", encoding="utf-8") as f:
        return f.read()

@app.get("/")
async def root():
    """Serves the Frontend (HTML/JS/CSS) file to the client."""
    return HTMLResponse(get_html_content())

@app.get("/audio")
async def audio_stream():
    """
    Extracts and streams audio from the video file using ffmpeg.
    Returns an MP3 audio stream that the browser can play natively.
    """
    video_path = getattr(app.state, "video_path", "video.mp4")
    
    if not os.path.exists(video_path):
        from fastapi import HTTPException
        raise HTTPException(status_code=404, detail="Video file not found")
    
    def audio_generator():
        # Use ffmpeg to extract audio as MP3 stream
        process = subprocess.Popen(
            [
                "ffmpeg",
                "-i", video_path,
                "-vn",               # No video
                "-acodec", "libmp3lame",
                "-ab", "128k",       # 128kbps bitrate
                "-ar", "44100",      # Sample rate
                "-f", "mp3",         # Output format
                "-loglevel", "quiet",
                "pipe:1"             # Output to stdout
            ],
            stdout=subprocess.PIPE,
            stderr=subprocess.DEVNULL
        )
        try:
            while True:
                chunk = process.stdout.read(4096)
                if not chunk:
                    break
                yield chunk
        finally:
            process.stdout.close()
            process.wait()
    
    return StreamingResponse(
        audio_generator(),
        media_type="audio/mpeg",
        headers={"Accept-Ranges": "bytes"}
    )

@app.websocket("/ws")
async def websocket_endpoint(websocket: WebSocket):
    """
    Starts decoding the video when a client connects, 
    converts to pure ASCII using AsciiMapper and sends via WebSockets.
    """
    await websocket.accept()
    
    video_path = getattr(app.state, "video_path", "video.mp4")
    render_mode = getattr(app.state, "render_mode", 1)
    cols = getattr(app.state, "cols", 200)
    rows = getattr(app.state, "rows", 80)
    
    try:
        decoder = VideoDecoder(video_path, cols, rows)
    except FileNotFoundError:
        await websocket.send_text("Error: Video file not found!")
        await websocket.close()
        return

    mapper = AsciiMapper()
    fps = decoder.fps
    frame_t = 1.0 / fps
    
    # Character -> byte code lookup table (for binary format)
    char_byte_lut = np.array([ord(c) for c in mapper._lut], dtype=np.uint8)
    
    # Set the quantization level once (render_mode is fixed)
    qb = {5: 0, 4: 2, 3: 3, 2: 5}.get(render_mode, 0)
    
    # Send meta information to the client (to create cols/rows grid)
    await websocket.send_text(f"INIT:{fps}:{render_mode}:{cols}:{rows}")

    try:
        # Decoder iterator yields (gray, bgr) for each frame
        # Pre-allocate binary frame buffer (reduces GC pressure)
        frame_buf = np.empty((rows, cols, 4), dtype=np.uint8) if render_mode > 1 else None
        
        for gray_frame, bgr_frame in decoder:
            t0 = asyncio.get_event_loop().time()
            
            # Common: intensity -> character index
            indices = np.floor_divide(gray_frame, max(1, 256 // mapper._n))
            np.clip(indices, 0, mapper._n - 1, out=indices)
            
            if render_mode == 1:
                # --- PURE ASCII CONVERSION (text) ---
                char_matrix = mapper._lut[indices]
                lines = [''.join(row) for row in char_matrix]
                await websocket.send_text('\n'.join(lines))
            else:
                # --- COLOR BINARY CONVERSION (numpy, zero Python loops) ---
                H, W = gray_frame.shape
                char_codes = char_byte_lut[indices]   # (H,W) uint8
                
                rgb = bgr_frame[:, :, ::-1]           # BGR → RGB
                if qb > 0:
                    rgb = (rgb >> qb) << qb
                
                # [char, R, G, B] interleaved binary frame
                frame_buf[:, :, 0] = char_codes
                frame_buf[:, :, 1:] = rgb
                
                await websocket.send_bytes(frame_buf.tobytes())
                
            elapsed = asyncio.get_event_loop().time() - t0
            wait = frame_t - elapsed
            if wait > 0:
                await asyncio.sleep(wait)
                
    except (WebSocketDisconnect, ConnectionClosed):
        print("Client disconnected from the stream.")
    finally:
        decoder.release()

if __name__ == "__main__":
    import argparse
    parser = argparse.ArgumentParser(description="Real-Time ASCII Web Server")
    parser.add_argument("video", help="Video file to be streamed", default="video.mp4", nargs='?')
    parser.add_argument("--port", type=int, default=8000, help="Server port")
    parser.add_argument("--mode", type=int, choices=[1, 2, 3, 4, 5], default=1, help="Render Mode: 1=B&W, 2=512colors, 3=32K, 4=262K, 5=16M Ultra")
    parser.add_argument("--cols", type=int, default=200, help="Terminal column width")
    parser.add_argument("--rows", type=int, default=80, help="Terminal row height")
    args = parser.parse_args()
    
    # Save arguments globally into the state
    app.state.video_path = args.video
    app.state.render_mode = args.mode
    app.state.cols = args.cols
    app.state.rows = args.rows
    
    if not os.path.exists(args.video):
        print(f"\n[WARNING] Video file '{args.video}' not found!")
        print("The server will start, but streaming will fail until the file is provided.\n")
    else:
        print(f"[{args.video}] ready to stream. Mode: {args.mode}, Res: {args.cols}x{args.rows}")
        
    print(f"Starting server... Please go to http://localhost:{args.port} in your browser.")
    
    uvicorn.run(app, host="0.0.0.0", port=args.port, ws_ping_interval=None, ws_ping_timeout=None)
