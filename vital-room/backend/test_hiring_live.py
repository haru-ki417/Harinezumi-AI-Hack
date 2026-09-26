"""Real HTTP/WebSocket integration; uses a temporary database and no paid AI calls."""
import asyncio
from datetime import datetime, timedelta, timezone
import json
import os
from pathlib import Path
import socket
import subprocess
import sys
import tempfile
import time
import unittest
import urllib.error
import urllib.request
import uuid

from websockets.asyncio.client import connect


class HiringLiveTests(unittest.IsolatedAsyncioTestCase):
    @classmethod
    def stop_server(cls):
        if os.name == "nt":
            subprocess.run(["taskkill", "/PID", str(cls.server.pid), "/T", "/F"],
                           stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL,
                           creationflags=subprocess.CREATE_NO_WINDOW, check=False)
        else:
            cls.server.terminate()
        cls.server.wait(timeout=5)

    @classmethod
    def setUpClass(cls):
        cls.temp = tempfile.TemporaryDirectory(prefix="hiring-test-")
        with socket.socket() as sock:
            sock.bind(("127.0.0.1", 0))
            cls.port = sock.getsockname()[1]
        cls.base = f"http://127.0.0.1:{cls.port}"
        env = {**os.environ, "HIRING_DB_PATH": str(Path(cls.temp.name) / "hiring.sqlite3"),
               "OPENAI_API_KEY": ""}
        cls.log = open(Path(cls.temp.name) / "server.log", "w+", encoding="utf-8")
        cls.server = subprocess.Popen(
            [sys.executable, "-m", "uvicorn", "app:app", "--host", "127.0.0.1",
             "--port", str(cls.port)], cwd=Path(__file__).parent, env=env,
            stdout=cls.log, stderr=cls.log,
            creationflags=subprocess.CREATE_NO_WINDOW if os.name == "nt" else 0,
        )
        for _ in range(150):
            try:
                urllib.request.urlopen(f"{cls.base}/health", timeout=0.2).close()
                return
            except OSError:
                if cls.server.poll() is not None:
                    break
                time.sleep(0.1)
        cls.stop_server()
        cls.log.seek(0)
        detail = cls.log.read()
        cls.log.close()
        cls.temp.cleanup()
        raise RuntimeError(detail)

    @classmethod
    def tearDownClass(cls):
        cls.stop_server()
        cls.log.close()
        cls.temp.cleanup()

    def api(self, path, data=None, token="", expected=200):
        headers = {"Content-Type": "application/json"}
        if token:
            headers["Authorization"] = f"Bearer {token}"
        request = urllib.request.Request(
            self.base + "/api/hiring" + path,
            data=json.dumps(data).encode() if data is not None else None,
            headers=headers,
        )
        try:
            response = urllib.request.urlopen(request, timeout=10)
        except urllib.error.HTTPError as error:
            response = error
        payload = json.loads(response.read())
        self.assertIn(response.code, (200, 201) if expected == 200 else (expected,), payload)
        return payload

    def account(self):
        return self.api("/auth/register", {
            "company_name": "テスト企業", "email": uuid.uuid4().hex + "@example.test",
            "password": "Interview-Test-123!",
        })["token"]

    def invitation(self, employer, mode="human"):
        template = self.api("/templates", {
            "title": "新卒面接", "job_title": "エンジニア", "mode": mode,
            "duration_minutes": 15, "questions": ["取り組んだことを教えてください。"],
            "criteria": ["チームでの取り組み"],
        }, employer)
        return self.api(f"/templates/{template['id']}/invitations", {
            "candidate_name": "応募者A", "opens_at": None,
            "expires_at": (datetime.now(timezone.utc) + timedelta(days=1)).isoformat(),
        }, employer)

    async def recv(self, ws, kind):
        for _ in range(12):
            event = json.loads(await asyncio.wait_for(ws.recv(), 4))
            if event["type"] == kind:
                return event
        self.fail(f"Missing {kind} event")

    async def test_admission_authorization_transcript_and_report(self):
        owner, other = self.account(), self.account()
        invitation = self.invitation(owner)
        invite_id = invitation["id"]
        claim = self.api("/join/start", {"code": invitation["code"], "name": "応募者A", "consent": True})
        candidate = claim["token"]
        self.assertEqual(claim["session"]["invitation"]["status"], "waiting")
        url = f"ws://127.0.0.1:{self.port}/ws/hiring/{invite_id}"
        async with connect(url) as denied:
            await denied.send(json.dumps({"type": "join", "token": other}))
            self.assertEqual((await self.recv(denied, "error"))["type"], "error")
        async with connect(url) as applicant, connect(url) as host:
            await applicant.send(json.dumps({"type": "join", "token": candidate}))
            self.assertIsNone((await self.recv(applicant, "state"))["session"]["report"])
            await applicant.send(json.dumps({"type": "transcript", "text": "待機中", "request_id": "waiting"}))
            await self.recv(applicant, "error")
            await host.send(json.dumps({"type": "join", "token": owner}))
            await self.recv(host, "state")
            state = self.api(f"/invitations/{invite_id}/admit", {}, owner)
            self.assertEqual(state["invitation"]["status"], "in_progress")
            await host.send(json.dumps({"type": "signal", "data": {"description": {"type": "offer", "sdp": "test"}}}))
            last_state = None
            while True:
                signal = json.loads(await asyncio.wait_for(applicant.recv(), 4))
                if signal["type"] == "state":
                    last_state = signal["session"]["invitation"]["status"]
                if signal["type"] == "signal":
                    break
            self.assertEqual(last_state, "in_progress")
            self.assertEqual(signal["role"], "interviewer")
            self.assertEqual(signal["data"]["description"]["sdp"], "test")
            message = {"type": "transcript", "text": "チームで実装を分担しました。",
                       "role": "interviewer", "request_id": "answer-unique-1"}
            await applicant.send(json.dumps(message))
            await self.recv(applicant, "transcript_saved")
            await applicant.send(json.dumps(message))
            await self.recv(applicant, "transcript_saved")
            owner_state = self.api(f"/invitations/{invite_id}", token=owner)
            self.assertEqual(len(owner_state["transcript"]), 1)
            self.assertEqual(owner_state["transcript"][0]["role"], "candidate")
            completed = self.api(f"/invitations/{invite_id}/finish", {}, owner)
            self.assertEqual(completed["invitation"]["status"], "completed")
            self.assertIsNotNone(completed["report"])
            self.api(f"/invitations/{invite_id}/review", {"decision": "advance", "notes": "社内限定メモ"}, owner)
            private = self.api(f"/session/{invite_id}", token=candidate)
            self.assertIsNone(private["report"])
            self.assertEqual(private["review"]["notes"], "")
            self.assertEqual(private["template"]["criteria"], [])
            await applicant.send(json.dumps({**message, "request_id": "after-end"}))
            await self.recv(applicant, "error")


if __name__ == "__main__":
    unittest.main()
