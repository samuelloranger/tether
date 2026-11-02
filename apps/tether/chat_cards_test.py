import copy
import io
import json
from pathlib import Path
import tempfile
import unittest

import chat_cards as cards

FIXTURES = json.loads((Path(__file__).parents[2] / "clients/apple/TetherKit/Tests/TetherKitTests/Fixtures/chat-cards.json").read_text())


class ChatCardTests(unittest.TestCase):
    def test_discovery_and_publication_over_stdio(self):
        requests = [
            {"id": 1, "method": "initialize", "params": {"protocolVersion": "2024-11-05"}},
            {"method": "notifications/initialized"},
            {"id": 2, "method": "tools/list"},
            {"id": 3, "method": "tools/call", "params": {"name": "tether_publish_card", "arguments": FIXTURES[0]}},
            {"id": 4, "method": "tools/call", "params": {"name": "tether_publish_card", "arguments": {}}},
        ]
        output = io.StringIO()
        cards.serve(io.StringIO("\n".join(map(json.dumps, requests)) + "\n"), output)
        responses = list(map(json.loads, output.getvalue().splitlines()))
        self.assertEqual([r["id"] for r in responses], [1, 2, 3, 4])
        self.assertIn("instructions", responses[0]["result"])
        self.assertEqual(responses[1]["result"]["tools"][0]["name"], "tether_publish_card")
        self.assertEqual(cards.find_card(responses[2]["result"])["id"], "weather-montreal")
        self.assertTrue(responses[3]["result"]["isError"])

    def test_validation_preserves_missing_metrics_and_rejects_fabricated_defaults(self):
        card, _ = cards.prepare(FIXTURES[1])
        self.assertIsNone(card["payload"]["containers"][1]["cpuPercent"])
        for mutate in (
            lambda c: c.update(revision=0),
            lambda c: c["payload"]["containers"][0].update(cpuPercent=float("nan")),
            lambda c: c["payload"]["containers"][0].update(memoryBytes=-1),
            lambda c: c["payload"].update(total=0),
            lambda c: c["payload"]["containers"].append(c["payload"]["containers"][0]),
        ):
            value = copy.deepcopy(FIXTURES[1])
            mutate(value)
            with self.assertRaises(ValueError):
                cards.prepare(value)

    def test_image_import_carries_bytes_without_exposing_paths(self):
        import base64
        png = base64.b64decode("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jD1cAAAAASUVORK5CYII=")
        with tempfile.TemporaryDirectory() as root:
            path = Path(root) / "pixel.png"
            path.write_bytes(png)
            args = copy.deepcopy(FIXTURES[2])
            args["payload"]["imageSource"] = str(path)
            card, image = cards.prepare(args)
            self.assertNotIn("imageSource", card["payload"])
            self.assertEqual(base64.b64decode(image["data"]), png)
            path.write_text("<svg></svg>")
            with self.assertRaises(ValueError):
                cards.prepare(args)

    def test_an_oversized_request_is_answered_and_the_server_keeps_going(self):
        big = json.dumps({"id": 9, "method": "tools/call", "params": {"name": "tether_publish_card",
                          "arguments": {"pad": "x" * (cards.MAX_JSON * 2)}}})
        output = io.StringIO()
        cards.serve(io.StringIO(big + "\n" + json.dumps({"id": 10, "method": "ping"}) + "\n"), output)
        responses = list(map(json.loads, output.getvalue().splitlines()))
        self.assertEqual([r["id"] for r in responses], [9, 10])
        self.assertTrue(responses[0]["result"]["isError"])

    def test_local_images_stay_in_the_chat_or_temp_folder_and_must_be_regular_files(self):
        import os
        with tempfile.TemporaryDirectory() as root:
            fifo = Path(root) / "pipe.png"
            os.mkfifo(fifo)
            with self.assertRaisesRegex(ValueError, "regular file"):
                cards.import_image(str(fifo))
            hidden = Path(root) / ".secret" / "a.png"
            hidden.parent.mkdir()
            hidden.write_bytes(b"\x89PNG\r\n\x1a\n" + b"\0" * 32)
            with self.assertRaisesRegex(ValueError, "hidden"):
                cards.import_image(str(hidden))
        with self.assertRaisesRegex(ValueError, "folder"):
            cards.import_image("/etc/hostname")

    def test_hermes_home_is_an_image_root_when_named(self):
        import base64
        import os
        from unittest import mock
        png = base64.b64decode("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jD1cAAAAASUVORK5CYII=")
        home = Path(__file__).resolve().parent / "image_root_test"
        try:
            (home / "image_cache").mkdir(parents=True)
            (home / "image_cache" / "a.png").write_bytes(png)
            with mock.patch.dict(os.environ, {"HOME": str(home), "TETHER_CARD_IMAGE_ROOT": "~"}), \
                    mock.patch.object(cards.tempfile, "gettempdir", return_value="/nonexistent"), \
                    mock.patch.object(cards.os, "getcwd", return_value="/nonexistent"):
                self.assertEqual(cards.import_image(str(home / "image_cache" / "a.png"))["mimeType"], "image/png")
        finally:
            import shutil
            shutil.rmtree(home, ignore_errors=True)

    def test_image_urls_must_reach_a_public_host(self):
        for url in ("https://127.0.0.1/a.png", "https://192.168.1.10/a.png", "https://169.254.169.254/a.png", "https://[::1]/a.png"):
            with self.assertRaisesRegex(ValueError, "public host"):
                cards.import_image(url)

    def test_unknown_method_is_a_json_rpc_error(self):
        output = io.StringIO()
        cards.serve(io.StringIO('{"id":1,"method":"unknown"}\n'), output)
        self.assertEqual(json.loads(output.getvalue())["error"]["code"], -32601)


if __name__ == "__main__":
    unittest.main()
