"""Screen updates (RFB-style moves and tiles): the phone's decoder must rebuild exactly the
frames the server encoded, and each update must carry only what changed."""
import json
import subprocess
import tempfile
import unittest
from pathlib import Path

from translator.tests.romkit import TOOLS, translate

ROOT = Path(__file__).resolve().parents[2]
SCRIPT = Path(__file__).with_name("frames_roundtrip.mjs")
FULL_RAW = 5 + 45 + 360 * 17


@unittest.skipUnless(TOOLS, "needs wat2wasm and node on PATH")
class FramesTest(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        with tempfile.TemporaryDirectory() as tmp:
            wasm = translate((ROOT / "roms" / "hello.gb").read_bytes(), "hello", tmp)
            out = subprocess.run(["node", str(SCRIPT), str(wasm)], check=True, capture_output=True, text=True)
        cls.res = {r["name"]: r for r in json.loads(out.stdout)}

    def test_round_trip_is_exact(self):
        for name, r in self.res.items():
            with self.subTest(case=name):
                self.assertTrue(r["ok"], r)

    def test_unchanged_frames_send_nothing(self):
        self.assertEqual(self.res["still"]["sizes"][1:], [0, 0])

    def test_one_pixel_sends_one_tile(self):
        self.assertLessEqual(self.res["one-pixel"]["sizes"][1], 5 + 45 + 17)

    def test_scrolling_is_a_move_not_a_redraw(self):
        for name in ("scroll-x", "scroll-y"):
            with self.subTest(case=name):
                r = self.res[name]
                self.assertEqual(r["moves"], len(r["sizes"]) - 1)
                # only the strip scrolled into view is new
                self.assertLess(max(r["sizes"][1:]), FULL_RAW // 3, r["sizes"])

    def test_noise_falls_back_to_raw_tiles(self):
        self.assertLessEqual(max(self.res["noise"]["sizes"]), FULL_RAW)

    def test_real_game_frames(self):
        sizes = [s for s in self.res["game"]["sizes"] if s]      # the first frames are blank
        self.assertEqual(len(sizes), 1, "the message is drawn once, then nothing changes")
        self.assertLess(sizes[0], 200, "only the 12 letter tiles are sent")


if __name__ == "__main__":
    unittest.main()
