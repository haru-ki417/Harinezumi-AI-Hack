# Vital Room — 非接触バイタルの透明な共有

企業による対人・AI面接、応募者別の招待、根拠付きの面接集計については
[企業向け面接の使い方](INTERVIEWS.md)を参照してください。企業画面は `/company`、応募者の参加画面は `/interviews/join` です。

> **ブラウザーだけで試せる Web 版**: https://haru-ki417.github.io/Harinezumi-AI-Hack/
> サーバー不要でスマホ・タブレット・パソコンから使えます（ひとりで計測・2人のルーム練習・AI面接練習）。
> 信号処理と面接ロジックを JavaScript に移植したもので、詳細は [web/README.md](web/README.md) を参照してください。

Webカメラ映像から **rPPG (remote photoplethysmography)** で心拍数(BPM)・
心拍変動(HRV)・ストレスの目安をリアルタイム推定し、**全員が同意した上で**
互いに数値を共有する双方向ルーム。面接官・就活生のどちらの役割でも使える。

> 医療機器ではありません。模擬面接・研究・ウェルネス/自己分析用途を想定。
> 相手の映像は共有せず、共有するのは各自が同意したバイタルの数値のみ。

## 設計の前提（同意と透明性）

- 参加前に**同意画面**があり、何を測り・誰に見えるかを明示。同意しないと参加不可
  （サーバも `consent:true` が無い参加を拒否）。
- 各参加者は**自分のカメラから自分のバイタル**だけを算出。相手の顔を測ったり
  録画したりはしない。
- ルーム内では全員のバイタルが**互いに見える**（＝透明）。常時「計測・共有中」を表示。
- いつでも「退出」で停止。

## アーキテクチャ

```
  ┌──────────────┐  25fps JPEG(WS)     ┌──────────────────────────┐
  │ Frontend      │ ─ {type:frame} ───▶ │ Backend (FastAPI)         │
  │ Next.js       │                     │  face ROI → POS(rPPG)     │
  │ 同意→ルーム    │ ◀ {type:room,       │  → bandpass → FFT → BPM   │
  │ 参加者カード    │    participants:[…]}│  → peaks → IBI → HRV      │
  └──────────────┘  (全員のバイタル)     │  → baseline比 → stress    │
                                        │  RoomManager: 同意/配信    │
                                        └──────────────────────────┘
```

信号処理(backend/vital): `face.py`(肌マスク+額/頬ROI) → `rppg.py`(overlap-add POS→
bandpass→FFT、信頼度/SNR) → `hrv.py`(ピーク→IBI→RMSSD/SDNN、ストレス0–100) →
`session.py`(平滑化・異常判定) → `rooms.py`(同意付きルーム、全員へ配信)。
`face_mesh.py` は任意の高精度ROI(要 `pip install mediapipe`)。

## エンドポイント

| 種別 | パス | 用途 |
|---|---|---|
| REST | `POST /api/vital` | 単体(セルフ)の1フレーム推定 |
| WS | `/ws/vital` | 単体(セルフ)のストリーム |
| WS | `/ws/room/{room_id}` | **同意付き双方向ルーム** |
| GET | `/health` | 疎通確認 |

ルームWSの手順: `{"type":"join","role":"interviewer|candidate","name":"…","consent":true}`
を送って参加 → `{"type":"frame","image_base64":"…"}` を送信 → サーバが
`{"type":"room","participants":[{client_id,role,name,vitals}]}` を全員へ配信。

## クイックスタート

### A. スクリプト(Windows)
```powershell
cd C:\Users\haruk\source\stealth-vital
powershell -ExecutionPolicy Bypass -File .\dev.ps1
```
### B. Docker
```bash
docker compose up --build     # frontend :3000 / backend :8000
```
### C. 手動
```bash
cd backend && python -m venv .venv && . .venv/bin/activate  # Win: .venv\Scripts\activate
pip install -r requirements.txt && uvicorn app:app --port 8000 --reload
cd frontend && npm install && npm run dev
```

## 2人で使う

1. 先にバックエンド(:8000)を起動。
2. 同じPCの別ブラウザーでは、開発時は `http://localhost:3001`、Docker・共有サービスでは `http://localhost:3000` を開く。別PC・スマートフォンから採用面接に参加する場合は、[共有URLの起動手順](INTERVIEWS.md#別のpcスマートフォンへ招待する)に従い、同じHTTPS URLを開く。
3. **同じルームコード**を入力し、役割（面接官/就活生）を選び、同意して参加。
4. 互いのBPM・ストレス・HRVがカードで見える。停止は「退出」。

※ 同一PCの2タブでも動作確認は可能（カメラは1つを共有）。

## 出力指標

| 項目 | 意味 |
|---|---|
| `current_bpm` | 推定心拍数(BPM) |
| `hrv_rmssd`/`hrv_sdnn` | 心拍変動(ms)。緊張でRMSSDが低下 |
| `stress` | 平常比のストレス 0–100 |
| `confidence`/`snr_db` | スペクトル信頼度 / 帯域SNR |
| `is_anomalous` | 平常比の急変で true(カードに「変化あり」表示) |

## 開発

- テスト: `cd backend && python test_rppg.py && python test_rooms.py`
- Lint/型: backend `ruff check . && mypy vital` / frontend `npm run lint && npm run typecheck`
- CI: ルートの `ci-workflow.yml` を `.github/workflows/ci.yml` に置く

`npm run dev` は `http://localhost:3001` で起動し、`.next-dev` を使用します。別端末向けの共有サービスは `3000` ポートと専用の世代別ビルドを使います。共有中の画面更新は `Update-SharedInterview.ps1` で行ってください。詳しい手順は [企業向け面接の共有手順](INTERVIEWS.md#別のpcスマートフォンへ招待する) を参照してください。

## チューニング

環境変数 `STEALTH_VITAL_*`(`backend/vital/config.py`): `ANOM_DELTA_BPM` /
`CONF_MIN` / `STRESS_ANOM_THRESHOLD` / `WINDOW_SEC` など。

## 精度の限界

rPPG は照明・動き・カメラ品質に敏感で、HRVは時間分解能の制約から近似値。
妥当性を示すならパルスオキシメーター等を正解値に「±X BPM」を実測して記載するのが最良。
