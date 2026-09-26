"""Evidence-linked coaching shared with candidates and interviewers.

Only public questions and what was actually said inform this feedback. Private
review criteria, hiring decisions and biometrics are deliberately not inputs.
"""
from __future__ import annotations

import json
import re
from collections import Counter
from datetime import datetime, timezone


MAX_QUESTIONS = 20
MAX_TURNS = 200
MAX_LOCAL_TURNS = 400
MAX_TEXT = 6000
MAX_BYTES = 128 * 1024
_UNSAFE = re.compile(
    r"採用|不採用|合否|合格|不合格|適性|向いて|性格|人格|人柄|誠実|不誠実|嘘|"
    r"正直|診断|心拍|ストレス|緊張|不安|容姿|外見|人種|民族|国籍|宗教|"
    r"妊娠|結婚|婚姻|家族構成|性的指向|性自認|障害|年齢|性別|支持政党|"
    r"[0-9０-９]+\s*(?:点|点満点)|[A-EＳＡＢＣＤＥ]\s*評価|総合評価|スコア|"
    r"(?:ignore|disregard|override).{0,60}(?:instruction|prompt|system)|"
    r"system\s*(?:prompt|message)|developer\s*message|"
    r"(?:指示|命令|プロンプト).{0,30}(?:無視|上書き)|"
    r"(?:無視|上書き).{0,30}(?:指示|命令|プロンプト)|"
    r"システムプロンプト|API[ _-]?キー|api[ _-]?key|秘密鍵|https?://|<[^>]+>|"
    r"\b(?:hire|hiring|reject|score|ranking|personality|honest|dishonest|nervous|"
    r"anxiety|diagnos\w*|ethnic\w*|religio\w*|pregnan\w*|marital|gender|race|nationality)\b",
    re.IGNORECASE,
)
_EMPTY_ANSWER = re.compile(r"^(?:はい|いいえ|わかりません|分かりません|思いつきません|ありません|特にありません|パス)[。.!！\s]*$")
_NEGATION = re.compile(r"(?:していません|しません|しなかった|していない|できません|できなかった|ではありません|していませんでした)")

