"""
rPPGコア/HRV/セッションの実測テスト(合成信号)。webカメラ不要。

  1. DSPコア: 既知BPMをRGB時系列から±3BPMで復元
  2. フルパイプライン: JPEG符号化→デコード→ROI→BPM
  3. HRV: 脈波からmean_hr/rmssdを妥当に算出
  4. ストレススコア: 単調性(HR上昇/RMSSD低下でスコア増)
  5. 異常検知(セッション): 平常→急上昇でis_anomalous
  6. ナイキスト: 1fpsでは復元不能(フレームレート要件の根拠)
"""
import base64
from unittest.mock import Mock, patch

import cv2
import numpy as np

from vital.config import load_settings
from vital.hrv import hrv_from_pulse, stress_score
from vital.rppg import compute_pulse, estimate_bpm
from vital.session import SessionManager


def synth_rgb(bpm, fps, seconds, noise=0.5, amp=6.0, seed=0):
    rng = np.random.default_rng(seed)
    n = int(fps * seconds)
    t = np.arange(n) / fps
    f = bpm / 60.0
    pulse = amp * np.sin(2 * np.pi * f * t)
    drift = 3.0 * np.sin(2 * np.pi * 0.2 * t)
    r = 130 + 0.2 * pulse + drift + rng.normal(0, noise, n)
    g = 128 + 1.0 * pulse + drift + rng.normal(0, noise, n)
    b = 100 + 0.1 * pulse + drift + rng.normal(0, noise, n)
    return t, np.stack([r, g, b], axis=1)


def make_frame(green_value, size=(240, 320)):
    H, W = size
    img = np.full((H, W, 3), 60, dtype=np.uint8)
    cy0, cy1 = 0, H
    cx0, cx1 = 0, W
    img[cy0:cy1, cx0:cx1, 0] = 100
    img[cy0:cy1, cx0:cx1, 1] = int(np.clip(green_value, 0, 255))
    img[cy0:cy1, cx0:cx1, 2] = 130
    ok, buf = cv2.imencode(".jpg", img, [cv2.IMWRITE_JPEG_QUALITY, 85])
    assert ok
    return base64.b64encode(buf.tobytes()).decode()


def _pulse_rgb(f, tt, amp=10.0):
    pulse = amp * np.sin(2 * np.pi * f * tt)
    return (130 + 0.2 * pulse, 128 + 1.0 * pulse, 100 + 0.1 * pulse)


def test_dsp_core():
    print("\n[1] DSPコア: 既知BPMの復元 (overlap-add POS)")
    for true_bpm in (60, 72, 90, 110):
        t, rgb = synth_rgb(true_bpm, fps=30, seconds=12)
        est, conf = estimate_bpm(t, rgb)
        err = abs(est - true_bpm)
        status = "OK " if err <= 3.0 else "NG "
        print(f"   {status} true={true_bpm:3d} est={est:6.1f} err={err:4.1f} conf={conf:.3f}")
        assert err <= 3.0, f"BPM復元誤差: {err:.1f}"


def test_full_pipeline():
    print("\n[2] フルパイプライン: JPEG→デコード→ROI→BPM")
    from vital.face import face_roi_rgb
    s = load_settings()
    mgr = SessionManager(s)
    true_bpm, fps, seconds = 78, 25, 14
    n = int(fps * seconds)
    f = true_bpm / 60.0
    last = None
    for i in range(n):
        tt = i / fps
        green = 128 + 12.0 * np.sin(2 * np.pi * f * tt)
        b64 = make_frame(green)
        img = cv2.imdecode(np.frombuffer(base64.b64decode(b64), np.uint8), cv2.IMREAD_COLOR)
        # Synthetic colors have no real face. Exercise JPEG + ROI processing
        # with a known detector rectangle, never a production no-face fallback.
        with patch('vital.face._CASCADE', Mock(detectMultiScale=Mock(return_value=[(0, 0, 320, 240)]))):
            rgb = face_roi_rgb(img)
        assert rgb is not None
        last = mgr.process("c", tt, rgb)
    err = abs(last.current_bpm - true_bpm)
    print(f"   true={true_bpm} est={last.current_bpm:.1f} err={err:.1f} "
          f"conf={last.confidence:.3f} eff_fps={last.eff_fps:.1f}")
    assert err <= 4.0, f"パイプライン復元誤差: {err:.1f}"
    print("   OK")


