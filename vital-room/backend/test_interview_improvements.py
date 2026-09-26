import os
import unittest
from datetime import timedelta
from unittest.mock import patch

import numpy as np

import hiring
from hiring_rtc import ice_servers
import test_hiring
from vital.config import Settings
from vital.face import face_roi_rgb
from vital.hrv import hrv_from_pulse
from vital.rppg import compute_pulse
from vital.session import ClientState


def synthetic(bpm=72, fps=20, seconds=20):
    times = np.arange(0, seconds, 1 / fps)
    pulse = np.sin(2 * np.pi * bpm / 60 * times)
    rgb = np.column_stack((120 + 0.4 * pulse, 90 + 2 * pulse, 70 + 0.2 * pulse))
    return times, rgb


class SignalQualityTests(unittest.TestCase):
    def test_known_pulse_with_irregular_frames(self):
        for bpm in [60, 72, 90, 110]:
            times, rgb = synthetic(bpm)
            keep = np.ones(len(times), dtype=bool)
            keep[::11] = False
            result = compute_pulse(times[keep], rgb[keep])
            self.assertIsNotNone(result)
            self.assertAlmostEqual(result.bpm, bpm, delta=2)

    def test_low_fps_gaps_invalid_timing_and_short_windows_rejected(self):
        for fps, seconds in [(6, 20), (20, 3)]:
            self.assertIsNone(compute_pulse(*synthetic(fps=fps, seconds=seconds)))
        times, rgb = synthetic()
        for broken in [np.where(times > 10, times + 1, times), times[::-1], np.full(len(times), np.nan)]:
            self.assertIsNone(compute_pulse(broken, rgb))
        self.assertIsNone(compute_pulse(times, np.zeros_like(rgb)))

    def test_no_face_and_overexposed_image_produce_no_measurement(self):
        for value in [0, 120, 255]:
            self.assertIsNone(face_roi_rgb(np.full((240, 320, 3), value, dtype=np.uint8)))

    def test_constant_intervals_have_low_hrv_and_short_hrv_is_rejected(self):
        times = np.arange(0, 20, 1 / 20)
        pulse = np.sin(2 * np.pi * 1.23 * times)
        result = hrv_from_pulse(pulse, 20)
        self.assertIsNotNone(result)
        self.assertLess(result.rmssd, 2)
        self.assertIsNone(hrv_from_pulse(pulse[:160], 20))

    def test_light_jump_and_frame_gap_reset_calibration(self):
        state = ClientState(Settings())
        for t, rgb in zip(*synthetic()):
            state.add(t, tuple(rgb))
        state.bpm_history.append((1, 72))
        state.add(21, (120, 90, 70))
        self.assertEqual(len(state.buf), 1)
        self.assertFalse(state.bpm_history)
        state.add(21.05, (180, 160, 150))
        self.assertEqual(len(state.buf), 1)

    def test_turn_credentials_are_temporary_and_secret_is_not_exposed(self):
        with patch.dict(os.environ, {'HIRING_TURN_URLS': 'turn:relay.example:3478,turns:relay.example:5349', 'HIRING_TURN_SECRET': 'private-secret'}):
            config = ice_servers('room1', 'candidate')
        self.assertEqual(len(config), 2)
        self.assertNotIn('private-secret', str(config))
        self.assertIn(':room1:candidate', config[1]['username'])


class SavedMeasurementTests(unittest.IsolatedAsyncioTestCase):
    setUp = test_hiring.HiringTests.setUp
    tearDown = test_hiring.HiringTests.tearDown
    api = test_hiring.HiringTests.api
    account = test_hiring.HiringTests.account
    fixture = test_hiring.HiringTests.fixture
    claim = test_hiring.HiringTests.claim

    async def test_saved_summary_validity_duplicates_ownership_and_reload(self):
        owner, invitation = await self.fixture('human')
        claim = await self.claim(invitation)
        room = invitation['id']
        await self.api(f'/invitations/{room}/admit', {}, owner)
        values = {'measurement_valid': True, 'stress_valid': True, 'current_bpm': 72, 'stress': 20}
        hiring.save_human_measurement(room, claim['token'], values)
        hiring.save_human_measurement(room, claim['token'], {**values, 'current_bpm': 140})
        hiring.save_human_measurement(room, owner, {**values, 'current_bpm': 80})
        with patch('hiring._now', return_value=hiring._now() + timedelta(seconds=1)):
            hiring.save_human_measurement(room, claim['token'], {**values, 'current_bpm': float('nan')})
            hiring.save_human_measurement(room, claim['token'], {**values, 'measurement_valid': False})
        current = await self.api(f'/session/{room}', token=claim['token'])
        self.assertIsNone(current['vital_summary'])
        await self.api(f'/invitations/{room}/finish', {}, owner)
        hiring._initialized.clear()  # Reopen a persisted database through the additive migration.
        employer = await self.api(f'/invitations/{room}', token=owner)
        applicant = await self.api(f'/session/{room}', token=claim['token'])
        self.assertEqual(len(employer['vital_summary']['participants']), 2)
        self.assertEqual(len(applicant['vital_summary']['participants']), 1)
        summary = applicant['vital_summary']['participants'][0]
        self.assertEqual(summary['role'], 'candidate')
        self.assertEqual(summary['bpm']['mean'], 72)
        self.assertEqual(summary['bpm']['count'], 1)
        self.assertNotIn('vital_summary', employer['report'])
        await self.api(f'/session/{room}', token='unrelated' * 6, expected=403)


if __name__ == '__main__':
    unittest.main()
