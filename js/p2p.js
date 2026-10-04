// 2人用ルームの P2P 接続（PeerJS / WebRTC）。
// ホストはルームコードから決まる ID で待ち受け、ゲストはその ID に接続する。
// 映像・音声・データ（数値・話題・チャット）は相手の端末と直接やり取りする。

import { CDN, PEER_PREFIX, peerOptions } from './config.js';

const CODE_CHARS = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';

export function randomCode() {
  const a = new Uint32Array(6);
  crypto.getRandomValues(a);
  return Array.from(a, (v) => CODE_CHARS[v % CODE_CHARS.length]).join('');
}

export function normalizeCode(text) {
  return String(text || '').toUpperCase().replace(/[^A-Z0-9]/g, '').slice(0, 6);
}

let peerLoading = null;
function loadPeerJs() {
  if (window.Peer) return Promise.resolve(window.Peer);
  if (!peerLoading) {
    peerLoading = new Promise((resolve, reject) => {
      const s = document.createElement('script');
      s.src = CDN.peerjs;
      s.crossOrigin = 'anonymous';
      s.onload = () => resolve(window.Peer);
      s.onerror = () => { peerLoading = null; reject(new Error('PeerJS を読み込めませんでした')); };
      document.head.append(s);
    });
  }
  return peerLoading;
}

const ERRORS = {
  'peer-unavailable': 'ルームが見つかりません。コードを確認するか、相手にルームを開いてもらってください。',
  'unavailable-id': 'このコードのルームはすでに開かれています。',
  network: 'ネットワークに接続できません。通信環境を確認してください。',
  'server-error': '接続の仲介サーバーに接続できません。しばらくしてからお試しください。',
  'socket-error': '接続の仲介サーバーとの通信が切れました。',
  'socket-closed': '接続の仲介サーバーとの通信が切れました。',
  'browser-incompatible': 'このブラウザーは P2P 通信に対応していません。',
  webrtc: '相手との直接接続を確立できませんでした。別のネットワーク（モバイル回線など）でお試しください。',
};

export function p2pErrorMessage(err) {
  return ERRORS[err?.type] || err?.message || '接続できませんでした。';
}

/**
 * events: onStatus(text, kind) / onPartner(info|null) / onMessage(msg) / onRemoteStream(stream|null) / onError(message, fatal)
 */
export class RoomLink {
  constructor({ code, host, stream, hello, events }) {
    this.code = code;
    this.host = host;
    this.stream = stream;
    this.hello = hello;
    this.ev = events;
    this.peer = null;
    this.conn = null;
    this.call = null;
    this.closed = false;
    this.lastSeen = 0;
    this.pingTimer = 0;
  }

  get hostId() { return PEER_PREFIX + this.code; }

  async open() {
    const Peer = await loadPeerJs();
    const opts = peerOptions();
    await new Promise((resolve, reject) => {
      this.peer = this.host ? new Peer(this.hostId, opts) : new Peer(opts);
      const onFirstError = (err) => reject(err);
      this.peer.once('open', () => { this.peer.off('error', onFirstError); resolve(); });
      this.peer.once('error', onFirstError);
    });
    this.peer.on('error', (err) => this._error(err));
    this.peer.on('disconnected', () => {
      if (this.closed) return;
      // 仲介サーバーとの接続だけが切れた状態。相手との通信は続くので再接続を試みる。
      setTimeout(() => { if (!this.closed && this.peer && this.peer.disconnected) this.peer.reconnect(); }, 1500);
    });
    if (this.host) {
      this.peer.on('connection', (conn) => this._accept(conn));
      this.peer.on('call', (call) => this._answer(call));
      this.ev.onStatus('相手の参加を待っています', 'wait');
    } else {
      this.ev.onStatus('ルームに接続しています…', 'wait');
      this._connectToHost();
    }
    this.pingTimer = setInterval(() => this._ping(), 4000);
  }

  _connectToHost() {
    const conn = this.peer.connect(this.hostId, { reliable: true, serialization: 'json' });
    this._wire(conn);
  }

