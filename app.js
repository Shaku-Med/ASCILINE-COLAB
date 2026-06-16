/**
 * ASCILINE ENGINE - Pure & Performant Logic
 * =========================================
 * No decorative animations. Pure WebSocket streaming
 * and high-performance canvas rendering.
 * Includes an "Invisible Selection Layer" for text selection.
 */

const player    = document.getElementById('ascii-player');
const canvas    = document.getElementById('ascii-canvas');
const ctx       = canvas.getContext('2d');
const statusEl  = document.getElementById('status');
const container = document.getElementById('player-container');
const overlay   = document.getElementById('play-overlay');
const audioEl   = document.getElementById('ascii-audio');
const volumeSlider = document.getElementById('volume-slider');
// Player controls
const btnPlay     = document.getElementById('btn-play');
const btnBack     = document.getElementById('btn-back');
const btnFwd      = document.getElementById('btn-fwd');
const seekSlider  = document.getElementById('seek-slider');
const seekBuffered = document.getElementById('seek-buffered');
const seekWrap    = document.querySelector('.seek-wrap');
const seekPreview = document.getElementById('seek-preview');
const seekPreviewImg  = document.getElementById('seek-preview-img');
const seekPreviewTime = document.getElementById('seek-preview-time');
const timeDisplay = document.getElementById('time-display');
const speedSelect = document.getElementById('speed-select');
const controlsBar = document.querySelector('.player-controls');

// ── STATE ──
let state = 'IDLE'; // IDLE | PLAYING | PAUSED
let ws = null;
const frameBuffer = [];
const BUFFER_SIZE = 4;
let codecDecoder = null; // Adaptive codec decoder (codec.js)

// ── PLAYBACK MODE (live WebSocket vs pre-rendered file) ──
// Decided by the server CLI (--playback). Fetched once from /config below.
let playbackMode = 'live';      // 'live' | 'prerendered'
let loopEnabled = false;
let prerenderedQueue = [];      // array of manifests from /config
let pqIndex = 0;                // which prerendered entry is playing
let curManifest = null;
// Pre-rendered decode pump (decodes the .aldata file ahead of playback)
let pumpBytes = null, pumpView = null, pumpPos = 0, pumpFrameIdx = 0;
let pumpRunning = false, pumpDone = false;
// Seeking + speed
let frameOffsets = null;     // byte offset of each frame's [len] header in .aldata
let keyframeInterval = 1;    // decode must restart from a keyframe when seeking
let playbackSpeed = 1;
let userSeeking = false;     // true while the user drags the seek slider
let seekRequest = null;      // pending keyframe index for the pump to jump to
let previewToken = 0;        // guards overlapping paused-scrub previews
let buffering = false;       // true while playing but the buffer has run dry
let seekThumbMeta = null;    // scrub-preview sprite layout (from manifest.seekThumbs)

fetch('/config').then(r => r.json()).then(cfg => {
    playbackMode     = cfg.playback || 'live';
    loopEnabled      = !!cfg.loop;
    prerenderedQueue = cfg.queue || [];
    applyControlsForMode();
    // Show the poster thumbnail of the first entry (if baked) before play
    if (playbackMode === 'prerendered' && prerenderedQueue[0]) {
        showThumbnail(prerenderedQueue[0]);
    }
}).catch(() => { /* default to live */ });
let targetFps = 24;
let frameInterval = 1000 / targetFps;
let renderMode = 1;
let pixelMode = false;
let readyToRender = false;
let pauseStartTime = 0;

// Grid & Dimensions
let gridCols = 0, gridRows = 0;
let charWidth = 0, charHeight = 0;
let xPos = null, yPos = null;

// Pixel Mode (--pixel) — ImageData pixel buffer
let dotImageData = null;

// Selection Layer optimization
const textDecoder = new TextDecoder();
let selectionBuffer = null;

// Timing & Metrics
let lastRenderTime = 0;
let frameCount = 0, currentFps = 0, lastFpsUpdate = 0;
let streamStartTime = 0;

const CHAR_LUT = new Array(128);
for (let i = 0; i < 128; i++) CHAR_LUT[i] = String.fromCharCode(i);

// ═══════════════════════════════════════
//  CANVAS SETUP
// ═══════════════════════════════════════