# Recognition describes wording that is present, never the person's ability.
_FEATURES = {
    "role": (re.compile(r"(?:私[はが]|自分[はがの]|自身[はがの]).{0,35}(?:担当|役割|受け持)|を担当|担当(?:した|しました|して|は)|役割は"),
             "自分の担当を説明", "担当や役割を述べた箇所があります。", "自分が担った範囲", "[自分の担当範囲]と[チーム全体の役割]を分けて説明する"),
    "action": (re.compile(r"(?:実施|提案|作成|共有|調査|相談|練習|設計|検証|改善|分担|整理|開発|分析|確認|工夫|話し合|取り組|働きかけ)(?:し|を|ん|い|ま|た)"),
               "行動を言葉にしている", "取り組みや行動に関する表現があります。", "行動についての説明", "[自分が実際に行ったこと]を実行した順に二つ挙げる。予定の行動とは区別する"),
    "reason": (re.compile(r"なぜなら|理由|ため|ので|判断した|考えたのは"),
               "理由・背景に触れている", "理由や背景を説明する表現があります。", "その行動を選んだ理由", "[当時の課題]と[その方法を選んだ理由]を一文ずつ補う"),
    "result": (re.compile(r"結果|達成|増え|減り|減ら|向上|改善され|成功|完成|つなが|繋が|上が|下が|完了|できるよう"),
               "結果に触れている", "結果や変化について述べた箇所があります。", "行動の後に起きた変化", "[行動の前後の変化]を、実際に確認できた範囲で説明する"),
    "detail": (re.compile(r"[0-9０-９]+\s*(?:人|件|回|日|週|月|年|時間|分|割|倍|%|％)|[一二三四五六七八九十百]+(?:人|件|回|日|週間|時間|割|倍)"),
               "規模・期間などを具体化", "人数・回数・期間などを示す表現があります。", "取り組みの規模や期間", "[人数・期間・回数など分かる事実]を一つ添える。分からない数字は補わない"),
    "learning": (re.compile(r"学(?:び|ん)|気づ|気付|次(?:は|回)|今後|活か|生か|振り返"),
                 "学び・次の行動に触れている", "学びや今後の行動を述べた箇所があります。", "経験から得た学び", "[この経験で分かったこと]と[次に試すこと]を結び付ける"),
    "motive": (re.compile(r"志望|興味|魅力|関心|惹か|ひか|希望|携わ|働きたい"),
               "関心・志望を言葉にしている", "関心や志望について述べる表現があります。", "関心を持った点", "[仕事のどの点に関心があるか]を最初の一文で伝える"),
    "work_link": (re.compile(r"職種|仕事|業務|事業|サービス|製品|開発|エンジニア|営業|企画|研究|御社|貴社"),
                  "仕事との接点に触れている", "仕事や事業に関する具体的な言葉があります。", "志望する仕事との接点", "[実際に調べた職種や事業の特徴]と[自分の関心]のつながりを説明する"),
    "experience_link": (re.compile(r"経験|大学|ゼミ|研究|授業|アルバイト|活動|取り組|制作|開発した|作成した"),
                        "経験・活動に触れている", "経験や活動について述べる表現があります。", "関心につながった経験やきっかけ", "[関心を持つきっかけになった出来事]を、実際に経験した範囲で一つ添える"),
    "goal": (re.compile(r"たい|目指|目標|将来|挑戦|身につけ|身に付け"),
             "今後の希望を言葉にしている", "希望や目標を表す言葉があります。", "今後の目標", "[何を学びたいか・できるようになりたいか]を一文で示す"),
    "goal_reason": (re.compile(r"なぜなら|理由|ため|ので|きっかけ|関心|興味"),
                    "目標の理由に触れている", "理由や関心を説明する表現があります。", "その目標を選んだ理由", "[その目標に関心を持った理由]を、自分の考えや経験と結び付けて説明する"),
    "next_step": (re.compile(r"まず|次に|毎[日週月]|予定|計画|始め|取り組|練習|受講|参加|実装|作成|試す|勉強"),
                  "進め方に触れている", "取り組み方や次の行動について述べる表現があります。", "次に取る具体的な行動", "[最初に取り組むこと]と[いつ・どのくらい行うか]を、今の計画として説明する"),
    "progress": (re.compile(r"確かめ|振り返|検証|比較|目安|目標値|達成|測|記録|フィードバック|進捗|できたか|理解でき"),
                 "進み具合の確認に触れている", "進み具合の確認や振り返りに関する言葉があります。", "進み具合の確かめ方", "[どんな状態になれば前進したと分かるか]と[確認する時期]を考える"),
}
_CONTEXT_FEATURES = {
    "past": ("role", "action", "reason", "result", "detail", "learning"),
    "motivation": ("motive", "work_link", "experience_link"),
    "future": ("goal", "goal_reason", "next_step", "progress", "detail"),
}


def _question_kind(question: str) -> str:
    if re.search(r"志望|応募.{0,8}理由|(?:当社|弊社|この会社|この職種).{0,12}(?:選|興味|関心|魅力)", question):
        return "motivation"
    # A goal can belong to a completed experience. Explicit retrospective
    # wording takes precedence over the broad future-topic word "目標".
    if re.search(r"(?:過去|これまで|以前).{0,30}(?:経験|活動|取り組|出来事)|"
                 r"(?:達成した|取り組んだ|挑戦した|実現した|学んだ).{0,25}(?:経験|出来事|こと)|"
                 r"(?:経験|出来事)(?:について|を)(?:教え|話|聞かせ|説明)", question):
        return "past"
    if re.search(r"今後|将来|これから|キャリア|目標|学びたい|身につけたい|身に付けたい|挑戦したい|やりたい|入社後", question):
        return "future"
    return "past"


def _stamp() -> str:
    return datetime.now(timezone.utc).isoformat()


def _safe(text: str) -> bool:
    return not _UNSAFE.search(text)


