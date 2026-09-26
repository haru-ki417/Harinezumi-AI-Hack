"""Copied invitation codes work across devices without relaxing admission rules."""
from datetime import timedelta
import unittest

import hiring
import test_hiring


def full_width(code):
    return "".join(chr(ord(character) + 0xFEE0) for character in code)


def copied_code(code):
    return "\ufeff" + "\u200b\u2011\u3000\r\n".join(
        full_width(code[index:index + 4].lower()) for index in range(0, len(code), 4)
    ) + "\u2060"


class HiringJoinInputTests(unittest.IsolatedAsyncioTestCase):
    setUp = test_hiring.HiringTests.setUp
    tearDown = test_hiring.HiringTests.tearDown
    api = test_hiring.HiringTests.api
    account = test_hiring.HiringTests.account
    fixture = test_hiring.HiringTests.fixture
    claim = test_hiring.HiringTests.claim

    async def another_invitation(self, owner, first):
        return await self.api(f"/templates/{first['template_id']}/invitations", {
            "candidate_name": "次の応募者", "expires_at": first["expires_at"],
        }, owner, expected=201)

    async def test_lookup_and_start_accept_the_same_copied_code_formats(self):
        owner, first = await self.fixture("human")
        formats = (
            lambda code: code.lower(),
            full_width,
            lambda code: " \t\r\n\u3000\u00a0".join(code),
            lambda code: "\u200b\u200c\u200d\u2060\ufeff".join(code),
            lambda code: "-\u2010\u2011\u2012\u2013\u2014\u2212\u00ad".join(
                code[index:index + 4] for index in range(0, len(code), 4)
            ),
            copied_code,
        )
        for index, formatting in enumerate(formats):
            invitation = first if index == 0 else await self.another_invitation(owner, first)
            entered = formatting(invitation["code"])
            with self.subTest(format=index):
                found = await self.api("/join/lookup", {"code": entered})
                self.assertEqual(found["id"], invitation["id"])
                self.assertEqual(found["status"], "invited")
                self.assertNotIn("candidate_name", found)
                self.assertNotIn("criteria", found)
                joined = await self.api("/join/start", {
                    "code": entered, "name": "応募者", "consent": True,
                })
                self.assertEqual(joined["session"]["invitation"]["id"], invitation["id"])
                self.assertEqual(joined["session"]["invitation"]["status"], "waiting")
                self.assertEqual(joined["session"]["invitation"]["code"], "")
                with hiring._db() as connection:
                    stored = connection.execute("SELECT code FROM invitations WHERE id=?", (invitation["id"],)).fetchone()
                self.assertEqual(stored["code"], invitation["code"])

    async def test_normalized_length_is_checked_after_copy_formatting(self):
        owner, invitation = await self.fixture("human")
        entered = " \t\n".join(invitation["code"])
        self.assertGreater(len(entered), 64)
        self.assertEqual((await self.api("/join/lookup", {"code": entered}))["id"], invitation["id"])
        # Keep the existing 12..64 ASCII code contract; unknown valid codes
        # return 404, while too short/long normalized codes return 422.
        for code in ("A" * 12, "A" * 64):
            await self.api("/join/lookup", {"code": code}, expected=404)
            await self.api("/join/start", {"code": code, "name": "応募者", "consent": True}, expected=404)
        for code in ("A" * 11, "A" * 65, "A---" * 3):
            await self.api("/join/lookup", {"code": code}, expected=422)
            await self.api("/join/start", {"code": code, "name": "応募者", "consent": True}, expected=422)

    async def test_invalid_characters_types_and_excessive_raw_input_are_rejected(self):
        _, invitation = await self.fixture("human")
        code = invitation["code"]
        invalid = (
            "", " \n\u200b-", None, 123456789012, [code],
            code + "!", code + "_", code + "/", code + "\u202e", code + "\x00",
            "\u0410" + code[1:], "ß" + code[2:],
            "https://interview.example.com/interviews/join?code=" + code,
            " " * (257 - len(code)) + code,
            code + "\u200b" * (257 - len(code)),
        )
        for value in invalid:
            with self.subTest(value=repr(value)[:80]):
                await self.api("/join/lookup", {"code": value}, expected=422)
                await self.api("/join/start", {"code": value, "name": "応募者", "consent": True}, expected=422)
        # Rejected inputs have not claimed or changed the invitation.
        fresh = await self.api("/join/lookup", {"code": code})
        self.assertEqual(fresh["status"], "invited")
        with hiring._db() as connection:
            self.assertIsNone(connection.execute("SELECT token_hash FROM invitations WHERE id=?", (invitation["id"],)).fetchone()[0])

    async def test_formatted_code_does_not_bypass_opening_expiry_or_revocation(self):
        owner, invitation = await self.fixture("human")
        identifier = invitation["id"]
        code = copied_code(invitation["code"])
        body = {"code": code, "name": "応募者", "consent": True}
        with hiring._db(write=True) as connection:
            connection.execute("UPDATE invitations SET opens_at=? WHERE id=?", (
                hiring._iso(hiring._now() + timedelta(hours=1)), identifier,
            ))
        self.assertEqual((await self.api("/join/lookup", {"code": code}))["id"], identifier)
        await self.api("/join/start", body, expected=409)
        with hiring._db(write=True) as connection:
            connection.execute("UPDATE invitations SET opens_at=NULL,expires_at=? WHERE id=?", (
                hiring._iso(hiring._now() - timedelta(seconds=1)), identifier,
            ))
        self.assertEqual((await self.api("/join/lookup", {"code": code}))["status"], "expired")
        await self.api("/join/start", body, expected=410)
        revoked = await self.another_invitation(owner, invitation)
        await self.api(f"/invitations/{revoked['id']}/revoke", {}, owner)
        body["code"] = copied_code(revoked["code"])
        self.assertEqual((await self.api("/join/lookup", {"code": body["code"]}))["status"], "revoked")
        await self.api("/join/start", body, expected=410)

    async def test_formatted_used_code_still_requires_the_original_resume_token(self):
        owner, invitation = await self.fixture("human")
        code = copied_code(invitation["code"])
        await self.api("/join/start", {"code": code, "name": "応募者", "consent": False}, expected=422)
        joined = await self.claim(invitation)
        token = joined["token"]
        self.assertEqual((await self.api("/join/lookup", {"code": code}))["status"], "waiting")
        for extra in ({}, {"resume_token": "x" * 43}, {"resume_token": owner}):
            await self.api("/join/start", {
                "code": code, "name": "別人", "consent": True, **extra,
            }, expected=409)
        resumed = await self.api("/join/start", {
            "code": code, "name": "", "consent": True, "resume_token": token,
        })
        self.assertEqual(resumed["token"], token)
        self.assertEqual(resumed["session"]["invitation"]["candidate_name"], "応募者")
        self.assertEqual(resumed["session"]["invitation"]["status"], "waiting")
        self.assertEqual(resumed["session"]["template"]["criteria"], [])
        self.assertIsNone(resumed["session"]["report"])


if __name__ == "__main__":
    unittest.main()
