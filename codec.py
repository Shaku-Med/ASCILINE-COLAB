"""
codec.py — Adaptive per-frame codec for ASCILINE's binary WebSocket stream.

Wire format (one message per frame):
    [4 bytes: frame_index, big-endian uint32]
    [1 byte : codec tag]
    [payload ...]

Tags:
    0 RAW    payload = framebuffer bytes, as the legacy protocol sent them
    1 ZLIB   payload = zlib(framebuffer bytes)
    2 DELTA  payload = zlib( changed-cell indices [uint32 LE] ++ changed values )

The encoder picks the smallest applicable encoding per frame. The decoder lives
in codec.js (browser + Node) so the shipped path is the tested path; it never
needs to change for any of the encoder optimizations below.

Optimizations:
  - zlib level 3 (near level-6 ratio at roughly half the CPU)
  - smart candidate selection: only try DELTA when few cells changed and ZLIB
    when many did, skipping the obvious loser at the extremes (saves CPU, no
    size cost in the common middle range)
  - lossy temporal delta (conditional replenishment): a colour cell is only
    re-sent once it drifts past `tolerance` from what the viewer already sees.
    The CHARACTER plane is always exact. tolerance=0 is lossless and keeps the
    stream bit-exact. State is the previously-SHOWN frame, so error is bounded
    by `tolerance` and never drifts.
"""
import struct
import zlib
import numpy as np

TAG_RAW = 0
TAG_ZLIB = 1
TAG_DELTA = 2

DEFAULT_LEVEL = 3        # zlib level: best size/CPU trade-off (see experiments/optimize.py)
KEYFRAME_INTERVAL = 48   # force a full frame this often for resync / late joiners

# Smart-selection thresholds (fraction of cells changed).
_DELTA_MAX_FRAC = 0.60   # above this, delta loses — don't bother building it
_ZLIB_MIN_FRAC = 0.10    # below this, full-frame zlib loses — don't bother


def _full_frame(raw: bytes, frame_index: int, level: int) -> bytes:
    z = zlib.compress(raw, level)
    if len(z) < len(raw):
        return struct.pack(">IB", frame_index, TAG_ZLIB) + z
    return struct.pack(">IB", frame_index, TAG_RAW) + raw


def encode_frame(frame: np.ndarray, prev: np.ndarray | None, frame_index: int,
                 level: int = DEFAULT_LEVEL, tolerance: int = 0):
    """
    Encode one framebuffer.

    :param frame: C-contiguous uint8 array, shape (rows, cols, C). C is 4 for
                  ASCII colour ([char,R,G,B]) or 3 for pixel mode ([B,G,R]).
    :param prev:  the previously-SHOWN frame (what the client currently displays)
                  or None for a keyframe.
    :param tolerance: max per-channel colour drift tolerated before re-sending a
                  cell (lossy). 0 = lossless. The character plane is always exact.
    :returns: (message_bytes, shown_frame) — shown_frame is what the client will
              now display and must be passed back as `prev` next call.
    """
    raw = frame.tobytes()
    keyframe = prev is None or (frame_index % KEYFRAME_INTERVAL == 0)
    if keyframe or prev.shape != frame.shape:
        return _full_frame(raw, frame_index, level), frame.copy()

    C = frame.shape[2]

    # ── Which cells changed? ──
    # Lossless (tolerance=0, the default) only needs equality, so a direct uint8
    # comparison suffices — avoids upcasting the WHOLE frame to int16 and an
    # abs() over it every frame. Only the lossy path needs drift magnitude, and
    # there only on the colour channels.
    if tolerance <= 0:
        changed = np.any(frame != prev, axis=2)
    elif C == 4:
        # channel 0 is the character (structure) -> always exact; tolerance on colour
        diff = np.abs(frame[:, :, 1:].astype(np.int16) - prev[:, :, 1:].astype(np.int16))
        changed = (frame[:, :, 0] != prev[:, :, 0]) | np.any(diff > tolerance, axis=2)
    else:
        diff = np.abs(frame.astype(np.int16) - prev.astype(np.int16))
        changed = np.any(diff > tolerance, axis=2)

    frac = float(changed.mean())

    candidates = []  # (tag, payload, shown_after_decode)
    # Only build the DELTA candidate when motion is low enough for it to win.
    # The nonzero scan + full prev copy + scatter write are pure waste in the
    # high-motion case — which is exactly when the CPU is most stressed.
    if frac < _DELTA_MAX_FRAC:
        ci = np.nonzero(changed.reshape(-1))[0].astype("<u4")
        vals = frame.reshape(-1, C)[ci]
        delta = zlib.compress(ci.tobytes() + vals.tobytes(), level)
        # Lossy reconstruction the client will hold if we send this DELTA.
        delta_shown = prev.copy()
        delta_shown.reshape(-1, C)[ci] = vals
        candidates.append((TAG_DELTA, delta, delta_shown))
    if frac >= _ZLIB_MIN_FRAC or not candidates:
        candidates.append((TAG_ZLIB, zlib.compress(raw, level), frame))

    tag, payload, shown = min(candidates, key=lambda c: len(c[1]))
    # Never exceed the raw frame (zlib can inflate incompressible data slightly).
    if len(raw) < len(payload):
        tag, payload, shown = TAG_RAW, raw, frame

    msg = struct.pack(">IB", frame_index, tag) + payload
    # If we sent a full frame, the client shows the TRUE frame, not the lossy one.
    return msg, (shown.copy() if shown is frame else shown)