def _questions(template: dict) -> list[str]:
    values = template.get("questions", [])
    if not isinstance(values, list):
        return []
    return [q.strip()[:1000] for q in values if isinstance(q, str) and q.strip()][:MAX_QUESTIONS]


def _groups(template: dict, transcript: list[dict]) -> list[dict]:
    questions = _questions(template)
    groups = {}
    for turn in transcript[:MAX_LOCAL_TURNS]:
        if not isinstance(turn, dict) or turn.get("role") not in {"candidate", "ai", "interviewer"}:
            continue
        index = turn.get("question_index", -1)
        if type(index) is not int or not -1 <= index < MAX_QUESTIONS:
            continue
        if index not in groups:
            question = questions[index] if 0 <= index < len(questions) else "対人面接でのやり取り" if index == -1 else "面接中の質問"
            groups[index] = {"question_index": index, "question": question if _safe(question) else "面接中の質問", "turns": []}
        text, turn_id = turn.get("text"), turn.get("id")
        if turn.get("role") == "candidate" and isinstance(text, str) and text.strip() and isinstance(turn_id, str) and 0 < len(turn_id) <= 200:
            groups[index]["turns"].append({"id": turn_id, "text": text[:MAX_TEXT]})
    return list(groups.values())[:MAX_QUESTIONS]


def _segments(turns: list[dict]) -> list[dict]:
    result = []
    for turn in turns:
        # Exact slices, including punctuation, keep every quotation verifiable.
        for match in re.finditer(r"[^。！？!?\n]+[。！？!?]?", turn["text"]):
            raw = match.group().strip()
            if raw and _safe(raw):
                for offset in range(0, min(len(raw), MAX_TEXT), 350):
                    quote = raw[offset:offset + 350]
                    if quote.strip():
                        result.append({"turn_id": turn["id"], "quote": quote})
    return result


def _outline(features: dict, kind: str = "past") -> list[str]:
    if kind == "motivation":
        return [
            "結論：[志望する理由・関心を持った点]を一文で伝える",
            "仕事との接点：[調べた職種や事業の特徴]と[自分の関心]を結び付ける",
            "きっかけ：[関心につながった実際の経験や出来事]を一つ添える",
            "希望：[その仕事で取り組んでみたいこと]を、自分の希望として述べる",
        ]
    if kind == "future":
        return [
            "目標：[今後学びたいこと・目指す状態]を一文で伝える",
            "理由：[その目標を選んだ理由やきっかけ]を説明する",
            "行動：[まず取り組むこと]と[開始時期・頻度]を、これからの計画として述べる",
            "確認：[進み具合を確かめる方法]と[振り返る時期]を考える",
        ]
    return [
        "結論：[質問への答え]を最初の一文で伝える",
        "背景・役割：[取り組んだ状況]と[自分の担当範囲]を説明する",
        "行動・理由：話した行動から[自分がしたこと]と[その理由]を整理する" if "action" in features else "行動・理由：[実際に自分がしたこと]と[その方法を選んだ理由]を補う",
        "結果・学び：[確認できた変化]と[分かったこと]を述べる。未確認の結果は未確認と伝える",
    ]


