"""実サーバーに複数のクライアントを接続してチャットを確認する。"""
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


class ChatTests(unittest.IsolatedAsyncioTestCase):
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
                    raise RuntimeError('テスト用バックエンドを起動できませんでした')
                time.sleep(0.1)
        cls.server.terminate()
        cls.server.wait(timeout=5)
        raise RuntimeError('テスト用バックエンドが応答しませんでした')

    @classmethod
    def tearDownClass(cls):
        cls.server.terminate()
        cls.server.wait(timeout=5)

    async def open_chat(self, room, name='太郎', consent=True):
        ws = await connect(f'ws://127.0.0.1:{self.port}/ws/chat/{room}')
        await ws.send(json.dumps({'type': 'join', 'name': name, 'role': 'candidate', 'consent': consent}))
        return ws, json.loads(await asyncio.wait_for(ws.recv(), 2))

    async def send(self, ws, text, request_id=None, **extra):
        await ws.send(json.dumps({'type': 'chat', 'text': text, 'request_id': request_id or uuid.uuid4().hex, **extra}))
        return json.loads(await asyncio.wait_for(ws.recv(), 2))

    async def test_delivery_history_isolation_and_sender_identity(self):
        room = uuid.uuid4().hex
        a, joined = await self.open_chat(room)
        b, _ = await self.open_chat(room, '花子')
        separate, _ = await self.open_chat(room + '-other')
        try:
            reply = await self.send(a, '面接前です\nよろしくお願いします', 'one', name='偽の名前', sender_id='spoof')
            received = json.loads(await asyncio.wait_for(b.recv(), 2))
            self.assertEqual(reply, received)
            self.assertEqual(reply['message']['name'], '太郎')
            self.assertEqual(reply['message']['sender_id'], joined['client_id'])
            self.assertEqual(reply['message']['text'], '面接前です\nよろしくお願いします')
            with self.assertRaises(asyncio.TimeoutError):
                await asyncio.wait_for(separate.recv(), 0.1)
            late, history = await self.open_chat(room, '途中参加')
            self.assertEqual(history['messages'], [reply['message']])
            await late.close()
            # 同一リクエストの再送は送信者への再確認だけで、相手には重複配信しない。
            duplicate = await self.send(a, '再送', 'one')
            self.assertEqual(duplicate, reply)
            with self.assertRaises(asyncio.TimeoutError):
                await asyncio.wait_for(b.recv(), 0.1)
        finally:
            await a.close()
            await b.close()
            await separate.close()

    async def test_validation_consent_and_no_vital_frames(self):
        ws, reply = await self.open_chat(uuid.uuid4().hex, consent=False)
        self.assertEqual(reply['reason'], 'consent_required')
        await ws.close()
        ws, _ = await self.open_chat(uuid.uuid4().hex)
        try:
            for text in ['', ' \n ', 'a' * 2001, 42]:
                self.assertEqual((await self.send(ws, text))['reason'], 'invalid_message')
            await ws.send(json.dumps({'type': 'frame', 'image_base64': 'not-an-image'}))
            self.assertEqual(json.loads(await ws.recv())['reason'], 'invalid_message')
            await ws.send('invalid-json')
            self.assertEqual(json.loads(await ws.recv())['reason'], 'invalid_message')
            self.assertEqual((await self.send(ws, '😀' * 2000))['type'], 'chat_message')
        finally:
            await ws.close()

    async def test_bounded_history_and_cleanup(self):
        room = uuid.uuid4().hex
        a, _ = await self.open_chat(room)
        for number in range(105):
            await self.send(a, str(number))
        b, reply = await self.open_chat(room)
        self.assertEqual(len(reply['messages']), 100)
        self.assertEqual(reply['messages'][0]['text'], '5')
        self.assertEqual(reply['messages'][-1]['text'], '104')
        await a.close()
        await b.close()
        # close() の後にサーバーの finally が完了するまで待つ。
        await asyncio.sleep(0.05)
        c, reply = await self.open_chat(room)
        self.assertEqual(reply['messages'], [])
        await c.close()


if __name__ == '__main__':
    unittest.main()
