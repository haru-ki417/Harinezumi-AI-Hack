"""Report validation, privacy, AI integration and deterministic fallback, without paid calls."""
import asyncio
import copy
import json
import threading
import unittest
from unittest.mock import patch

from fastapi import HTTPException, Request
from pydantic import ValidationError

import reporting


def sample_report():
    return {
        "sessionId": "private-session", "startedAt": 1000, "endedAt": 9000,
        "thresholds": {"stress": 70, "bpm": 100},
        "questions": [
            {"id": 1, "label": "Q1", "topic": "秘密の質問", "startedAt": 1000, "endedAt": 5000},
            {"id": 2, "label": "Q2", "topic": "別の質問", "startedAt": 5000, "endedAt": 9000},
        ],
        "participants": [{
            "id": "private-client", "name": "秘密の名前", "role": "candidate", "excludedSamples": 3,
            "questions": [
                {"questionId": 1,
                 "stress": {"count": 3, "avg": 60, "peak": 80, "firstExceededAt": 3000,
                            "peakAt": 4000, "exceededCount": 1},
                 "bpm": {"count": 3, "avg": 90, "peak": 100, "firstExceededAt": None,
                         "peakAt": 4000, "exceededCount": 0}},
                {"questionId": 2,
                 "stress": {"count": 0, "avg": None, "peak": None, "firstExceededAt": None,
                            "peakAt": None, "exceededCount": 0},
                 "bpm": {"count": 0, "avg": None, "peak": None, "firstExceededAt": None,
                         "peakAt": None, "exceededCount": 0}},
            ],
        }],
    }


def provider_commentary(**overrides):
    data = {
        "summary": "Q1ではストレス推定指標の最大値80が基準値70を超えました。",
        "observations": [{
            "participantId": "P1", "questionId": 1,
            "comment": "Q1のストレス推定指標は最大80、基準値70を初めて超えたのは2秒後です。",
        }],
    }
    data.update(overrides)
    return reporting.ProviderCommentary.model_validate(data)


def request_for(body):
    sent = False

    async def receive():
        nonlocal sent
        if sent:
            return {"type": "http.disconnect"}
        sent = True
        return {"type": "http.request", "body": body, "more_body": False}

    return Request({"type": "http", "method": "POST", "path": "/api/reports/analyze"}, receive)


class ReportValidationTests(unittest.TestCase):
    def test_valid_payload_and_strict_crossing(self):
        report = reporting.Report.model_validate(sample_report())
        self.assertEqual(report.participants[0].questions[0].bpm.exceededCount, 0)

    def test_rejects_inconsistent_and_unbounded_input(self):
        def mutate(path, value):
            payload = sample_report()
            target = payload
            for part in path[:-1]:
                target = target[part]
            target[path[-1]] = value
            return payload

        cases = [
            (["endedAt"], 500),
            (["thresholds", "stress"], float("nan")),
            (["thresholds", "bpm"], float("inf")),
            (["thresholds", "stress"], "70"),
            (["questions", 0, "label"], "Q9"),
            (["questions", 1, "startedAt"], 4000),
            (["participants", 0, "questions", 0, "questionId"], 99),
            (["participants", 0, "questions", 0, "stress", "count"], True),
            (["participants", 0, "questions", 0, "stress", "avg"], 90),
            (["participants", 0, "questions", 0, "stress", "peak"], 101),
            (["participants", 0, "questions", 0, "stress", "peakAt"], 6000),
            (["participants", 0, "questions", 0, "stress", "firstExceededAt"], 4500),
            (["participants", 0, "questions", 0, "stress", "exceededCount"], 4),
            (["participants", 0, "questions", 0, "stress", "exceededCount"], 3),
            (["participants", 0, "questions", 0, "stress", "exceededCount"], 0),
            (["participants", 0, "questions", 1, "stress", "avg"], 0),
            (["questions"], sample_report()["questions"] * 101),
            (["participants"], sample_report()["participants"] * 21),
        ]
        for path, value in cases:
            with self.subTest(path=path, value=str(value)[:60]):
                with self.assertRaises(ValidationError):
                    reporting.Report.model_validate(mutate(path, value))

    def test_rejects_duplicate_ids(self):
        for field in ("questions", "participants"):
            payload = sample_report()
            payload[field].append(copy.deepcopy(payload[field][0]))
            with self.subTest(field=field), self.assertRaises(ValidationError):
                reporting.Report.model_validate(payload)