function buildCanvas(cols, rows) {
    gridCols = cols;
    gridRows = rows;

    // Sizing and positioning for both layers
    const syncSize = (el) => {
        el.style.width  = container.clientWidth + 'px';
        el.style.height = container.clientHeight + 'px';
        el.style.objectFit = 'contain';
        el.style.position = 'absolute';
        el.style.top = '0';
        el.style.left = '0';
    };

    if (pixelMode) {
        // ── DOT MODE: 1 canvas pixel = 1 grid cell ──
        canvas.width  = cols;
        canvas.height = rows;
        canvas.style.display = 'block';
        canvas.style.imageRendering = 'pixelated';
        dotImageData = ctx.createImageData(cols, rows);
        // Pre-fill alpha channel to 255 (fully opaque)
        const d = dotImageData.data;
        for (let i = 3; i < d.length; i += 4) d[i] = 255;
        syncSize(canvas);
        // Hide selection layer — no text to select in dot mode
        player.style.display = 'none';
    } else {
        // ── STANDARD ASCII MODES (1-5) ──
        canvas.style.imageRendering = '';
        dotImageData = null;
        ctx.font = 'bold 8px Courier New';
        charWidth = ctx.measureText('M').width;
        charHeight = 8;
        canvas.width  = cols * charWidth;
        canvas.height = rows * charHeight;
        canvas.style.display = 'block';

        // Selection Layer Buffer
        selectionBuffer = new Uint8Array((cols + 1) * rows);
        for (let r = 0; r < rows; r++) selectionBuffer[r * (cols + 1) + cols] = 10;

        syncSize(canvas);

        // Selection layer: match canvas object-fit:contain position exactly
        const containerW = container.clientWidth;
        const containerH = container.clientHeight;
        const fitScaleX = containerW / canvas.width;
        const fitScaleY = containerH / canvas.height;
        const fitScale  = Math.min(fitScaleX, fitScaleY);
        const renderedW = canvas.width  * fitScale;
        const renderedH = canvas.height * fitScale;
        const offsetX   = (containerW - renderedW) / 2;
        const offsetY   = (containerH - renderedH) / 2;

        player.style.width  = canvas.width + 'px';
        player.style.height = canvas.height + 'px';
        player.style.position = 'absolute';
        player.style.top = '0';
        player.style.left = '0';
        player.style.transformOrigin = 'top left';
        player.style.transform = `translate(${offsetX}px, ${offsetY}px) scale(${fitScale})`;
        player.style.fontSize = '8px';
        player.style.lineHeight = '8px';

        ctx.font = 'bold 8px Courier New';
        ctx.textBaseline = 'top';
        xPos = new Float32Array(cols);
        yPos = new Float32Array(rows);
        for (let c = 0; c < cols; c++) xPos[c] = c * charWidth;
        for (let r = 0; r < rows; r++) yPos[r] = r * charHeight;
    }
}

// ═══════════════════════════════════════
//  STREAM CONTROL
// ═══════════════════════════════════════

function startStream() {
    if (state !== 'IDLE') return;
    overlay.classList.add('hidden');
    statusEl.style.color = 'var(--accent-color)';
    if (playbackMode === 'prerendered') {
        statusEl.textContent = 'Loading…';
        pqIndex = 0;
        playPrerenderedEntry(pqIndex);
    } else {
        statusEl.textContent = 'Connecting...';
        connectWebSocket();
    }
}

