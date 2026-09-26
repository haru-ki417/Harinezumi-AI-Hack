"""Public invitation URL discovery, authentication, and bounded reachability checks."""
import io
import json
import os
from pathlib import Path
import tempfile
import unittest
from unittest.mock import MagicMock, patch
from urllib.error import HTTPError, URLError

import hiring_sharing as sharing
import test_hiring


class SharingConfigurationTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory(prefix="hiring-sharing-")
        self.path = Path(self.temp.name) / "url.txt"
        self.env = patch.dict(os.environ, {
            "HIRING_PUBLIC_URL": "", "HIRING_SHARING_URL_FILE": str(self.path),
        })
        self.env.start()
        sharing._cache.clear()
        self.probe = patch.object(sharing, "_probe", return_value=True).start()

    def tearDown(self):
        patch.stopall()
        self.temp.cleanup()

    def test_missing_and_explicitly_disabled_file_do_not_probe(self):
        self.assertEqual(sharing.sharing_status(), {
            "public_origin": None, "reachable": False, "temporary": False, "reason": "not_configured",
        })
        self.path.write_text("https://active-test.trycloudflare.com", encoding="utf-8")
        os.environ["HIRING_SHARING_URL_FILE"] = ""
        self.assertEqual(sharing.sharing_status()["reason"], "not_configured")
        self.probe.assert_not_called()

    def test_environment_takes_precedence_and_normalizes_origin(self):
        self.path.write_text("https://old-test.trycloudflare.com", encoding="utf-8")
        os.environ["HIRING_PUBLIC_URL"] = " https://INTERVIEW.example.com:443/ "
        self.assertEqual(sharing.sharing_status(), {
            "public_origin": "https://interview.example.com", "reachable": True,
            "temporary": False, "reason": None,
        })
        self.probe.assert_called_once_with("https://interview.example.com")

    def test_invalid_environment_never_falls_back_to_file(self):
        self.path.write_text("https://active-test.trycloudflare.com", encoding="utf-8")
        os.environ["HIRING_PUBLIC_URL"] = "http://interview.example.com"
        self.assertEqual(sharing.sharing_status()["reason"], "invalid")
        self.probe.assert_not_called()

    def test_tunnel_file_handles_bom_and_changes_without_using_old_cache(self):
        self.path.write_text("https://first-test.trycloudflare.com\n", encoding="utf-8-sig")
        first = sharing.sharing_status()
        self.assertEqual(first["public_origin"], "https://first-test.trycloudflare.com")
        self.assertTrue(first["temporary"])
        self.path.write_text("https://second-test.trycloudflare.com\n", encoding="utf-8-sig")
        self.assertEqual(sharing.sharing_status()["public_origin"], "https://second-test.trycloudflare.com")
        self.assertEqual(self.probe.call_count, 2)
        self.path.unlink()
        self.assertEqual(sharing.sharing_status()["reason"], "not_configured")
        self.assertEqual(self.probe.call_count, 2)

    def test_file_rejects_other_hosts_bad_encoding_and_large_content(self):
        for raw in (
            b"https://interview.example.com", b"https://trycloudflare.com",
            b"https://test.trycloudflare.com.attacker.example", b"\xff\xfe",
            b" " * (sharing.MAX_URL_BYTES + 1),
        ):
            with self.subTest(raw=raw[:80]):
                self.path.write_bytes(raw)
                self.assertEqual(sharing.sharing_status()["reason"], "invalid")
        self.probe.assert_not_called()

    def test_rejects_non_public_or_non_origin_urls_before_probe(self):
        invalid = [
            "http://public.example.com", "https://localhost", "https://room.localhost",
            "https://room.local", "https://room.internal", "https://room.home",
            "https://127.0.0.1", "https://10.1.2.3", "https://192.168.1.2",
            "https://172.16.0.1", "https://169.254.169.254", "https://100.64.0.1",
            "https://0.0.0.0", "https://224.0.0.1", "https://[ff02::1]",
            "https://[::1]", "https://[fc00::1]", "https://[fe80::1]",
            "https://127.1", "https://2130706433", "https://0x7f000001",
            "https://0177.0.0.1", "https://localhost.", "https://example.com.",
            "https://user:password@example.com", "https://user@example.com",
            "https://example.com/join", "https://example.com?", "https://example.com#",
            "https://example.com?target=localhost", "https://example.com\\@localhost",
            "https://exa mple.com", "https://example.com:bad", "https://example.com:0",
            "https://example.com:65536", "https://%65xample.com", "https://[::1",
            "https://" + "a" * (sharing.MAX_URL_BYTES + 1),
        ]
        for value in invalid:
            with self.subTest(value=value[:80]):
                os.environ["HIRING_PUBLIC_URL"] = value
                self.assertEqual(sharing.sharing_status()["reason"], "invalid")
        self.probe.assert_not_called()

    def test_cache_expires_success_after_ten_seconds_and_failure_after_two(self):
        os.environ["HIRING_PUBLIC_URL"] = "https://interview.example.com"
        with patch.object(sharing.time, "monotonic", return_value=100) as clock:
            self.assertTrue(sharing.sharing_status()["reachable"])
            clock.return_value = 109
            self.assertTrue(sharing.sharing_status()["reachable"])
            self.probe.assert_called_once()
            clock.return_value = 110
            self.probe.return_value = False
            self.assertEqual(sharing.sharing_status(), {
                "public_origin": None, "reachable": False, "temporary": False, "reason": "unreachable",
            })
            clock.return_value = 111
            self.assertFalse(sharing.sharing_status()["reachable"])
            self.assertEqual(self.probe.call_count, 2)
            clock.return_value = 112
            self.probe.return_value = True
            self.assertTrue(sharing.sharing_status()["reachable"])
            self.assertEqual(self.probe.call_count, 3)

    def test_changed_configuration_does_not_reuse_reachability(self):
        os.environ["HIRING_PUBLIC_URL"] = "https://first.example.com"
        self.assertTrue(sharing.sharing_status()["reachable"])
        os.environ["HIRING_PUBLIC_URL"] = "https://second.example.com"
        self.probe.return_value = False
        self.assertEqual(sharing.sharing_status()["reason"], "unreachable")
        self.assertEqual(self.probe.call_count, 2)


