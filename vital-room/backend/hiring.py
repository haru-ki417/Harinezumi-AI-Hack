"""Persisted company interviews, private invitations and candidate sessions.

SQLite transactions own every state transition. Provider calls happen outside
transactions and are guarded by persisted, expiring reservations so retries and
multiple API workers cannot append the same answer twice.
"""
from __future__ import annotations

import asyncio
import hashlib
import hmac
import json
import os
import re
import secrets
import sqlite3
import threading
import time
import unicodedata
import uuid
from collections import defaultdict, deque
from contextlib import contextmanager
from datetime import datetime, timedelta, timezone
from pathlib import Path
from typing import Annotated, Literal

from fastapi import APIRouter, Depends, Header, HTTPException, Request
from fastapi.exceptions import RequestValidationError
from fastapi.routing import APIRoute
from pydantic import BaseModel, ConfigDict, Field, StringConstraints, field_validator

import interview_ai
import interview_questions
import hiring_measurements
import hiring_sharing

UTC = timezone.utc
MAX_BODY_BYTES = 65536
MAX_TRANSCRIPT_CHARS = 120000
RESERVATION_SECONDS = 120
PASSWORD_ROUNDS = 600000
_schema_lock = threading.Lock()
_initialized: set[str] = set()
_rate_lock = threading.Lock()
_rates: dict[str, deque] = defaultdict(deque)


class HiringRoute(APIRoute):
    """Bound unauthenticated JSON bodies and keep private responses out of caches."""

    def get_route_handler(self):
        original = super().get_route_handler()

        async def handler(request: Request):
            if request.method == "POST":
                body = bytearray()
                async for chunk in request.stream():
                    body.extend(chunk)
                    if len(body) > MAX_BODY_BYTES:
                        raise HTTPException(413, "送信内容が大きすぎます。")
                request._body = bytes(body)
            try:
                response = await original(request)
            except RequestValidationError as exc:
                raise HTTPException(422, "入力内容を確認してください。文字数・日時・必須項目が不正です。") from exc
            response.headers["Cache-Control"] = "no-store"
            response.headers["Pragma"] = "no-cache"
            return response

        return handler


router = APIRouter(prefix="/api/hiring", tags=["hiring"], route_class=HiringRoute)


def _now() -> datetime:
    return datetime.now(UTC)


def _iso(value: datetime | None = None) -> str:
    return (value or _now()).astimezone(UTC).isoformat().replace("+00:00", "Z")


def _date(value: str) -> datetime:
    return datetime.fromisoformat(value.replace("Z", "+00:00")).astimezone(UTC)


def _json(value) -> str:
    return json.dumps(value, ensure_ascii=False, separators=(",", ":"))


def _hash(token: str) -> str:
    return hashlib.sha256(token.encode("utf-8")).hexdigest()


def _new_id() -> str:
    return uuid.uuid4().hex


_SCHEMA = """
CREATE TABLE IF NOT EXISTS companies (
 id TEXT PRIMARY KEY, name TEXT NOT NULL, email TEXT NOT NULL UNIQUE,
 password_hash TEXT NOT NULL, created_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS employer_sessions (
 token_hash TEXT PRIMARY KEY, company_id TEXT NOT NULL REFERENCES companies(id),
 created_at TEXT NOT NULL, expires_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS employer_sessions_company ON employer_sessions(company_id);
CREATE TABLE IF NOT EXISTS templates (
 id TEXT PRIMARY KEY, company_id TEXT NOT NULL REFERENCES companies(id), data TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS templates_company ON templates(company_id);
CREATE TABLE IF NOT EXISTS invitations (
 id TEXT PRIMARY KEY, company_id TEXT NOT NULL REFERENCES companies(id),
 template_id TEXT NOT NULL REFERENCES templates(id), code TEXT NOT NULL UNIQUE,
 candidate_name TEXT NOT NULL, opens_at TEXT, expires_at TEXT NOT NULL,
 status TEXT NOT NULL, created_at TEXT NOT NULL, token_hash TEXT UNIQUE,
 consent_at TEXT, started_at TEXT, ended_at TEXT, deadline_at TEXT,
 report TEXT, review TEXT NOT NULL DEFAULT '{"decision":"pending","notes":""}',
 busy_request TEXT, busy_since TEXT, report_busy_since TEXT,
 feedback TEXT, feedback_busy_since TEXT
);
CREATE INDEX IF NOT EXISTS invitations_company ON invitations(company_id);
CREATE TABLE IF NOT EXISTS turns (
 sequence INTEGER PRIMARY KEY AUTOINCREMENT, id TEXT NOT NULL UNIQUE,
 invitation_id TEXT NOT NULL REFERENCES invitations(id), role TEXT NOT NULL,
 text TEXT NOT NULL, created_at TEXT NOT NULL, question_index INTEGER NOT NULL,
 source TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS turns_invitation ON turns(invitation_id, sequence);
CREATE TABLE IF NOT EXISTS requests (
 invitation_id TEXT NOT NULL REFERENCES invitations(id), actor TEXT NOT NULL,
 request_id TEXT NOT NULL, payload_hash TEXT NOT NULL, status TEXT NOT NULL,
 created_at TEXT NOT NULL, PRIMARY KEY (invitation_id, actor, request_id)
);
"""


def _database_path() -> Path:
    return Path(os.environ.get("HIRING_DB_PATH") or Path(__file__).parent / "records" / "hiring.sqlite3").resolve()