function connectWebSocket() {
    frameBuffer.length = 0;
    frameCount = 0;
    currentFps = 0;

    // Audio is loaded later in INIT handler (Audio Ready Gate).
    // Don't preload here — causes race conditions with vol=0 (204 response).

    const protocol = location.protocol === 'https:' ? 'wss:' : 'ws:';
    ws = new WebSocket(`${protocol}//${location.host}/ws?codec=adaptive`);
    ws.binaryType = 'arraybuffer';

    ws.onmessage = (event) => {
        if (typeof event.data === 'string') {
            if (event.data.startsWith('Error:')) {
                statusEl.textContent = event.data;
                statusEl.style.color = '#ff0000';
                if (ws) ws.close();
                setTimeout(() => finishStream(), 3000);
                return;
            }
            if (event.data.startsWith('INIT:')) {
                const p = event.data.split(':');
                targetFps = parseFloat(p[1]);
                frameInterval = 1000 / targetFps;
                renderMode = parseInt(p[2]);
                pixelMode = (p.length > 5 && parseInt(p[5]) === 1);
                const currentQueueIndex = (p.length > 6) ? parseInt(p[6]) : null;
                buildCanvas(parseInt(p[3]), parseInt(p[4]));

                // Initialize adaptive codec decoder (pixel=3 bytes, ASCII color=4 bytes)
                if (typeof AscilineCodec !== 'undefined' && renderMode > 1) {
                    codecDecoder = AscilineCodec.makeDecoder(pixelMode ? 3 : 4);
                } else {
                    codecDecoder = null;
                }

                // ── AUDIO READY GATE ──
                // Buffer video frames but don't render until audio is ready.
                // This prevents the 0.5s initial stutter.
                readyToRender = false;
                state = 'PLAYING';
                updatePlayButton();

                const beginRendering = () => {
                    readyToRender = true;
                    streamStartTime = performance.now();
                    lastRenderTime = performance.now();
                    lastFpsUpdate = lastRenderTime;
                    requestAnimationFrame(renderFrame);
                };

                if (audioEl) {
                    audioEl.pause();
                    const qs = currentQueueIndex !== null ? `?v=${currentQueueIndex}&` : '?';
                    audioEl.src = `/audio${qs}t=${Date.now()}`;
                    audioEl.volume = volumeSlider ? volumeSlider.value : 1.0;
                    audioEl.load();
                    audioEl.play().catch(() => {});

                    // Wait for audio to actually start playing
                    if (audioEl.readyState >= 3) {
                        beginRendering();
                    } else {
                        audioEl.addEventListener('playing', beginRendering, { once: true });
                        // Fallback: if audio fails to load (vol=0 / 204), start after 500ms
                        setTimeout(() => {
                            if (!readyToRender) beginRendering();
                        }, 500);
                    }
                } else {
                    // No audio element at all → start immediately
                    beginRendering();
                }
                return;
            }
            
            // Mode 1: Text Frame with Timestamp
            const text = event.data;
            const newlineIdx = text.indexOf('\n');
            const frameIndex = parseInt(text.substring(0, newlineIdx));
            const frameTime = frameIndex / targetFps;
            const frameData = text.substring(newlineIdx + 1);
            frameBuffer.push({ data: frameData, time: frameTime });
        } else {
            // Binary Frames — decoded via adaptive codec (raw/zlib/delta)
            if (codecDecoder) {
                codecDecoder.decode(event.data).then(({ frameIndex, frame }) => {
                    const frameTime = frameIndex / targetFps;
                    frameBuffer.push({ data: frame, time: frameTime });
                });
            } else {
                // Fallback: legacy 4-byte header
                const buffer = event.data;
                const view = new DataView(buffer);
                const frameIndex = view.getUint32(0, false);
                const frameTime = frameIndex / targetFps;
                const frameData = new Uint8Array(buffer, 4);
                frameBuffer.push({ data: frameData, time: frameTime });
            }
        }

        while (frameBuffer.length > BUFFER_SIZE * 5) frameBuffer.shift();
    };

    ws.onopen = () => { statusEl.textContent = 'Buffering...'; };

    ws.onclose = () => {
        if (state === 'PLAYING' || state === 'PAUSED') {
            statusEl.textContent = 'Stream Ended.';
            statusEl.style.color = '#888';
            if (audioEl) audioEl.pause();
            setTimeout(() => finishStream(), 800);
        }
    };

    ws.onerror = () => {
        statusEl.textContent = 'Connection Error!';
        statusEl.style.color = '#ff0000';
        setTimeout(() => finishStream(), 2000);
    };
}

// ═══════════════════════════════════════
//  PRE-RENDERED PLAYBACK (no WebSocket)
// ═══════════════════════════════════════
// The .aldata file holds the exact same per-frame payloads the live socket
// would have sent (codec.js decodes the binary ones, mode 1 is UTF-8 text), so
// rendering reuses renderFrame() unchanged — mode 5 colours included. Audio is
// the master clock, exactly like live, so it plays "captions-over-video" style.

