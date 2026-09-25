"""RoomManager(同意付き透明ルーム)のテスト。"""
from unittest.mock import patch

from vital.rooms import RoomManager


def test_consent_required():
    print("\n[R1] 同意なしは参加拒否")
    rm = RoomManager()
    assert rm.join("r1", "c1", "candidate", "太郎", consent=False) is False
    assert rm.count("r1") == 0
    assert rm.join("r1", "c1", "candidate", "太郎", consent=True) is True
    assert rm.count("r1") == 1
    print("   OK")


def test_two_party_snapshot():
    print("\n[R2] 双方向: 2人参加→全員が両方を見られる")
    rm = RoomManager()
    rm.join("room", "a", "interviewer", "面接官", True)
    rm.join("room", "b", "candidate", "就活生", True)
    rm.update_vitals("room", "a", {"current_bpm": 68.0, "stress": 10.0})
    rm.update_vitals("room", "b", {"current_bpm": 92.0, "stress": 60.0})
    snap = rm.snapshot("room")
    assert len(snap) == 2
    roles = {m["role"] for m in snap}
    assert roles == {"interviewer", "candidate"}
    by_id = {m["client_id"]: m for m in snap}
    assert by_id["a"]["vitals"]["current_bpm"] == 68.0
    assert by_id["b"]["vitals"]["stress"] == 60.0
    print(f"   参加者: {[(m['role'], m['name'], m['vitals']) for m in snap]}")
    print("   OK")


def test_leave_cleanup():
    print("\n[R3] 退出でルームから消え、空なら破棄")
    rm = RoomManager()
    rm.join("x", "a", "interviewer", "面接官", True)
    rm.join("x", "b", "candidate", "就活生", True)
    rm.leave("x", "a")
    assert rm.count("x") == 1
    assert [m["client_id"] for m in rm.snapshot("x")] == ["b"]
    rm.leave("x", "b")
    assert rm.count("x") == 0
    assert rm.snapshot("x") == []
    print("   OK")


def test_topic_share():
    print("\n[R4] トピック共有: 設定→取得、空室で破棄")
    rm = RoomManager()
    rm.join("t", "a", "interviewer", "面接官", True)
    assert rm.get_topic("t") == ""
    rm.set_topic("t", "志望動機について")
    assert rm.get_topic("t") == "志望動機について"
    rm.leave("t", "a")                 # 空室 → トピックも破棄
    assert rm.get_topic("t") == ""
    print("   OK")


def test_transcript():
    print("\n[R5] 文字起こし: フラグ・ログ・役割取得")
    rm = RoomManager()
    rm.join("v", "i", "interviewer", "面接官", True)
    rm.join("v", "c", "candidate", "就活生", True)
    assert rm.get_transcribe("v") is False
    assert rm.get_role("v", "i") == "interviewer"
    rm.set_transcribe("v", True)
    assert rm.get_transcribe("v") is True
    rm.add_transcript("v", {"name": "就活生", "role": "candidate", "text": "よろしくお願いします"})
    rm.add_transcript("v", {"name": "面接官", "role": "interviewer", "text": "志望動機を教えてください"})
    log = rm.get_transcript("v")
    assert len(log) == 2 and log[1]["text"].startswith("志望動機")
    rm.leave("v", "i"); rm.leave("v", "c")   # 空室で破棄
    assert rm.get_transcribe("v") is False and rm.get_transcript("v") == []
    print("   OK")


def test_question_history_and_cleanup():
    rm = RoomManager()
    assert rm.set_topic("missing", "ignored") is False
    assert rm.get_question_id("missing") == 0
    assert rm.get_questions("missing") == []
    rm.join("questions", "i", "interviewer", "面接官", True)
    rm.join("questions", "c", "candidate", "参加者", True)
    with patch("vital.rooms.time.time", side_effect=[1000.1, 1000.2, 1000.3]):
        rm.set_topic("questions", "自己紹介")
        rm.set_topic("questions", "自己紹介")
        rm.set_topic("questions", "志望動機")
    assert rm.get_questions("questions") == [
        {"id": 1, "topic": "自己紹介", "started_at": 1000100},
        {"id": 2, "topic": "自己紹介", "started_at": 1000200},
        {"id": 3, "topic": "志望動機", "started_at": 1000300},
    ]
    # Public history copies cannot mutate room state.
    rm.get_questions("questions")[0]["topic"] = "changed"
    assert rm.get_questions("questions")[0]["topic"] == "自己紹介"
    rm.leave("questions", "i")
    assert rm.get_question_id("questions") == 3
    rm.leave("questions", "c")
    assert rm.get_question_id("questions") == 0
    assert rm.get_questions("questions") == []
    rm.join("questions", "i2", "interviewer", "面接官", True)
    rm.set_topic("questions", "新しい面接")
    assert rm.get_question_id("questions") == 1


def test_question_history_is_bounded():
    rm = RoomManager()
    rm.join("bounded", "i", "interviewer", "面接官", True)
    for _ in range(RoomManager.MAX_QUESTIONS):
        assert rm.set_topic("bounded", "繰り返し") is True
    assert rm.set_topic("bounded", "上限を超えた質問") is False
    questions = rm.get_questions("bounded")
    assert len(questions) == RoomManager.MAX_QUESTIONS
    assert questions[0]["id"] == 1
    assert questions[-1]["id"] == RoomManager.MAX_QUESTIONS
    assert rm.get_question_id("bounded") == RoomManager.MAX_QUESTIONS
    assert rm.get_topic("bounded") == "繰り返し"


def test_vitals_keep_original_question_and_update_timestamp():
    rm = RoomManager()
    rm.join("vitals", "c", "candidate", "参加者", True)
    initial = rm.snapshot("vitals")[0]
    assert initial["vitals_updated_at"] == 0
    assert initial["vitals_question_id"] == 0
    with patch("vital.rooms.time.time", return_value=1000):
        rm.update_vitals("vitals", "c", {"current_bpm": 70})
        rm.set_topic("vitals", "自己紹介")
        # A topic broadcast must not reassign an old measurement to the new question.
        cached = rm.snapshot("vitals")[0]
        assert cached["vitals_question_id"] == 0
        assert cached["vitals_updated_at"] == 1000000
        rm.update_vitals("vitals", "c", {"current_bpm": 80})
        fresh = rm.snapshot("vitals")[0]
        assert fresh["vitals_question_id"] == 1
        assert fresh["vitals_updated_at"] == 1000001
        assert fresh["vitals"]["current_bpm"] == 80


if __name__ == "__main__":
    test_consent_required()
    test_two_party_snapshot()
    test_leave_cleanup()
    test_topic_share()
    test_transcript()
    test_question_history_and_cleanup()
    test_question_history_is_bounded()
    test_vitals_keep_original_question_and_update_timestamp()
    print("\n=== ルーム全テスト通過 ===")
