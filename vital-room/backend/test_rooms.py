"""RoomManager(同意付き透明ルーム)のテスト。"""
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


if __name__ == "__main__":
    test_consent_required()
    test_two_party_snapshot()
    test_leave_cleanup()
    test_topic_share()
    print("\n=== ルーム全テスト通過 ===")