@contextmanager
def _db(write: bool = False):
    path = _database_path()
    key = str(path)
    with _schema_lock:
        if key not in _initialized or not path.exists():
            path.parent.mkdir(parents=True, exist_ok=True)
            initial = sqlite3.connect(path, timeout=10)
            try:
                initial.execute("PRAGMA journal_mode=WAL")
                initial.executescript(_SCHEMA + hiring_measurements.SCHEMA)
                # Additive migration: preserve existing invitations and reviews.
                columns = {column[1] for column in initial.execute("PRAGMA table_info(invitations)")}
                for column in ("feedback", "feedback_busy_since"):
                    if column not in columns:
                        initial.execute(f"ALTER TABLE invitations ADD COLUMN {column} TEXT")
                initial.commit()
            finally:
                initial.close()
            _initialized.add(key)
    connection = sqlite3.connect(path, timeout=10)
    connection.row_factory = sqlite3.Row
    connection.execute("PRAGMA foreign_keys=ON")
    try:
        if write:
            connection.execute("BEGIN IMMEDIATE")
        yield connection
        connection.commit()
    except BaseException:
        connection.rollback()
        raise
    finally:
        connection.close()


def _rate(key: str, limit: int, window: int = 60):
    now = time.monotonic()
    with _rate_lock:
        # Discard inactive identities; cap memory used by unauthenticated callers.
        if len(_rates) > 10000:
            for old in list(_rates):
                if not _rates[old] or now - _rates[old][-1] > 3600:
                    del _rates[old]
            if len(_rates) > 10000:
                raise HTTPException(429, "混み合っています。しばらく待ってお試しください。")
        entries = _rates[key]
        while entries and entries[0] <= now - window:
            entries.popleft()
        if len(entries) >= limit:
            raise HTTPException(429, "操作が多すぎます。しばらく待ってお試しください。", headers={"Retry-After": str(window)})
        entries.append(now)


def _ip(request: Request) -> str:
    # Do not trust client-supplied forwarded headers. Configure trusted proxies in uvicorn.
    return request.client.host if request.client else "unknown"


def _password_hash(password: str) -> str:
    salt = secrets.token_hex(16)
    digest = hashlib.pbkdf2_hmac("sha256", password.encode(), bytes.fromhex(salt), PASSWORD_ROUNDS).hex()
    return f"pbkdf2_sha256${PASSWORD_ROUNDS}${salt}${digest}"


def _password_matches(password: str, encoded: str | None) -> bool:
    if encoded is None:
        hashlib.pbkdf2_hmac("sha256", password.encode(), b"unknown-company", PASSWORD_ROUNDS)
        return False
    _, rounds, salt, expected = encoded.split("$")
    actual = hashlib.pbkdf2_hmac("sha256", password.encode(), bytes.fromhex(salt), int(rounds)).hex()
    return hmac.compare_digest(actual, expected)


def _bearer(authorization: str | None) -> str:
    if not authorization or len(authorization) > 256 or not authorization.startswith("Bearer "):
        raise HTTPException(401, "ログインまたは参加し直してください。")
    token = authorization[7:]
    if not re.fullmatch(r"[A-Za-z0-9_-]{32,128}", token):
        raise HTTPException(401, "ログインまたは参加し直してください。")
    return token


def _company_for_token(connection, token: str):
    return connection.execute(
        "SELECT c.id,c.name,c.email FROM employer_sessions s JOIN companies c ON c.id=s.company_id "
        "WHERE s.token_hash=? AND s.expires_at>?", (_hash(token), _iso()),
    ).fetchone()


def employer(authorization: str | None = Header(default=None)) -> dict:
    token = _bearer(authorization)
    with _db() as connection:
        company = _company_for_token(connection, token)
    if not company:
        raise HTTPException(401, "ログインの有効期限が切れています。再度ログインしてください。")
    return dict(company)


@router.get("/sharing")
def sharing(company: dict = Depends(employer)):
    return hiring_sharing.sharing_status()


@router.get("/sharing/identity")
async def sharing_identity():
    return hiring_sharing.identity()


class Input(BaseModel):
    model_config = ConfigDict(extra="forbid", str_strip_whitespace=True)


class Login(Input):
    email: str = Field(min_length=3, max_length=254)
    password: Annotated[str, StringConstraints(strip_whitespace=False, min_length=10, max_length=128)]

    @field_validator("email")
    @classmethod
    def email_valid(cls, value):
        value = value.lower()
        if not re.fullmatch(r"[^\s@]+@[^\s@]+\.[^\s@]+", value):
            raise ValueError("invalid email")
        return value


class Register(Login):
    company_name: str = Field(min_length=1, max_length=120)


class NewTemplate(Input):
    title: str = Field(min_length=1, max_length=160)
    job_title: str = Field(min_length=1, max_length=120)
    mode: Literal["human", "ai"]
    duration_minutes: int = Field(ge=5, le=120)
    questions: list[str] = Field(min_length=1, max_length=20)
    criteria: list[str] = Field(default_factory=list, max_length=15)

    @field_validator("questions", "criteria")
    @classmethod
    def list_valid(cls, value):
        items = [item.strip() for item in value]
        if any(not item or len(item) > 1000 for item in items):
            raise ValueError("invalid item")
        return items


