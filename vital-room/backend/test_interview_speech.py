"""Authenticated interview speech tests. Providers are mocked; no paid requests."""
import asyncio
import json
import tempfile
import threading
import time
import unittest
from datetime import timedelta
from pathlib import Path
from unittest.mock import patch

from fastapi import FastAPI, HTTPException, Request

import hiring
import interview_speech as speech


class InterviewSpeechTests(unittest.IsolatedAsyncioTestCase):
    def setUp(self):
        self.directory = tempfile.TemporaryDirectory(prefix="interview-speech-")
        self.addCleanup(self.directory.cleanup)
        environment = patch.dict("os.environ", {
            "HIRING_DB_PATH": str(Path(self.directory.name) / "speech.sqlite3"),
            "OPENAI_API_KEY": "test-secret-key", "OPENAI_INTERVIEW_TTS_MODEL": "",
            "OPENAI_INTERVIEW_TTS_VOICE": "",
        })
        environment.start()
        self.addCleanup(environment.stop)
        speech._cache.clear()
        speech._cache_bytes = 0
        speech._inflight.clear()
        hiring._rates.clear()
        self.company = {"id": "owner", "name": "秘密の企業", "email": "owner@example.test"}
        self.other = {"id": "other", "name": "別企業", "email": "other@example.test"}
        self.owner_token, self.other_token = "h" * 43, "o" * 43
        with hiring._db(write=True) as connection:
            for company, token in ((self.company, self.owner_token), (self.other, self.other_token)):
                connection.execute("INSERT INTO companies VALUES(?,?,?,?,?)", (
                    company["id"], company["name"], company["email"], "unused", hiring._iso(),
                ))
                connection.execute("INSERT INTO employer_sessions VALUES(?,?,?,?)", (
                    hiring._hash(token), company["id"], hiring._iso(),
                    hiring._iso(hiring._now() + timedelta(hours=1)),
                ))
        self.request = Request({"type": "http", "client": ("speech-test", 1), "method": "POST", "path": "/"})
        self.app = FastAPI()
        self.app.include_router(speech.router)

    def fixture(self, mode="ai", question="学生時代に取り組んだことを教えてください。"):
        template = hiring.create_template(hiring.NewTemplate(
            title="秘密の面接", job_title="開発職", mode=mode, duration_minutes=5,
            questions=[question, "ご自身の行動を具体的に教えてください。"], criteria=["秘密の確認項目"],
        ), self.company)
        invitation = hiring.create_invitation(template["id"], hiring.NewInvitation(
            candidate_name="秘密の応募者", expires_at=hiring._now() + timedelta(hours=1),
        ), self.company)
        joined = hiring.start(hiring.Start(code=invitation["code"], name="秘密の応募者", consent=True), self.request)
        return invitation, joined

    async def play(self, invitation, joined):
        return await speech.speech(invitation["id"], speech.SpeechRequest(
            turn_id=joined["session"]["transcript"][-1]["id"],
        ), "Bearer " + joined["token"])

    async def api(self, identifier, token, body=None, raw=None):
        content = raw if raw is not None else json.dumps(body).encode()
        messages = []
        path = f"/api/hiring/session/{identifier}/speech"
        scope = {
            "type": "http", "asgi": {"version": "3.0"}, "http_version": "1.1",
            "method": "POST", "scheme": "http", "path": path, "raw_path": path.encode(),
            "query_string": b"", "root_path": "",
            "headers": [(b"content-type", b"application/json"), (b"authorization", f"Bearer {token}".encode())],
            "client": ("127.0.0.1", 12345), "server": ("testserver", 80),
        }

        async def receive():
            return {"type": "http.request", "body": content, "more_body": False}

        async def send(message):
            messages.append(message)

        await self.app(scope, receive, send)
        status = next(message for message in messages if message["type"] == "http.response.start")
        payload = b"".join(message.get("body", b"") for message in messages if message["type"] == "http.response.body")
        return status, payload

    async def test_current_question_audio_replay_cached_and_provider_receives_question_only(self):
        invitation, joined = self.fixture()
        with patch.object(speech, "call_provider", return_value=b"ID3-test-audio") as provider:
            first = await self.play(invitation, joined)
            second = await self.play(invitation, joined)
        self.assertEqual(first.body, b"ID3-test-audio")
        self.assertEqual(second.body, first.body)
        self.assertEqual(first.headers["content-type"], "audio/mpeg")
        self.assertEqual(first.headers["cache-control"], "no-store")
        provider.assert_called_once_with(joined["session"]["transcript"][-1]["text"],
                                         "test-secret-key", "gpt-4o-mini-tts", "marin")
        sent_text = provider.call_args.args[0]
        for private in ("秘密の応募者", "秘密の企業", "秘密の確認項目", invitation["id"], invitation["code"], joined["token"]):
            self.assertNotIn(private, sent_text)

    async def test_authorization_and_wrong_turn_rejected_before_provider(self):
        invitation, joined = self.fixture()
        _, other_candidate = self.fixture()
        with patch.object(speech, "call_provider") as provider:
            for token, turn, status in (
                (self.owner_token, joined["session"]["transcript"][-1]["id"], 403),
                (self.other_token, joined["session"]["transcript"][-1]["id"], 403),
                (other_candidate["token"], joined["session"]["transcript"][-1]["id"], 403),
                (joined["token"], "unknown-turn", 404),
                ("invalid", joined["session"]["transcript"][-1]["id"], 401),
            ):
                with self.subTest(status=status, turn=turn), self.assertRaises(HTTPException) as error:
                    await speech.speech(invitation["id"], speech.SpeechRequest(turn_id=turn), "Bearer " + token)
                self.assertEqual(error.exception.status_code, status)
        provider.assert_not_called()

    async def test_human_finished_and_answered_questions_cannot_be_synthesized(self):
        human, participant = self.fixture(mode="human")
        invitation, joined = self.fixture()
        with patch.object(speech, "call_provider") as provider:
            with self.assertRaises(HTTPException) as error:
                await speech.speech(human["id"], speech.SpeechRequest(turn_id="any-turn"), "Bearer " + participant["token"])
            self.assertEqual(error.exception.status_code, 403)
            with hiring._db(write=True) as connection:
                hiring._insert_turn(connection, invitation["id"], hiring._turn("candidate", "保存された回答", 0, "human"))
            with self.assertRaises(HTTPException) as error:
                await self.play(invitation, joined)
            self.assertEqual(error.exception.status_code, 404)
            with hiring._db(write=True) as connection:
                connection.execute("UPDATE invitations SET status='completed',ended_at=? WHERE id=?", (hiring._iso(), invitation["id"]))
            with self.assertRaises(HTTPException) as error:
                await self.play(invitation, joined)
            self.assertEqual(error.exception.status_code, 403)
        provider.assert_not_called()

    async def test_route_only_accepts_turn_id_and_enforces_body_limit(self):
        invitation, joined = self.fixture()
        turn_id = joined["session"]["transcript"][-1]["id"]
        with patch.object(speech, "call_provider", return_value=b"audio") as provider:
            for body in ({"turn_id": turn_id, "text": "arbitrary paid synthesis"}, {"turn_id": 123}, {"turn_id": ""}):
                status, _ = await self.api(invitation["id"], joined["token"], body)
                self.assertEqual(status["status"], 422)
            status, _ = await self.api(invitation["id"], joined["token"], raw=b"x" * (hiring.MAX_BODY_BYTES + 1))
            self.assertEqual(status["status"], 413)
            provider.assert_not_called()
            status, payload = await self.api(invitation["id"], joined["token"], {"turn_id": turn_id})
        self.assertEqual(status["status"], 200)
        self.assertEqual(payload, b"audio")
        self.assertIn((b"cache-control", b"no-store"), status["headers"])

    async def test_missing_key_provider_failure_empty_and_large_responses_use_503(self):
        invitation, joined = self.fixture()
        with patch.dict("os.environ", {"OPENAI_API_KEY": ""}), patch.object(speech, "call_provider") as provider:
            with self.assertRaises(HTTPException) as error:
                await self.play(invitation, joined)
            self.assertEqual(error.exception.status_code, 503)
        provider.assert_not_called()
        for result in (b"", b"x" * (speech.MAX_PROVIDER_BYTES + 1), "not-bytes", TimeoutError("private provider error")):
            options = {"side_effect": result} if isinstance(result, Exception) else {"return_value": result}
            with self.subTest(result=type(result).__name__), patch.object(speech, "call_provider", **options):
                with self.assertRaises(HTTPException) as error:
                    await self.play(invitation, joined)
                self.assertEqual(error.exception.status_code, 503)
                self.assertNotIn("private provider error", error.exception.detail)
        self.assertEqual(len(speech._cache), 0)

    async def test_identical_inflight_requests_coalesce(self):
        invitation, joined = self.fixture()
        started, release = threading.Event(), threading.Event()

        def blocked(*_):
            started.set()
            release.wait(3)
            return b"audio"

        with patch.object(speech, "call_provider", side_effect=blocked) as provider:
            first = asyncio.create_task(self.play(invitation, joined))
            await asyncio.to_thread(started.wait, 2)
            second = asyncio.create_task(self.play(invitation, joined))
            await asyncio.sleep(0)
            try:
                self.assertEqual(provider.call_count, 1)
                self.assertEqual(len(speech._inflight), 1)
            finally:
                release.set()
            results = await asyncio.gather(first, second)
        self.assertEqual([result.body for result in results], [b"audio", b"audio"])
        self.assertEqual(provider.call_count, 1)

    async def test_cancellation_keeps_capacity_reserved_until_worker_finishes(self):
        invitation, joined = self.fixture()
        other, other_joined = self.fixture()
        started, release = threading.Event(), threading.Event()

        def blocked(*_):
            started.set()
            release.wait(3)
            return b"audio"

        with patch.object(speech, "MAX_CONCURRENT", 1), patch.object(speech, "call_provider", side_effect=blocked) as provider:
            first = asyncio.create_task(self.play(invitation, joined))
            await asyncio.to_thread(started.wait, 2)
            first.cancel()
            with self.assertRaises(asyncio.CancelledError):
                await first
            try:
                with self.assertRaises(HTTPException) as error:
                    await self.play(other, other_joined)
                self.assertEqual(error.exception.status_code, 503)
                self.assertEqual(provider.call_count, 1)
                self.assertEqual(len(speech._inflight), 1)
            finally:
                release.set()
                await asyncio.gather(*list(speech._inflight.values()), return_exceptions=True)
        self.assertEqual(len(speech._inflight), 0)

    async def test_revocation_or_new_answer_during_generation_rechecks_authorization(self):
        for change in ("revoked", "answered"):
            invitation, joined = self.fixture()

            def changed_during_generation(*_):
                with hiring._db(write=True) as connection:
                    if change == "revoked":
                        connection.execute("UPDATE invitations SET status='revoked' WHERE id=?", (invitation["id"],))
                    else:
                        hiring._insert_turn(connection, invitation["id"], hiring._turn("candidate", "回答しました", 0, "human"))
                return b"audio"

            with self.subTest(change=change), patch.object(speech, "call_provider", side_effect=changed_during_generation):
                with self.assertRaises(HTTPException) as error:
                    await self.play(invitation, joined)
                self.assertEqual(error.exception.status_code, 403 if change == "revoked" else 404)
            # A cached result is not a capability; authorization still precedes lookup.
            with patch.object(speech, "call_provider") as provider:
                with self.assertRaises(HTTPException):
                    await self.play(invitation, joined)
            provider.assert_not_called()

    async def test_provider_failure_after_revocation_finish_or_answer_does_not_allow_fallback(self):
        for change in ("revoked", "completed", "answered"):
            invitation, joined = self.fixture()

            def fail_after_state_change(*_):
                with hiring._db(write=True) as connection:
                    if change == "answered":
                        hiring._insert_turn(connection, invitation["id"], hiring._turn("candidate", "回答済み", 0, "human"))
                    else:
                        connection.execute("UPDATE invitations SET status=? WHERE id=?", (change, invitation["id"]))
                raise TimeoutError("private provider timeout")

            with self.subTest(change=change), patch.object(speech, "call_provider", side_effect=fail_after_state_change):
                with self.assertRaises(HTTPException) as error:
                    await self.play(invitation, joined)
                self.assertEqual(error.exception.status_code, 404 if change == "answered" else 403)
                self.assertNotIn("private provider timeout", error.exception.detail)
        self.assertEqual(len(speech._cache), 0)

    async def test_cache_scope_model_voice_expiry_and_lru_limits(self):
        fixtures = [self.fixture() for _ in range(3)]
        with patch.object(speech, "MAX_CACHE_ENTRIES", 2), patch.object(speech, "MAX_CACHE_BYTES", 8), patch.object(speech, "call_provider", return_value=b"1234") as provider:
            for invitation, joined in fixtures:
                await self.play(invitation, joined)
            self.assertEqual(provider.call_count, 3)  # Same text, distinct applicant scopes.
            self.assertEqual(len(speech._cache), 2)
            self.assertEqual(speech._cache_bytes, 8)
            await self.play(*fixtures[0])  # Evicted least-recently-used invitation.
            self.assertEqual(provider.call_count, 4)
            key = next(reversed(speech._cache))
            speech._cache[key] = (time.monotonic() - speech.CACHE_SECONDS - 1, b"1234")
            await self.play(*fixtures[0])
            self.assertEqual(provider.call_count, 5)
            with patch.dict("os.environ", {"OPENAI_INTERVIEW_TTS_MODEL": "custom-model", "OPENAI_INTERVIEW_TTS_VOICE": "custom-voice"}):
                await self.play(*fixtures[0])
            self.assertEqual(provider.call_count, 6)
            self.assertEqual(provider.call_args.args[-2:], ("custom-model", "custom-voice"))
            self.assertLessEqual(len(speech._cache), 2)
            self.assertLessEqual(speech._cache_bytes, 8)

    async def test_cache_byte_budget_evicts_before_entry_limit(self):
        first, second = self.fixture(), self.fixture()
        with patch.object(speech, "MAX_CACHE_ENTRIES", 16), patch.object(speech, "MAX_CACHE_BYTES", 6), patch.object(speech, "call_provider", return_value=b"1234") as provider:
            await self.play(*first)
            await self.play(*second)
            self.assertEqual(len(speech._cache), 1)
            self.assertEqual(speech._cache_bytes, 4)
            await self.play(*first)
            self.assertEqual(provider.call_count, 3)
            self.assertEqual(speech._cache_bytes, 4)

    async def test_invitation_rate_limit_precedes_new_provider_request(self):
        invitation, joined = self.fixture()
        with patch.object(speech, "REQUESTS_PER_MINUTE", 1), patch.object(speech, "call_provider", return_value=b"audio") as provider:
            await self.play(invitation, joined)
            with self.assertRaises(HTTPException) as error:
                await self.play(invitation, joined)
            self.assertEqual(error.exception.status_code, 429)
            self.assertEqual(provider.call_count, 1)


