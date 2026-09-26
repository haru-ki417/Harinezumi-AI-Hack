"""Independent state-transition and access-control regressions for hiring rooms."""
import asyncio
import tempfile
import unittest
from datetime import timedelta
from pathlib import Path
from unittest.mock import patch

from fastapi import HTTPException, Request

import hiring


class HiringEdgeCases(unittest.IsolatedAsyncioTestCase):
    def setUp(self):
        self.directory = tempfile.TemporaryDirectory()
        self.addCleanup(self.directory.cleanup)
        self.environment = patch.dict("os.environ", {
            "HIRING_DB_PATH": str(Path(self.directory.name) / "edge.sqlite3"),
            "OPENAI_API_KEY": "",
        })
        self.environment.start()
        self.addCleanup(self.environment.stop)
        hiring._rates.clear()
        self.company = {"id": "owner", "name": "企業", "email": "owner@example.test"}
        self.other = {"id": "other", "name": "他社", "email": "other@example.test"}
        self.host_token = "h" * 43
        self.other_token = "o" * 43
        with hiring._db(write=True) as connection:
            for company, token in ((self.company, self.host_token), (self.other, self.other_token)):
                connection.execute("INSERT INTO companies VALUES(?,?,?,?,?)", (
                    company["id"], company["name"], company["email"], "unused", hiring._iso(),
                ))
                connection.execute("INSERT INTO employer_sessions VALUES(?,?,?,?)", (
                    hiring._hash(token), company["id"], hiring._iso(),
                    hiring._iso(hiring._now() + timedelta(hours=1)),
                ))
        self.request = Request({"type": "http", "client": ("edge-test", 1), "method": "POST", "path": "/"})

    def create(self, mode="ai"):
        template = hiring.create_template(hiring.NewTemplate(
            title="面接", job_title="開発職", mode=mode, duration_minutes=5,
            questions=["活動を教えてください。", "今後学びたいことは何ですか。"], criteria=["秘密の確認項目"],
        ), self.company)
        return hiring.create_invitation(template["id"], hiring.NewInvitation(
            candidate_name="応募者", expires_at=hiring._now() + timedelta(hours=1),
        ), self.company)

    def join(self, invitation, resume=None):
        return hiring.start(hiring.Start(code=invitation["code"], name="応募者", consent=True,
                                       resume_token=resume), self.request)

    async def test_simultaneous_invitation_claim_has_one_winner(self):
        invitation = self.create()
        results = await asyncio.gather(
            asyncio.to_thread(self.join, invitation), asyncio.to_thread(self.join, invitation),
            return_exceptions=True,
        )
        successes = [result for result in results if isinstance(result, dict)]
        failures = [result for result in results if isinstance(result, HTTPException)]
        self.assertEqual(len(successes), 1)
        self.assertEqual([error.status_code for error in failures], [409])
        resumed = self.join(invitation, successes[0]["token"])
        self.assertEqual(resumed["token"], successes[0]["token"])
        self.assertEqual(len(resumed["session"]["transcript"]), 1)

    async def test_company_and_candidate_views_are_private_and_durable(self):
        invitation = self.create()
        joined = self.join(invitation)
        with self.assertRaises(HTTPException) as error:
            hiring.access_session(invitation["id"], self.other_token)
        self.assertEqual(error.exception.status_code, 403)
        with self.assertRaises(HTTPException):
            hiring.get_invitation(invitation["id"], self.other)
        await hiring.candidate_finish(invitation["id"], "Bearer " + joined["token"])
        hiring.review(invitation["id"], hiring.Review(decision="advance", notes="秘密の担当者メモ"), self.company)
        hiring._initialized.clear()  # Simulate module schema cache reset/restart.
        _, candidate = hiring.access_session(invitation["id"], joined["token"])
        self.assertEqual(candidate["template"]["criteria"], [])
        self.assertEqual(candidate["invitation"]["code"], "")
        self.assertEqual(candidate["invitation"]["decision"], "pending")
        self.assertEqual(candidate["review"], {"decision": "pending", "notes": ""})
        self.assertIsNone(candidate["report"])
        _, employer = hiring.access_session(invitation["id"], self.host_token)
        self.assertEqual(employer["review"]["notes"], "秘密の担当者メモ")
        self.assertIsNotNone(employer["report"])

    async def test_answer_retries_concurrent_submission_and_stale_question(self):
        invitation = self.create()
        joined = self.join(invitation)
        body = hiring.Answer(text="チームで活動しました。", request_id="answer1",
                             expected_turn_id=joined["session"]["transcript"][-1]["id"])
        started, release = asyncio.Event(), asyncio.Event()

        async def question(*_):
            started.set()
            await release.wait()
            return {"text": "担当した作業は何ですか。", "question_index": 0, "is_follow_up": True, "source": "local"}

        authorization = "Bearer " + joined["token"]
        with patch.object(hiring.interview_ai, "next_question", side_effect=question):
            first = asyncio.create_task(hiring.answer(invitation["id"], body, authorization))
            await started.wait()
            try:
                with self.assertRaises(HTTPException) as error:
                    await hiring.answer(invitation["id"], body, authorization)
                self.assertEqual(error.exception.status_code, 409)
            finally:
                release.set()
            result = await first
        replay = await hiring.answer(invitation["id"], body, authorization)
        self.assertEqual(len(result["transcript"]), 3)
        self.assertEqual(replay["transcript"], result["transcript"])
        for retry in (
            body.model_copy(update={"text": "別の回答"}),
            body.model_copy(update={"request_id": "stale-answer"}),
        ):
            with self.assertRaises(HTTPException) as error:
                await hiring.answer(invitation["id"], retry, authorization)
            self.assertEqual(error.exception.status_code, 409)

    async def test_accepted_answer_survives_deadline_during_provider_call(self):
        invitation = self.create()
        joined = self.join(invitation)
        body = hiring.Answer(text="締切前に送信した回答です。", request_id="last-answer",
                             expected_turn_id=joined["session"]["transcript"][-1]["id"])
        now = hiring._now()

        async def cross_deadline(*_):
            nonlocal now
            now += timedelta(minutes=6)
            return {"text": "具体例はありますか。", "question_index": 0, "is_follow_up": True, "source": "local"}

        with patch.object(hiring, "_now", side_effect=lambda: now), patch.object(hiring.interview_ai, "next_question", side_effect=cross_deadline):
            result = await hiring.answer(invitation["id"], body, "Bearer " + joined["token"])
        self.assertEqual(result["invitation"]["status"], "completed")
        candidate_turns = [turn for turn in result["transcript"] if turn["role"] == "candidate"]
        self.assertEqual([turn["text"] for turn in candidate_turns], [body.text])
        self.assertEqual(len(result["transcript"]), 2)

    async def test_poll_or_websocket_refresh_at_deadline_includes_pending_answer(self):
        invitation = self.create()
        joined = self.join(invitation)
        body = hiring.Answer(text="締切前に送信した回答です。", request_id="poll-deadline",
                             expected_turn_id=joined["session"]["transcript"][-1]["id"])
        now = hiring._now()
        observed = {}

        async def refresh_while_pending(*_):
            nonlocal now
            _, processing = hiring.access_session(invitation["id"], joined["token"])
            self.assertTrue(processing["processing"])
            self.assertEqual(processing["transcript"][-1]["text"], body.text)
            now += timedelta(minutes=6)
            _, snapshot = hiring.access_session(invitation["id"], self.host_token)
            observed.update(snapshot)
            return {"text": "具体例はありますか。", "question_index": 0, "is_follow_up": True, "source": "local"}

        with patch.object(hiring, "_now", side_effect=lambda: now), patch.object(hiring.interview_ai, "next_question", side_effect=refresh_while_pending):
            result = await hiring.answer(invitation["id"], body, "Bearer " + joined["token"])
        self.assertEqual(observed["invitation"]["status"], "completed")
        self.assertIn("回答1件", observed["report"]["summary"])
        self.assertEqual(result["transcript"], observed["transcript"])
        self.assertEqual(len(result["transcript"]), 2)
        self.assertFalse(result["processing"])

    async def test_cancelled_worker_preserves_answer_and_recovers_after_lease(self):
        invitation = self.create()
        joined = self.join(invitation)
        body = hiring.Answer(text="再起動でも失わない回答です。", request_id="cancelled-answer",
                             expected_turn_id=joined["session"]["transcript"][-1]["id"])
        started = asyncio.Event()

        async def interrupted_provider(*_):
            started.set()
            await asyncio.Event().wait()

        authorization = "Bearer " + joined["token"]
        with patch.object(hiring.interview_ai, "next_question", side_effect=interrupted_provider):
            request = asyncio.create_task(hiring.answer(invitation["id"], body, authorization))
            await started.wait()
            request.cancel()
            with self.assertRaises(asyncio.CancelledError):
                await request
        _, pending = hiring.access_session(invitation["id"], joined["token"])
        self.assertTrue(pending["processing"])
        self.assertEqual(pending["transcript"][-1]["text"], body.text)
        after_lease = hiring._now() + timedelta(seconds=hiring.RESERVATION_SECONDS + 1)
        with patch.object(hiring, "_now", return_value=after_lease):
            _, recovered = hiring.access_session(invitation["id"], joined["token"])
            replay = await hiring.answer(invitation["id"], body, authorization)
        self.assertFalse(recovered["processing"])
        self.assertEqual(recovered["transcript"][-1]["question_index"], 0)
        self.assertEqual(recovered["interview_progress"]["follow_up_depth"], 1)
        self.assertEqual(recovered["transcript"][-1]["role"], "ai")
        self.assertEqual(len(recovered["transcript"]), 3)
        self.assertEqual(replay["transcript"], recovered["transcript"])

    async def test_revocation_blocks_new_candidate_answers_and_human_admission(self):
        for mode in ("ai", "human"):
            invitation = self.create(mode)
            joined = self.join(invitation)
            hiring.revoke(invitation["id"], self.company)
            with self.assertRaises(HTTPException):
                if mode == "ai":
                    await hiring.answer(invitation["id"], hiring.Answer(
                        text="回答", request_id="revoked-answer",
                        expected_turn_id=joined["session"]["transcript"][-1]["id"],
                    ), "Bearer " + joined["token"])
                else:
                    hiring.admit(invitation["id"], self.company)


if __name__ == "__main__":
    unittest.main()
