"""Authenticated managed-room vitals, consent and worker lifecycle regressions."""
import asyncio
import base64
import json
import tempfile
import threading
import unittest
from datetime import timedelta
from pathlib import Path
from unittest.mock import patch

import cv2
import numpy as np
from fastapi import HTTPException, Request, WebSocketDisconnect

import hiring
import hiring_live as live
from vital import SessionManager, VitalState, load_settings


class Socket:
    def __init__(self, incoming=None):
        self.sent = []
        self.incoming = list(incoming or [])
        self.closed = []

    async def accept(self):
        pass

    async def send_json(self, message):
        self.sent.append(message)

    async def receive_text(self):
        if self.incoming:
            return json.dumps(self.incoming.pop(0))
        raise WebSocketDisconnect()

    async def close(self, **kwargs):
        self.closed.append(kwargs)


class HiringVitalTests(unittest.IsolatedAsyncioTestCase):
    def setUp(self):
        self.directory = tempfile.TemporaryDirectory(prefix="hiring-vitals-")
        self.addCleanup(self.directory.cleanup)
        environment = patch.dict("os.environ", {
            "HIRING_DB_PATH": str(Path(self.directory.name) / "vitals.sqlite3"), "OPENAI_API_KEY": "",
        })
        environment.start()
        self.addCleanup(environment.stop)
        hiring._rates.clear()
        live._peers.clear()
        live._frame_workers.clear()
        self.company = {"id": "owner", "name": "企業", "email": "owner@example.test"}
        self.owner_token = "h" * 43
        with hiring._db(write=True) as connection:
            connection.execute("INSERT INTO companies VALUES(?,?,?,?,?)", (
                "owner", "企業", "owner@example.test", "unused", hiring._iso(),
            ))
            connection.execute("INSERT INTO employer_sessions VALUES(?,?,?,?)", (
                hiring._hash(self.owner_token), "owner", hiring._iso(), hiring._iso(hiring._now() + timedelta(hours=1)),
            ))
        self.request = Request({"type": "http", "client": ("vital-test", 1), "method": "POST", "path": "/"})

    async def asyncTearDown(self):
        tasks = [peer.frame_task for peers in live._peers.values() for peer in peers.values() if peer.frame_task]
        await asyncio.gather(*tasks, return_exceptions=True)
        await asyncio.gather(*list(live._frame_workers), return_exceptions=True)
        live._peers.clear()

    def fixture(self, mode="human", admitted=True):
        template = hiring.create_template(hiring.NewTemplate(
            title="面接", job_title="開発職", mode=mode, duration_minutes=5,
            questions=["経験を教えてください。"], criteria=["経験"],
        ), self.company)
        invitation = hiring.create_invitation(template["id"], hiring.NewInvitation(
            candidate_name="応募者", expires_at=hiring._now() + timedelta(hours=1),
        ), self.company)
        joined = hiring.start(hiring.Start(code=invitation["code"], name="応募者", consent=True), self.request)
        if admitted and mode == "human":
            hiring.admit(invitation["id"], self.company)
        host = live.Peer(Socket(), self.owner_token, "interviewer", "面接官")
        candidate = live.Peer(Socket(), joined["token"], "candidate", "応募者")
        live._peers[invitation["id"]] = {"interviewer": host, "candidate": candidate}
        return invitation["id"], host, candidate

    async def consent(self, room, peer, enabled=True):
        await live._vital_message(room, peer, {"type": "vital_consent", "enabled": enabled})

    async def frame(self, room, peer, **extra):
        await live._vital_message(room, peer, {"type": "frame", "image_base64": "mock-frame", **extra})
        task = peer.frame_task
        if task:
            await task

    def values(self, valid=True):
        return VitalState(current_bpm=77, stress=23, measurement_valid=valid, stress_valid=valid).as_dict()

    async def test_no_frames_before_admission_consent_or_in_ai_rooms(self):
        waiting, _, candidate = self.fixture(admitted=False)
        ai, _, ai_candidate = self.fixture(mode="ai")
        active, _, active_candidate = self.fixture()
        with patch.object(live, "_analyze_frame") as analyzer:
            for room, peer, message, status in (
                (waiting, candidate, {"type": "vital_consent", "enabled": True}, 409),
                (waiting, candidate, {"type": "frame", "image_base64": "frame"}, 409),
                (ai, ai_candidate, {"type": "vital_consent", "enabled": True}, 409),
                (active, active_candidate, {"type": "frame", "image_base64": "frame"}, 403),
                (active, active_candidate, {"type": "vital_consent", "enabled": "true"}, 422),
            ):
                with self.subTest(status=status), self.assertRaises(HTTPException) as error:
                    await live._vital_message(room, peer, message)
                self.assertEqual(error.exception.status_code, status)
        analyzer.assert_not_called()

    async def test_websocket_join_rejects_other_applicant_and_ai_room(self):
        first, _, candidate = self.fixture()
        other, _, _ = self.fixture()
        ai, _, ai_candidate = self.fixture(mode="ai")
        with patch.object(live, "_analyze_frame") as analyzer:
            for room, token, status in ((other, candidate.token, 403), (ai, ai_candidate.token, 400)):
                ws = Socket([{"type": "join", "token": token}, {"type": "vital_consent", "enabled": True}])
                await live.human_interview(ws, room)
                self.assertEqual(ws.sent[0]["status"], status)
                self.assertTrue(ws.closed)
        analyzer.assert_not_called()

    async def test_computed_metrics_bound_to_authenticated_speaker_and_same_room(self):
        room, host, candidate = self.fixture()
        other, other_host, other_candidate = self.fixture()
        await self.consent(room, candidate)
        with patch.object(live, "_analyze_frame", return_value=self.values()) as analyzer:
            await self.frame(room, candidate, role="interviewer", client_id="attacker", current_bpm=999, stress=999)
        for recipient in (host, candidate):
            event = [event for event in recipient.ws.sent if event["type"] == "vitals"][-1]
            self.assertEqual((event["client_id"], event["role"], event["name"]), ("candidate", "candidate", "応募者"))
            self.assertEqual(event["vitals"]["current_bpm"], 77)
        self.assertFalse([event for peer in (other_host, other_candidate) for event in peer.ws.sent if event["type"] == "vitals"])
        self.assertEqual(analyzer.call_args.args[1], "candidate")
        self.assertEqual(hiring.access_session(room, candidate.token)[1]["transcript"], [])
        with hiring._db() as connection:
            self.assertEqual(connection.execute("SELECT report FROM invitations WHERE id=?", (room,)).fetchone()[0], None)

    async def test_persistence_requires_new_explicit_summary_consent(self):
        room, host, candidate = self.fixture()
        await self.consent(room, candidate)
        with patch.object(live, "_analyze_frame", return_value=self.values()):
            await self.frame(room, candidate)
        with hiring._db() as connection:
            self.assertEqual(connection.execute("SELECT count(*) FROM hiring_measurements").fetchone()[0], 0)
        await live._vital_message(room, candidate, {"type": "vital_consent", "enabled": True, "save_summary": True})
        candidate.last_frame = candidate.last_vital_broadcast = 0
        with patch.object(live, "_analyze_frame", return_value=self.values()):
            await self.frame(room, candidate)
        with hiring._db() as connection:
            row = connection.execute("SELECT * FROM hiring_measurements").fetchone()
            self.assertEqual(row['role'], 'candidate')
            self.assertEqual(row['bpm'], 77)
        await self.consent(room, candidate, False)
        self.assertFalse(candidate.save_summary)

    async def test_withdrawal_discards_inflight_result_and_restarts_clean_buffer(self):
        room, host, candidate = self.fixture()
        await self.consent(room, candidate)
        original_manager = candidate.vital_manager
        started, release = threading.Event(), threading.Event()

        def delayed(*_):
            started.set()
            release.wait(3)
            return self.values()

        with patch.object(live, "_analyze_frame", side_effect=delayed):
            await live._vital_message(room, candidate, {"type": "frame", "image_base64": "frame"})
            task = candidate.frame_task
            await asyncio.to_thread(started.wait, 2)
            await self.consent(room, candidate, False)
            self.assertIsNone(candidate.vital_manager)
            self.assertTrue(any(event["type"] == "vitals_clear" for event in host.ws.sent))
            await self.consent(room, candidate)
            self.assertIsNot(candidate.vital_manager, original_manager)
            release.set()
            await task
        self.assertFalse(any(event["type"] == "vitals" for event in host.ws.sent))

    async def test_end_revoke_or_recipient_auth_loss_during_compute_prevents_delivery(self):
        for transition in ("completed", "revoked", "host_logged_out"):
            room, host, candidate = self.fixture()
            await self.consent(room, candidate)

            def change_during_analysis(*_):
                with hiring._db(write=True) as connection:
                    if transition == "host_logged_out":
                        connection.execute("DELETE FROM employer_sessions WHERE token_hash=?", (hiring._hash(self.owner_token),))
                    else:
                        connection.execute("UPDATE invitations SET status=? WHERE id=?", (transition, room))
                return self.values()

            with self.subTest(transition=transition), patch.object(live, "_analyze_frame", side_effect=change_during_analysis):
                await self.frame(room, candidate)
                self.assertFalse(any(event["type"] == "vitals" for event in host.ws.sent))
                if transition != "host_logged_out":
                    self.assertFalse(candidate.vital_consent)
                    self.assertFalse(any(event["type"] == "vitals" for event in candidate.ws.sent))

    async def test_state_end_clears_both_consents_and_measurement_flags_are_fresh(self):
        room, host, candidate = self.fixture()
        await self.consent(room, candidate)
        await self.consent(room, host)
        with patch.object(live, "_analyze_frame", return_value=self.values(valid=False)):
            await self.frame(room, candidate)
        event = [event for event in host.ws.sent if event["type"] == "vitals"][-1]
        self.assertEqual((event["vitals"]["current_bpm"], event["vitals"]["stress"]), (0, 0))
        with hiring._db(write=True) as connection:
            connection.execute("UPDATE invitations SET status='completed' WHERE id=?", (room,))
        await live._state(room, host)
        self.assertFalse(host.vital_consent)
        self.assertFalse(candidate.vital_consent)
        state = host.ws.sent[-1]
        self.assertTrue(all(not peer["vital_consent"] for peer in state["peers"]))

    async def test_global_worker_limit_is_reserved_before_scheduling_and_fps_drops(self):
        room, host, candidate = self.fixture()
        second, _, third = self.fixture()
        for identifier, peer in ((room, host), (room, candidate), (second, third)):
            await self.consent(identifier, peer)
        release = threading.Event()

        def blocked(*_):
            release.wait(3)
            return self.values()

        with patch.object(live, "_analyze_frame", side_effect=blocked) as analyzer:
            for identifier, peer in ((room, host), (room, candidate), (second, third)):
                await live._vital_message(identifier, peer, {"type": "frame", "image_base64": "frame"})
            self.assertEqual(len(live._frame_workers), 2)
            self.assertIsNone(third.frame_task)
            release.set()
            await asyncio.gather(host.frame_task, candidate.frame_task)
            self.assertEqual(analyzer.call_count, 2)
            candidate.last_frame = live.time.monotonic()
            await self.frame(room, candidate)
            self.assertEqual(analyzer.call_count, 2)

    async def test_disconnect_cleans_shared_values_and_requires_new_connection_consent(self):
        room, host, candidate = self.fixture()
        await self.consent(room, candidate)
        ws = Socket([{"type": "join", "token": candidate.token}, {"type": "vital_consent", "enabled": True}])
        await live.human_interview(ws, room)
        self.assertNotIn("candidate", live._peers[room])
        self.assertFalse(candidate.vital_consent)
        self.assertTrue(any(event["type"] == "vitals_clear" for event in host.ws.sent))

    async def test_timeout_revokes_measurement_and_retains_slot_until_worker_stops(self):
        room, host, candidate = self.fixture()
        await self.consent(room, candidate)
        await self.consent(room, host)
        started, release = threading.Event(), threading.Event()

        def blocked(*_):
            started.set()
            release.wait(3)
            return self.values()

        with patch.object(live, "FRAME_TIMEOUT", 0.02), patch.object(live, "MAX_FRAME_WORKERS", 1), patch.object(live, "_analyze_frame", side_effect=blocked) as analyzer:
            await live._vital_message(room, candidate, {"type": "frame", "image_base64": "frame"})
            task = candidate.frame_task
            await asyncio.to_thread(started.wait, 2)
            await task
            try:
                self.assertFalse(candidate.vital_consent)
                self.assertIsNone(candidate.vital_manager)
                self.assertEqual(len(live._frame_workers), 1)
                await live._vital_message(room, host, {"type": "frame", "image_base64": "frame"})
                self.assertIsNone(host.frame_task)
                self.assertEqual(analyzer.call_count, 1)
            finally:
                release.set()
                await asyncio.gather(*list(live._frame_workers))
        self.assertFalse(any(event["type"] == "vitals" for event in host.ws.sent))

    async def test_size_invalid_image_and_crossroom_controls_rejected(self):
        room, _, candidate = self.fixture()
        other, _, _ = self.fixture()
        await self.consent(room, candidate)
        with self.assertRaises(HTTPException) as error:
            await live._vital_message(room, candidate, {"type": "frame", "image_base64": "x" * (live.MAX_FRAME_BASE64 + 1)})
        self.assertEqual(error.exception.status_code, 413)
        with self.assertRaises(HTTPException) as error:
            await self.consent(other, candidate, False)
        self.assertEqual(error.exception.status_code, 403)
        self.assertTrue(candidate.vital_consent)
        with patch.object(live, "_analyze_frame", side_effect=ValueError("decode")):
            await self.frame(room, candidate)
        self.assertEqual(candidate.ws.sent[-1]["status"], 422)