class NewInvitation(Input):
    candidate_name: str = Field(min_length=1, max_length=120)
    opens_at: datetime | None = None
    expires_at: datetime

    @field_validator("opens_at", "expires_at")
    @classmethod
    def aware(cls, value):
        if value is not None and (value.tzinfo is None or value.utcoffset() is None):
            raise ValueError("timezone required")
        return value


class Lookup(Input):
    code: str = Field(min_length=12, max_length=64, pattern=r"^[A-Z0-9]+$")

    @field_validator("code", mode="before")
    @classmethod
    def code_valid(cls, value):
        # Bound the original text before normalization/whitespace stripping so
        # pasted separators cannot bypass the input limit. The same validator
        # applies to lookup and Start, including resume requests.
        if not isinstance(value, str) or len(value) > 256:
            raise ValueError("invalid invitation code")
        normalized = unicodedata.normalize("NFKC", value)
        normalized = "".join(character for character in normalized if not (
            character.isspace() or unicodedata.category(character) == "Pd"
            or character in "\u00ad\u200b\u200c\u200d\u2060\ufeff\u2212"
        ))
        # Reject non-ASCII lookalikes instead of mapping arbitrary letters to
        # another applicant's code (for example, case folding sharp s to SS).
        if not re.fullmatch(r"[A-Za-z0-9]+", normalized):
            raise ValueError("invalid invitation code")
        return normalized.upper()


class Start(Lookup):
    name: str = Field(default="", max_length=120)
    consent: bool
    resume_token: str | None = Field(default=None, min_length=32, max_length=128)


class Answer(Input):
    text: str = Field(min_length=1, max_length=6000)
    request_id: str = Field(min_length=1, max_length=100, pattern=r"^[A-Za-z0-9_-]+$")
    expected_turn_id: str = Field(min_length=1, max_length=100)


class Review(Input):
    decision: Literal["pending", "advance", "hold", "reject"]
    notes: str = Field(default="", max_length=12000)


def _owned(connection, invitation_id: str, company_id: str):
    row = connection.execute("SELECT * FROM invitations WHERE id=? AND company_id=?", (invitation_id, company_id)).fetchone()
    if not row:
        raise HTTPException(404, "面接が見つかりません。")
    return row


def _template(connection, template_id: str) -> dict:
    return json.loads(connection.execute("SELECT data FROM templates WHERE id=?", (template_id,)).fetchone()[0])


def _transcript(connection, invitation_id: str) -> list[dict]:
    return [dict(row) for row in connection.execute(
        "SELECT id,role,text,created_at,question_index,source FROM turns WHERE invitation_id=? ORDER BY sequence", (invitation_id,),
    )]


def _engine_template(connection, row) -> dict:
    template = _template(connection, row["template_id"])
    company_name = connection.execute("SELECT name FROM companies WHERE id=?", (row["company_id"],)).fetchone()[0]
    remaining = max(0, (min(_date(row["deadline_at"]), _date(row["expires_at"])) - _now()).total_seconds()) if row["deadline_at"] else None
    return {**template, "_redact_names": [row["candidate_name"], company_name],
            "_remaining_seconds": remaining}


def _status(row) -> str:
    if row["status"] not in ("completed", "revoked") and _date(row["expires_at"]) <= _now():
        return "expired"
    return row["status"]


def _invitation(connection, row, private: bool = True) -> dict:
    template = _template(connection, row["template_id"])
    result = {key: row[key] for key in ("id", "template_id", "candidate_name", "opens_at", "expires_at", "created_at")}
    result.update({key: template[key] for key in ("title", "job_title", "mode", "duration_minutes")})
    result.update(status=_status(row), code=row["code"] if private else "", decision=json.loads(row["review"])["decision"] if private else "pending")
    return result


def _refresh(connection, row):
    """Persist deadline completion even if the browser disappears or REST is polled."""
    if row["status"] == "in_progress":
        end = min(_date(row["deadline_at"]), _date(row["expires_at"]))
        # A process may stop after accepting an answer but before generating the
        # next question. Accepted speech is already durable; recover locally on
        # the next access once that worker's reservation has expired.
        if end > _now() and row["busy_request"] and not _busy(row):
            transcript = _transcript(connection, row["id"])
            template = _engine_template(connection, row)
            if transcript and transcript[-1]["role"] == "candidate":
                next_turn = _safe_next(template, transcript, {})
                if next_turn:
                    _insert_turn(connection, row["id"], next_turn)
                else:
                    report = interview_ai.local_report(template, transcript)
                    feedback = interview_ai.local_feedback(template, transcript)
                    connection.execute("UPDATE invitations SET status='completed',ended_at=?,report=?,feedback=? WHERE id=?", (_iso(), _json(report), _json(feedback), row["id"]))
            connection.execute("UPDATE requests SET status='done' WHERE invitation_id=? AND actor='candidate' AND request_id=?", (row["id"], row["busy_request"]))
            connection.execute("UPDATE invitations SET busy_request=NULL,busy_since=NULL WHERE id=?", (row["id"],))
            row = connection.execute("SELECT * FROM invitations WHERE id=?", (row["id"],)).fetchone()
        if end <= _now():
            template, transcript = _engine_template(connection, row), _transcript(connection, row["id"])
            report = interview_ai.local_report(template, transcript)
            feedback = interview_ai.local_feedback(template, transcript)
            connection.execute("UPDATE requests SET status='done' WHERE invitation_id=? AND status='pending'", (row["id"],))
            connection.execute(
                "UPDATE invitations SET status='completed',ended_at=?,report=?,feedback=?,busy_request=NULL,busy_since=NULL WHERE id=?",
                (_iso(end), _json(report), _json(feedback), row["id"]),
            )
            row = connection.execute("SELECT * FROM invitations WHERE id=?", (row["id"],)).fetchone()
    return row