async function playPrerenderedEntry(i) {
    const man = prerenderedQueue[i];
    if (!man) { finishStream(); return; }
    if (!man.available) {
        statusEl.textContent = `Not pre-rendered: ${man.video || ''} — run with --prerender`;
        statusEl.style.color = '#ff0000';
        setTimeout(() => finishStream(), 3500);
        return;
    }

    curManifest   = man;
    targetFps     = man.fps;
    frameInterval = 1000 / targetFps;
    renderMode    = man.mode;
    pixelMode     = !!man.pixel;
    buildCanvas(man.cols, man.rows);

    codecDecoder = (man.cellBytes > 0 && typeof AscilineCodec !== 'undefined')
        ? AscilineCodec.makeDecoder(man.cellBytes)
        : null;

    // Reset buffers + decode pump for this entry
    frameBuffer.length = 0;
    pumpBytes = null; pumpView = null; pumpPos = 0; pumpFrameIdx = 0;
    pumpRunning = false; pumpDone = false; seekRequest = null;
    readyToRender = false;
    state = 'PLAYING';

    statusEl.textContent = 'Loading frames…';
    let buf;
    try {
        buf = await fetch('/ascidata/' + man.data).then(r => r.arrayBuffer());
    } catch (e) {
        statusEl.textContent = 'Failed to load pre-rendered data.';
        statusEl.style.color = '#ff0000';
        setTimeout(() => finishStream(), 2500);
        return;
    }
    if (state !== 'PLAYING') return; // stopped while loading
    pumpBytes = new Uint8Array(buf);
    pumpView  = new DataView(buf);
    buildFrameIndex();                          // enables seeking
    keyframeInterval = man.keyframeInterval || 1;

    // Prime the controls for this entry
    if (seekSlider) { seekSlider.max = man.duration || (man.nframes / targetFps); seekSlider.value = 0; }
    if (timeDisplay) timeDisplay.textContent = '0:00 / ' + fmtTime(man.duration || 0);
    setupSeekPreview(man);
    updatePlayButton();

    const begin = () => {
        readyToRender   = true;
        streamStartTime = performance.now();
        lastRenderTime  = performance.now();
        lastFpsUpdate   = lastRenderTime;
        pumpDecode();
        requestAnimationFrame(renderFrame);
    };

    if (man.audio && audioEl) {
        audioEl.onended = () => advancePrerendered();
        audioEl.pause();
        audioEl.src = '/ascidata/' + man.audio + '?t=' + Date.now();
        audioEl.volume = volumeSlider ? volumeSlider.value : 1.0;
        audioEl.playbackRate = playbackSpeed;
        audioEl.load();
        audioEl.play().then(begin).catch(() => begin());
    } else {
        if (audioEl) { audioEl.onended = null; audioEl.removeAttribute('src'); }
        begin();
    }
}

// Walk the [4B len][payload] records once to record each frame's byte offset,
// so a seek can jump the decode pump straight to the right keyframe.
function buildFrameIndex() {
    frameOffsets = [];
    let p = 0;
    while (p + 4 <= pumpBytes.length) {
        frameOffsets.push(p);
        const len = pumpView.getUint32(p, false);
        p += 4 + len;
    }
}

// THE SEEK FIX. Deltas patch the previous frame, so you can't just jump the
// audio clock — the decoder has to restart from the nearest keyframe at/before
// the target and roll forward. The earlier version reset the decoder right here,
// which could happen WHILE a frame was still decoding: the next delta then read a
// null previous frame, threw inside the async pump, and left it wedged forever
// (that was the freeze). Now we only *request* a seek; the pump applies it at a
// safe point where nothing is mid-decode.
function seekTo(timeSec) {
    if (playbackMode !== 'prerendered' || !pumpBytes || !frameOffsets) return;
    const N  = Math.max(0, Math.min(Math.round(timeSec * targetFps), frameOffsets.length - 1));
    const ki = keyframeInterval > 0 ? keyframeInterval : 1;
    const K  = Math.floor(N / ki) * ki;
    seekRequest = K;
    frameBuffer.length = 0;   // drop stale frames so the renderer doesn't wait on them
    pumpDone = false;
    if (state === 'PAUSED') {
        paintSeekPreview(N, K); // scrub-while-paused: show the target frame now
    } else {
        pumpDecode();           // (re)start the pump if it isn't already running
    }
}

// Decode just enough (keyframe K → target N) on a throwaway decoder to paint a
// single frame while paused, without disturbing the main decoder's state.
async function paintSeekPreview(N, K) {
    if (!pumpBytes || !frameOffsets) return;
    const my = ++previewToken;
    if (!codecDecoder) { // text mode: every frame is self-contained
        const pos = frameOffsets[N], len = pumpView.getUint32(pos, false);
        paintFrame(textDecoder.decode(pumpBytes.subarray(pos + 4, pos + 4 + len)));
        return;
    }
    const tmp = AscilineCodec.makeDecoder(curManifest.cellBytes);
    let frame;
    for (let i = K; i <= N; i++) {
        const pos = frameOffsets[i], len = pumpView.getUint32(pos, false);
        ({ frame } = await tmp.decode(pumpBytes.subarray(pos + 4, pos + 4 + len)));
        if (my !== previewToken) return; // a newer scrub superseded this one
    }
    if (state === 'PAUSED' && my === previewToken) paintFrame(frame);
}

// Move playback to an absolute time. With audio we set currentTime (which fires
// 'seeked' → seekTo); without audio we rebase the virtual clock and seek directly.
function performSeek(timeSec) {
    if (!curManifest) return;
    const dur = curManifest.duration || (curManifest.nframes / targetFps);
    timeSec = Math.max(0, Math.min(timeSec, dur));
    if (audioEl && curManifest.audio) {
        audioEl.currentTime = timeSec;
    } else {
        streamStartTime = performance.now() - (timeSec / playbackSpeed) * 1000;
        seekTo(timeSec);
    }
}

