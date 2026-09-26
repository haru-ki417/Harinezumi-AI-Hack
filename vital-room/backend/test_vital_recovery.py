"""Managed camera frames exercise JPEG, tracked ROI, BPM and stress together."""
import gc
import unittest
from unittest.mock import Mock, patch

import numpy as np

import hiring_live as live
from test_rppg import make_frame
from vital import SessionManager, load_settings
from vital.face import _TRACKS, face_roi_rgb


class VitalRecoveryTests(unittest.TestCase):
    def test_small_seated_face_is_detected_in_camera_thumbnail(self):
        def detect(gray, **options):
            return [(110, 50, 60, 60)] if options['minSize'][0] <= 60 else []

        with patch('vital.face._CASCADE', Mock(detectMultiScale=detect)):
            self.assertIsNotNone(face_roi_rgb(np.full((180, 320, 3), (100, 128, 130), dtype=np.uint8)))

    def test_managed_jpeg_frames_produce_bpm_and_stress_with_isolated_tracking(self):
        manager = SessionManager(load_settings())
        other = SessionManager(load_settings())
        self.assertNotEqual(manager.roi_key, other.roi_key)
        key = manager.roi_key
        detector = Mock(return_value=[(100, 50, 60, 60)])
        first_bpm = first_stress = None
        phase = 0.0
        with patch.object(live, '_mesh_roi', None), patch('vital.face._CASCADE', Mock(detectMultiScale=detector)):
            for index in range(20 * 48):
                t = index / 20
                phase += 2 * np.pi * (1.2 + 0.05 * np.sin(2 * np.pi * 0.1 * t)) / 20
                values = live._analyze_frame(manager, 'candidate', make_frame(128 + 8 * np.sin(phase)), t)
                if values['measurement_valid'] and first_bpm is None:
                    first_bpm = t
                if values['stress_valid'] and first_stress is None:
                    first_stress = t
        self.assertIsNotNone(first_bpm)
        self.assertLess(first_bpm, 8)
        self.assertIsNotNone(first_stress)
        self.assertAlmostEqual(values['current_bpm'], 72, delta=5)
        self.assertTrue(values['stress_valid'])
        self.assertGreaterEqual(values['stress'], 0)
        self.assertLessEqual(values['stress'], 100)
        self.assertLess(detector.call_count, 200)
        self.assertIn(key, _TRACKS)
        self.assertNotIn(other.roi_key, _TRACKS)
        del manager
        gc.collect()
        self.assertNotIn(key, _TRACKS)


if __name__ == '__main__':
    unittest.main()
