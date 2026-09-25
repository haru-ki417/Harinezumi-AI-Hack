# Stealth Vital API (FastAPI + rPPG)

Webカメラのフレーム(JPEG/Base64)を受け取り、顔の色変化から心拍数(BPM)を
rPPG(remote photoplethysmography)で推定して返すバックエンド。フロントの
`useVitalAPI` が叩く `POST http://localhost:8000/api/vital` を実装している。

## 構成

```
stealth-vital-api/
├── app.py              # FastAPI エントリポイント (/api/vital, /health)
├── requirements.txt
├── test_rppg.py        # 合成信号によるDSPコアの検証（webカメラ不要で実行可）
└── vital/
    ├── rppg.py         # DSPコア: RGB時系列 → BPM (POS法 + バンドパス + FFT)
    ├── face.py         # フレームデコード + 顔ROIのRGB平均抽出 (OpenCV Haar)
    └── session.py      # クライアント別バッファ + 平滑化 + 異常検知
```

## セットアップ & 起動

```bash
cd stealth-vital-api
python -m venv .venv && source .venv/bin/activate   # Windows: .venv\Scripts\activate
pip install -r requirements.txt

uvicorn app:app --host 0.0.0.0 --port 8000 --reload
```

`http://localhost:8000/health` が `{"status":"ok"}` を返せば起動成功。

## テスト（webカメラ不要）

```bash
python test_rppg.py
```

既知BPMを埋めた合成信号で、DSPコアの復元精度・フルパイプライン・異常検知・
サンプリングレート要件を検証する。手元での実測結果:

| 項目 | 結果 |
|---|---|
| DSPコア (60–110 BPM) | 誤差 ≤ 2 BPM |
| JPEG圧縮を通したフルパイプライン (78 BPM) | est 80.1 / 誤差 2.1 |
| 異常検知 | 平常時 誤検知なし / 急上昇で発火 |
| 1fps入力 | 復元不能 (est 47) ← 下記の注意点 |

## ⚠️ フロント側の必須修正：フレームレート

**現状のフロントは `intervalMs: 1000`（1fps）だが、これでは rPPG は原理的に動かない。**
心拍は 0.7–4.0 Hz(42–240 BPM)。ナイキスト定理より取り出すには実効サンプリング
レートが最低でも 8 Hz 必要で、1fps だと 0.5 Hz(30 BPM)までしか表現できない。

`hooks/useWebcam.ts` の呼び出しを変更する:

```ts
// app/page.tsx
useWebcam({ onFrame: sendFrame, intervalMs: 40, quality: 0.6 }); // 25fps
```

- **`intervalMs: 33〜66`（15〜30fps）にすること。** localhost なら 1リクエスト
  ≈ 10–20ms で処理できるので、in-flightガードで多少間引かれても十分な実効fpsが出る
  （サーバは受信時刻でタイムスタンプを打つので、間隔が多少揺れても解析は成立する）。
- ペイロード/CPU削減のため、キャプチャ解像度を 320×240 程度に落とすとより安定する
  （`getUserMedia` の `width/height` を下げる）。

BPMが安定して出るまで **起動後6〜12秒**（解析窓が埋まるまで）かかる。それまでは
`current_bpm: 0` を返す（フロントのバッジは `0` 表示）。

## API

### `WebSocket /ws/chat/{room_id}`

面接ルームへの入室完了後にフロントエンドが接続する、ファイル添付付きのチャット。バイタル用の接続と独立しており、
この接続ではカメラ画像の送信や計測を開始しない。同じルームコードの参加者に配信する。

- 接続直後: `{"type":"join","name":"表示名","role":"candidate","consent":true}`。role は `candidate` / `interviewer`。
- 参加応答: `{"type":"chat_joined","client_id":"...","upload_token":"...","messages":[]}`。直近100件の履歴と、この接続専用の添付アクセス用トークンを含む。
- 送信: `{"type":"chat","request_id":"送信ごとの一意なID","text":"こんにちは","attachment_ids":[]}`。本文は最大2000文字。添付がある場合は本文なしでも送れる。
- 受信: `{"type":"chat_message","message":{"id":"...","request_id":"...","sender_id":"...","name":"...","role":"candidate","text":"こんにちは","attachments":[],"sent_at":"ISO日時"}}`。送信者にも返す。
- エラー: `{"type":"chat_error","reason":"invalid_message"}`。送信者名・ID・日時はサーバーが設定する。

履歴と添付はメモリ上のみで、全員がチャットから退出するかサーバーを再起動すると消える。
現状は単一プロセスで起動すること。複数ワーカー・複数サーバーに分散する場合は共有ストアと配信基盤が必要。