def _snapshot(connection, row, private: bool = True) -> dict:
    template = _template(connection, row["template_id"])
    transcript = _transcript(connection, row["id"])
    completed = row["status"] == "completed"
    # Existing completed interviews and deadline completion get an immediately
    # usable local review, without sending private employer criteria to coaching.
    feedback = (json.loads(row["feedback"]) if row["feedback"] else
                interview_ai.local_feedback(template, transcript)) if completed else None
    latest_question = next((turn for turn in reversed(transcript) if turn["role"] == "ai"), None)
    current_index = latest_question["question_index"] if latest_question else 0
    depth = max(0, sum(turn["role"] == "ai" and turn["question_index"] == current_index for turn in transcript) - 1)
    feedback_processing = bool(completed and row["feedback_busy_since"] and
                               (_now() - _date(row["feedback_busy_since"])).total_seconds() < RESERVATION_SECONDS)
    if not private:
        template["criteria"] = []
    return {
        "invitation": _invitation(connection, row, private), "template": template,
        "transcript": transcript,
        "report": json.loads(row["report"]) if private and row["report"] else None,
        "feedback": feedback, "feedback_processing": feedback_processing,
        "interview_progress": {
            "question_index": current_index, "question_count": len(template["questions"]),
            "follow_up_depth": depth, "max_follow_ups": interview_questions.MAX_FOLLOW_UPS,
            "answered_questions": len({turn["question_index"] for turn in transcript
                                       if turn["role"] == "candidate" and turn["question_index"] >= 0}),
        } if template["mode"] == "ai" else None,
        "review": json.loads(row["review"]) if private else {"decision": "pending", "notes": ""},
        "started_at": row["started_at"], "ended_at": row["ended_at"], "deadline_at": row["deadline_at"],
        "ai_available": interview_ai.ai_available(),
        "processing": bool(_busy(row)),
        "vital_summary": hiring_measurements.summarize(connection, row, private),
    }


def _authorize(connection, invitation_id: str, token: str):
    if not token or len(token) > 128:
        raise HTTPException(401, "ログインまたは参加し直してください。")
    row = connection.execute("SELECT * FROM invitations WHERE id=?", (invitation_id,)).fetchone()
    company = _company_for_token(connection, token)
    if company and row and company["id"] == row["company_id"]:
        return "interviewer", row
    if row and row["token_hash"] and hmac.compare_digest(row["token_hash"], _hash(token)):
        return "candidate", row
    raise HTTPException(403, "この面接にアクセスする権限がありません。")


def access_session(invitation_id: str, token: str) -> tuple[str, dict]:
    """WebSocket and REST shared authorization; snapshots are role-redacted."""
    with _db(write=True) as connection:
        role, row = _authorize(connection, invitation_id, token)
        return role, _snapshot(connection, _refresh(connection, row), private=role == "interviewer")


def active_human_peer(invitation_id: str, token: str, expected_role: str) -> bool:
    """Authorize each camera frame without rebuilding transcripts/reports or a write lock."""
    with _db() as connection:
        role, row = _authorize(connection, invitation_id, token)
        now = _now()
        return (role == expected_role and row['status'] == 'in_progress'
                and _date(row['expires_at']) > now
                and (not row['deadline_at'] or _date(row['deadline_at']) > now)
                and _template(connection, row['template_id'])['mode'] == 'human')


def save_human_measurement(invitation_id: str, token: str, values: dict) -> None:
    with _db(write=True) as connection:
        role, row = _authorize(connection, invitation_id, token)
        row = _refresh(connection, row)
        if row['status'] != 'in_progress' or not row['started_at']:
            return
        if _template(connection, row['template_id'])['mode'] != 'human':
            return
        elapsed = (_now() - _date(row['started_at'])).total_seconds()
        hiring_measurements.save(connection, row, role, values, elapsed)


def _require_open(row):
    if row["status"] == "revoked":
        raise HTTPException(410, "この招待は取り消されています。")
    if _date(row["expires_at"]) <= _now():
        raise HTTPException(410, "この招待の有効期限は終了しました。")
    if row["opens_at"] and _date(row["opens_at"]) > _now():
        raise HTTPException(409, "面接の参加可能時刻になっていません。")


def _turn(role: str, text: str, index: int, source: str) -> dict:
    return {"id": _new_id(), "role": role, "text": text, "created_at": _iso(), "question_index": index, "source": source}


def _insert_turn(connection, invitation_id: str, turn: dict):
    connection.execute(
        "INSERT INTO turns(id,invitation_id,role,text,created_at,question_index,source) VALUES(?,?,?,?,?,?,?)",
        (turn["id"], invitation_id, turn["role"], turn["text"], turn["created_at"], turn["question_index"], turn["source"]),
    )


def _new_employer_session(connection, company_id: str) -> str:
    token = secrets.token_urlsafe(32)
    connection.execute("DELETE FROM employer_sessions WHERE expires_at<=?", (_iso(),))
    connection.execute("INSERT INTO employer_sessions VALUES(?,?,?,?)", (_hash(token), company_id, _iso(), _iso(_now() + timedelta(hours=12))))
    return token


