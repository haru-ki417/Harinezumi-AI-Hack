"""Consented camera estimates, kept separate from hiring assessments and AI input."""
from __future__ import annotations

import math
from collections import defaultdict

SCHEMA = """
CREATE TABLE IF NOT EXISTS hiring_measurements (
 invitation_id TEXT NOT NULL REFERENCES invitations(id),
 role TEXT NOT NULL, second INTEGER NOT NULL, bpm REAL, stress REAL,
 PRIMARY KEY(invitation_id, role, second)
);
"""


def valid_number(value, minimum, maximum):
    return (not isinstance(value, bool) and isinstance(value, (int, float))
            and math.isfinite(value) and minimum <= value <= maximum)


def save(connection, row, role, values, elapsed):
    # The caller has authenticated the participant and checked explicit consent.
    second = int(elapsed)
    if not 0 <= second < 7200 or row['status'] != 'in_progress':
        return
    bpm = values.get('current_bpm') if values.get('measurement_valid') is True else None
    stress = values.get('stress') if values.get('stress_valid') is True else None
    bpm = bpm if valid_number(bpm, 40, 240) else None
    stress = stress if bpm is not None and valid_number(stress, 0, 100) else None
    if bpm is None:
        return
    connection.execute('INSERT OR IGNORE INTO hiring_measurements VALUES (?, ?, ?, ?, ?)',
                       (row['id'], role, second, bpm, stress))


def summarize(connection, row, private):
    if row['status'] != 'completed':
        return None
    samples = connection.execute(
        'SELECT role, second, bpm, stress FROM hiring_measurements WHERE invitation_id=?'
        + ('' if private else " AND role='candidate'") + ' ORDER BY second', (row['id'],)
    ).fetchall()
    groups = defaultdict(list)
    for sample in samples:
        groups[sample['role']].append(dict(sample))

    def stats(values):
        valid = [value for value in values if value is not None]
        return ({'mean': round(sum(valid) / len(valid), 1), 'min': round(min(valid), 1),
                 'max': round(max(valid), 1), 'count': len(valid)} if valid else None)

    participants = []
    for role, points in groups.items():
        buckets = defaultdict(list)
        for point in points:
            buckets[point['second'] // 30].append(point)
        trend = []
        for bucket in range(min(buckets), max(buckets) + 1):
            chunk = buckets.get(bucket, [])
            bpm = stats([p['bpm'] for p in chunk])
            stress = stats([p['stress'] for p in chunk])
            trend.append({'second': bucket * 30, 'bpm': bpm['mean'] if bpm else None,
                          'stress': stress['mean'] if stress else None})
        participants.append({
            'role': role, 'name': row['candidate_name'] if role == 'candidate' else '面接官',
            'sample_seconds': len(points), 'first_second': points[0]['second'],
            'last_second': points[-1]['second'],
            'bpm': stats([p['bpm'] for p in points]),
            'stress': stats([p['stress'] for p in points]), 'trend': trend,
        })
    return {'participants': participants}
