// 外部ライブラリの読み込み先と P2P 接続設定。
// バージョンは固定し、意図しない更新が入らないようにしている。

export const CDN = Object.freeze({
  mediapipe: 'https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@0.10.21',
  faceModel: 'https://storage.googleapis.com/mediapipe-models/face_detector/blaze_face_short_range/float16/1/blaze_face_short_range.tflite',
  peerjs: 'https://cdn.jsdelivr.net/npm/peerjs@1.5.5/dist/peerjs.min.js',
});

// ルームの ID が他アプリと衝突しないよう付ける接頭辞。
export const PEER_PREFIX = 'vitalroom-hnz-';

/**
 * PeerJS の接続先。既定は PeerJS 公開サーバー（接続の仲介のみ。映像・音声・数値は通らない）。
 * 自前の PeerServer を使う場合は URL に ?signal=host:port を付ける。
 */
export function peerOptions() {
  const params = new URLSearchParams(location.search);
  const signal = params.get('signal');
  const options = {
    debug: 0,
    config: {
      iceServers: [
        { urls: 'stun:stun.l.google.com:19302' },
        { urls: 'stun:global.stun.twilio.com:3478' },
      ],
    },
  };
  if (signal && /^[\w.-]+(:\d{2,5})?$/.test(signal)) {
    const [host, port] = signal.split(':');
    const local = host === 'localhost' || host === '127.0.0.1';
    Object.assign(options, { host, port: Number(port || (local ? 9000 : 443)), path: '/', secure: !local });
  }
  return options;
}
