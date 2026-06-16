"""
Tests for the pre render stuff I/We added to ASCILINE.

Only the new bits: the offline render, the asset files, and the two endpoints.
The original engine is left alone. Each test makes its own tiny video and writes
into a temp folder, so it never touches your real videos or needs ffmpeg.

    python -m unittest discover -s tests
    pytest tests/
"""
import io
import os
import sys
import json
import struct
import zlib
import asyncio
import tempfile
import shutil
import unittest
from contextlib import redirect_stdout

import numpy as np
import cv2

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
import stream_server as ss


def _make_test_video(path, frames=30, w=64, h=48, fps=10.0):
    # tiny clip with a block that moves around, so I/We get keyframes and deltas
    vw = cv2.VideoWriter(path, cv2.VideoWriter_fourcc(*"MJPG"), fps, (w, h))
    if not vw.isOpened():
        return False

    for i in range(frames):
        img = np.zeros((h, w, 3), np.uint8)
        img[:, : w // 2] = (40, 80, 120)
        img[:, w // 2 :] = (120, 80, 40)
        x = (i * 2) % max(1, w - 8)
        img[h // 2 : h // 2 + 8, x : x + 8] = (255, 255, 255)
        vw.write(img)

    vw.release()
    return os.path.exists(path) and os.path.getsize(path) > 0


def _decode_aldata_binary(data, C):
    # same thing codec.js does, just in python so I/We can check the file
    prev, pos, frames = None, 0, []

    while pos < len(data):
        (ln,) = struct.unpack_from(">I", data, pos); pos += 4
        msg = data[pos : pos + ln]; pos += ln
        fidx = struct.unpack_from(">I", msg, 0)[0]
        tag = msg[4]
        payload = msg[5:]

        if tag == 0:
            frame = bytearray(payload)
        elif tag == 1:
            frame = bytearray(zlib.decompress(payload))
        else:
            body = zlib.decompress(payload)
            k = len(body) // (4 + C)
            frame = bytearray(prev)
            voff = k * 4
            for j in range(k):
                cell = struct.unpack_from("<I", body, j * 4)[0]
                d, s = cell * C, voff + j * C
                frame[d : d + C] = body[s : s + C]

        prev = frame
        frames.append((fidx, bytes(frame)))

    return frames


def _read_bytes(path):
    with open(path, "rb") as f:
        return f.read()


def _read_aldata_text(data):
    # mode 1 just stores the text grid per frame
    pos, out = 0, []
    while pos < len(data):
        (ln,) = struct.unpack_from(">I", data, pos); pos += 4
        out.append(data[pos : pos + ln].decode("utf-8")); pos += ln
    return out


def _prerender_quiet(entry, **kw):
    # hush the progress bar so it doesn't spam the test output
    with redirect_stdout(io.StringIO()):
        return ss.prerender_video(entry, **kw)


class PrerenderTestBase(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.tmp = tempfile.mkdtemp(prefix="asciline_test_")
        cls.video = os.path.join(cls.tmp, "sample.avi")
        if not _make_test_video(cls.video):
            raise unittest.SkipTest("OpenCV could not write a test video here.")

        # point the asset folder at the temp dir so real files stay untouched
        cls._orig_dir = ss.ASCIDATA_DIR
        ss.ASCIDATA_DIR = os.path.join(cls.tmp, "ascidata")
        os.makedirs(ss.ASCIDATA_DIR, exist_ok=True)

    @classmethod
    def tearDownClass(cls):
        ss.ASCIDATA_DIR = cls._orig_dir
        shutil.rmtree(cls.tmp, ignore_errors=True)

    def entry(self, **over):
        e = {"video": self.video, "mode": 5, "pixel": False, "cols": 32, "rows": 0, "vol": 0}
        e.update(over)
        return e


class TestNaming(PrerenderTestBase):
    def test_asset_key_encodes_settings(self):
        k1 = ss.asset_key({"video": "a.mp4", "mode": 5, "pixel": False}, 240, 67)
        self.assertEqual(k1, "a.m5.240x67")

        # change any setting and the name has to change too
        self.assertNotEqual(k1, ss.asset_key({"video": "a.mp4", "mode": 5, "pixel": True}, 240, 67))
        self.assertNotEqual(k1, ss.asset_key({"video": "a.mp4", "mode": 3, "pixel": False}, 240, 67))
        self.assertNotEqual(k1, ss.asset_key({"video": "a.mp4", "mode": 5, "pixel": False}, 200, 67))

    def test_asset_key_sanitizes_name(self):
        k = ss.asset_key({"video": "I/We ird/na:me.mp4", "mode": 1, "pixel": False}, 10, 5)
        self.assertNotIn("/", k)
        self.assertNotIn(":", k)
        self.assertNotIn(" ", k)
        self.assertTrue(k.endswith(".m1.10x5"))

    def test_resolve_grid_explicit_rows(self):
        cols, rows = ss.resolve_grid(self.entry(cols=50, rows=20))
        self.assertEqual((cols, rows), (50, 20))

    def test_resolve_grid_auto_rows_from_aspect(self):
        cols, rows = ss.resolve_grid(self.entry(cols=32, rows=0))
        self.assertEqual(cols, 32)
        self.assertEqual(rows, ss.calc_auto_rows(32, 64, 48, False))
        self.assertGreater(rows, 0)


class TestPrerenderColor(PrerenderTestBase):
    def test_creates_files_and_manifest(self):
        man = _prerender_quiet(self.entry(mode=5, cols=32))

        self.assertIsNotNone(man)
        self.assertTrue(man["available"])
        self.assertEqual(man["mode"], 5)
        self.assertEqual(man["cellBytes"], 4)
        self.assertFalse(man["textMode"])
        self.assertEqual(man["keyframeInterval"], ss.KEYFRAME_INTERVAL)
        self.assertIsNone(man["audio"])   # vol 0 so ffmpeg never runs
        self.assertGreater(man["nframes"], 0)

        self.assertTrue(os.path.isfile(os.path.join(ss.ASCIDATA_DIR, man["data"])))
        self.assertTrue(os.path.isfile(os.path.join(ss.ASCIDATA_DIR, man["data"][:-7] + ".json")))

    def test_aldata_decodes_to_correct_frames(self):
        man = _prerender_quiet(self.entry(mode=5, cols=32))
        data = _read_bytes(os.path.join(ss.ASCIDATA_DIR, man["data"]))
        frames = _decode_aldata_binary(data, man["cellBytes"])

        self.assertEqual(len(frames), man["nframes"])
        expected_len = man["cols"] * man["rows"] * man["cellBytes"]
        for i, (fidx, fr) in enumerate(frames):
            self.assertEqual(fidx, i)
            self.assertEqual(len(fr), expected_len)

    def test_frame0_matches_source_pixels(self):
        # decode frame 0 from the baked file, then rebuild it straight from the
        # video. if colour really survives, they end up the exact same bytes.
        man = _prerender_quiet(self.entry(mode=5, cols=32))
        data = _read_bytes(os.path.join(ss.ASCIDATA_DIR, man["data"]))
        frame0 = _decode_aldata_binary(data, 4)[0][1]

        cols, rows = man["cols"], man["rows"]
        mapper = ss.AsciiMapper()
        lut = np.array([ord(c) for c in mapper._lut], np.uint8)

        cap = cv2.VideoCapture(self.video)
        ok, bgr = cap.read(); cap.release()
        self.assertTrue(ok)

        small = cv2.resize(bgr, (cols, rows), interpolation=cv2.INTER_LINEAR)
        gray = cv2.cvtColor(small, cv2.COLOR_BGR2GRAY)
        idx = np.floor_divide(gray, max(1, 256 // mapper._n))
        np.clip(idx, 0, mapper._n - 1, out=idx)

        fb = np.empty((rows, cols, 4), np.uint8)
        fb[:, :, 0] = lut[idx]
        fb[:, :, 1:] = small[:, :, ::-1]
        self.assertEqual(frame0, fb.tobytes())


class TestPrerenderTextMode(PrerenderTestBase):
    def test_mode1_text_manifest_and_frames(self):
        man = _prerender_quiet(self.entry(mode=1, cols=20))

        self.assertTrue(man["textMode"])
        self.assertEqual(man["cellBytes"], 0)
        self.assertEqual(man["keyframeInterval"], 1)

        data = _read_bytes(os.path.join(ss.ASCIDATA_DIR, man["data"]))
        grids = _read_aldata_text(data)
        self.assertEqual(len(grids), man["nframes"])

        lines = grids[0].split("\n")
        self.assertEqual(len(lines), man["rows"])
        self.assertTrue(all(len(ln) == man["cols"] for ln in lines))


class TestThumbnail(PrerenderTestBase):
    def test_thumbnail_is_decodable_keyframe(self):
        man = _prerender_quiet(self.entry(mode=5, cols=32), thumbnail=True)
        self.assertIsNotNone(man["thumb"])

        path = os.path.join(ss.ASCIDATA_DIR, man["thumb"])
        self.assertTrue(os.path.isfile(path))

        payload = _read_bytes(path)
        frames = _decode_aldata_binary(struct.pack(">I", len(payload)) + payload, 4)
        self.assertEqual(len(frames), 1)
        self.assertEqual(len(frames[0][1]), man["cols"] * man["rows"] * 4)


class TestSeekSprite(PrerenderTestBase):
    def test_make_seek_sprite_dims_and_meta(self):
        cap = cv2.VideoCapture(self.video)
        fps = cap.get(cv2.CAP_PROP_FPS)
        nframes = int(cap.get(cv2.CAP_PROP_FRAME_COUNT))
        cap.release()

        out = os.path.join(ss.ASCIDATA_DIR, "sprite_test.jpg")
        meta = ss.make_seek_sprite(self.video, fps, nframes, out, max_count=12)

        self.assertIsNotNone(meta)
        self.assertTrue(os.path.isfile(out))
        self.assertGreaterEqual(meta["count"], 1)
        self.assertLessEqual(meta["count"], 12)
        self.assertGreaterEqual(meta["gridCols"] * meta["gridRows"], meta["count"])

        img = cv2.imread(out)
        self.assertEqual(img.shape[0], meta["gridRows"] * meta["cellH"])
        self.assertEqual(img.shape[1], meta["gridCols"] * meta["cellW"])

    def test_prerender_with_seek_thumbs_sets_manifest(self):
        man = _prerender_quiet(self.entry(mode=5, cols=32), seek_thumbs=True)
        self.assertIsNotNone(man["seekThumbs"])

        st = man["seekThumbs"]
        for field in ("sprite", "count", "gridCols", "gridRows", "cellW", "cellH", "interval"):
            self.assertIn(field, st)
        self.assertTrue(os.path.isfile(os.path.join(ss.ASCIDATA_DIR, st["sprite"])))


class TestEndpoints(PrerenderTestBase):
    def test_config_returns_manifest_for_prerendered_queue(self):
        _prerender_quiet(self.entry(mode=5, cols=32))
        ss.app.state.queue = [self.entry(mode=5, cols=32)]
        ss.app.state.playback = "prerendered"
        ss.app.state.loop = False

        body = json.loads(asyncio.run(ss.get_config()).body)
        self.assertEqual(body["playback"], "prerendered")
        self.assertEqual(len(body["queue"]), 1)
        self.assertTrue(body["queue"][0]["available"])
        self.assertEqual(body["queue"][0]["mode"], 5)

    def test_config_flags_missing_asset(self):
        ss.app.state.queue = [self.entry(mode=2, cols=99)]
        ss.app.state.playback = "prerendered"
        ss.app.state.loop = False

        body = json.loads(asyncio.run(ss.get_config()).body)
        self.assertFalse(body["queue"][0]["available"])

    def test_ascidata_serves_existing_file(self):
        man = _prerender_quiet(self.entry(mode=5, cols=32))
        resp = asyncio.run(ss.serve_ascidata(man["data"]))
        self.assertEqual(resp.path, os.path.join(ss.ASCIDATA_DIR, man["data"]))

    def test_ascidata_blocks_path_traversal(self):
        # nobody should be able to climb out of the assets folder
        from fastapi import HTTPException
        for bad in ["../stream_server.py", "..\\stream_server.py", "sub/dir.txt"]:
            with self.assertRaises(HTTPException):
                asyncio.run(ss.serve_ascidata(bad))

    def test_ascidata_missing_file_404s(self):
        from fastapi import HTTPException
        with self.assertRaises(HTTPException):
            asyncio.run(ss.serve_ascidata("does_not_exist.aldata"))


if __name__ == "__main__":
    unittest.main(verbosity=2)
