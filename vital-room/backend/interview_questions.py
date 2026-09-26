"""Deterministic interview branches with optional, bounded provider wording.

The scheduler, not the model, owns the primary-question order and follow-up
budget. Local questions depend on the current answer and already covered angles;
they do not quote untrusted candidate prose or infer an applicant's ability.
"""
from __future__ import annotations

import math
import re
import unicodedata
from difflib import SequenceMatcher


MAX_FOLLOW_UPS = 3
MAX_QUESTIONS = 20
MAIN_QUESTION_RESERVE_SECONDS = 45
FOLLOW_UP_RESERVE_SECONDS = 35

_REFUSAL = re.compile(
    r"答えたく(?:ない|ありません)|回答(?:は|を)?(?:控え|辞退|拒否)|"
    r"(?:話|お話|説明)したく(?:ない|ありません)|答え(?:られ|れ)ません|"
    r"(?:次の質問|別の質問)(?:に|へ|を)|(?:この質問|この話題).{0,8}(?:パス|飛ば|やめ)|"
    r"^(?:パス|スキップ)(?:します|でお願いします)?[。.!！\s]*$|"
    r"\b(?:prefer not to answer|decline to answer|skip this question)\b",
    re.IGNORECASE,
)
_NO_EXAMPLE = re.compile(
    r"(?:わかり|分かり|判り)ません|(?:思い(?:当たり|つき))ません|"
    r"(?:経験|具体例|例|エピソード).{0,8}(?:ない|ありません|ありませんでした)|"
    r"^(?:ないです|ありません|特にありません|覚えていません)[。.!！\s]*$|"
    r"\b(?:do not know|don't know|no experience|cannot recall)\b",
    re.IGNORECASE,
)
_FEATURES = {
    "context": re.compile(r"授業|学業|研究|ゼミ|サークル|部活|大学|学校|アルバイト|バイト|インターン|チーム|プロジェクト|開発|イベント|仕事|業務|店舗|活動"),
    "action": re.compile(r"担当|作成|実装|提案|調整|共有|分析|改善|作った|行った|取り組|話し合|説明|確認|検証|設計|相談|練習|計画|分担|比較"),
    "own_action": re.compile(r"私(?:は|が|の)|自分|自身|担当|一人で|個人で"),
    "reason": re.compile(r"(?:ため|ので|ことから|からです)|理由|判断|重視|狙い|仮説|選んだ|選び|原因"),
    "result": re.compile(r"結果|成果|達成|完成|短縮|向上|好評|成功|提出でき|導入でき|解決し|減(?:り|った|りました)|増(?:え|やせ)|改善(?:し|され|でき)|[0-9０-９]+\s*[%％倍]"),
    "measurement": re.compile(r"(?:前後|以前|実施前|導入前|昨年|先月|以前|従来).{0,25}(?:比|から|より)|アンケート|測定|集計|記録|検証|[0-9０-９]+\s*(?:[%％]|倍|件|時間|分|日|人|円|回)"),
    "learning": re.compile(r"学(?:び|んだ|べた)|気づ|気付|分かりました|わかりました|大切|重要|得た教訓|振り返"),
    "application": re.compile(r"今後|次回|次の機会|別の場面|別の活動|活か|生か|応用|再現|これから|継続"),
    "challenge": re.compile(r"課題|困難|苦労|難し|失敗|壁|反対|衝突|意見が|遅れ"),
}