@router.post("/auth/register", status_code=201)
async def register(body: Register, request: Request):
    _rate("register:" + _ip(request), 12, 300)
    encoded = await asyncio.to_thread(_password_hash, body.password)
    company = {"id": _new_id(), "name": body.company_name, "email": body.email}
    try:
        with _db(write=True) as connection:
            connection.execute("INSERT INTO companies VALUES(?,?,?,?,?)", (company["id"], company["name"], company["email"], encoded, _iso()))
            token = _new_employer_session(connection, company["id"])
    except sqlite3.IntegrityError as exc:
        raise HTTPException(409, "このメールアドレスは登録済みです。ログインしてください。") from exc
    return {"token": token, "company": company}


@router.post("/auth/login")
async def login(body: Login, request: Request):
    _rate("login:" + _ip(request), 25, 300)
    _rate("login-email:" + _hash(body.email), 15, 300)
    with _db() as connection:
        row = connection.execute("SELECT * FROM companies WHERE email=?", (body.email,)).fetchone()
    if not await asyncio.to_thread(_password_matches, body.password, row["password_hash"] if row else None):
        raise HTTPException(401, "メールアドレスまたはパスワードが正しくありません。")
    with _db(write=True) as connection:
        token = _new_employer_session(connection, row["id"])
    return {"token": token, "company": {key: row[key] for key in ("id", "name", "email")}}


@router.get("/auth/me")
def me(company: dict = Depends(employer)):
    return company


@router.post("/auth/logout")
def logout(authorization: str | None = Header(default=None)):
    token = _bearer(authorization)
    with _db(write=True) as connection:
        connection.execute("DELETE FROM employer_sessions WHERE token_hash=?", (_hash(token),))
    return {"ok": True}


@router.get("/templates")
def templates(company: dict = Depends(employer)):
    with _db() as connection:
        return {"templates": [json.loads(row[0]) for row in connection.execute("SELECT data FROM templates WHERE company_id=? ORDER BY rowid DESC", (company["id"],))]}


@router.post("/templates", status_code=201)
def create_template(body: NewTemplate, company: dict = Depends(employer)):
    _rate("templates:" + company["id"], 30)
    template = {"id": _new_id(), **body.model_dump(), "created_at": _iso()}
    with _db(write=True) as connection:
        connection.execute("INSERT INTO templates VALUES(?,?,?)", (template["id"], company["id"], _json(template)))
    return template


@router.get("/invitations")
def invitations(company: dict = Depends(employer)):
    with _db(write=True) as connection:
        rows = connection.execute("SELECT * FROM invitations WHERE company_id=? ORDER BY created_at DESC", (company["id"],)).fetchall()
        return {"invitations": [_invitation(connection, _refresh(connection, row)) for row in rows]}


@router.post("/templates/{template_id}/invitations", status_code=201)
def create_invitation(template_id: str, body: NewInvitation, company: dict = Depends(employer)):
    _rate("invitations:" + company["id"], 100)
    if body.expires_at <= _now() or body.expires_at > _now() + timedelta(days=366):
        raise HTTPException(422, "有効期限は現在から366日以内の未来に設定してください。")
    if body.opens_at and body.opens_at >= body.expires_at:
        raise HTTPException(422, "参加開始日時は有効期限より前に設定してください。")
    with _db(write=True) as connection:
        if not connection.execute("SELECT id FROM templates WHERE id=? AND company_id=?", (template_id, company["id"])).fetchone():
            raise HTTPException(404, "面接設定が見つかりません。")
        identifier = _new_id()
        # 100 bits of entropy, grouped in UI if desired; each applicant gets a distinct code.
        code = "".join(secrets.choice("ABCDEFGHJKLMNPQRSTUVWXYZ23456789") for _ in range(20))
        connection.execute(
            "INSERT INTO invitations(id,company_id,template_id,code,candidate_name,opens_at,expires_at,status,created_at) VALUES(?,?,?,?,?,?,?,'invited',?)",
            (identifier, company["id"], template_id, code, body.candidate_name, _iso(body.opens_at) if body.opens_at else None, _iso(body.expires_at), _iso()),
        )
        return _invitation(connection, _owned(connection, identifier, company["id"]))


@router.post("/invitations/{invitation_id}/revoke")
def revoke(invitation_id: str, company: dict = Depends(employer)):
    with _db(write=True) as connection:
        row = _refresh(connection, _owned(connection, invitation_id, company["id"]))
        if row["status"] == "completed":
            raise HTTPException(409, "終了した面接の招待は取り消せません。")
        connection.execute("UPDATE invitations SET status='revoked',ended_at=?,busy_request=NULL,busy_since=NULL WHERE id=?", (_iso(), invitation_id))
        return _invitation(connection, _owned(connection, invitation_id, company["id"]))


@router.get("/invitations/{invitation_id}")
def get_invitation(invitation_id: str, company: dict = Depends(employer)):
    with _db(write=True) as connection:
        return _snapshot(connection, _refresh(connection, _owned(connection, invitation_id, company["id"])))