添付APIは、いずれも `Authorization: Bearer <upload_token>` が必要。トークンは発行したチャット接続が有効な間、そのルームでのみ使える。

- `POST /api/chat/{room_id}/attachments`: ファイル本体をそのまま送信し、`X-Filename` に `encodeURIComponent(file.name)` を設定する。応答は HTTP 201 と `{"id":"...","name":"資料.pdf","size":123,"content_type":"application/pdf"}`。得られたIDをチャットの `attachment_ids` に含めて送信する。
- `GET /api/chat/{room_id}/attachments/{id}`: 同じルームで投稿されたファイルを取得する。投稿前のファイルはアップロードした本人のみ取得できる。
- `DELETE /api/chat/{room_id}/attachments/{id}`: 本人がアップロードした未送信ファイルを削除する。成功時は HTTP 204。送信済みファイルは履歴保護のため HTTP 409。

1ファイル10 MiB、1メッセージ5件、ルーム全体50 MiB、サーバー全体200 MiBまで。
空ファイルは拒否する。PNG/JPEG/GIF/WebP/PDF はファイルの先頭データで判定し、それ以外は
`application/octet-stream` としてダウンロードする。指定された拡張子やMIMEだけでは画像として扱わない。
履歴100件から外れたメッセージだけが参照するファイルは削除する。未送信ファイルは本人の退出時に削除し、
10分経過したものは次の添付操作・送信時に削除する。アップロードは60秒で打ち切る。
同時アップロードはサーバー全体16件、ファイル数は全体1000件、未送信ファイルは1接続20件まで。
エラーは `{"detail":"file_too_large"}`（413）、`room_storage_full` / `storage_full`（507）、
`invalid_file`（400/404）、`invalid_session`（401）、`too_many_attachments`（429）などを返す。

`python -m unittest test_chat -v` で配信・ルーム分離・履歴・添付認証・容量制限・途中切断時の解放を確認できる。
ブラウザとの結合テストは `../frontend` で `npm run test:chat` を実行する。
新しいエンドポイントを反映するにはバックエンドを再起動すること。

既存の顔検出で使う `cv2.CascadeClassifier` との互換性のため、依存関係は
`opencv-python>=4.8,<5` としている。更新時は `pip install -r requirements.txt` を実行する。

### `POST /api/vital`

Request:
```json
{ "image_base64": "<data URLプレフィックスを除いた純粋なBase64>" }
```

Response:
```json
{ "current_bpm": 72.3, "is_anomalous": false }
```

- `current_bpm`: 推定心拍数。データ不足/低信頼度の間は `0.0`。
- `is_anomalous`: 直近60秒のBPM中央値(ベースライン)より **+12 BPM以上** 高い状態で `true`。
  信頼度の低いフレームはベースライン更新に使わないため、照明ノイズでの誤発火を抑えている。

顔が検出できないフレームは状態を汚さず直近BPMをそのまま返す（フェイルセーフ）。

## アルゴリズム（vital/rppg.py）

1. クライアント別に直近12秒の顔ROI平均RGBをバッファ
2. 不等間隔の時系列を30Hz一様グリッドへ線形補間
3. **POS法**(Plane-Orthogonal-to-Skin, Wang et al. 2017)で脈波信号を抽出
4. 線形デトレンド → 4次Butterworthバンドパス(0.7–4.0Hz) → Hann窓 → FFT
5. 帯域内スペクトルピーク → BPM。ピークの尖鋭さを信頼度とする
6. EMAで平滑化し、ローリング中央値からの乖離で異常判定

## チューニング（vital/session.py の定数）

| 定数 | 既定 | 意味 |
|---|---|---|
| `WINDOW_SEC` | 12.0 | 解析窓長。長いほど安定、反応は鈍る |
| `MIN_FPS_FOR_HR` | 6.0 | これ未満の実効fpsではBPMを更新しない |
| `CONF_MIN` | 0.15 | スペクトルピークの最小信頼度 |
| `BPM_SMOOTH` | 0.30 | EMA係数。小さいほど滑らか |
| `ANOM_DELTA_BPM` | 12.0 | 異常とみなすベースラインからの上昇幅 |

## 精度の限界（現実的な話）

Webカメラの rPPG は照明・動き・カメラ品質に大きく左右される。顔が動く／逆光／
低フレームレートの環境では BPM が跳ねる。`is_anomalous` を「動揺の検知」として
使うなら、閾値(`ANOM_DELTA_BPM`)と信頼度(`CONF_MIN`)を実環境で調整すること。
医療用途ではない。