  /** ゲストから発信する（ホストは応答のみ）。双方が通話を選んだときだけ。 */
  _maybeCall(partner) {
    if (this.host || !this.hello.media || !partner.media || this.call) return;
    const call = this.peer.call(this.hostId, this.stream);
    if (call) this._wireCall(call);
  }

  _accept(conn) {
    if (this.conn && this.conn.open) {
      conn.on('open', () => { conn.send({ type: 'full' }); setTimeout(() => conn.close(), 500); });
      return;
    }
    this._wire(conn);
  }

  _answer(call) {
    if (!this.hello.media || !this.conn || call.peer !== this.conn.peer) { call.close(); return; }
    this.call?.close();
    call.answer(this.stream);
    this._wireCall(call);
  }

  _wire(conn) {
    this.conn = conn;
    conn.on('open', () => {
      this.lastSeen = Date.now();
      conn.send({ type: 'hello', ...this.hello });
      this.ev.onStatus('接続しました', 'ok');
    });
    conn.on('data', (msg) => {
      this.lastSeen = Date.now();
      if (!msg || typeof msg !== 'object' || typeof msg.type !== 'string') return;
      if (msg.type === 'ping') return;
      if (msg.type === 'full') { this.ev.onError('このルームはすでに2人が参加しています。', true); this.close(); return; }
      if (msg.type === 'hello') { const info = sanitizeHello(msg); this.ev.onPartner(info); this._maybeCall(info); }
      this.ev.onMessage(msg);
    });
    conn.on('close', () => {
      if (this.conn !== conn) return;
      this.conn = null;
      this.ev.onPartner(null);
      this.ev.onRemoteStream(null);
      this.call?.close(); this.call = null;
      if (!this.closed) this.ev.onStatus(this.host ? '相手が退出しました。再参加を待っています' : 'ホストとの接続が切れました', 'warn');
    });
    conn.on('error', (err) => this._error(err));
  }

  _wireCall(call) {
    this.call = call;
    call.on('stream', (remote) => this.ev.onRemoteStream(remote));
    call.on('close', () => { if (this.call === call) { this.call = null; this.ev.onRemoteStream(null); } });
    call.on('error', (err) => this._error(err));
  }

  _ping() {
    if (!this.conn || !this.conn.open) return;
    try { this.conn.send({ type: 'ping' }); } catch { /* noop */ }
    const quiet = Date.now() - this.lastSeen;
    if (quiet > 15000) this.ev.onStatus('相手との通信が不安定です', 'warn');
  }

  _error(err) {
    if (this.closed) return;
    const fatal = ['peer-unavailable', 'unavailable-id', 'browser-incompatible', 'invalid-id', 'ssl-unavailable'].includes(err?.type)
      && !(this.conn && this.conn.open);
    this.ev.onError(p2pErrorMessage(err), fatal);
  }

  send(msg) {
    if (this.conn && this.conn.open) {
      try { this.conn.send(msg); return true; } catch { return false; }
    }
    return false;
  }

  get connected() { return !!(this.conn && this.conn.open); }

  /** 映像トラックを差し替える（カメラ切り替え時）。 */
  replaceStream(stream) {
    this.stream = stream;
    const pc = this.call?.peerConnection;
    if (!pc) return;
    for (const sender of pc.getSenders()) {
      const track = stream.getTracks().find((t) => t.kind === sender.track?.kind);
      if (track) sender.replaceTrack(track).catch(() => {});
    }
  }

  close() {
    if (this.closed) return;
    this.closed = true;
    clearInterval(this.pingTimer);
    try { this.send({ type: 'bye' }); } catch { /* noop */ }
    try { this.call?.close(); } catch { /* noop */ }
    try { this.conn?.close(); } catch { /* noop */ }
    try { this.peer?.destroy(); } catch { /* noop */ }
  }
}

function sanitizeHello(msg) {
  return {
    name: String(msg.name || '参加者').slice(0, 20),
    role: msg.role === 'interviewer' ? 'interviewer' : 'candidate',
    share: !!msg.share,
    media: !!msg.media,
  };
}
