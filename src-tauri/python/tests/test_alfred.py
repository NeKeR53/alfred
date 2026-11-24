"""Tests du paquet ``alfred`` contre un faux pont local (bibliothèque standard seulement).

Lancés par le test Rust ``python::bridge::tests::the_python_package_passes_its_own_tests`` :
``python3 -m unittest discover -s tests`` depuis ``src-tauri/python``.
"""

import base64
import importlib
import json
import os
import threading
import unittest
from http.server import BaseHTTPRequestHandler, HTTPServer

TOKEN = "jeton-de-test-0123456789"


class FakeBridge(BaseHTTPRequestHandler):
    """Rend ``{"ok": <ce qu’on lui a demandé>}`` ; refuse un mauvais jeton comme le vrai pont."""

    calls = []
    replies = {}

    def do_POST(self):  # noqa: N802 (nom imposé par http.server)
        length = int(self.headers.get("Content-Length") or 0)
        body = json.loads(self.rfile.read(length) or b"{}")
        method = self.path.rsplit("/", 1)[-1]
        FakeBridge.calls.append((method, body, dict(self.headers)))
        if self.headers.get("Authorization") != f"Bearer {TOKEN}":
            return self._send(401, {"error": {"message": "Jeton absent ou expiré."}})
        if method == "db.query" and "banque_" in body.get("sql", ""):
            return self._send(400, {"error": {"message": f"Accès refusé ({TOKEN}) : tables notes_ seulement."}})
        reply = FakeBridge.replies.get(method, body)
        return self._send(200, {"ok": reply})

    def _send(self, status, payload):
        data = json.dumps(payload).encode("utf-8")
        self.send_response(status)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(data)))
        self.end_headers()
        self.wfile.write(data)

    def log_message(self, *args):
        pass