class SharingProbeTests(unittest.TestCase):
    def response(self, payload, status=200):
        response = io.BytesIO(payload)
        response.status = status
        return response

    def test_identity_match_with_timeout_and_redirects_disabled(self):
        opener = MagicMock()
        opener.open.return_value = self.response(json.dumps(sharing.identity()).encode())
        with patch.object(sharing, "build_opener", return_value=opener) as build:
            self.assertTrue(sharing._probe("https://interview.example.com"))
        handler = build.call_args.args[0]
        self.assertIsInstance(handler, sharing._NoRedirect)
        self.assertIsNone(handler.redirect_request(None, None, 302, None, None, "https://elsewhere.example.com"))
        request = opener.open.call_args.args[0]
        self.assertEqual(request.full_url, "https://interview.example.com/api/hiring/sharing/identity")
        self.assertEqual(opener.open.call_args.kwargs["timeout"], 3)
        self.assertFalse(request.has_header("Authorization"))

    def test_unrelated_server_oversize_or_invalid_response_is_not_reachable(self):
        for payload, status in (
            (b'{"instance_id":"another-backend"}', 200), (b'[]', 200),
            (b'<html>Unavailable</html>', 200), (b'\xff', 200),
            (b' ' * (sharing.MAX_IDENTITY_BYTES + 1), 200),
            (json.dumps(sharing.identity()).encode(), 503),
        ):
            with self.subTest(status=status, payload=payload[:60]):
                opener = MagicMock()
                opener.open.return_value = self.response(payload, status)
                with patch.object(sharing, "build_opener", return_value=opener):
                    self.assertFalse(sharing._probe("https://interview.example.com"))

    def test_connection_errors_and_redirects_are_unreachable(self):
        for error in (
            URLError("connection refused"), TimeoutError("timed out"),
            HTTPError("https://interview.example.com", 302, "redirect", {}, None),
        ):
            with self.subTest(error=error):
                opener = MagicMock()
                opener.open.side_effect = error
                with patch.object(sharing, "build_opener", return_value=opener):
                    self.assertFalse(sharing._probe("https://interview.example.com"))


class SharingAuthenticationTests(unittest.IsolatedAsyncioTestCase):
    api = test_hiring.HiringTests.api
    account = test_hiring.HiringTests.account
    fixture = test_hiring.HiringTests.fixture
    claim = test_hiring.HiringTests.claim

    def setUp(self):
        test_hiring.HiringTests.setUp(self)
        self.sharing_environment = patch.dict(os.environ, {
            "HIRING_PUBLIC_URL": "https://interview.example.com", "HIRING_SHARING_URL_FILE": "",
        })
        self.sharing_environment.start()
        sharing._cache.clear()

    def tearDown(self):
        self.sharing_environment.stop()
        test_hiring.HiringTests.tearDown(self)

    async def test_employer_only_configuration_and_public_harmless_identity(self):
        with patch.object(sharing, "_probe", return_value=True) as probe:
            await self.api("/sharing", expected=401)
            await self.api("/sharing", token="x" * 43, expected=401)
            identity = await self.api("/sharing/identity")
            self.assertEqual(identity, sharing.identity())
            self.assertEqual(set(identity), {"instance_id"})
            probe.assert_not_called()
            owner, invitation = await self.fixture()
            candidate = await self.claim(invitation)
            await self.api("/sharing", token=candidate["token"], expected=401)
            probe.assert_not_called()
            self.assertEqual((await self.api("/sharing", token=owner))["public_origin"], "https://interview.example.com")
            probe.assert_called_once()

    async def test_identity_response_cannot_be_cached(self):
        messages = []
        scope = {
            "type": "http", "asgi": {"version": "3.0"}, "http_version": "1.1", "method": "GET",
            "scheme": "http", "path": "/api/hiring/sharing/identity", "query_string": b"",
            "root_path": "", "headers": [], "client": ("127.0.0.1", 12345), "server": ("testserver", 80),
        }

        async def receive():
            return {"type": "http.request", "body": b"", "more_body": False}

        async def send(message):
            messages.append(message)

        await self.app(scope, receive, send)
        headers = dict(next(message for message in messages if message["type"] == "http.response.start")["headers"])
        self.assertEqual(headers[b"cache-control"], b"no-store")
        self.assertEqual(headers[b"pragma"], b"no-cache")


if __name__ == "__main__":
    unittest.main()