function getMasterClock() {
    if (audioEl && curManifest && curManifest.audio && audioEl.readyState >= 1) {
        return audioEl.currentTime;   // truth even while paused (correct for ±10 buttons)
    }
    return (performance.now() - streamStartTime) / 1000 * playbackSpeed;
}

function setSpeed(s) {
    if (curManifest && curManifest.audio) {
        playbackSpeed = s;
        if (audioEl) audioEl.playbackRate = s;
    } else {
        // no audio → rebase the virtual clock so the position stays continuous
        const mcNow = (performance.now() - streamStartTime) / 1000 * playbackSpeed;
        playbackSpeed = s;
        streamStartTime = performance.now() - (mcNow / s) * 1000;
    }
}

function onAudioSeeked() {
    if (playbackMode === 'prerendered' && audioEl) seekTo(audioEl.currentTime);
}

// Decode frames a bounded distance ahead of the clock so memory stays small and
// the UI never blocks. Deltas patch the previous frame, so order is mandatory.
// The try/finally guarantees pumpRunning is released even if a decode throws.
async function pumpDecode() {
    if (pumpRunning || !pumpBytes) return;
    pumpRunning = true;
    try {
        while (state === 'PLAYING') {
            // Apply a pending seek HERE: a safe point with no decode in flight,
            // so resetting the decoder can't corrupt an in-progress frame.
            if (seekRequest !== null) {
                const K = seekRequest; seekRequest = null;
                if (codecDecoder) codecDecoder.reset();
                pumpPos = frameOffsets[K];
                pumpFrameIdx = K;
            }
            if (pumpPos >= pumpBytes.length) { pumpDone = true; break; }
            if (frameBuffer.length > 90) {            // far enough ahead — yield
                await new Promise(r => setTimeout(r, 16));
                continue;
            }
            const pos = pumpPos;
            const len = pumpView.getUint32(pos, false);
            const msg = pumpBytes.subarray(pos + 4, pos + 4 + len);
            if (codecDecoder) {
                const { frameIndex, frame } = await codecDecoder.decode(msg);
                // A seek landed while this was decoding → frame is stale. Drop it
                // and let the loop top apply the seek (don't advance the cursor).
                if (seekRequest !== null) continue;
                frameBuffer.push({ data: frame, time: frameIndex / targetFps });
            } else {
                frameBuffer.push({ data: textDecoder.decode(msg), time: pumpFrameIdx / targetFps });
            }
            pumpPos = pos + 4 + len;
            pumpFrameIdx++;
        }
    } finally {
        pumpRunning = false;
    }
}

function advancePrerendered() {
    if (audioEl) audioEl.onended = null;
    readyToRender = false;
    pqIndex++;
    if (pqIndex >= prerenderedQueue.length) {
        if (loopEnabled) pqIndex = 0;
        else { finishStream(); return; }
    }
    playPrerenderedEntry(pqIndex);
}

// ═══════════════════════════════════════
//  RENDER LOOP
// ═══════════════════════════════════════

function renderFrame(now) {
    if (state !== 'PLAYING' || !readyToRender) return;
    requestAnimationFrame(renderFrame);

    // ── MASTER CLOCK LOGIC ──
    let masterClock;
    if (audioEl && audioEl.readyState >= 1 && !audioEl.paused) {
        masterClock = audioEl.currentTime;
    } else {
        masterClock = (now - streamStartTime) / 1000.0 * playbackSpeed;
    }

    if (frameBuffer.length === 0) {
        // Empty mid-play and more frames are coming → we're buffering.
        buffering = (playbackMode === 'prerendered' && !pumpDone);
        if (playbackMode === 'prerendered') updateControlsUI(masterClock);
        // Pre-rendered with no audio track: when the pump is drained and the
        // buffer is empty, the video is over → advance the queue.
        if (playbackMode === 'prerendered' && pumpDone &&
            (!curManifest || !curManifest.audio)) {
            advancePrerendered();
        }
        return;
    }
    buffering = false;
    if (playbackMode === 'prerendered') updateControlsUI(masterClock);

    // A/V Sync: Drop frames that are too far behind the master clock (catch up)
    while (frameBuffer.length > 1 && frameBuffer[0].time < masterClock - 0.1) {
        frameBuffer.shift();
    }

    // A/V Sync: Wait if the frame is in the future
    if (frameBuffer[0].time > masterClock + 0.05) {
        return;
    }

    const frameObj = frameBuffer.shift();
    const frame = frameObj.data;

    frameCount++;
    if (now - lastFpsUpdate >= 1000) {
        currentFps = frameCount;
        frameCount = 0;
        lastFpsUpdate = now;
        const modes = { 2: '512 Color', 3: '32K Color', 4: '262K Color', 5: '16M Ultra' };
        const label = (modes[renderMode] || 'B&W') + (pixelMode ? ' PIXEL' : '');
        statusEl.textContent = `FPS: ${currentFps}/${Math.round(targetFps)} | Buf: ${frameBuffer.length} | ${label}`;
    }

    lastRenderTime = now;
    paintFrame(frame);
}

