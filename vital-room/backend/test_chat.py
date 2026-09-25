"""実サーバーに複数のクライアントを接続してチャットを確認する。"""
import asyncio
import base64
import json
import os
from pathlib import Path
import socket
import subprocess
import sys
import time
import unittest
import urllib.error
import urllib.parse
import urllib.request
import uuid
from unittest.mock import patch

from fastapi import HTTPException, Request
from websockets.asyncio.client import connect

import chat


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

    async def file_request(self, room, token=None, *, data=None, name='資料.pdf',
                           content_type='application/pdf', attachment_id=None, method=None, headers=None):
        request_headers = {'X-Filename': urllib.parse.quote(name), 'Content-Type': content_type}
        if token:
            request_headers['Authorization'] = 'Bearer ' + token
        request_headers.update(headers or {})
        url = f'http://127.0.0.1:{self.port}/api/chat/{room}/attachments'
        if attachment_id:
            url += '/' + attachment_id
        request = urllib.request.Request(url, data=data, headers=request_headers, method=method)

        def perform():
            try:
                response = urllib.request.urlopen(request, timeout=5)
            except urllib.error.HTTPError as error:
                response = error
            with response:
                return response.status, response.headers, response.read()

        return await asyncio.to_thread(perform)

    async def test_attachment_delivery_authentication_and_cleanup(self):
        room = uuid.uuid4().hex
        a, joined_a = await self.open_chat(room)
        b, joined_b = await self.open_chat(room)
        other, joined_other = await self.open_chat(room + '-other')
        token_a, token_b = joined_a['upload_token'], joined_b['upload_token']
        data = b'%PDF-1.7\nattachment test\n%%EOF'
        try:
            self.assertNotEqual(token_a, token_b)
            status, _, _ = await self.file_request(room, data=data)
            self.assertEqual(status, 401)
            status, _, body = await self.file_request(room, token_a, data=data)
            self.assertEqual(status, 201)
            attachment = json.loads(body)
            self.assertEqual(attachment['name'], '資料.pdf')
            self.assertEqual(attachment['size'], len(data))
            self.assertEqual(attachment['content_type'], 'application/pdf')
            identifier = attachment['id']
            # Unsent uploads stay private, even from other participants in this room.
            self.assertEqual((await self.file_request(room, token_b, attachment_id=identifier))[0], 404)
            self.assertEqual((await self.file_request(room, token_a, attachment_id=identifier))[2], data)
            stolen = await self.send(b, '', attachment_ids=[identifier])
            self.assertEqual(stolen['reason'], 'invalid_attachment')
            message = await self.send(a, '', 'attachment-only', attachment_ids=[identifier])
            self.assertEqual(message['message']['text'], '')
            self.assertEqual(message['message']['attachments'], [attachment])
            self.assertEqual(json.loads(await b.recv()), message)
            # Duplicate sends do not repost or lose their attachment.
            duplicate = await self.send(a, '', 'attachment-only', attachment_ids=[identifier])
            self.assertEqual(duplicate, message)
            with self.assertRaises(asyncio.TimeoutError):
                await asyncio.wait_for(b.recv(), 0.1)
            status, headers, downloaded = await self.file_request(room, token_b, attachment_id=identifier)
            self.assertEqual((status, downloaded), (200, data))
            self.assertEqual(headers['X-Content-Type-Options'], 'nosniff')
            self.assertIn("attachment; filename*=UTF-8''", headers['Content-Disposition'])
            self.assertIn(urllib.parse.quote('資料.pdf'), headers['Content-Disposition'])
            self.assertEqual(headers['Cache-Control'], 'no-store')
            self.assertEqual((await self.file_request(room, token_a, attachment_id=identifier, method='DELETE'))[0], 409)
            self.assertEqual((await self.file_request(room, joined_other['upload_token'], attachment_id=identifier))[0], 401)
            self.assertEqual((await self.file_request(room + '-other', joined_other['upload_token'], attachment_id=identifier))[0], 404)
            late, history = await self.open_chat(room)
            self.assertEqual(history['messages'], [message['message']])
            await late.close()
            await a.close()
            await asyncio.sleep(0.05)
            self.assertEqual((await self.file_request(room, token_a, attachment_id=identifier))[0], 401)
            self.assertEqual((await self.file_request(room, token_b, attachment_id=identifier))[2], data)
        finally:
            await a.close()
            await b.close()
            await other.close()
        await asyncio.sleep(0.05)
        fresh, fresh_joined = await self.open_chat(room)
        try:
            self.assertEqual(fresh_joined['messages'], [])
            self.assertEqual((await self.file_request(room, fresh_joined['upload_token'], attachment_id=identifier))[0], 404)
        finally:
            await fresh.close()

    async def test_attachment_validation_safe_types_and_pending_deletion(self):
        room = uuid.uuid4().hex
        ws, joined = await self.open_chat(room)
        token = joined['upload_token']
        png = base64.b64decode('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aX1sAAAAASUVORK5CYII=')
        try:
            for filename in ['../secret.pdf', 'bad\r\nheader.pdf', '']:
                status, _, body = await self.file_request(room, token, data=b'file', name=filename)
                self.assertEqual((status, json.loads(body)['detail']), (400, 'invalid_file'))
            status, _, body = await self.file_request(room, token, data=b'x', headers={'Content-Length': str(chat.MAX_FILE_SIZE + 1)})
            self.assertEqual((status, json.loads(body)['detail']), (413, 'file_too_large'))
            self.assertEqual((await self.file_request(room, token, data=b''))[0], 400)
            for data, mime, expected in [(png, 'application/octet-stream', 'image/png'),
                                         (b'<svg onload="alert(1)"/>', 'image/png', 'application/octet-stream')]:
                status, _, body = await self.file_request(room, token, data=data, name='photo.png', content_type=mime)
                self.assertEqual(status, 201)
                attachment = json.loads(body)
                self.assertEqual(attachment['content_type'], expected)
                identifier = attachment['id']
                self.assertEqual((await self.file_request(room, token, attachment_id=identifier, method='DELETE'))[0], 204)
                self.assertEqual((await self.file_request(room, token, attachment_id=identifier))[0], 404)
            for identifiers in [['missing'], ['a'] * 6, ['a', 'a'], [42], 'not-a-list']:
                reply = await self.send(ws, 'files', attachment_ids=identifiers)
                self.assertEqual(reply['type'], 'chat_error')
        finally:
            await ws.close()

    async def test_attachment_history_eviction_and_references(self):
        room = uuid.uuid4().hex
        ws, joined = await self.open_chat(room)
        token = joined['upload_token']
        try:
            _, _, body = await self.file_request(room, token, data=b'%PDF-1.7 test')
            attachment = json.loads(body)
            identifier = attachment['id']
            await self.send(ws, 'first use', 'first', attachment_ids=[identifier])
            await self.send(ws, 'second use', 'second', attachment_ids=[identifier])
            for number in range(99):
                await self.send(ws, str(number))
            # Evicting one reference must preserve the second message's attachment.
            self.assertEqual((await self.file_request(room, token, attachment_id=identifier))[0], 200)
            await self.send(ws, 'evict second use')
            self.assertEqual((await self.file_request(room, token, attachment_id=identifier))[0], 404)
            reply = await self.send(ws, 'retry evicted', 'second', attachment_ids=[identifier])
            self.assertEqual(reply['reason'], 'invalid_attachment')
        finally:
            await ws.close()

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


