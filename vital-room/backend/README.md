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
