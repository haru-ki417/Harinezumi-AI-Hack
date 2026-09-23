# Vital Room — フロントエンド (Next.js)

同意付き・透明な双方向バイタル共有UI。ロビーで表示名・ルームコード・役割
（面接官/就活生）を入力し、同意チェックの上で参加。カメラから自分の
心拍・HRV・ストレスを算出し、同じルームの相手と数値を互いに共有する
（相手の映像は共有しない）。

## 構成

```
frontend/
├── app/
│   ├── layout.tsx        # タイトル「バイタル共有ルーム」
│   ├── globals.css
│   ├── page.tsx          # ロビー(同意)→ルーム(参加者カード)
│   └── page.module.css
├── hooks/
│   ├── useWebcam.ts      # カメラ→フレームBase64(25fps)
│   ├── useVitalRoom.ts   # /ws/room/{id} クライアント(同意送信・スナップショット受信)
│   ├── useVitalStream.ts # (単体モード用)WS/RESTクライアント・参考
│   └── useVitalAPI.ts    # (旧)REST版・参考
└── types/index.ts
```

## 起動

```bash
cd frontend
npm install
npm run dev        # http://localhost:3000
```

先にバックエンド(:8000)を起動しておくこと。

## 使い方(2人)

2人がそれぞれ `localhost:3000` を開き、**同じルームコード**を入力・役割を選び、
同意して参加。互いのBPM・ストレス・HRVがカードで見える。停止は「退出」。

## 開発コマンド

- `npm run typecheck` : 型チェック
- `npm run lint`      : ESLint

## メモ

送信間隔 `intervalMs: 40`(25fps)。医療用途ではない。
共有されるのは各自が同意したバイタルの数値のみで、相手の映像は送られない。