class AttachmentStreamingTests(unittest.IsolatedAsyncioTestCase):
    """Exercise streamed requests and disconnect races with small storage budgets."""

    def setUp(self):
        self.room_id = uuid.uuid4().hex
        self.peer = chat.Peer(ws=None, name='Test', role='candidate')
        self.room = chat.ChatRoom(peers={'sender': self.peer})
        chat._rooms[self.room_id] = self.room

    def tearDown(self):
        chat._remove(self.room_id, self.room, 'sender')
        self.assertEqual(chat._storage, 0)
        self.assertEqual(chat._stored_files, 0)
        self.assertEqual(chat._active_uploads, 0)

    def request(self, chunks, before_chunk=None):
        iterator = iter(chunks)

        async def receive():
            try:
                chunk = next(iterator)
            except StopIteration:
                return {'type': 'http.request', 'body': b'', 'more_body': False}
            if before_chunk:
                await before_chunk()
            return {'type': 'http.request', 'body': chunk, 'more_body': True}

        return Request({'type': 'http', 'headers': [
            (b'authorization', ('Bearer ' + self.peer.upload_token).encode()),
            (b'x-filename', b'stream.bin'),
        ]}, receive)

    async def test_stream_limits_release_partial_uploads(self):
        for limits, expected in [({'MAX_FILE_SIZE': 5}, 'file_too_large'),
                                  ({'MAX_ROOM_STORAGE': 5}, 'room_storage_full'),
                                  ({'MAX_STORAGE': 5}, 'storage_full')]:
            with patch.multiple(chat, **limits):
                with self.assertRaises(HTTPException) as raised:
                    await chat.upload_attachment(self.request([b'1234', b'56']), self.room_id)
                self.assertEqual(raised.exception.detail, expected)
                self.assertEqual(self.room.storage, 0)
                self.assertEqual(chat._storage, 0)
                self.assertEqual(self.room.attachments, {})
                self.assertEqual(self.room.uploads, {})

    async def test_sender_departure_during_upload_releases_memory(self):
        received = 0

        async def disconnect():
            nonlocal received
            received += 1
            if received == 2:
                chat._remove(self.room_id, self.room, 'sender')

        with self.assertRaises(HTTPException) as raised:
            await chat.upload_attachment(self.request([b'1234', b'5678'], disconnect), self.room_id)
        self.assertEqual(raised.exception.detail, 'invalid_session')
        self.assertEqual(self.room.storage, 0)
        self.assertNotIn(self.room_id, chat._rooms)

    async def test_timeout_and_cancelled_request_release_partial_uploads(self):
        for cancel in [False, True]:
            waiting = asyncio.Event()
            chunks_received = 0

            async def stall():
                nonlocal chunks_received
                chunks_received += 1
                if chunks_received == 2:
                    waiting.set()
                    await asyncio.Event().wait()

            with patch.object(chat, 'UPLOAD_TIMEOUT', 1 if cancel else 0.02):
                task = asyncio.create_task(chat.upload_attachment(self.request([b'1234', b'5'], stall), self.room_id))
                await asyncio.wait_for(waiting.wait(), 1)
                self.assertEqual(self.room.storage, 4)
                if cancel:
                    task.cancel()
                    with self.assertRaises(asyncio.CancelledError):
                        await task
                else:
                    with self.assertRaises(HTTPException) as raised:
                        await task
                    self.assertEqual(raised.exception.detail, 'upload_interrupted')
                self.assertEqual(self.room.storage, 0)
                self.assertEqual(chat._storage, 0)
                self.assertEqual(chat._active_uploads, 0)

    async def test_global_storage_is_shared_across_rooms(self):
        another_id = self.room_id + '-another'
        another = chat.ChatRoom(peers={'sender': self.peer})
        chat._rooms[another_id] = another
        try:
            with patch.object(chat, 'MAX_STORAGE', 6):
                await chat.upload_attachment(self.request([b'1234']), self.room_id)
                with self.assertRaises(HTTPException) as raised:
                    await chat.upload_attachment(self.request([b'567']), another_id)
                self.assertEqual(raised.exception.detail, 'storage_full')
                self.assertEqual(another.storage, 0)
                self.assertEqual(chat._storage, 4)
                chat._remove(self.room_id, self.room, 'sender')
                attachment = await chat.upload_attachment(self.request([b'567']), another_id)
                self.assertEqual(attachment['size'], 3)
        finally:
            chat._remove(another_id, another, 'sender')

    async def test_concurrent_uploads_share_capacity_and_expire_pending(self):
        first_waiting, continue_first = asyncio.Event(), asyncio.Event()
        chunks_received = 0

        async def pause_first():
            nonlocal chunks_received
            chunks_received += 1
            if chunks_received == 2:
                first_waiting.set()
                await continue_first.wait()

        with patch.object(chat, 'MAX_ROOM_STORAGE', 7):
            first = asyncio.create_task(chat.upload_attachment(self.request([b'1234', b'5'], pause_first), self.room_id))
            try:
                await asyncio.wait_for(first_waiting.wait(), 1)
                with self.assertRaises(HTTPException) as raised:
                    await chat.upload_attachment(self.request([b'6789']), self.room_id)
                self.assertEqual(raised.exception.detail, 'room_storage_full')
                self.assertEqual(self.room.storage, 4)
            finally:
                continue_first.set()
                attachment = await first
            self.assertEqual(attachment['size'], 5)
            # Pending drafts expire without affecting already posted history.
            self.room.attachments[attachment['id']].created_at -= chat.PENDING_TTL + 1
            next_attachment = await chat.upload_attachment(self.request([b'new']), self.room_id)
            self.assertEqual(self.room.storage, 3)
            self.assertNotIn(attachment['id'], self.room.attachments)
            self.assertIn(next_attachment['id'], self.room.attachments)


if __name__ == '__main__':
    unittest.main()
