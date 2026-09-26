"""Exercise question tracking and interview closure over real room WebSockets."""
import asyncio
import json
import os
from pathlib import Path
import socket
import subprocess
import sys
import time
import unittest
import urllib.request
import uuid

from websockets.asyncio.client import connect
from websockets.exceptions import ConnectionClosedOK


class RoomProtocolTests(unittest.IsolatedAsyncioTestCase):
    @classmethod
    def setUpClass(cls):
        with socket.socket() as sock:
            sock.bind(('127.0.0.1', 0))
            cls.port = sock.getsockname()[1]
        cls.server = subprocess.Popen(
            [sys.executable, '-m', 'uvicorn', 'app:app', '--host', '127.0.0.1', '--port', str(cls.port)],
            cwd=Path(__file__).parent, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL,
            creationflags=subprocess.CREATE_NO_WINDOW if os.name == 'nt' else 0,
        )
        for _ in range(100):
            try:
                urllib.request.urlopen(f'http://127.0.0.1:{cls.port}/health', timeout=0.2).close()
                return
            except OSError:
                if cls.server.poll() is not None:
                    raise RuntimeError('The room test server failed to start')
                time.sleep(0.1)
        cls.server.terminate()
        cls.server.wait(timeout=5)
        raise RuntimeError('The room test server did not respond')

    @classmethod
    def tearDownClass(cls):
        cls.server.terminate()
        cls.server.wait(timeout=5)

    async def receive(self, ws):
        return json.loads(await asyncio.wait_for(ws.recv(), 3))

    async def join(self, room, role):
        ws = await connect(f'ws://127.0.0.1:{self.port}/ws/room/{room}')
        await ws.send(json.dumps({'type': 'join', 'role': role, 'name': role, 'consent': True}))
        joined = await self.receive(ws)
        self.assertEqual(joined['type'], 'joined')
        self.assertIsInstance(joined['joined_at'], int)
        self.assertGreater(joined['joined_at'], 0)
        return ws, joined['client_id'], await self.receive(ws), joined['joined_at']

    async def test_questions_require_interviewer_and_preserve_vital_association(self):
        room = uuid.uuid4().hex
        interviewer, _, initial, _ = await self.join(room, 'interviewer')
        candidate, candidate_id, _, candidate_joined_at = await self.join(room, 'candidate')
        await self.receive(interviewer)  # Candidate joined.
        try:
            self.assertEqual(initial['question_id'], 0)
            self.assertEqual(initial['questions'], [])
            await candidate.send(json.dumps({'type': 'topic', 'topic': 'rejected'}))
            self.assertEqual(await self.receive(candidate), {
                'type': 'error', 'reason': 'interviewer_required',
            })
            # A candidate cannot end the session either, and the socket remains usable.
            await candidate.send(json.dumps({'type': 'end_session'}))
            self.assertEqual((await self.receive(candidate))['reason'], 'interviewer_required')
            await asyncio.sleep(0.12)  # Room snapshots are limited to ten per second.
            await candidate.send(json.dumps({'type': 'frame', 'image_base64': ''}))
            await asyncio.gather(self.receive(interviewer), self.receive(candidate))
            for question_id in [1, 2]:
                await interviewer.send(json.dumps({'type': 'topic', 'topic': 'same question'}))
                snapshots = await asyncio.gather(self.receive(interviewer), self.receive(candidate))
                # A frame can produce a room broadcast before the forced topic broadcast.
                for index, ws in enumerate([interviewer, candidate]):
                    while snapshots[index]['question_id'] != question_id:
                        snapshots[index] = await self.receive(ws)
                    snapshot = snapshots[index]
                    self.assertEqual([q['id'] for q in snapshot['questions']], list(range(1, question_id + 1)))
                    self.assertTrue(all(q['topic'] == 'same question' for q in snapshot['questions']))
                    member = next(p for p in snapshot['participants'] if p['client_id'] == candidate_id)
                    self.assertGreater(member['vitals_updated_at'], 0)
                    self.assertGreaterEqual(member['vitals_updated_at'], candidate_joined_at)
                    self.assertEqual(member['vitals_question_id'], 0)
        finally:
            await interviewer.close()
            await candidate.close()

    async def test_end_broadcasts_final_snapshot_then_end_and_closes_everyone(self):
        room = uuid.uuid4().hex
        interviewer, _, _, _ = await self.join(room, 'interviewer')
        candidate, _, _, _ = await self.join(room, 'candidate')
        await self.receive(interviewer)
        try:
            await interviewer.send(json.dumps({'type': 'topic', 'topic': 'last question'}))
            await asyncio.gather(self.receive(interviewer), self.receive(candidate))
            await interviewer.send(json.dumps({'type': 'end_session'}))
            ended_at = []
            for ws in [interviewer, candidate]:
                snapshot = await self.receive(ws)
                self.assertEqual(snapshot['type'], 'room')
                self.assertEqual(len(snapshot['participants']), 2)
                self.assertEqual(snapshot['questions'][0]['topic'], 'last question')
                event = await self.receive(ws)
                self.assertEqual(event['type'], 'session_ended')
                self.assertGreaterEqual(event['ended_at'], snapshot['questions'][0]['started_at'])
                ended_at.append(event['ended_at'])
                with self.assertRaises(ConnectionClosedOK):
                    await asyncio.wait_for(ws.recv(), 3)
            self.assertEqual(ended_at[0], ended_at[1])
        finally:
            await interviewer.close()
            await candidate.close()

    async def test_question_limit_preserves_history_and_keeps_socket_usable(self):
        interviewer, _, _, _ = await self.join(uuid.uuid4().hex, 'interviewer')
        try:
            for question_id in range(1, 201):
                await interviewer.send(json.dumps({'type': 'topic', 'topic': f'question {question_id}'}))
                snapshot = await self.receive(interviewer)
                self.assertEqual(snapshot['question_id'], question_id)
            await interviewer.send(json.dumps({'type': 'topic', 'topic': 'over limit'}))
            self.assertEqual(await self.receive(interviewer), {
                'type': 'topic_error', 'reason': 'question_limit',
            })
            await interviewer.send(json.dumps({'type': 'transcribe', 'on': True}))
            snapshot = await self.receive(interviewer)
            self.assertTrue(snapshot['transcribe'])
            self.assertEqual(snapshot['question_id'], 200)
            self.assertEqual(snapshot['topic'], 'question 200')
            self.assertEqual(snapshot['questions'][0]['topic'], 'question 1')
            self.assertEqual(len(snapshot['questions']), 200)
        finally:
            await interviewer.close()


if __name__ == '__main__':
    unittest.main()