def local_feedback(template: dict, transcript: list[dict]) -> dict:
    """Create bounded, specific coaching from observable wording alone."""
    groups = _groups(template, transcript)
    reviews, strengths, improvements = [], [], []
    missing_counts = Counter()
    positive_seen, missing_seen = set(), set()
    answer_count = sum(len(group["turns"]) for group in groups)
    for group in groups:
        kind = _question_kind(group["question"])
        context_keys = _CONTEXT_FEATURES[kind]
        segments = _segments(group["turns"])
        substantive = [item for item in segments if not _EMPTY_ANSWER.fullmatch(item["quote"])]
        features = {}
        for key in context_keys:
            pattern = _FEATURES[key][0]
            evidence = next((item for item in substantive if pattern.search(item["quote"]) and not _NEGATION.search(item["quote"])), None)
            if evidence:
                features[key] = evidence
        missing = [key for key in context_keys if key != "detail" and key not in features]
        evidence = []
        for reference in list(features.values()) + segments:
            if reference not in evidence:
                evidence.append(reference)
            if len(evidence) == 3:
                break
        question = group["question"]
        if not segments:
            summary = "確認できる回答の記録がないため、回答内容への助言は作成していません。"
            review_improvements = ["記録がないことは、経験や能力がないことを意味しません。次回は回答が文字起こしに残っているか確認してください。"]
        elif not substantive or sum(len(item["quote"]) for item in substantive) < 20:
            summary = "短い回答が記録されています。引用の範囲では、答えの背景や詳しい説明までは確認できません。"
            review_improvements = {
                "past": ["回答内では具体的な出来事を確認できません。思い当たる経験を一つ選び、状況と自分がしたことを補ってください。経験がなければその旨を伝えて構いません。"],
                "motivation": ["回答内では関心を持った理由を詳しく確認できません。仕事のどの点に関心があり、何がきっかけだったかを補ってください。まだ考えている途中なら、その旨を伝えて構いません。"],
                "future": ["回答内では今後の目標や進め方を詳しく確認できません。学びたいこととその理由、まず試す行動を補ってください。未定の点は未定と伝えて構いません。"],
            }[kind]
        else:
            labels = [_FEATURES[key][3] for key, reference in features.items() if reference in evidence]
            summary = ("回答では、" + "・".join(labels[:4]) + "に触れています。詳しさや前後の文脈は引用で確認してください。") if labels else "記録された回答を引用しました。質問への答えとその理由を聞き手が追えるように、説明を整理する余地があります。"
            review_improvements = [f"回答内では{_FEATURES[key][3]}を明確に確認できません。{_FEATURES[key][4]}。" for key in missing[:3]]
            if not missing:
                review_improvements = ["質問への答えを冒頭に置き、理由と補足が続く順に並べ直して、同じ説明の繰り返しを減らせるか確認してください。"]
        review_strengths = [_FEATURES[key][2] for key, reference in features.items() if reference in evidence][:4]
        reviews.append({"question_index": group["question_index"], "question": question,
                        "summary": summary, "evidence": evidence, "strengths": review_strengths,
                        "improvements": review_improvements, "answer_outline": _outline(features, kind) if segments else []})
        for key, reference in features.items():
            if key not in positive_seen and len(strengths) < 4:
                positive_seen.add(key)
                strengths.append({"title": _FEATURES[key][1], "observation": _FEATURES[key][2],
                                  "evidence": [reference], "suggestion": "引用した箇所を残し、質問への答えとして伝わる順序になっているか読み返してください。"})
        if segments:
            for key in missing:
                missing_counts[key] += 1
            for key in missing[:3]:
                if key not in missing_seen and len(improvements) < 4:
                    missing_seen.add(key)
                    improvements.append({"title": _FEATURES[key][3] + "を補う", "observation": f"この質問への回答内では、{_FEATURES[key][3]}を明確に確認できません。経験の有無についての判断ではありません。",
                                         "evidence": evidence[:1], "suggestion": _FEATURES[key][4] + "。"})
    practice_plan = [_FEATURES[key][4] + "。" for key, _ in missing_counts.most_common(2)]
    if answer_count:
        practice_plan.append("質問別の構成例に沿って、実際の経験と今後の希望・計画を区別して60〜90秒で話し、録音で質問への答えが冒頭にあるか確認する。")
    summary = (f"回答{answer_count}件を、質問ごとに整理しました。発言の引用から、伝わっている要素と補足できる要素を振り返ります。表現に基づく整理のため、経験の有無や能力を判定するものではありません。"
               if answer_count else "面接の回答記録がないため、具体的なフィードバックはまだ作成できません。")
    if len(transcript) > MAX_LOCAL_TURNS:
        summary += f"この振り返りは先頭{MAX_LOCAL_TURNS}件の発言を対象にしています。"
    return {"version": 1, "source": "local", "generated_at": _stamp(), "summary": summary,
            "strengths": strengths, "improvements": improvements, "question_reviews": reviews,
            "practice_plan": practice_plan}


def _string(limit: int) -> dict:
    return {"type": "string", "minLength": 1, "maxLength": limit}