// Draw one decoded frame to the canvas/selection layer. Shared by the live loop,
// the pre-rendered loop, and the static thumbnail poster.
function paintFrame(frame) {
    if (renderMode === 1) {
        player.style.display = 'block';
        player.style.color = '#fff';
        player.textContent = frame;
    } else if (pixelMode) {
        // ── ZERO-COPY PIXEL MODE ──
        // Server sends raw BGR (3 bytes/pixel). We swap B↔R here.
        const view = frame; // Already a Uint8Array
        const data = dotImageData.data;
        // view: [B,G,R, B,G,R, ...] → data: [R,G,B,A, R,G,B,A, ...]
        for (let src = 0, dst = 0; src < view.length; src += 3, dst += 4) {
            data[dst]     = view[src + 2]; // R (from BGR)
            data[dst + 1] = view[src + 1]; // G
            data[dst + 2] = view[src];     // B
            // Alpha already set to 255 in buildCanvas
        }
        ctx.putImageData(dotImageData, 0, 0);
    } else {
        // ── STANDARD COLOR MODES (2-5): fillText per character ──
        const view = frame; // Already a Uint8Array

        // 1. Draw Canvas (Background)
        ctx.fillStyle = '#050505';
        ctx.fillRect(0, 0, canvas.width, canvas.height);
        ctx.font = 'bold 8px Courier New';
        ctx.textBaseline = 'top';

        let col = 0, row = 0, prevPacked = -1;
        for (let idx = 0; idx < view.length; idx += 4) {
            const packed = (view[idx+1] << 16) | (view[idx+2] << 8) | view[idx+3];
            if (packed !== prevPacked) {
                ctx.fillStyle = `rgb(${view[idx+1]},${view[idx+2]},${view[idx+3]})`;
                prevPacked = packed;
            }
            ctx.fillText(CHAR_LUT[view[idx]], xPos[col], yPos[row]);

            // Fill Selection Buffer (char code is at view[idx])
            selectionBuffer[row * (gridCols + 1) + col] = view[idx];

            col++;
            if (col >= gridCols) { col = 0; row++; }
        }

        // 2. Update Selection Layer (Foreground)
        player.style.display = 'block';
        player.style.color = 'transparent';
        player.textContent = textDecoder.decode(selectionBuffer);
    }
}

// ═══════════════════════════════════════
//  CONTROLS + THUMBNAIL
// ═══════════════════════════════════════

function fmtTime(s) {
    s = Math.max(0, Math.floor(s || 0));
    const m = Math.floor(s / 60), ss = s % 60;
    return m + ':' + (ss < 10 ? '0' : '') + ss;
}

function updatePlayButton() {
    if (btnPlay) btnPlay.textContent = (state === 'PLAYING') ? '❚❚' : '▶';
}

function updateControlsUI(mc) {
    if (!curManifest) return;
    const dur = curManifest.duration || (curManifest.nframes / targetFps) || 0;
    if (seekSlider && !userSeeking) seekSlider.value = Math.min(mc, dur);
    if (timeDisplay) timeDisplay.textContent = fmtTime(mc) + ' / ' + fmtTime(dur);
    // Buffered = how far the decoder has run ahead (ready-to-play region).
    if (seekBuffered && curManifest.nframes) {
        seekBuffered.style.width = Math.min(100, (pumpFrameIdx / curManifest.nframes) * 100) + '%';
    }
    if (controlsBar) controlsBar.classList.toggle('buffering', buffering);
}

// Seeking + speed only make sense for a file; a live stream can't rewind.
function applyControlsForMode() {
    const live = playbackMode === 'live';
    [btnBack, btnFwd, seekSlider, speedSelect].forEach(el => { if (el) el.disabled = live; });
}