class ReportAnalysisTests(unittest.IsolatedAsyncioTestCase):
    def setUp(self):
        reporting._cache.clear()
        reporting._inflight.clear()
        reporting._request_times.clear()
        self.key_patch = patch.dict("os.environ", {"OPENAI_API_KEY": "test-only-key"})
        self.key_patch.start()
        self.addCleanup(self.key_patch.stop)
        self.report = reporting.Report.model_validate(sample_report())

    async def test_no_key_returns_explicit_numerical_fallback(self):
        with patch.dict("os.environ", {"OPENAI_API_KEY": ""}), patch.object(reporting, "call_provider") as provider:
            result = await reporting.analyze_report(self.report)
        provider.assert_not_called()
        self.assertEqual((result.source, result.reason), ("local", "not_configured"))
        self.assertIn("2秒後", result.observations[0].comment)
        self.assertIn("基準値100 BPMを超えた測定はありません", result.observations[0].comment)
        self.assertIn("有効な測定データがありません", result.observations[1].comment)

    async def test_no_data_skips_provider(self):
        self.report.participants[0].questions = [self.report.participants[0].questions[1]]
        with patch.object(reporting, "call_provider") as provider:
            result = await reporting.analyze_report(self.report)
        provider.assert_not_called()
        self.assertEqual(result.reason, "insufficient_data")

    async def test_ai_anonymizes_input_and_restores_ids_and_uses_cache(self):
        with patch.object(reporting, "call_provider", return_value=provider_commentary()) as provider:
            first = await reporting.analyze_report(self.report)
            self.report.participants[0].id = "new-client-id"
            second = await reporting.analyze_report(self.report)
        self.assertEqual(provider.call_count, 1)
        transmitted = json.dumps(provider.call_args.args[0], ensure_ascii=False)
        for private_text in ("private-session", "private-client", "秘密の名前", "秘密の質問", "candidate"):
            self.assertNotIn(private_text, transmitted)
        self.assertEqual(first.source, "ai")
        self.assertIsNone(first.reason)
        self.assertEqual(first.observations[0].participantId, "private-client")
        self.assertEqual(second.observations[0].participantId, "new-client-id")
        self.assertTrue(first.observations[1].comment.startswith("数値集計："))

    async def test_provider_receives_display_precision_and_accepts_matching_comment(self):
        metric = self.report.participants[0].questions[0].bpm
        metric.avg = 100.7333333
        metric.peak = 110.0666667
        metric.exceededCount = 2
        metric.firstExceededAt = 3000
        result = provider_commentary(observations=[{
            "participantId": "P1", "questionId": 1,
            "comment": "Q1の推定心拍数は平均100.7 BPM、最大110.1 BPMでした。",
        }])
        with patch.object(reporting, "call_provider", return_value=result) as provider:
            response = await reporting.analyze_report(self.report)
        sent = provider.call_args.args[0]["commentedRows"][0]["bpm"]
        self.assertEqual(sent["avg"], 100.7)
        self.assertEqual(sent["peak"], 110.1)
        self.assertEqual(response.source, "ai")
        self.assertIn("100.7 BPM", response.observations[0].comment)

    def test_provider_display_precision_preserves_null_metrics(self):
        self.report.participants[0].questions[0].stress = self.report.participants[0].questions[1].stress
        payload, _ = reporting._provider_input(self.report)
        stress = payload["commentedRows"][0]["stress"]
        self.assertIsNone(stress["avg"])
        self.assertIsNone(stress["peak"])

    async def test_provider_errors_and_unsafe_or_invented_output_fall_back(self):
        invalid_comments = [
            "Q1で緊張が見られます。",
            "Q99で最大80でした。",
            "Q1で基準値90を超えました。",
            "Q1で最大999でした。",
            "最大80でした。",
        ]
        for text in invalid_comments:
            result = provider_commentary()
            result.observations[0].comment = text
            with self.subTest(text=text), patch.object(reporting, "call_provider", return_value=result):
                response = await reporting.analyze_report(self.report)
                self.assertEqual((response.source, response.reason), ("local", "provider_error"))
        for error in (TimeoutError(), OSError(), ValueError()):
            with self.subTest(error=type(error)), patch.object(reporting, "call_provider", side_effect=error):
                response = await reporting.analyze_report(self.report)
                self.assertEqual(response.reason, "provider_error")

    async def test_unknown_participant_and_question_are_rejected(self):
        for field, value in (("participantId", "P99"), ("questionId", 2)):
            result = provider_commentary()
            setattr(result.observations[0], field, value)
            with self.subTest(field=field), patch.object(reporting, "call_provider", return_value=result):
                response = await reporting.analyze_report(self.report)
                self.assertEqual(response.reason, "provider_error")

    async def test_deduplicates_inflight_requests_and_bounds_concurrency(self):
        release = threading.Event()
        entered = threading.Event()

        def slow_provider(*_args):
            entered.set()
            release.wait(timeout=3)
            return provider_commentary()

        with patch.object(reporting, "call_provider", side_effect=slow_provider) as provider:
            first = asyncio.create_task(reporting.analyze_report(self.report))
            await asyncio.to_thread(entered.wait, 2)
            second = asyncio.create_task(reporting.analyze_report(self.report))
            await asyncio.sleep(0)
            with patch.object(reporting, "MAX_CONCURRENT", 1):
                other = self.report.model_copy(deep=True)
                other.thresholds.bpm = 110
                limited = await reporting.analyze_report(other)
            release.set()
            answers = await asyncio.gather(first, second)
        self.assertEqual(provider.call_count, 1)
        self.assertEqual([answer.source for answer in answers], ["ai", "ai"])
        self.assertEqual(limited.reason, "provider_error")
        self.assertFalse(reporting._inflight)

    async def test_hourly_budget_returns_local(self):
        with patch.object(reporting, "MAX_REQUESTS_PER_HOUR", 0), patch.object(reporting, "call_provider") as provider:
            result = await reporting.analyze_report(self.report)
        provider.assert_not_called()
        self.assertEqual(result.reason, "provider_error")

    async def test_endpoint_body_limit_and_validation(self):
        for body, status in ((b"{}", 422), (b"bad json", 422), (b"x" * (reporting.MAX_BODY_BYTES + 1), 413)):
            with self.subTest(status=status), self.assertRaises(HTTPException) as context:
                await reporting.analyze_endpoint(request_for(body))
            self.assertEqual(context.exception.status_code, status)
        with patch.dict("os.environ", {"OPENAI_API_KEY": ""}):
            response = await reporting.analyze_endpoint(request_for(json.dumps(sample_report()).encode()))
        self.assertEqual(response.source, "local")


