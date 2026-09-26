"""Cached display values must never become fresh report measurements."""
from types import SimpleNamespace
import unittest
from unittest.mock import patch

import numpy as np

from vital.config import Settings
from vital.session import ClientState, SessionManager, VitalState


class MeasurementValidityTests(unittest.TestCase):
    def setUp(self):
        self.settings = Settings()
        self.state = ClientState(self.settings)
        for index in range(8):
            self.state.add(9 + index / 10, (80, 90, 100))
        self.state.bpm = 70
        self.state.rmssd = 50
        self.state.bpm_history.extend([(1, 70), (2, 70), (3, 70)])
        self.state.rmssd_history.extend([(1, 50), (2, 50), (3, 50)])
        self.pulse = SimpleNamespace(bpm=78, confidence=0.9, snr_db=4, pulse=np.zeros(100), fs=30)
        self.hrv = SimpleNamespace(rmssd=25, sdnn=30)

    def fresh_state(self):
        with patch("vital.session.compute_pulse", return_value=self.pulse), \
                patch("vital.session.hrv_from_pulse", return_value=self.hrv), \
                patch("vital.session.stress_score", return_value=82):
            return self.state.compute(10)

    def test_success_then_rejected_signal_retains_values_but_marks_invalid(self):
        fresh = self.fresh_state()
        self.assertTrue(fresh.measurement_valid)
        self.assertTrue(fresh.stress_valid)
        self.assertEqual(fresh.stress, 82)
        self.assertTrue(fresh.as_dict()["measurement_valid"])
        self.assertTrue(fresh.as_dict()["stress_valid"])
        for result in (None, SimpleNamespace(bpm=78, confidence=0.1, snr_db=4),
                       SimpleNamespace(bpm=78, confidence=0.9, snr_db=-5)):
            with self.subTest(result=result), patch("vital.session.compute_pulse", return_value=result):
                rejected = self.state.compute(11)
            self.assertEqual(rejected.current_bpm, fresh.current_bpm)
            self.assertEqual(rejected.stress, fresh.stress)
            self.assertEqual(rejected.confidence, fresh.confidence)
            self.assertFalse(rejected.measurement_valid)
            self.assertFalse(rejected.stress_valid)
            self.assertFalse(rejected.is_anomalous)

    def test_peek_for_missing_face_marks_cached_measurement_invalid(self):
        fresh = self.fresh_state()
        manager = SessionManager(self.settings)
        manager._clients["participant"] = self.state
        cached = manager.peek("participant")
        self.assertEqual(cached.current_bpm, fresh.current_bpm)
        self.assertEqual(cached.stress, fresh.stress)
        self.assertFalse(cached.measurement_valid)
        self.assertFalse(cached.stress_valid)

    def test_accepted_bpm_without_fresh_hrv_cannot_reuse_old_stress(self):
        self.state.stress = 90
        with patch("vital.session.compute_pulse", return_value=self.pulse), \
                patch("vital.session.hrv_from_pulse", return_value=None), \
                patch("vital.session.stress_score") as stress_score:
            result = self.state.compute(10)
        stress_score.assert_not_called()
        self.assertTrue(result.measurement_valid)
        self.assertFalse(result.stress_valid)
        self.assertEqual(result.stress, 90)
        self.assertFalse(result.is_anomalous)

    def test_fresh_bpm_and_hrv_without_baselines_cannot_measure_stress(self):
        self.state.bpm_history.clear()
        self.state.rmssd_history.clear()
        with patch("vital.session.compute_pulse", return_value=self.pulse), \
                patch("vital.session.hrv_from_pulse", return_value=self.hrv), \
                patch("vital.session.stress_score") as stress_score:
            result = self.state.compute(10)
        stress_score.assert_not_called()
        self.assertTrue(result.measurement_valid)
        self.assertFalse(result.stress_valid)

    def test_warmup_and_low_frame_rate_are_invalid(self):
        self.assertFalse(VitalState().measurement_valid)
        warmup = ClientState(self.settings).compute(1)
        self.assertFalse(warmup.measurement_valid)
        self.assertFalse(warmup.stress_valid)
        self.state.buf.clear()
        for index in range(8):
            self.state.add(index, (80, 90, 100))
        with patch("vital.session.compute_pulse", return_value=self.pulse):
            low_fps = self.state.compute(8)
        self.assertFalse(low_fps.measurement_valid)
        self.assertFalse(low_fps.stress_valid)


if __name__ == "__main__":
    unittest.main()