// Wire the sprite (one image, many cells) into the hover preview, or disable it.
function setupSeekPreview(man) {
    seekThumbMeta = (man && man.seekThumbs) ? man.seekThumbs : null;
    if (!seekThumbMeta || !seekPreviewImg) return;
    const m = seekThumbMeta;
    seekPreviewImg.style.width  = m.cellW + 'px';
    seekPreviewImg.style.height = m.cellH + 'px';
    seekPreviewImg.style.backgroundImage = `url(/ascidata/${m.sprite})`;
    seekPreviewImg.style.backgroundSize  = (m.gridCols * m.cellW) + 'px ' + (m.gridRows * m.cellH) + 'px';
}

// Show the sprite cell for the time under the cursor while hovering the seek bar.
function onSeekHover(e) {
    if (!seekThumbMeta || !curManifest || playbackMode !== 'prerendered') return;
    if (seekSlider && seekSlider.disabled) return;
    const m    = seekThumbMeta;
    const rect = seekWrap.getBoundingClientRect();
    const x    = Math.max(0, Math.min(e.clientX - rect.left, rect.width));
    const dur  = curManifest.duration || (curManifest.nframes / targetFps) || 0;
    const time = (x / rect.width) * dur;
    const idx  = Math.max(0, Math.min(Math.floor(time / m.interval), m.count - 1));
    const col  = idx % m.gridCols, row = Math.floor(idx / m.gridCols);
    seekPreviewImg.style.backgroundPosition = `-${col * m.cellW}px -${row * m.cellH}px`;
    seekPreviewTime.textContent = fmtTime(time);
    // Keep the popup inside the bar so it never clips off the edges.
    const half = m.cellW / 2;
    seekPreview.style.left = Math.max(half, Math.min(x, rect.width - half)) + 'px';
    seekPreview.classList.add('show');
}

function hideSeekPreview() {
    if (seekPreview) seekPreview.classList.remove('show');
}

// Render the baked poster frame (one keyframe) behind the play overlay.
async function showThumbnail(man) {
    if (!man || !man.available || !man.thumb) return;
    curManifest = man;           // so the seek bar can scrub-preview before play
    targetFps   = man.fps;
    renderMode  = man.mode;
    pixelMode   = !!man.pixel;
    buildCanvas(man.cols, man.rows);
    if (seekSlider) { seekSlider.max = man.duration || 0; seekSlider.value = 0; }
    if (seekBuffered) seekBuffered.style.width = '0%';
    if (timeDisplay) timeDisplay.textContent = '0:00 / ' + fmtTime(man.duration || 0);
    setupSeekPreview(man);
    try {
        const bytes = new Uint8Array(await fetch('/ascidata/' + man.thumb).then(r => r.arrayBuffer()));
        let frame;
        if (man.cellBytes > 0 && typeof AscilineCodec !== 'undefined') {
            ({ frame } = await AscilineCodec.makeDecoder(man.cellBytes).decode(bytes));
        } else {
            frame = textDecoder.decode(bytes);
        }
        if (state === 'IDLE') paintFrame(frame); // don't clobber live playback
    } catch (e) { /* no poster, no problem */ }
}

// ═══════════════════════════════════════
//  CLEANUP
// ═══════════════════════════════════════

function finishStream() {
    state = 'IDLE';
    if (ws) { ws.onclose = null; ws.close(); ws = null; }
    if (audioEl) { audioEl.onended = null; audioEl.pause(); audioEl.src = ''; }
    ctx.clearRect(0, 0, canvas.width, canvas.height);
    player.textContent = '';
    player.style.display = 'none';
    container.classList.remove('paused');
    overlay.classList.remove('hidden');
    statusEl.textContent = 'Ready';
    statusEl.style.color = 'rgba(255,255,255,0.6)';
    readyToRender = false;
    pauseStartTime = 0;
    frameBuffer.length = 0;
    // Reset pre-rendered playback state
    pumpBytes = null; pumpView = null; pumpDone = false; pumpRunning = false;
    frameOffsets = null; curManifest = null; seekRequest = null; buffering = false;
    // Reset controls
    if (seekSlider) seekSlider.value = 0;
    if (seekBuffered) seekBuffered.style.width = '0%';
    if (controlsBar) controlsBar.classList.remove('buffering');
    if (timeDisplay) timeDisplay.textContent = '0:00 / 0:00';
    hideSeekPreview();
    updatePlayButton();
    // Re-show the first entry's poster so the player isn't blank
    if (playbackMode === 'prerendered' && prerenderedQueue[0]) {
        showThumbnail(prerenderedQueue[0]);
    }
}

// ═══════════════════════════════════════
//  PAUSE / RESUME
// ═══════════════════════════════════════

