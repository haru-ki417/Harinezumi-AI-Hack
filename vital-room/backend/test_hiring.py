"""Managed interview contract/security tests without external services or paid AI."""
import asyncio
from datetime import timedelta
import json
import os
from pathlib import Path
import tempfile
import unittest
from unittest.mock import AsyncMock, patch

from fastapi import FastAPI, HTTPException

import hiring


class HiringTests(unittest.IsolatedAsyncioTestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory(prefix="hiring-unit-")
        self.environment = patch.dict(os.environ, {
            "HIRING_DB_PATH": str(Path(self.temp.name) / "interviews.sqlite3"),
            "OPENAI_API_KEY": "",
        })
        self.environment.start()
        self.app = FastAPI()
        self.app.include_router(hiring.router)
        hiring._rates.clear()

    def tearDown(self):
        self.environment.stop()
        self.temp.cleanup()

    async def api(self, path, data=None, token=None, expected=200, raw=None):
        body = raw if raw is not None else json.dumps(data).encode() if data is not None else b""
        messages = []
        headers = [(b"content-type", b"application/json")]
        if token:
            headers.append((b"authorization", f"Bearer {token}".encode()))
        scope = {
            "type": "http", "asgi": {"version": "3.0"}, "http_version": "1.1",
            "method": "POST" if data is not None or raw is not None else "GET",
            "scheme": "http", "path": "/api/hiring" + path, "raw_path": ("/api/hiring" + path).encode(),
            "query_string": b"", "root_path": "", "headers": headers,
            "client": ("127.0.0.1", 12345), "server": ("testserver", 80),
        }

        async def receive():
            return {"type": "http.request", "body": body, "more_body": False}

        async def send(message):
            messages.append(message)

        await self.app(scope, receive, send)
        start = next(message for message in messages if message["type"] == "http.response.start")
        payload = json.loads(b"".join(message.get("body", b"") for message in messages if message["type"] == "http.response.body"))
        self.assertEqual(start["status"], expected, payload)
        return payload

    async def account(self, email="owner@example.test"):
        return await self.api("/auth/register", {
            "company_name": "企業A", "email": email, "password": "testing-secret-1234",
        }, expected=201)

    async def fixture(self, mode="ai", questions=None):
        account = await self.account()
        owner = account["token"]
        template = await self.api("/templates", {
            "title": "新卒一次面接", "job_title": "開発職", "mode": mode,
            "duration_minutes": 5, "questions": questions or ["学生時代の取り組みは？"],
            "criteria": ["協力した経験"],
        }, owner, expected=201)
        invitation = await self.api(f"/templates/{template['id']}/invitations", {
            "candidate_name": "応募者", "expires_at": hiring._iso(hiring._now() + timedelta(days=1)),
        }, owner, expected=201)
        return owner, invitation

    async def claim(self, invitation):
        return await self.api("/join/start", {"code": invitation["code"], "name": "応募者", "consent": True})

    async def test_password_and_session_auth_persist_and_logout(self):
        account = await self.account()
        with hiring._db() as connection:
            row = connection.execute("SELECT * FROM companies").fetchone()
            self.assertNotIn("testing-secret", row["password_hash"])
            session = connection.execute("SELECT * FROM employer_sessions").fetchone()
            self.assertNotEqual(session["token_hash"], account["token"])
        await self.api("/auth/login", {"email": "owner@example.test", "password": "wrong-password"}, expected=401)
        signed_in = await self.api("/auth/login", {"email": "OWNER@example.test", "password": "testing-secret-1234"})
        # Reinitializing connections/schema must retain account and bearer sessions.
        hiring._initialized.clear()
        profile = await self.api("/auth/me", token=signed_in["token"])
        self.assertEqual(profile["id"], account["company"]["id"])
        await self.api("/auth/logout", {}, signed_in["token"])
        await self.api("/auth/me", token=signed_in["token"], expected=401)
        await self.api("/auth/me", token=account["token"])
        with hiring._db(write=True) as connection:
            connection.execute("UPDATE employer_sessions SET expires_at=?", (hiring._iso(hiring._now() - timedelta(seconds=1)),))
        await self.api("/auth/me", token=account["token"], expected=401)

    async def test_isolation_consent_claim_and_resume(self):
        owner, invitation = await self.fixture()
        other = (await self.account("other@example.test"))["token"]
        await self.api(f"/invitations/{invitation['id']}", token=other, expected=404)
        await self.api(f"/templates/{invitation['template_id']}/invitations", {
            "candidate_name": "別人", "expires_at": invitation["expires_at"],
        }, other, expected=404)
        self.assertEqual((await self.api("/templates", token=other))["templates"], [])
        lookup = await self.api("/join/lookup", {"code": invitation["code"]})
        self.assertNotIn("candidate_name", lookup)
        self.assertNotIn("criteria", lookup)
        await self.api("/join/start", {"code": invitation["code"], "name": "応募者", "consent": False}, expected=422)
        claimed = await self.claim(invitation)
        candidate = claimed["token"]
        self.assertEqual(claimed["session"]["template"]["criteria"], [])
        self.assertEqual(claimed["session"]["invitation"]["code"], "")
        await self.api("/join/start", {"code": invitation["code"], "name": "別人", "consent": True}, expected=409)
        resumed = await self.api("/join/start", {"code": invitation["code"], "name": "応募者", "consent": True, "resume_token": candidate})
        self.assertEqual(resumed["token"], candidate)
        self.assertEqual(resumed["session"]["transcript"], claimed["session"]["transcript"])
        await self.api(f"/session/{invitation['id']}", token=other, expected=403)
        await self.api(f"/invitations/{invitation['id']}", token=candidate, expected=401)
        with hiring._db() as connection:
            row = connection.execute("SELECT * FROM invitations WHERE id=?", (invitation["id"],)).fetchone()
            self.assertIsNotNone(row["consent_at"])
            self.assertNotEqual(candidate, row["token_hash"])

    async def test_atomic_claim_allows_only_one_candidate(self):
        _, invitation = await self.fixture()
        request = hiring.Start(code=invitation["code"], name="応募者", consent=True)
        from starlette.requests import Request
        scope = {"type": "http", "client": ("claim-test", 80), "headers": []}

        def claim():
            try:
                return hiring.start(request, Request(scope))
            except HTTPException as error:
                return error.status_code

        results = await asyncio.gather(asyncio.to_thread(claim), asyncio.to_thread(claim))
        self.assertEqual(sum(isinstance(result, dict) for result in results), 1)
        self.assertIn(409, results)
        with hiring._db() as connection:
            self.assertEqual(connection.execute("SELECT COUNT(*) FROM turns").fetchone()[0], 1)

    async def test_ai_full_flow_evidence_idempotency_and_private_review(self):
        owner, invitation = await self.fixture(questions=["協力した経験は？", "何を学びましたか？"])
        claim = await self.claim(invitation)
        token, session = claim["token"], claim["session"]
        first_body = None
        answers = 0
        while session["invitation"]["status"] == "in_progress":
            answers += 1
            self.assertLessEqual(answers, 8)
            body = {"text": "チームで実装を分担し、毎日進捗を共有して期限内に完成しました。",
                    "request_id": f"answer-{answers}", "expected_turn_id": session["transcript"][-1]["id"]}
            first_body = first_body or body
            session = await self.api(f"/session/{invitation['id']}/answer", body, token)
        self.assertIsNone(session["report"])
        again = await self.api(f"/session/{invitation['id']}/answer", first_body, token)
        self.assertEqual(again["transcript"], session["transcript"])
        await self.api(f"/session/{invitation['id']}/answer", {**first_body, "text": "changed"}, token, expected=409)
        employer = await self.api(f"/invitations/{invitation['id']}", token=owner)
        self.assertEqual(employer["report"]["source"], "local")
        candidate_turns = {turn["id"]: turn["text"] for turn in employer["transcript"] if turn["role"] == "candidate"}
        evidence_count = 0
        for item in employer["report"]["items"]:
            for evidence in item["evidence"]:
                evidence_count += 1
                self.assertIn(evidence["quote"], candidate_turns[evidence["turn_id"]])
        self.assertGreater(evidence_count, 0)
        await self.api(f"/invitations/{invitation['id']}/review", {"decision": "advance", "notes": "企業内の判断"}, owner)
        private = await self.api(f"/session/{invitation['id']}", token=token)
        self.assertEqual(private["review"], {"decision": "pending", "notes": ""})
        self.assertEqual(private["invitation"]["decision"], "pending")
        self.assertEqual(private["template"]["criteria"], [])
        self.assertIsNone(private["report"])
        await self.api(f"/session/{invitation['id']}/finish", {}, token)

    async def test_concurrent_ai_answers_and_stale_questions_are_rejected(self):
        _, invitation = await self.fixture()
        claim = await self.claim(invitation)
        token = claim["token"]
        body = {"text": "取り組みました。", "request_id": "answer-1", "expected_turn_id": claim["session"]["transcript"][-1]["id"]}
        entered, release = asyncio.Event(), asyncio.Event()

        async def delayed_question(template, transcript):
            entered.set()
            await release.wait()
            return {"text": "具体的に教えてください。", "question_index": 0, "is_follow_up": True, "source": "local"}

        with patch.object(hiring.interview_ai, "next_question", side_effect=delayed_question):
            first = asyncio.create_task(self.api(f"/session/{invitation['id']}/answer", body, token))
            await asyncio.wait_for(entered.wait(), 2)
            await self.api(f"/session/{invitation['id']}/answer", body, token, expected=409)
            await self.api(f"/session/{invitation['id']}/answer", {**body, "request_id": "answer-2"}, token, expected=409)
            await self.api(f"/session/{invitation['id']}/finish", {}, token, expected=409)
            release.set()
            session = await first
        self.assertEqual(len(session["transcript"]), 3)
        await self.api(f"/session/{invitation['id']}/answer", {**body, "request_id": "answer-2"}, token, expected=409)
        # Provider must not be able to loop on a configured question indefinitely.
        with patch.object(hiring.interview_ai, "next_question", new=AsyncMock(return_value={
            "text": "不正な追加質問", "question_index": 0, "is_follow_up": True, "source": "ai",
        })):
            completed = session
            for number in range(3, 7):
                if completed["invitation"]["status"] == "completed":
                    break
                completed = await self.api(f"/session/{invitation['id']}/answer", {
                    "text": "成果は完成です。", "request_id": f"answer-{number}", "expected_turn_id": completed["transcript"][-1]["id"],
                }, token)
        self.assertEqual(completed["invitation"]["status"], "completed")

    async def test_human_admission_transcript_permissions_and_report(self):
        owner, invitation = await self.fixture("human")
        claim = await self.claim(invitation)
        candidate = claim["token"]
        identifier = invitation["id"]
        self.assertEqual(claim["session"]["invitation"]["status"], "waiting")
        with self.assertRaises(HTTPException):
            await hiring.append_human_turn(identifier, candidate, "待機中", "same-id")
        await self.api(f"/session/{identifier}/finish", {}, candidate, expected=403)
        await self.api(f"/invitations/{identifier}/admit", {}, owner)
        await hiring.append_human_turn(identifier, owner, "経験を教えてください。", "same-id")
        first = await hiring.append_human_turn(identifier, candidate, "チームで開発しました。", "same-id")
        duplicate = await hiring.append_human_turn(identifier, candidate, "チームで開発しました。", "same-id")
        self.assertEqual(first["transcript"], duplicate["transcript"])
        self.assertEqual([turn["role"] for turn in first["transcript"]], ["interviewer", "candidate"])
        with self.assertRaises(HTTPException) as conflict:
            await hiring.append_human_turn(identifier, candidate, "異なる回答", "same-id")
        self.assertEqual(conflict.exception.status_code, 409)
        completed = await self.api(f"/invitations/{identifier}/finish", {}, owner)
        self.assertIsNotNone(completed["report"])
        with self.assertRaises(HTTPException):
            await hiring.append_human_turn(identifier, candidate, "終了後", "late")
        again = await self.api(f"/invitations/{identifier}/finish", {}, owner)
        self.assertEqual(again["ended_at"], completed["ended_at"])

    async def test_expiry_revocation_and_deadline_complete_without_browser(self):
        owner, invitation = await self.fixture("human")
        identifier = invitation["id"]
        with hiring._db(write=True) as connection:
            connection.execute("UPDATE invitations SET opens_at=? WHERE id=?", (hiring._iso(hiring._now() + timedelta(hours=1)), identifier))
        await self.api("/join/start", {"code": invitation["code"], "name": "応募者", "consent": True}, expected=409)
        with hiring._db(write=True) as connection:
            connection.execute("UPDATE invitations SET opens_at=NULL,expires_at=? WHERE id=?", (hiring._iso(hiring._now() - timedelta(seconds=1)), identifier))
        state = await self.api("/join/lookup", {"code": invitation["code"]})
        self.assertEqual(state["status"], "expired")
        await self.api("/join/start", {"code": invitation["code"], "name": "応募者", "consent": True}, expected=410)
        with hiring._db(write=True) as connection:
            connection.execute("UPDATE invitations SET expires_at=? WHERE id=?", (hiring._iso(hiring._now() + timedelta(hours=1)), identifier))
        claim = await self.claim(invitation)
        await self.api(f"/invitations/{identifier}/admit", {}, owner)
        await hiring.append_human_turn(identifier, claim["token"], "自分で実装しました。", "answer")
        with hiring._db(write=True) as connection:
            connection.execute("UPDATE invitations SET deadline_at=? WHERE id=?", (hiring._iso(hiring._now() - timedelta(seconds=1)), identifier))
        role, snapshot = hiring.access_session(identifier, owner)
        self.assertEqual(role, "interviewer")
        self.assertEqual(snapshot["invitation"]["status"], "completed")
        self.assertEqual(snapshot["report"]["source"], "local")
        fresh = await self.api(f"/templates/{invitation['template_id']}/invitations", {
            "candidate_name": "次の応募者", "expires_at": invitation["expires_at"],
        }, owner, expected=201)
        await self.api(f"/invitations/{fresh['id']}/revoke", {}, owner)
        await self.api("/join/start", {"code": fresh["code"], "name": "応募者", "consent": True}, expected=410)

    async def test_provider_failure_finishes_with_local_report(self):
        owner, invitation = await self.fixture()
        claim = await self.claim(invitation)
        with patch.object(hiring.interview_ai, "next_question", new=AsyncMock(side_effect=RuntimeError("offline"))), \
                patch.object(hiring.interview_ai, "build_report", new=AsyncMock(side_effect=RuntimeError("offline"))), \
                patch.object(hiring.interview_ai, "build_feedback", new=AsyncMock(side_effect=RuntimeError("offline"))):
            session = claim["session"]
            for number in range(4):
                if session["invitation"]["status"] == "completed":
                    break
                session = await self.api(f"/session/{invitation['id']}/answer", {
                    "text": "チームで協力して担当部分を実装しました。", "request_id": f"answer-{number}", "expected_turn_id": session["transcript"][-1]["id"],
                }, claim["token"])
        self.assertEqual(session["invitation"]["status"], "completed")
        self.assertEqual(session["feedback"]["source"], "local")
        report = (await self.api(f"/invitations/{invitation['id']}", token=owner))["report"]
        self.assertEqual(report["source"], "local")
        self.assertEqual(report["items"][0]["evidence"][0]["quote"], "チームで協力して担当部分を実装しました。")

    async def test_bounds_validation_and_rate_limit(self):
        await self.api("/auth/register", {"company_name": "x", "email": "bad", "password": "short"}, expected=422)
        await self.api("/join/lookup", raw=b"x" * (hiring.MAX_BODY_BYTES + 1), expected=413)
        owner, invitation = await self.fixture()
        await self.api("/templates", {
            "title": "test", "job_title": "job", "mode": "ai", "duration_minutes": 10,
            "questions": [" "], "criteria": [],
        }, owner, expected=422)
        await self.api(f"/templates/{invitation['template_id']}/invitations", {
            "candidate_name": "応募者", "expires_at": "2030-01-01T00:00:00",
        }, owner, expected=422)
        for _ in range(60):
            await self.api("/join/lookup", {"code": "X" * 20}, expected=404)
        await self.api("/join/lookup", {"code": "X" * 20}, expected=429)


if __name__ == "__main__":
    unittest.main()
