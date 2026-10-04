# VITAL ROOM — Web 版（サーバー不要）

**公開ページ: https://haru-ki417.github.io/Harinezumi-AI-Hack/**

VITAL ROOM の計測・練習機能を、サーバーなしでブラウザーだけで動くように移植した版です。
スマホ・タブレット・パソコンでページを開くだけで使えます（インストール・登録不要）。

![ホーム](docs/screenshots/home.jpg)

| ひとりで計測 | ルームで練習（2人） |
|---|---|
| ![計測](docs/screenshots/measure.jpg) | ![ルーム](docs/screenshots/room.jpg) |

| AI面接練習の振り返り | スマートフォン |
|---|---|
| ![振り返り](docs/screenshots/ai-feedback.jpg) | ![スマートフォン](docs/screenshots/phone.jpg) |

※ スクリーンショットのカメラ映像は、動作確認用に NASA のパブリックドメイン写真から作った合成映像（脈拍 75 BPM を埋め込んだもの）です。

## できること

| 画面 | 内容 |
|---|---|
| ひとりで計測 | カメラの映像から心拍（BPM）・心拍変動（RMSSD / SDNN）・平常時と比べたストレス指標を表示。結果は CSV でも保存できます。 |
| ルームで練習 | 2人用ルーム。ルームコードかリンクで招待し、話題（自己紹介・志望動機など）ごとにお互いの心拍の変化を記録します。映像通話つき／数値の共有だけ、を選べます。 |
| AI面接練習 | AI 面接官が質問し、回答に合わせて「理由・結果・学び」などを深掘り。終了後、発言を引用した振り返りと答え方の構成例を作ります。読み上げ・音声入力に対応（文字入力でも可）。 |
| 記録 | 保存した結果をこのブラウザーの中で見返せます（最大 50 件、いつでも削除可）。 |

## しくみ

すべての計算はブラウザーの中で行います。フル版のバックエンド（`backend/`）の処理をそのまま JavaScript に移植しています。

| フル版（Python） | Web 版（JavaScript） | 内容 |
|---|---|---|
| `vital/face.py` | `js/face.js` | 顔検出（Web 版は MediaPipe Face Detector）→ 額・両頬の ROI → YCrCb 肌マスクで平均 RGB |
| `vital/rppg.py` | `js/dsp.js` | POS 法（overlap-add）→ 線形トレンド除去 → 4 次 Butterworth 帯域通過（filtfilt）→ FFT・放物線補間で BPM、SNR から信頼度 |
| `vital/hrv.py` | `js/dsp.js` | ピーク検出（`find_peaks` 相当）→ 拍間隔 → RMSSD / SDNN、ベースライン比のストレス指標 |
| `vital/session.py` | `js/session.js` | 平滑化・外れフレームの除外・平常値の確立・異常判定 |
| `interview_questions.py` | `js/interview.js` | 深掘り質問の選択（同じ観点を繰り返さない・回答拒否や時間切れで次へ） |
| `interview_feedback.py` | `js/interview.js` | 発言の引用にもとづく振り返り（合否・性格・生体情報は使わない） |

移植の正しさは、同じ入力を Python 版と Web 版に与えて比較して確認しました（脈波の差 1e-11 以下、BPM・HRV・状態遷移・質問の選択・振り返りの内容が完全一致）。
`tests/logic.test.mjs` は依存パッケージなしで動く回帰テストです。

```bash
cd vital-room/web
node --test tests/*.test.mjs   # ロジックのテスト
python3 -m http.server 8080    # http://localhost:8080 で確認（カメラは localhost か https で動きます）
```

ビルドは不要です。外部ライブラリはバージョンを固定して CDN から読み込みます（`js/config.js`）。

- MediaPipe Tasks Vision 0.10.21（顔検出。モデルは Google 配布の BlazeFace short range）
- PeerJS 1.5.5（ルームの P2P 接続）

## プライバシー

- カメラ映像は端末の外に送りません。録画もしません。
- ルームでは相手と WebRTC で直接つながります。接続の仲介（シグナリング）にだけ PeerJS の公開サーバーを使い、映像・音声・数値はそこを通りません。自前の PeerServer を使う場合は URL に `?signal=ホスト名:ポート` を付けます。
- AI 面接の音声入力はブラウザーの音声認識機能を使います（Chrome では Google のサーバーで処理されます）。使いたくない場合はオフにして文字で回答できます。
- 記録はこのブラウザーの localStorage にだけ保存されます。

## 制限

- 医療機器ではありません。値は照明・動き・カメラの性能の影響を受ける参考値です。
- 2人とも厳しいファイアウォールの内側にいると P2P 接続できないことがあります（TURN サーバーは使っていません）。その場合はモバイル回線などでお試しください。
- 企業向けの面接管理・招待、AI 音声（OpenAI）などはフル版（`frontend/` + `backend/`）の機能です。

## 公開

`main` に push すると `.github/workflows/web.yml` がテストを実行し、このフォルダーのサイトを `gh-pages` 枝に置きます（GitHub Pages: Deploy from a branch → `gh-pages` / `(root)`）。