# These recognize the intent of earlier follow-ups, including provider wording.
# A broad primary question does not itself count as a completed follow-up angle.
_ASKED_FOCUS = {
    "example": re.compile(r"具体例|場面を一つ|どのような状況|思い当たる"),
    "own_action": re.compile(r"(?:自身|自分|あなた|担当).{0,25}(?:担当|行っ|行動|作業|役割)|担当した作業"),
    "reason": re.compile(r"理由|なぜ|何を重視|選んだ|判断の根拠"),
    "result": re.compile(r"何が変わ|どのような結果|どんな結果|取り組みの結果|成果は|結果を教え"),
    "measurement": re.compile(r"どのように確かめ|どう(?:測|確かめ)|測定|比較した時期|結果.{0,12}(?:確かめ|測っ|検証|確認した方法)|指標"),
    "contribution": re.compile(r"寄与|貢献|結果につながった|ほかの要因|チーム全体の取り組み"),
    "learning": re.compile(r"何を学|どんな学び|学んだこと|経験を振り返|変えたい点|得た教訓"),
    "application": re.compile(r"別の場面|条件が違う|次回.{0,12}(?:生か|活か|行動)|学び.{0,12}(?:生か|活か|応用)"),
    "challenge": re.compile(r"難しかった|困難|苦労|乗り越え|うまくいかな"),
    "motivation": re.compile(r"理由|きっかけ|関心を持|重視して"),
    "role_connection": re.compile(r"希望する仕事|仕事との接点|職務との接点|どのような点がつなが"),
    "first_step": re.compile(r"まずどのような|最初の一歩|始める予定|第一歩"),
    "approach": re.compile(r"どのような順序|必要な準備|進める方法|進め方を考え"),
    "verification": re.compile(r"今後どのように確かめ|目安にしたい|進捗をどう確認"),
    "future_example": re.compile(r"今後の学業|試してみたいこと"),
}
_FOCUS_DESCRIPTIONS = {
    "example": "抽象的な回答を、実際の一つの場面・状況に具体化する",
    "own_action": "チームの活動と区別して、本人が担当した行動を確認する",
    "reason": "直前に述べた行動・工夫を選んだ理由と判断過程を確認する",
    "result": "その取り組みで実際に何が変わったかを確認する",
    "measurement": "直前に述べた結果をどう確かめたか、比較や記録を確認する",
    "contribution": "述べた結果と本人の働きかけの関係を、ほかの要因と分けて確認する",
    "learning": "その経験で得た学びや、振り返って変えたい点を確認する",
    "application": "述べた学びを、条件の違う場面でどう生かすかを確認する",
    "challenge": "進める中での難しさと、それに応じて変えた行動を確認する",
    "motivation": "述べた将来の目標や関心を持った理由・きっかけを確認する。過去の実績は前提にしない",
    "role_connection": "本人の興味や学びと、希望する仕事との接点を確認する。職務経験は前提にしない",
    "first_step": "将来の目標に向けた最初の具体的な行動を尋ねる。既に実行したとはみなさない",
    "approach": "これから取り組む際の順序・方法・準備を確認する。過去の結果は前提にしない",
    "verification": "将来の取り組みをどのような目安で確かめたいかを尋ねる。達成済みの成果は前提にしない",
    "future_example": "答えが浮かばない場合、今後試したいことを一度だけ尋ねる。過去の実績を求めず、思い当たらない回答も受け入れる",
}


def _questions(template: dict) -> list[str]:
    return [text.strip() for text in template.get("questions", [])
            if isinstance(text, str) and text.strip()][:MAX_QUESTIONS]


def _canonical(text: str) -> str:
    return "".join(char for char in unicodedata.normalize("NFKC", text).casefold()
                   if char.isalnum())


def _repeated(text: str, previous: list[str]) -> bool:
    key = _canonical(text)
    if not key:
        return True
    for old in previous:
        other = _canonical(old)
        if key == other:
            return True
        if min(len(key), len(other)) >= 16 and SequenceMatcher(None, key, other).ratio() >= 0.88:
            return True
    return False


def _features(text: str) -> set[str]:
    return {name for name, pattern in _FEATURES.items() if pattern.search(text)}


def _remaining_seconds(template: dict) -> float | None:
    value = template.get("_remaining_seconds")
    if isinstance(value, bool) or not isinstance(value, (int, float)) or not math.isfinite(value):
        return None
    return max(0.0, value)


def _question_kind(question: str, latest: str) -> str:
    if re.search(r"志望|応募.*理由|希望する.*仕事|働きたい|入社.*理由", question):
        return "motivation"
    # A goal may be part of a completed experience, not a future plan.
    if re.search(r"(?:過去|これまで|以前).{0,30}(?:経験|活動|取り組|出来事)|"
                 r"(?:達成した|取り組んだ|挑戦した|実現した|学んだ).{0,25}(?:経験|出来事|こと)|"
                 r"(?:経験|出来事)(?:について|を)(?:教え|話|聞かせ|説明)", question):
        return "experience"
    if re.search(r"今後|将来|目指|目標|学びたい|挑戦したい|やりたい|取り組みたい|興味|関心", question):
        return "future"
    # A plan is not an achieved result, even when it contains words such as
    # "improve" or "reduce" that also occur in descriptions of past outcomes.
    if (re.search(r"将来|今後|したい|学びたい|目指したい|取り組む予定", latest)
            and not re.search(r"しました|できました|なりました|だった|した経験", latest)):
        return "future"
    return "experience"


def _planned_focus_order(kind: str, combined: str, asked: set[str]) -> list[str]:
    order = []
    if "reason" not in _features(combined):
        order.append("motivation")
    if kind == "motivation":
        order.append("role_connection")
    order.append("first_step")
    if kind == "future":
        order.append("approach")
    order.append("verification")
    return [focus for focus in order if focus not in asked]