@router.post("/invitations/{invitation_id}/admit")
def admit(invitation_id: str, company: dict = Depends(employer)):
    with _db(write=True) as connection:
        row = _refresh(connection, _owned(connection, invitation_id, company["id"]))
        _require_open(row)
        template = _template(connection, row["template_id"])
        if template["mode"] != "human":
            raise HTTPException(409, "AI面接は応募者の開始操作で始まります。")
        if row["status"] == "in_progress":
            return _snapshot(connection, row)
        if row["status"] != "waiting":
            raise HTTPException(409, "応募者が参加準備を終えるまでお待ちください。")
        deadline = min(_now() + timedelta(minutes=template["duration_minutes"]), _date(row["expires_at"]))
        connection.execute("UPDATE invitations SET status='in_progress',started_at=?,deadline_at=? WHERE id=?", (_iso(), _iso(deadline), invitation_id))
        return _snapshot(connection, _owned(connection, invitation_id, company["id"]))


@router.post("/join/lookup")
def lookup(body: Lookup, request: Request):
    _rate("lookup:" + _ip(request), 60)
    with _db(write=True) as connection:
        row = connection.execute("SELECT * FROM invitations WHERE code=?", (body.code,)).fetchone()
        if not row:
            raise HTTPException(404, "参加コードを確認してください。")
        row = _refresh(connection, row)
        # A lookup may explain a future/expired invite, but never includes applicant data.
        template = _template(connection, row["template_id"])
        company_name = connection.execute("SELECT name FROM companies WHERE id=?", (row["company_id"],)).fetchone()[0]
        return {"id": row["id"], "company_name": company_name,
                **{key: template[key] for key in ("title", "job_title", "mode", "duration_minutes")},
                "opens_at": row["opens_at"], "expires_at": row["expires_at"], "status": _status(row), "ai_available": interview_ai.ai_available()}


@router.post("/join/start")
def start(body: Start, request: Request):
    _rate("start:" + _ip(request), 40)
    if not body.consent:
        raise HTTPException(422, "面接の記録と利用目的を確認し、同意してから開始してください。")
    with _db(write=True) as connection:
        row = connection.execute("SELECT * FROM invitations WHERE code=?", (body.code,)).fetchone()
        if not row:
            raise HTTPException(404, "参加コードを確認してください。")
        row = _refresh(connection, row)
        if row["token_hash"]:
            if body.resume_token and hmac.compare_digest(row["token_hash"], _hash(body.resume_token)):
                return {"token": body.resume_token, "session": _snapshot(connection, row, private=False)}
            raise HTTPException(409, "この招待は使用済みです。参加したブラウザで再開してください。")
        _require_open(row)
        if row["status"] != "invited":
            raise HTTPException(409, "この面接には参加できません。")
        if not body.name:
            raise HTTPException(422, "参加者のお名前を入力してください。")
        token = secrets.token_urlsafe(32)
        template = _template(connection, row["template_id"])
        ai = template["mode"] == "ai"
        deadline = min(_now() + timedelta(minutes=template["duration_minutes"]), _date(row["expires_at"])) if ai else None
        connection.execute(
            "UPDATE invitations SET token_hash=?,candidate_name=?,consent_at=?,status=?,started_at=?,deadline_at=? WHERE id=?",
            (_hash(token), body.name, _iso(), "in_progress" if ai else "waiting", _iso() if ai else None, _iso(deadline) if deadline else None, row["id"]),
        )
        if ai:
            _insert_turn(connection, row["id"], _turn("ai", template["questions"][0], 0, "local"))
        updated = connection.execute("SELECT * FROM invitations WHERE id=?", (row["id"],)).fetchone()
        return {"token": token, "session": _snapshot(connection, updated, private=False)}


@router.get("/session/{invitation_id}")
def get_session(invitation_id: str, authorization: str | None = Header(default=None)):
    return access_session(invitation_id, _bearer(authorization))[1]


def _request(connection, invitation_id, actor, request_id, payload_hash):
    previous = connection.execute("SELECT * FROM requests WHERE invitation_id=? AND actor=? AND request_id=?", (invitation_id, actor, request_id)).fetchone()
    if previous and previous["payload_hash"] != payload_hash:
        raise HTTPException(409, "同じ送信IDで異なる内容は送信できません。")
    return previous


def _busy(row):
    return row["busy_request"] and row["busy_since"] and (_now() - _date(row["busy_since"])).total_seconds() < RESERVATION_SECONDS


def _check_transcript_capacity(transcript: list[dict], text: str):
    if len(transcript) >= 400 or sum(len(turn["text"]) for turn in transcript) + len(text) > MAX_TRANSCRIPT_CHARS:
        raise HTTPException(413, "面接記録の上限に達しました。面接を終了してください。")


def _safe_next(template: dict, transcript: list[dict], proposal: dict) -> dict | None:
    """The server controls topic order, depth and time even after a provider failure."""
    proposal = proposal if isinstance(proposal, dict) else {}
    expected = interview_questions.local_next_question(template, transcript)
    if not expected.get("text"):
        return None
    index = expected["question_index"]
    text, source = expected["text"], "local"
    proposed_text = proposal.get("text") if isinstance(proposal, dict) else None
    if (expected["is_follow_up"] and proposal.get("question_index") == index
            and proposal.get("is_follow_up") is True and isinstance(proposed_text, str)
            and 1 <= len(proposed_text.strip()) <= 400 and interview_ai._safe_text(proposed_text)
            and proposed_text.strip() not in {turn["text"].strip() for turn in transcript if turn["role"] == "ai"}):
        text = proposed_text.strip()
        source = "ai" if proposal.get("source") == "ai" else "local"
    return _turn("ai", text, index, source)