def _array(item: dict, limit: int) -> dict:
    return {"type": "array", "items": item, "maxItems": limit}


def _object(properties: dict) -> dict:
    return {"type": "object", "additionalProperties": False, "properties": properties, "required": list(properties)}


_EVIDENCE_SCHEMA = _array(_object({"turn_id": _string(200), "quote": _string(600)}), 3)
_POINT_SCHEMA = _object({"title": _string(80), "observation": _string(400), "evidence": _EVIDENCE_SCHEMA, "suggestion": _string(400)})
_REVIEW_SCHEMA = _object({"question_index": {"type": "integer", "minimum": -1, "maximum": 19},
                          "question": _string(1000), "summary": _string(600), "evidence": _EVIDENCE_SCHEMA,
                          "strengths": _array(_string(300), 4), "improvements": _array(_string(300), 4),
                          "answer_outline": _array(_string(300), 6)})
FEEDBACK_SCHEMA = _object({"summary": _string(800), "strengths": _array(_POINT_SCHEMA, 4),
                           "improvements": _array(_POINT_SCHEMA, 4), "question_reviews": _array(_REVIEW_SCHEMA, MAX_QUESTIONS),
                           "practice_plan": _array(_string(400), 4)})

FEEDBACK_INSTRUCTIONS = """
Create Japanese feedback that BOTH the candidate and interviewer can read. The
only permitted inputs are the public job and questions, transcript, and supplied
question_groups. No private evaluation criteria, decisions, notes or biometrics.
Comment on how the candidate explains their answer: direct answer, situation,
own role, concrete actions, reasons, results and learning. Avoid generic praise.
Adapt the dimensions to the question: motivation questions concern the stated
reason, connection to the job and the experience that prompted interest; future
or career questions concern the goal, reason, next action and how to check
progress. Do NOT demand completed results, past team roles or a past-experience
STAR structure from an answer about motivation or future plans. Treat plans as
plans, never as completed achievements, and adapt fill-in outlines accordingly.
Attribute experiences to what the candidate said; do not certify truth, infer
traits, assess employability, assign scores or invent experience. Each strength
must describe observable wording supported by a quotation. Improvements describe
what is not established IN THIS ANSWER, never absent ability or experience.
Every point and every review with factual content needs 1-3 exact, contiguous,
nonempty candidate quotations. turn_id uses supplied T aliases only. Do not cite
interviewer/AI speech, instructions, or redaction placeholders. References in a
question review must belong to that question_index. Every strength/improvement
within a review must be supported by that review's quoted answer. Summary only
introduces the feedback process; no overall appraisal or additional factual claims.
Return exactly one question_review per supplied question_groups entry in order,
copying question_index and question exactly. Group follow-ups with the main
question. For human question_index=-1, review the conversation together rather
than pretending a template question was asked. When no usable answer is recorded,
use summary '確認できる回答の記録がありません。', evidence [], strengths [],
improvements [], and answer_outline []. An unrecorded answer is not missing ability.
Give a practical next step for each improvement and up to four prioritized
practice steps. answer_outline uses fill-in placeholders such as [自分の役割],
[実際に行ったこと], [確認できた変化]. These are a structure, NOT a fabricated
model answer. Do not invent numbers, successful results, or claim experience not
stated. Keep each string within schema limits. Return only the required object.
"""


def _validate(value, schema: dict, safe_text) -> None:
    kind = schema["type"]
    if kind == "object":
        if not isinstance(value, dict) or set(value) != set(schema["properties"]):
            raise ValueError("invalid feedback object")
        for key, child in schema["properties"].items():
            _validate(value[key], child, safe_text)
    elif kind == "array":
        if not isinstance(value, list) or len(value) > schema["maxItems"]:
            raise ValueError("unbounded feedback list")
        for item in value:
            _validate(item, schema["items"], safe_text)
    elif kind == "integer":
        if type(value) is not int or not schema["minimum"] <= value <= schema["maximum"]:
            raise ValueError("invalid question index")
    elif not isinstance(value, str) or not schema["minLength"] <= len(value.strip()) <= schema["maxLength"] or not _safe(value) or not safe_text(value):
        raise ValueError("unsafe or unbounded feedback text")