def _local_wording(focus: str, latest: str) -> str:
    if focus == "future_example":
        return "今後の学業・活動・仕事で、まず試してみたいことはありますか。思い当たらない場合は、その旨を教えてください。"
    if focus == "motivation":
        return "その目標や仕事に関心を持った理由や、きっかけを教えてください。特にどのような点を重視していますか。"
    if focus == "role_connection":
        return "これまでの学びや興味と、希望する仕事のどのような点がつながると考えていますか。今分かる範囲で教えてください。"
    if focus == "first_step":
        return "その目標に向けて、まずどのようなことから始める予定ですか。まだ決まっていない点があれば、それも教えてください。"
    if focus == "approach":
        return "その取り組みを進めるとき、どのような順序や方法を考えていますか。必要な準備も含めて教えてください。"
    if focus == "verification":
        return "取り組みを進められたかどうか、今後どのように確かめたいですか。目安にしたいことを教えてください。"
    if focus == "example":
        if _NO_EXAMPLE.search(latest):
            return "学業・活動・日常の中で思い当たる具体例はありますか。思い当たらない場合は、その旨を教えてください。"
        return "いまのお話について、実際に取り組んだ場面を一つ選び、どのような状況だったか教えてください。"
    if focus == "own_action":
        return "その場面で、周囲の方と分担したことのうち、ご自身が担当して実際に行ったことを教えてください。"
    if focus == "reason":
        if re.search(r"共有|報告|連絡|進捗", latest):
            return "その情報共有の進め方を選んだ理由と、特に工夫した点を教えてください。"
        if re.search(r"提案|改善策|解決策", latest):
            return "その提案・改善策を選んだのはなぜですか。ほかの選択肢と比べたときの判断の根拠を教えてください。"
        if re.search(r"分析|調査|確認|検証", latest):
            return "その分析・確認の進め方を選んだ理由と、判断の根拠にした情報を教えてください。"
        return "いまお話しいただいた行動を選んだ理由を教えてください。ほかの方法も考えたうえで、何を重視して判断しましたか。"
    if focus == "result":
        return "その取り組みによって、実施前と比べて何が変わりましたか。分かる範囲で、結果を確認できた事実を教えてください。"
    if focus == "measurement":
        return "いまお話しいただいた結果は、どのように確かめましたか。比較した時期や記録など、判断の根拠を教えてください。"
    if focus == "contribution":
        other = "チーム全体の取り組み" if re.search(r"チーム|メンバー|みんな|全員|分担", latest) else "ほかの要因"
        return f"その結果につながった、ご自身の働きかけは何だと考えていますか。{other}との関係も含めて教えてください。"
    if focus == "learning":
        return "その経験から何を学びましたか。振り返って、次も続けたい工夫や変えたい点を教えてください。"
    if focus == "application":
        return "その学びを、条件が違う別の場面で生かすとしたら、まずどのように行動しますか。"
    return "その進め方で難しかった点と、乗り越えるために変えたことを具体的に教えてください。"


def _focus_order(latest: str, combined: str, asked: set[str]) -> list[str]:
    current = _features(latest)
    covered = _features(combined)
    preferred: list[str] = []
    if _NO_EXAMPLE.search(latest) or (len(latest.strip()) < 20 and not current & {"action", "result", "learning"}):
        preferred.append("example")
    if "learning" in current and "application" not in covered:
        preferred.append("application")
    if "result" in current:
        preferred.extend(["measurement", "contribution"] if "measurement" not in covered else ["contribution", "learning"])
    if "action" in current:
        if "own_action" not in covered and re.search(r"チーム|みんな|全員|メンバー|分担", combined):
            preferred.append("own_action")
        preferred.append("reason" if "reason" not in covered else "result")
    if "challenge" in current and "action" not in current:
        preferred.append("challenge")
    if not covered & {"context", "action", "result", "learning"}:
        preferred.append("example")
    for feature, focus in (("action", "own_action"), ("reason", "reason"),
                           ("result", "result"), ("learning", "learning"),
                           ("application", "application")):
        if feature not in covered:
            # Asking how to apply an unmentioned learning would invent a premise.
            if focus == "application" and "learning" not in covered:
                continue
            preferred.append(focus)
    preferred.extend(["challenge", "learning", "contribution", "result"])
    return [focus for focus in dict.fromkeys(preferred) if focus not in asked]