function togglePause() {
    if (state === 'PLAYING') {
        state = 'PAUSED';
        pauseStartTime = performance.now();
        if (playbackMode === 'prerendered') {
            // Real pause: stop the audio so the master clock freezes.
            if (audioEl) audioEl.pause();
        } else if (audioEl && !audioEl.paused) {
            // Live stream: mute instead of pausing, so the master clock keeps
            // ticking with the server (you can't pause a live source).
            audioEl.dataset.prePauseVolume = audioEl.volume;
            audioEl.volume = 0;
        }
        container.classList.add('paused');
        statusEl.textContent = '❚❚ PAUSED';
        statusEl.style.color = '#888';
        updatePlayButton();
    } else if (state === 'PAUSED') {
        state = 'PLAYING';
        container.classList.remove('paused');
        statusEl.textContent = 'Resuming...';
        statusEl.style.color = 'var(--accent-color)';

        if (playbackMode === 'prerendered') {
            if (audioEl && curManifest && curManifest.audio) {
                audioEl.play().catch(() => {});
            } else if (pauseStartTime) {
                // No-audio virtual clock: absorb the paused gap so it doesn't jump.
                streamStartTime += performance.now() - pauseStartTime;
            }
            pauseStartTime = 0;
            seekTo(getMasterClock());   // re-align decoder + pump to the paused spot
        } else {
            // Live: restore volume, flush stale frames, kick the pump.
            if (audioEl && !audioEl.paused) {
                audioEl.volume = audioEl.dataset.prePauseVolume !== undefined
                    ? parseFloat(audioEl.dataset.prePauseVolume)
                    : (volumeSlider ? volumeSlider.value : 1.0);
            }
            pauseStartTime = 0;
            frameBuffer.length = 0;
        }

        lastRenderTime = performance.now();
        lastFpsUpdate = performance.now();
        frameCount = 0;
        requestAnimationFrame(renderFrame);
        updatePlayButton();
    }
}

// ── EVENT LISTENERS ──
overlay.addEventListener('click', (e) => {
    e.stopPropagation();
    startStream();
});

// ── PAUSE TOGGLE (click on player area) ──
container.addEventListener('click', (e) => {
    if (e.target.closest('#play-overlay')) return;
    if (window.getSelection().toString().length > 0) return;
    togglePause();
});

// ── KEYBOARD: Space to toggle pause ──
document.addEventListener('keydown', (e) => {
    if (e.code === 'Space' && (state === 'PLAYING' || state === 'PAUSED')) {
        e.preventDefault();
        togglePause();
    }
});

if (volumeSlider) {
    volumeSlider.addEventListener('input', () => {
        if (audioEl) audioEl.volume = volumeSlider.value;
    });
}

// ── PLAYER CONTROLS ──
if (btnPlay) {
    btnPlay.addEventListener('click', (e) => {
        e.stopPropagation();
        if (state === 'IDLE') startStream();
        else togglePause();
    });
}
if (btnBack) {
    btnBack.addEventListener('click', (e) => {
        e.stopPropagation();
        if (state === 'PLAYING' || state === 'PAUSED') performSeek(getMasterClock() - 10);
    });
}
if (btnFwd) {
    btnFwd.addEventListener('click', (e) => {
        e.stopPropagation();
        if (state === 'PLAYING' || state === 'PAUSED') performSeek(getMasterClock() + 10);
    });
}
if (seekSlider) {
    // While dragging, hold the UI; commit the seek on release / change.
    seekSlider.addEventListener('input', () => {
        userSeeking = true;
        if (timeDisplay && curManifest) {
            const dur = curManifest.duration || 0;
            timeDisplay.textContent = fmtTime(parseFloat(seekSlider.value)) + ' / ' + fmtTime(dur);
        }
    });
    seekSlider.addEventListener('change', () => {
        userSeeking = false;
        if (state === 'PLAYING' || state === 'PAUSED') performSeek(parseFloat(seekSlider.value));
    });
}
if (speedSelect) {
    speedSelect.addEventListener('change', () => setSpeed(parseFloat(speedSelect.value)));
}
// Scrub-preview thumbnail on hover (YouTube-style)
if (seekWrap) {
    seekWrap.addEventListener('mousemove', onSeekHover);
    seekWrap.addEventListener('mouseleave', hideSeekPreview);
}
// Catch ANY seek of the audio element (our slider, OS media keys, etc.) and
// re-sync the frame decoder — this is what fixes the freeze-after-seek bug.
if (audioEl) {
    audioEl.addEventListener('seeked', onAudioSeeked);
}

window.addEventListener('resize', () => {
    const syncSize = (el) => {
        if (!el) return;
        el.style.width  = container.clientWidth + 'px';
        el.style.height = container.clientHeight + 'px';
    };
    syncSize(canvas);
    syncSize(player);
});
