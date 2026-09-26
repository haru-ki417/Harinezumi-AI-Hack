"""Exercise the camera ingest path with the burst delivery of a public tunnel."""
import asyncio
import threading
import unittest
from types import SimpleNamespace
from unittest.mock import Mock, patch

import numpy as np
from fastapi import HTTPException

import hiring
import hiring_live as live
import test_hiring_vitals as fixtures
from test_rppg import make_frame
from vital.rppg import _pos_overlap_add


class VitalTransportTests(unittest.IsolatedAsyncioTestCase):
    setUp = fixtures.HiringVitalTests.setUp
    asyncTearDown = fixtures.HiringVitalTests.asyncTearDown
    fixture = fixtures.HiringVitalTests.fixture
    consent = fixtures.HiringVitalTests.consent
    values = fixtures.HiringVitalTests.values

    async def drain(self, peer):
        while peer.frame_task is not None:
            await peer.frame_task

    async def test_bursts_preserve_camera_cadence_and_deliver_both_measurements(self):
        room, host, candidate = self.fixture()
        await self.consent(room, candidate)
        clock = 1000.0
        phase = 0.0
        with patch.object(live, 'time', SimpleNamespace(monotonic=lambda: clock)), \
                patch.object(live, '_mesh_roi', None), \
                patch('vital.face._CASCADE', Mock(detectMultiScale=Mock(return_value=[(100, 50, 60, 60)]))), \
                patch.object(hiring, '_snapshot', side_effect=AssertionError('frame path must not build reports')):
            # Four 20fps frames arriving at once: the old arrival-time throttle
            # retained only one (=5fps), so neither BPM nor stress ever appeared.
            for batch in range(240):
                clock = 1000 + batch * 0.2
                for index in range(4):
                    captured = batch * 0.2 + index * 0.05
                    phase += 2 * np.pi * (1.2 + 0.05 * np.sin(2 * np.pi * 0.1 * captured)) / 20
                    await live._vital_message(room, candidate, {
                        'type': 'frame', 'captured_at': captured,
                        'image_base64': make_frame(128 + 8 * np.sin(phase)),
                    })
                await self.drain(candidate)
        samples = [event['vitals'] for event in host.ws.sent if event['type'] == 'vitals']
        self.assertTrue(any(v['measurement_valid'] for v in samples))
        self.assertTrue(any(v['stress_valid'] for v in samples))
        self.assertAlmostEqual(samples[-1]['current_bpm'], 72, delta=5)
        self.assertAlmostEqual(samples[-1]['eff_fps'], 20, delta=0.1)

    async def test_timestamp_validation_queue_bound_and_withdrawal(self):
        room, _, candidate = self.fixture()
        await self.consent(room, candidate)
        for invalid in (True, '1', float('nan'), float('inf'), -1):
            with self.assertRaises(HTTPException):
                await live._vital_message(room, candidate, {'type': 'frame', 'captured_at': invalid, 'image_base64': 'frame'})
        release = threading.Event()
        analyzed = []

        def blocked(*args):
            analyzed.append(args[-1])
            release.wait(2)
            return self.values()

        with patch.object(live, '_analyze_frame', side_effect=blocked), \
                patch.object(live, 'time', SimpleNamespace(monotonic=lambda: 1000)):
            try:
                for stamp in [0, 0, 10000, -1] + [i / 25 for i in range(1, 30)]:
                    if stamp < 0:
                        continue
                    await live._vital_message(room, candidate, {'type': 'frame', 'captured_at': stamp, 'image_base64': 'frame'})
                self.assertLessEqual(len(candidate.pending_frames), live.MAX_PENDING_FRAMES)
                self.assertLessEqual(candidate.last_capture, 0.5)
                await self.consent(room, candidate, False)
                self.assertFalse(candidate.pending_frames)
            finally:
                release.set()
                await self.drain(candidate)
        self.assertLessEqual(len(analyzed), 1)


class PosEquivalenceTests(unittest.TestCase):
    def test_vectorized_pos_matches_original_window_algorithm(self):
        rng = np.random.default_rng(42)
        for fs, count in [(20, 400), (30, 600), (10, 45)]:
            rgb = 100 + rng.normal(size=(count, 3))
            expected = np.zeros(count)
            wl = min(count, max(8, round(1.6 * fs)))
            for index in range(count - wl + 1):
                c = rgb[index:index + wl]
                cn = c / (c.mean(axis=0) + 1e-9)
                s1 = cn[:, 1] - cn[:, 2]
                s2 = -2 * cn[:, 0] + cn[:, 1] + cn[:, 2]
                h = s1 + (s1.std() + 1e-9) / (s2.std() + 1e-9) * s2
                expected[index:index + wl] += h - h.mean()
            np.testing.assert_allclose(_pos_overlap_add(rgb, fs), expected, atol=1e-12)


if __name__ == '__main__':
    unittest.main()