def _plan(template: dict, transcript: list[dict]) -> tuple[dict, dict]:
    questions = _questions(template)
    complete = {"text": "", "question_index": len(questions), "is_follow_up": False, "source": "local"}
    remaining = _remaining_seconds(template)
    if not questions or remaining == 0:
        return complete, {}
    turns = [turn for turn in transcript if turn.get("role") in {"ai", "interviewer", "candidate"}]
    if not turns:
        return {"text": questions[0], "question_index": 0, "is_follow_up": False, "source": "local"}, {}
    latest_turn = turns[-1]
    if latest_turn["role"] != "candidate":
        return {**complete, "question_index": latest_turn.get("question_index", 0)}, {}
    index = latest_turn.get("question_index", 0)
    if type(index) is not int or not 0 <= index < len(questions):
        return complete, {}
    branch = [turn for turn in turns if turn.get("question_index") == index]
    answers = [turn for turn in branch if turn["role"] == "candidate"]
    branch_questions = [str(turn.get("text", "")) for turn in branch if turn["role"] in {"ai", "interviewer"}]
    # Candidate count also bounds malformed/recovered histories missing an AI turn.
    depth = max(0, len(branch_questions) - 1, len(answers) - 1)
    latest = str(latest_turn.get("text", "")).strip()
    kind = _question_kind(questions[index], latest)
    combined = "\n".join(str(turn.get("text", "")) for turn in answers)
    covered = _features(combined)
    next_index = index + 1
    advance = ({"text": questions[next_index], "question_index": next_index,
                "is_follow_up": False, "source": "local"} if next_index < len(questions) else complete)
    if depth >= MAX_FOLLOW_UPS or _REFUSAL.search(latest):
        return advance, {}
    # One invitation to use an everyday example is enough; never pressure someone
    # to fabricate an experience after repeated "I don't know / no example".
    if _NO_EXAMPLE.search(latest) and (depth >= 1 or sum(bool(_NO_EXAMPLE.search(str(t.get("text", "")))) for t in answers) >= 2):
        return advance, {}
    if remaining is not None and remaining < (len(questions) - next_index) * MAIN_QUESTION_RESERVE_SECONDS + FOLLOW_UP_RESERVE_SECONDS:
        return advance, {}
    # This only decides when to stop asking for details; it is not an evaluation
    # of the answer's truth, quality, or the applicant's ability.
    if (kind == "experience" and len(combined) >= 130 and {"action", "own_action", "reason", "result"} <= covered
            and covered & {"measurement", "learning"}):
        return advance, {}
    asked = {focus for focus, pattern in _ASKED_FOCUS.items()
             if any(pattern.search(question) for question in branch_questions[1:])}
    focuses = (_focus_order(latest, combined, asked) if kind == "experience"
               else _planned_focus_order(kind, combined, asked))
    if kind != "experience" and _NO_EXAMPLE.search(latest) and "future_example" not in asked:
        focuses.insert(0, "future_example")
    for focus in focuses:
        text = _local_wording(focus, latest)
        if _repeated(text, branch_questions):
            continue
        return ({"text": text, "question_index": index, "is_follow_up": True, "source": "local"},
                {"follow_up_depth": depth + 1, "focus": focus, "question_kind": kind})
    return advance, {}


def local_next_question(template: dict, transcript: list[dict]) -> dict:
    """Pure scheduling/fallback; calling it never contacts a provider."""
    return _plan(template, transcript)[0]


async def next_question(template: dict, transcript: list[dict], *, provider, provider_input, safe_text) -> dict:
    """A provider may reword a follow-up, but cannot change its index or depth."""
    result, context = _plan(template, transcript)
    if not result["is_follow_up"] or provider is None:
        return result
    try:
        payload, _ = provider_input(template, transcript)
        index = result["question_index"]
        # All text sent here comes from the existing redacted, allowlisted payload.
        prior_questions = [turn["text"] for turn in payload["transcript"]
                           if turn["role"] in {"ai", "interviewer"} and turn["question_index"] == index]
        payload.update({
            "current_question_index": index,
            "follow_up_depth": context["follow_up_depth"],
            "max_follow_ups": MAX_FOLLOW_UPS,
            "focus": context["focus"],
            "question_kind": context["question_kind"],
            "focus_description": _FOCUS_DESCRIPTIONS[context["focus"]],
            "previous_branch_questions": [text[:1000] for text in prior_questions[-(MAX_FOLLOW_UPS + 1):]],
            "remaining_main_questions": len(_questions(template)) - index - 1,
        })
        generated = await provider("question", payload)
        if not isinstance(generated, dict) or set(generated) != {"text"}:
            raise ValueError("invalid follow-up structure")
        text = generated["text"]
        if not isinstance(text, str) or not 1 <= len(text.strip()) <= 400 or not safe_text(text):
            raise ValueError("unsafe or unbounded follow-up")
        previous = [str(turn.get("text", "")) for turn in transcript if turn.get("role") in {"ai", "interviewer"}]
        if _repeated(text, previous + _questions(template)):
            raise ValueError("repeated follow-up")
        if not re.search(r"[?？]|(?:教えて|聞かせ|説明|お話|伺|ください)|か[。\s]*$", text):
            raise ValueError("follow-up is not a question")
        return {**result, "text": text.strip(), "source": "ai"}
    except Exception:
        return result