class ProviderTransportTests(unittest.TestCase):
    def test_responses_api_schema_and_output_extraction(self):
        body = {"status": "completed", "output": [{"type": "message", "content": [
            {"type": "output_text", "text": provider_commentary().model_dump_json()},
        ]}]}
        with patch.object(reporting.urllib.request, "urlopen") as urlopen:
            response = urlopen.return_value.__enter__.return_value
            response.read.return_value = json.dumps(body).encode()
            result = reporting.call_provider({"thresholds": {"stress": 70, "bpm": 100}}, "secret-key", "test-model")
        request = urlopen.call_args.args[0]
        sent = json.loads(request.data)
        self.assertEqual(request.full_url, "https://api.openai.com/v1/responses")
        self.assertFalse(sent["store"])
        self.assertEqual(sent["text"]["format"]["type"], "json_schema")
        self.assertTrue(sent["text"]["format"]["strict"])
        self.assertEqual(urlopen.call_args.kwargs["timeout"], 25)
        self.assertEqual(result.observations[0].questionId, 1)

    def test_refused_incomplete_or_oversized_response_rejected(self):
        bodies = [
            json.dumps({"status": "incomplete", "output": []}).encode(),
            json.dumps({"status": "completed", "output": [{"type": "message", "content": [
                {"type": "refusal", "refusal": "No"},
            ]}]}).encode(),
            b"x" * (reporting.MAX_PROVIDER_BYTES + 1),
        ]
        for body in bodies:
            with self.subTest(size=len(body)), patch.object(reporting.urllib.request, "urlopen") as urlopen:
                urlopen.return_value.__enter__.return_value.read.return_value = body
                with self.assertRaises(ValueError):
                    reporting.call_provider({}, "secret-key", "test-model")


if __name__ == "__main__":
    unittest.main()
