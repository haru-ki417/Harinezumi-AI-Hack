"""Saved coaching, interview depth, migration and audience isolation."""
import asyncio
import json
import sqlite3
import unittest
from contextlib import closing
from datetime import timedelta
from unittest.mock import patch

import hiring
import test_hiring


class FeedbackIntegrationTests(unittest.IsolatedAsyncioTestCase):
    setUp = test_hiring.HiringTests.setUp
    tearDown = test_hiring.HiringTests.tearDown
    api = test_hiring.HiringTests.api
    account = test_hiring.HiringTests.account
    fixture = test_hiring.HiringTests.fixture
    claim = test_hiring.HiringTests.claim

    async def test_adaptive_branch_saved_feedback_and_private_decision(self):
        owner, invitation = await self.fixture(questions=["チームで取り組んだ経験を教えてください。"])
        joined = await self.claim(invitation)
        room, token, session = invitation["id"], joined["token"], joined["session"]
        self.assertIsNone(session["feedback"])
        await self.api(f"/session/{room}/feedback", {}, token, expected=409)
        answers = [
            "私はチームで作業の分担を提案しました。",
            "作業が一人に偏っていたので、担当を一覧表にして相談しました。",
            "週一回の確認で、期限内に完成したことを確かめました。",
            "次は最初に負担を確認し、途中でも担当を見直したいと考えています。",
        ]
        questions = []
        depths = []
        for index, text in enumerate(answers):
            if session["invitation"]["status"] == "completed":
                break
            questions.append(session["transcript"][-1]["text"])
            depths.append(session["interview_progress"]["follow_up_depth"])
            session = await self.api(f"/session/{room}/answer", {
                "text": text, "request_id": f"depth-{index}",
                "expected_turn_id": session["transcript"][-1]["id"],
            }, token)
        self.assertIn(2, depths)
        self.assertEqual(len(questions), len(set(questions)))
        self.assertEqual(session["invitation"]["status"], "completed")
        self.assertIsNone(session["report"])
        self.assertTrue(session["feedback"]["question_reviews"])
        evidence = {turn["id"]: turn["text"] for turn in session["transcript"] if turn["role"] == "candidate"}
        for review in session["feedback"]["question_reviews"]:
            for reference in review["evidence"]:
                self.assertIn(reference["quote"], evidence[reference["turn_id"]])
        await self.api(f"/invitations/{room}/review", {"decision": "advance", "notes": "社内だけの判断根拠"}, owner)
        employer = await self.api(f"/invitations/{room}", token=owner)
        refreshed = await self.api(f"/session/{room}/feedback", {}, token)
        self.assertNotIn("社内だけの判断根拠", json.dumps(refreshed, ensure_ascii=False))
        self.assertEqual(refreshed["review"], {"decision": "pending", "notes": ""})
        self.assertEqual(refreshed["template"]["criteria"], [])
        self.assertIsNone(refreshed["report"])
        self.assertEqual((await self.api(f"/invitations/{room}", token=owner))["report"], employer["report"])
        hiring._initialized.clear()
        restored = await self.api(f"/session/{room}", token=token)
        self.assertEqual(restored["feedback"], refreshed["feedback"])
        await self.api(f"/session/{room}/feedback", {}, "x" * 43, expected=403)

    async def test_feedback_generation_reservation_and_allowlisted_template(self):
        owner, invitation = await self.fixture("human")
        joined = await self.claim(invitation)
        room, token = invitation["id"], joined["token"]
        await self.api(f"/invitations/{room}/admit", {}, owner)
        await hiring.append_human_turn(room, token, "私は資料の作成を担当し、二人で内容を確認しました。", "turn-1")
        ended = await self.api(f"/invitations/{room}/finish", {}, owner)
        self.assertIsNotNone(ended["feedback"])
        entered, release = asyncio.Event(), asyncio.Event()
        seen = []

        async def delayed(template, transcript):
            seen.append(template)
            entered.set()
            await release.wait()
            return hiring.interview_ai.local_feedback(template, transcript)

        with patch.object(hiring.interview_ai, "build_feedback", side_effect=delayed):
            first = asyncio.create_task(self.api(f"/session/{room}/feedback", {}, token))
            await asyncio.wait_for(entered.wait(), 3)
            try:
                waiting = await self.api(f"/session/{room}/feedback", {}, owner)
                self.assertTrue(waiting["feedback_processing"])
                self.assertEqual(len(seen), 1)
                self.assertEqual(set(seen[0]), {"job_title", "questions", "_redact_names"})
            finally:
                release.set()
            result = await first
        self.assertFalse(result["feedback_processing"])
        self.assertEqual(result["feedback"]["question_reviews"][0]["question_index"], -1)

    async def test_deadline_and_legacy_completed_reports_get_feedback(self):
        _, invitation = await self.fixture()
        joined = await self.claim(invitation)
        room, token = invitation["id"], joined["token"]
        future = hiring._now() + timedelta(minutes=6)
        with patch.object(hiring, "_now", return_value=future):
            ended = await self.api(f"/session/{room}", token=token)
        self.assertEqual(ended["invitation"]["status"], "completed")
        self.assertEqual(ended["feedback"]["strengths"], [])
        with hiring._db(write=True) as connection:
            connection.execute("UPDATE invitations SET feedback=NULL WHERE id=?", (room,))
        legacy = await self.api(f"/session/{room}", token=token)
        self.assertIsNotNone(legacy["feedback"])
        regenerated = await self.api(f"/session/{room}/feedback", {}, token)
        self.assertIsNotNone(regenerated["feedback"])

    async def test_additive_migration_preserves_old_invitation(self):
        owner, invitation = await self.fixture()
        room = invitation["id"]
        # Recreate the pre-feedback schema only inside this test's temporary DB.
        path = hiring._database_path()
        with closing(sqlite3.connect(path)) as connection:
            connection.execute("ALTER TABLE invitations DROP COLUMN feedback")
            connection.execute("ALTER TABLE invitations DROP COLUMN feedback_busy_since")
            connection.commit()
        hiring._initialized.clear()
        recovered = await self.api(f"/invitations/{room}", token=owner)
        self.assertEqual(recovered["invitation"]["code"], invitation["code"])
        self.assertEqual(recovered["invitation"]["status"], "invited")
        with hiring._db() as connection:
            columns = {row[1] for row in connection.execute("PRAGMA table_info(invitations)")}
            self.assertTrue({"feedback", "feedback_busy_since"} <= columns)


if __name__ == "__main__":
    unittest.main()