async def _generate_private_report(invitation_id: str, retry: bool = False):
    reservation = _iso()
    with _db(write=True) as connection:
        row = connection.execute("SELECT * FROM invitations WHERE id=?", (invitation_id,)).fetchone()
        if row["status"] != "completed":
            raise HTTPException(409, "面接を終了してから集計してください。")
        if row["report"] and not retry:
            return
        if row["report_busy_since"] and (_now() - _date(row["report_busy_since"])).total_seconds() < RESERVATION_SECONDS:
            return
        template = _engine_template(connection, row)
        transcript = _transcript(connection, invitation_id)
        connection.execute("UPDATE invitations SET report_busy_since=? WHERE id=?", (reservation, invitation_id))
    try:
        report = await interview_ai.build_report(template, transcript)
    except Exception:
        report = interview_ai.local_report(template, transcript)
    with _db(write=True) as connection:
        connection.execute("UPDATE invitations SET report=?,report_busy_since=NULL WHERE id=? AND report_busy_since=?", (_json(report), invitation_id, reservation))


async def _generate_feedback(invitation_id: str, retry: bool = False):
    reservation = _iso()
    with _db(write=True) as connection:
        row = connection.execute("SELECT * FROM invitations WHERE id=?", (invitation_id,)).fetchone()
        if row["status"] != "completed":
            raise HTTPException(409, "面接終了後にフィードバックを作成できます。")
        if row["feedback"] and not retry:
            return
        if row["feedback_busy_since"] and (_now() - _date(row["feedback_busy_since"])).total_seconds() < RESERVATION_SECONDS:
            return
        template = _engine_template(connection, row)
        # The candidate-facing generator never receives employer assessment criteria.
        template = {key: template[key] for key in ("job_title", "questions", "_redact_names")}
        transcript = _transcript(connection, invitation_id)
        connection.execute("UPDATE invitations SET feedback_busy_since=? WHERE id=?", (reservation, invitation_id))
    try:
        feedback = await interview_ai.build_feedback(template, transcript)
    except Exception:
        feedback = interview_ai.local_feedback(template, transcript)
    with _db(write=True) as connection:
        connection.execute("UPDATE invitations SET feedback=?,feedback_busy_since=NULL WHERE id=? AND feedback_busy_since=?",
                           (_json(feedback), invitation_id, reservation))


async def _generate_report(invitation_id: str, retry: bool = False):
    # Independent reservations keep a candidate refresh from regenerating or
    # exposing the employer's private report. Both calls share provider limits.
    await asyncio.gather(_generate_private_report(invitation_id, retry),
                         _generate_feedback(invitation_id, retry))


@router.post("/session/{invitation_id}/answer")
async def answer(invitation_id: str, body: Answer, authorization: str | None = Header(default=None)):
    token = _bearer(authorization)
    payload_hash = _hash(_json([body.text, body.expected_turn_id]))
    with _db(write=True) as connection:
        role, row = _authorize(connection, invitation_id, token)
        if role != "candidate":
            raise HTTPException(403, "回答は応募者のみ送信できます。")
        row = _refresh(connection, row)
        previous = _request(connection, invitation_id, role, body.request_id, payload_hash)
        if previous and previous["status"] == "done":
            return _snapshot(connection, row, private=False)
        _require_open(row)
        template = _engine_template(connection, row)
        if template["mode"] != "ai" or row["status"] != "in_progress":
            raise HTTPException(409, "回答を受け付ける面接ではありません。")
        if _busy(row):
            raise HTTPException(409, "前の回答を処理しています。少し待って再送してください。")
        transcript = _transcript(connection, invitation_id)
        if not transcript or transcript[-1]["role"] != "ai" or transcript[-1]["id"] != body.expected_turn_id:
            raise HTTPException(409, "質問が更新されています。最新の面接画面を確認してください。")
        _check_transcript_capacity(transcript, body.text)
        _rate("answer:" + invitation_id, 30)
        connection.execute("INSERT INTO requests VALUES(?,?,?,?,?,?) ON CONFLICT(invitation_id,actor,request_id) DO UPDATE SET status='pending',created_at=excluded.created_at", (invitation_id, role, body.request_id, payload_hash, "pending", _iso()))
        connection.execute("UPDATE invitations SET busy_request=?,busy_since=? WHERE id=?", (body.request_id, _iso(), invitation_id))
        candidate_turn = _turn("candidate", body.text, transcript[-1]["question_index"], "human")
        # Commit accepted input before contacting the provider. A deadline,
        # disconnect or worker restart must never erase an accepted answer.
        _insert_turn(connection, invitation_id, candidate_turn)
        pending_transcript = [*transcript, candidate_turn]
    try:
        proposal = await interview_ai.next_question(template, pending_transcript)
    except Exception:
        proposal = {}
    completed = False
    with _db(write=True) as connection:
        _, row = _authorize(connection, invitation_id, token)
        row = _refresh(connection, row)
        previous = _request(connection, invitation_id, role, body.request_id, payload_hash)
        if previous and previous["status"] == "done":
            return _snapshot(connection, row, private=False)
        if row["status"] != "in_progress" or row["busy_request"] != body.request_id:
            raise HTTPException(409, "面接が終了または更新されたため回答を保存できませんでした。")
        next_turn = _safe_next(_engine_template(connection, row), pending_transcript, proposal)
        if next_turn:
            _insert_turn(connection, invitation_id, next_turn)
        else:
            completed = True
            connection.execute("UPDATE invitations SET status='completed',ended_at=? WHERE id=?", (_iso(), invitation_id))
        connection.execute("UPDATE requests SET status='done' WHERE invitation_id=? AND actor=? AND request_id=?", (invitation_id, role, body.request_id))
        connection.execute("UPDATE invitations SET busy_request=NULL,busy_since=NULL WHERE id=?", (invitation_id,))
    if completed:
        await _generate_report(invitation_id)
    return access_session(invitation_id, token)[1]