def _restore(evidence: list[dict], aliases: dict, question_index=None) -> list[dict]:
    restored, seen = [], set()
    for reference in evidence:
        alias, quote = reference["turn_id"], reference["quote"]
        source = aliases.get(alias)
        if not isinstance(source, dict) or not isinstance(source.get("turn"), dict):
            raise ValueError("unknown evidence alias")
        turn = source["turn"]
        if turn.get("role") != "candidate" or not isinstance(turn.get("id"), str) or not turn["id"]:
            raise ValueError("non-candidate evidence")
        if quote not in source.get("text", "") or quote not in turn.get("text", ""):
            raise ValueError("fabricated or redacted quote")
        if question_index is not None and turn.get("question_index", -1) != question_index:
            raise ValueError("evidence from a different question")
        if (alias, quote) in seen:
            raise ValueError("duplicate evidence")
        seen.add((alias, quote))
        restored.append({"turn_id": turn["id"], "quote": quote})
    return restored


async def build_feedback(template: dict, transcript: list[dict], *, provider, provider_input, safe_text) -> dict:
    fallback = local_feedback(template, transcript)
    if provider is None or not any(review["evidence"] for review in fallback["question_reviews"]):
        return fallback
    try:
        if len(transcript) > MAX_TURNS:
            raise ValueError("too many turns")
        # Redaction metadata stays within provider_input and is never serialized.
        public_template = {"job_title": template.get("job_title", ""), "questions": _questions(template),
                           "criteria": [], "_redact_names": template.get("_redact_names", [])}
        public_turns = [{key: turn[key] for key in ("id", "role", "text", "question_index") if key in turn}
                        for turn in transcript if isinstance(turn, dict)]
        payload, aliases = provider_input(public_template, public_turns)
        payload = {key: payload[key] for key in ("job_title", "questions", "transcript") if key in payload}
        # The public group labels contain no applicant identity. A source question
        # uses the same redaction as the existing provider boundary.
        groups = _groups(template, transcript)
        provider_questions = payload.get("questions", [])
        expected = [{"question_index": group["question_index"],
                     "question": provider_questions[group["question_index"]] if 0 <= group["question_index"] < len(provider_questions) else group["question"]}
                    for group in groups]
        payload["question_groups"] = expected
        if len(json.dumps(payload, ensure_ascii=False).encode("utf-8")) > MAX_BYTES:
            raise ValueError("feedback input exceeds limit")
        generated = await provider("feedback", payload)
        if len(json.dumps(generated, ensure_ascii=False).encode("utf-8")) > MAX_BYTES:
            raise ValueError("feedback output exceeds limit")
        _validate(generated, FEEDBACK_SCHEMA, safe_text)
        if len(generated["question_reviews"]) != len(expected):
            raise ValueError("omitted question review")
        for point in generated["strengths"] + generated["improvements"]:
            if not point["evidence"]:
                raise ValueError("ungrounded feedback point")
            point["evidence"] = _restore(point["evidence"], aliases)
        for group, original_group, review in zip(expected, groups, generated["question_reviews"]):
            if review["question_index"] != group["question_index"] or review["question"] != group["question"]:
                raise ValueError("invented or reordered question")
            if not review["evidence"] and (review["summary"] != "確認できる回答の記録がありません。" or review["strengths"] or review["improvements"] or review["answer_outline"]):
                raise ValueError("ungrounded question review")
            review["evidence"] = _restore(review["evidence"], aliases, group["question_index"])
            if review["answer_outline"] and any("[" not in item or "]" not in item for item in review["answer_outline"]):
                raise ValueError("outline must contain fill-in placeholders")
            review["question"] = original_group["question"]
        # No unsupported global appraisal escapes even when other AI fields pass.
        generated["summary"] = fallback["summary"]
        return {"version": 1, "source": "ai", "generated_at": _stamp(), **generated}
    except Exception:
        return fallback