class AlfredTest(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.server = HTTPServer(("127.0.0.1", 0), FakeBridge)
        threading.Thread(target=cls.server.serve_forever, daemon=True).start()
        os.environ["ALFRED_SDK_URL"] = f"http://127.0.0.1:{cls.server.server_port}/sdk"
        os.environ["ALFRED_SDK_TOKEN"] = TOKEN
        os.environ["ALFRED_MODULE"] = "notes"
        import alfred

        cls.alfred = importlib.reload(alfred)

    @classmethod
    def tearDownClass(cls):
        cls.server.shutdown()

    def setUp(self):
        FakeBridge.calls.clear()
        FakeBridge.replies.clear()

    def last(self):
        return FakeBridge.calls[-1]

    def test_sends_token_and_module(self):
        self.alfred.db.query("SELECT 1", [2])
        method, body, headers = self.last()
        self.assertEqual(method, "db.query")
        self.assertEqual(body, {"sql": "SELECT 1", "params": [2]})
        self.assertEqual(headers["Authorization"], f"Bearer {TOKEN}")
        self.assertEqual(headers["X-Alfred-Module"], "notes")
        self.assertEqual(self.alfred.module, "notes")

    def test_errors_are_clear_and_never_show_the_token(self):
        with self.assertRaises(self.alfred.AlfredError) as caught:
            self.alfred.db.query("SELECT * FROM banque_c")
        self.assertEqual(caught.exception.status, 400)
        self.assertEqual(caught.exception.method, "db.query")
        self.assertIn("notes_", str(caught.exception))
        self.assertNotIn(TOKEN, str(caught.exception))

    def test_missing_bridge(self):
        saved = os.environ.pop("ALFRED_SDK_URL")
        try:
            with self.assertRaises(self.alfred.AlfredError) as caught:
                self.alfred.db.query("SELECT 1")
            self.assertIn("Pont d’Alfred absent", caught.exception.message)
        finally:
            os.environ["ALFRED_SDK_URL"] = saved

    def test_expired_token(self):
        os.environ["ALFRED_SDK_TOKEN"] = "autre"
        try:
            with self.assertRaises(self.alfred.AlfredError) as caught:
                self.alfred.db.execute("DELETE FROM notes_n")
            self.assertEqual(caught.exception.status, 401)
        finally:
            os.environ["ALFRED_SDK_TOKEN"] = TOKEN

    def test_client_request_and_response(self):
        FakeBridge.replies["clients.request"] = {"status": 200, "ok": True, "headers": {}, "body": {"key": "ABC-1"}}
        jira = self.alfred.client("jira", instance="acme")
        response = jira.get("/rest/api/3/issue/ABC-1", {"fields": "summary"})
        method, body, _ = self.last()
        self.assertEqual(method, "clients.request")
        self.assertEqual(
            body,
            {
                "client": "jira",
                "instance": "acme",
                "method": "GET",
                "path": "/rest/api/3/issue/ABC-1",
                "query": {"fields": "summary"},
            },
        )
        self.assertTrue(response.ok)
        self.assertEqual(response.body["key"], "ABC-1")
        self.assertIs(response.raise_for_status(), response)

    def test_failed_response_raises_on_demand(self):
        FakeBridge.replies["clients.request"] = {"status": 404, "ok": False, "headers": {}, "body": "absent"}
        response = self.alfred.client("jira").post("/x", {"a": 1})
        self.assertEqual(self.last()[1]["body"], {"a": 1})
        with self.assertRaises(self.alfred.AlfredError) as caught:
            response.raise_for_status()
        self.assertEqual(caught.exception.status, 404)

    def test_files_encode_bytes(self):
        self.alfred.files.save("a.bin", data=b"\x00\x01")
        self.assertEqual(self.last()[1], {"name": "a.bin", "data": base64.b64encode(b"\x00\x01").decode()})
        FakeBridge.replies["files.read"] = {"info": {}, "data": base64.b64encode(b"abc").decode()}
        self.assertEqual(self.alfred.files.read("f1"), b"abc")
        with self.assertRaises(self.alfred.AlfredError):
            self.alfred.files.save("a.txt")

    def test_secrets_stay_sealed(self):
        self.assertTrue(self.alfred.secrets.is_ref(self.alfred.SECRET_REF_PREFIX + "abc"))
        self.assertFalse(self.alfred.secrets.is_ref("motdepasse"))
        with self.assertRaises(self.alfred.AlfredError):
            self.alfred.secrets.reveal(self.alfred.SECRET_REF_PREFIX + "abc")
        with self.assertRaises(self.alfred.AlfredError):
            self.alfred.secrets.write_env_file(entries=[])

    def test_events_notify_and_channels(self):
        self.alfred.events.publish("note.creee", {"id": 3}, occurrence="3")
        self.assertEqual(self.last()[:2], ("events.publish", {"event": "note.creee", "payload": {"id": 3}, "occurrence": "3"}))
        self.alfred.notify("Import fini", tone="success")
        self.assertEqual(self.last()[:2], ("notify", {"title": "Import fini", "tone": "success"}))
        FakeBridge.replies["channels.open"] = {"channel": "notes:import"}
        FakeBridge.replies["channels.publish"] = {"open": True}
        with self.alfred.channels.open("import") as channel:
            self.assertEqual(channel.id, "notes:import")
            self.assertTrue(channel.publish({"fait": 1}))
            self.assertEqual(self.last()[1], {"channel": "notes:import", "data": {"fait": 1}})
            channel.publish("texte")
            self.assertEqual(self.last()[1], {"channel": "notes:import", "text": "texte"})
        self.assertEqual(self.last()[0], "channels.close")

    def test_log_hides_the_token(self):
        self.alfred.log.warning(f"avec {TOKEN}", valeur=TOKEN)
        method, body, _ = self.last()
        self.assertEqual(method, "log")
        self.assertEqual(body["level"], "warning")
        self.assertNotIn(TOKEN, json.dumps(body))
        self.alfred.log("simple")
        self.assertEqual(self.last()[1], {"level": "info", "message": "simple"})


if __name__ == "__main__":
    unittest.main()