class SpeechProviderBoundaryTests(unittest.TestCase):
    def test_provider_endpoint_format_instructions_timeout_and_read_bound(self):
        with patch.object(speech.urllib.request, "urlopen") as opened:
            opened.return_value.__enter__.return_value.read.return_value = b"ID3-audio"
            result = speech.call_provider("具体例を教えてください。", "private-key", "gpt-4o-mini-tts", "marin")
        self.assertEqual(result, b"ID3-audio")
        request = opened.call_args.args[0]
        body = json.loads(request.data)
        self.assertEqual(request.full_url, "https://api.openai.com/v1/audio/speech")
        self.assertEqual(body["input"], "具体例を教えてください。")
        self.assertEqual(body["response_format"], "mp3")
        self.assertEqual(body["voice"], "marin")
        self.assertIn("Japanese", body["instructions"])
        self.assertNotIn("private-key", request.data.decode())
        self.assertEqual(opened.call_args.kwargs["timeout"], speech.PROVIDER_TIMEOUT)
        opened.return_value.__enter__.return_value.read.assert_called_once_with(speech.MAX_PROVIDER_BYTES + 1)

    def test_provider_rejects_empty_and_oversized_audio(self):
        for audio in (b"", b"x" * (speech.MAX_PROVIDER_BYTES + 1)):
            with self.subTest(size=len(audio)), patch.object(speech.urllib.request, "urlopen") as opened:
                opened.return_value.__enter__.return_value.read.return_value = audio
                with self.assertRaises(ValueError):
                    speech.call_provider("質問", "key", "model", "voice")


if __name__ == "__main__":
    unittest.main()