def test_hrv():
    print("\n[3] HRV: 脈波からmean_hr/rmssd")
    # わずかに周波数変調した脈波(拍間隔にゆらぎ)
    fps, seconds, base_bpm = 30, 20, 72
    n = int(fps * seconds)
    t = np.arange(n) / fps
    f = base_bpm / 60.0
    inst = f + 0.05 * np.sin(2 * np.pi * 0.1 * t)   # ゆっくりした心拍ゆらぎ
    phase = 2 * np.pi * np.cumsum(inst) / fps
    pulse = np.sin(phase)
    res = compute_pulse(t, np.stack([130 + 0.2 * pulse, 128 + pulse, 100 + 0.1 * pulse], axis=1))
    assert res is not None
    hrv = hrv_from_pulse(res.pulse, res.fs)
    assert hrv is not None, "HRVが算出できない"
    print(f"   mean_hr={hrv.mean_hr:.1f} rmssd={hrv.rmssd:.1f}ms sdnn={hrv.sdnn:.1f}ms beats={hrv.n_beats}")
    assert abs(hrv.mean_hr - base_bpm) <= 6, "HRがずれすぎ"
    assert hrv.rmssd > 0 and hrv.sdnn > 0
    print("   OK")


def test_stress_monotonic():
    print("\n[4] ストレススコア: 単調性")
    base_hr, base_rmssd = 70.0, 50.0
    calm = stress_score(70, 50, base_hr, base_rmssd)
    tense = stress_score(88, 25, base_hr, base_rmssd)   # HR上昇+RMSSD低下
    print(f"   calm={calm}  tense={tense}")
    assert calm < tense
    assert 0 <= calm <= 100 and 0 <= tense <= 100
    assert tense >= 55, "強い緊張がしきい値未満"
    print("   OK")


def test_anomaly_session():
    print("\n[5] 異常検知(セッション): 平常→急上昇")
    s = load_settings()
    mgr = SessionManager(s)
    fps = 15
    f_base, f_high = 70 / 60.0, 100 / 60.0
    flagged_calm = False
    flagged_spike = False
    n_base = fps * 40
    n_high = fps * 12
    for i in range(n_base):
        tt = i / fps
        st = mgr.process("c", tt, _pulse_rgb(f_base, tt))
        if tt > 15 and st.is_anomalous:
            flagged_calm = True
    t_off = n_base / fps
    for i in range(n_high):
        tt = t_off + i / fps
        st = mgr.process("c", tt, _pulse_rgb(f_high, tt))
        if st.is_anomalous:
            flagged_spike = True
    print(f"   平常時に誤検知なし: {not flagged_calm} / 急上昇で検知: {flagged_spike}")
    print(f"   最終: bpm={st.current_bpm} stress={st.stress} rmssd={st.hrv_rmssd}")
    assert not flagged_calm, "平常時に誤検知"
    assert flagged_spike, "急上昇を検知できず"
    print("   OK")


def test_nyquist():
    print("\n[6] ナイキスト: 1fpsでは復元不能")
    t, rgb = synth_rgb(72, fps=1, seconds=15)
    est, _ = estimate_bpm(t, rgb)
    t2, rgb2 = synth_rgb(72, fps=20, seconds=15)
    est2, _ = estimate_bpm(t2, rgb2)
    print(f"   1fps est={est:.1f} (誤り想定) / 20fps est={est2:.1f} (正)")
    assert abs(est2 - 72) <= 3.0
    assert abs(est - 72) > 5.0
    print("   OK  (送信間隔は33〜66ms/15〜30fps)")


if __name__ == "__main__":
    test_dsp_core()
    test_full_pipeline()
    test_hrv()
    test_stress_monotonic()
    test_anomaly_session()
    test_nyquist()
    print("\n=== 全テスト通過 ===")