class FramePipelineTests(unittest.TestCase):
    def test_real_small_jpeg_uses_roi_and_server_session_manager(self):
        success, data = cv2.imencode(".jpg", np.full((120, 160, 3), 127, dtype=np.uint8))
        self.assertTrue(success)
        encoded = "data:image/jpeg;base64," + base64.b64encode(data.tobytes()).decode()
        manager = SessionManager(load_settings())
        with patch.object(live, "_mesh_roi", return_value=None), patch.object(live, "face_roi_rgb", return_value=(127, 126, 125)):
            state = live._analyze_frame(manager, "candidate", encoded, 10)
        self.assertFalse(state["measurement_valid"])
        self.assertEqual(len(manager._clients["candidate"].buf), 1)

    def test_dimensions_checked_before_decoder_allocation(self):
        success, image = cv2.imencode(".jpg", np.zeros((800, 800, 3), dtype=np.uint8))
        self.assertTrue(success)
        encoded = base64.b64encode(image.tobytes()).decode()
        with patch.object(live, "decode_image") as decode:
            for value in (encoded, "data:image/png;base64,AAAA", "not-base64"):
                with self.assertRaises(ValueError):
                    live._analyze_frame(SessionManager(load_settings()), "candidate", value, 0)
        decode.assert_not_called()


if __name__ == "__main__":
    unittest.main()