async def append_human_turn(invitation_id: str, token: str, text: str, request_id: str) -> dict:
    """Persist authenticated human speech/chat; never accept a client supplied role."""
    if not isinstance(text, str) or not 1 <= len(text.strip()) <= 6000:
        raise HTTPException(422, "発言は1文字から6000文字で入力してください。")
    if not isinstance(request_id, str) or not re.fullmatch(r"[A-Za-z0-9_-]{1,100}", request_id):
        raise HTTPException(422, "送信IDが不正です。")
    text = text.strip()
    payload_hash = _hash(text)
    with _db(write=True) as connection:
        role, row = _authorize(connection, invitation_id, token)
        row = _refresh(connection, row)
        previous = _request(connection, invitation_id, role, request_id, payload_hash)
        if previous and previous["status"] == "done":
            return _snapshot(connection, row, private=role == "interviewer")
        _require_open(row)
        if _template(connection, row["template_id"])["mode"] != "human" or row["status"] != "in_progress":
            raise HTTPException(409, "入室許可後の対人面接中のみ発言を記録できます。")
        transcript = _transcript(connection, invitation_id)
        _check_transcript_capacity(transcript, text)
        _rate("human-turn:" + invitation_id + ":" + role, 120)
        _insert_turn(connection, invitation_id, _turn(role, text, -1, "human"))
        connection.execute("INSERT INTO requests VALUES(?,?,?,?,?,?)", (invitation_id, role, request_id, payload_hash, "done", _iso()))
        return _snapshot(connection, row, private=role == "interviewer")


async def _finish(invitation_id: str, token: str, candidate_only: bool):
    with _db(write=True) as connection:
        role, row = _authorize(connection, invitation_id, token)
        row = _refresh(connection, row)
        mode = _template(connection, row["template_id"])["mode"]
        if candidate_only and (role != "candidate" or mode != "ai"):
            raise HTTPException(403, "この面接は企業担当者が終了します。")
        if not candidate_only and role != "interviewer":
            raise HTTPException(403, "企業担当者のみ操作できます。")
        if row["status"] != "completed":
            if row["status"] != "in_progress":
                raise HTTPException(409, "開始していない面接は終了できません。")
            if _busy(row):
                raise HTTPException(409, "回答の保存処理が終わるまでお待ちください。")
            connection.execute("UPDATE invitations SET status='completed',ended_at=?,busy_request=NULL,busy_since=NULL WHERE id=?", (_iso(), invitation_id))
    await _generate_report(invitation_id)
    return access_session(invitation_id, token)[1]


@router.post("/session/{invitation_id}/finish")
async def candidate_finish(invitation_id: str, authorization: str | None = Header(default=None)):
    return await _finish(invitation_id, _bearer(authorization), candidate_only=True)


@router.post("/invitations/{invitation_id}/finish")
async def employer_finish(invitation_id: str, company: dict = Depends(employer), authorization: str | None = Header(default=None)):
    with _db() as connection:
        _owned(connection, invitation_id, company["id"])
    return await _finish(invitation_id, _bearer(authorization), candidate_only=False)


@router.post("/invitations/{invitation_id}/report")
async def generate_report(invitation_id: str, company: dict = Depends(employer)):
    _rate("report:" + company["id"], 15)
    with _db(write=True) as connection:
        _refresh(connection, _owned(connection, invitation_id, company["id"]))
    await _generate_report(invitation_id, retry=True)
    with _db() as connection:
        return _snapshot(connection, _owned(connection, invitation_id, company["id"]))


@router.post("/session/{invitation_id}/feedback")
async def generate_candidate_feedback(invitation_id: str, authorization: str | None = Header(default=None)):
    token = _bearer(authorization)
    with _db(write=True) as connection:
        role, row = _authorize(connection, invitation_id, token)
        row = _refresh(connection, row)
        if row["status"] != "completed":
            raise HTTPException(409, "面接終了後にフィードバックを作成できます。")
    _rate("feedback:" + invitation_id + ":" + role, 6)
    await _generate_feedback(invitation_id, retry=True)
    return access_session(invitation_id, token)[1]


@router.post("/invitations/{invitation_id}/review")
def review(invitation_id: str, body: Review, company: dict = Depends(employer)):
    with _db(write=True) as connection:
        row = _refresh(connection, _owned(connection, invitation_id, company["id"]))
        if row["status"] != "completed":
            raise HTTPException(409, "面接を終了してから判断とメモを保存してください。")
        connection.execute("UPDATE invitations SET review=? WHERE id=?", (_json(body.model_dump()), invitation_id))
        return _snapshot(connection, _owned(connection, invitation_id, company["id"]))
