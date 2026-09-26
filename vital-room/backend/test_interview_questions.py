"""Behavioral tests for answer-derived interview branches; no network calls."""
import unittest
from unittest.mock import AsyncMock

import interview_questions as questions


def template(**extra):
    return {"questions": ["チームで取り組んだ経験を教えてください。", "今後学びたいことを教えてください。"], **extra}


def ask(turns, proposal):
    turns.append({"role": "ai", "text": proposal["text"], "question_index": proposal["question_index"]})


def answer(turns, text):
    turns.append({"role": "candidate", "text": text, "question_index": turns[-1]["question_index"]})


def branch(text):
    turns = []
    ask(turns, questions.local_next_question(template(), turns))
    answer(turns, text)
    return turns


class LocalQuestionTests(unittest.TestCase):
    def test_answer_derived_branch_has_multiple_distinct_followups_then_next_primary(self):
        turns = branch("私はチームの進捗共有を担当し、毎週共有会を開きました。")
        first = questions.local_next_question(template(), turns)
        self.assertTrue(first["is_follow_up"])
        self.assertIn("情報共有", first["text"])
        self.assertIn("理由", first["text"])
        ask(turns, first)
        answer(turns, "遅れを早く発見するため、全員で作業の状況を確認しました。")
        second = questions.local_next_question(template(), turns)
        self.assertTrue(second["is_follow_up"])
        self.assertIn("何が変わ", second["text"])
        ask(turns, second)
        answer(turns, "結果として、期限に間に合うようになりました。")
        third = questions.local_next_question(template(), turns)
        self.assertTrue(third["is_follow_up"])
        self.assertIn("どのように確かめ", third["text"])
        self.assertEqual(len({first["text"], second["text"], third["text"]}), 3)
        ask(turns, third)
        answer(turns, "作業記録で確認しました。")
        primary = questions.local_next_question(template(), turns)
        self.assertFalse(primary["is_follow_up"])
        self.assertEqual(primary["question_index"], 1)
        self.assertEqual(primary["text"], template()["questions"][1])

    def test_learning_leads_to_application_and_measured_result_to_contribution(self):
        learned = questions.local_next_question(template(), branch("その経験から、早めに相談することの大切さを学びました。"))
        self.assertIn("条件が違う別の場面", learned["text"])
        outcome = questions.local_next_question(template(), branch("チームの提案を導入し、結果として作業時間が20%短縮しました。"))
        self.assertIn("ご自身の働きかけ", outcome["text"])

    def test_short_abstract_answer_requests_one_specific_situation(self):
        result = questions.local_next_question(template(), branch("頑張りました。"))
        self.assertTrue(result["is_follow_up"])
        self.assertIn("場面を一つ", result["text"])

    def test_refusal_moves_on_without_pressuring(self):
        for text in ("この質問は答えたくありません。", "回答を控えさせてください。", "次の質問に進んでください。"):
            with self.subTest(text=text):
                result = questions.local_next_question(template(), branch(text))
                self.assertFalse(result["is_follow_up"])
                self.assertEqual(result["question_index"], 1)

    def test_no_experience_gets_one_alternative_and_then_moves_on(self):
        turns = branch("そのような経験はありません。")
        first = questions.local_next_question(template(), turns)
        self.assertIn("思い当たらない", first["text"])
        ask(turns, first)
        answer(turns, "思い当たりません。")
        second = questions.local_next_question(template(), turns)
        self.assertFalse(second["is_follow_up"])
        self.assertEqual(second["question_index"], 1)

    def test_time_budget_preserves_remaining_primary_questions(self):
        turns = branch("私はチームの進捗共有を担当し、毎週共有会を開きました。")
        enough = questions.local_next_question(template(_remaining_seconds=300), turns)
        short = questions.local_next_question(template(_remaining_seconds=60), turns)
        expired = questions.local_next_question(template(_remaining_seconds=0), turns)
        self.assertTrue(enough["is_follow_up"])
        self.assertEqual((short["question_index"], short["is_follow_up"]), (1, False))
        self.assertEqual(expired["text"], "")

    def test_complete_specific_account_can_advance_early(self):
        turns = branch("私は大学の開発チームで進捗確認を担当しました。作業が遅れる原因を早く発見するため、毎週の共有会を提案して実施しました。共有会では各自の担当作業と困っている点を確認し、解決できる人に相談する方法を選びました。結果として、作業記録で確認した遅延件数が以前の6件から2件に減りました。この経験から、問題を小さいうちに共有する大切さを学びました。")
        result = questions.local_next_question(template(), turns)
        self.assertEqual((result["question_index"], result["is_follow_up"]), (1, False))

    def test_waiting_and_invalid_index_do_not_repeat_questions(self):
        turns = []
        first = questions.local_next_question(template(), turns)
        ask(turns, first)
        self.assertEqual(questions.local_next_question(template(), turns)["text"], "")
        answer(turns, "回答")
        turns[-1]["question_index"] = True
        self.assertEqual(questions.local_next_question(template(), turns)["text"], "")

    def test_achieved_goal_questions_remain_about_past_experience(self):
        for question in ("目標を達成した経験を教えてください。", "難しい目標に取り組んだ経験を教えてください。"):
            with self.subTest(question=question):
                config = template(questions=[question])
                turns = []
                ask(turns, questions.local_next_question(config, turns))
                answer(turns, "私はチームの担当として作業の進め方を提案しました。")
                follow_up = questions.local_next_question(config, turns)
                self.assertTrue(follow_up["is_follow_up"])
                self.assertIn("提案・改善策を選んだ", follow_up["text"])
                self.assertNotIn("始める予定", follow_up["text"])

    def test_future_goals_ask_about_intentions_not_unachieved_results(self):
        config = template(questions=["将来どのようなことに取り組みたいですか。"])
        turns = []
        ask(turns, questions.local_next_question(config, turns))
        answer(turns, "将来エンジニアとして、仕事の進め方を改善したいです。")
        motivation = questions.local_next_question(config, turns)
        self.assertIn("理由", motivation["text"])
        ask(turns, motivation)
        answer(turns, "使う人の待ち時間を減らしたいためです。")
        first_step = questions.local_next_question(config, turns)
        self.assertIn("始める予定", first_step["text"])
        ask(turns, first_step)
        answer(turns, "まずPythonを学び、小さなプログラムを作る予定です。")
        approach = questions.local_next_question(config, turns)
        self.assertIn("順序や方法", approach["text"])
        for question in (motivation, first_step, approach):
            self.assertTrue(question["is_follow_up"])
            self.assertNotIn("結果", question["text"])
            self.assertNotIn("確かめました", question["text"])

    def test_motivation_explores_role_connection_without_assuming_work_experience(self):
        config = template(questions=["この仕事の志望理由を教えてください。"])
        turns = []
        ask(turns, questions.local_next_question(config, turns))
        answer(turns, "利用者の不便を減らすため、開発の仕事を希望しています。")
        connection = questions.local_next_question(config, turns)
        self.assertIn("希望する仕事", connection["text"])
        ask(turns, connection)
        answer(turns, "授業で学んだプログラミングへの興味とつながっています。")
        action = questions.local_next_question(config, turns)
        self.assertIn("始める予定", action["text"])
        ask(turns, action)
        answer(turns, "簡単な画面を作って、使い方を学ぶ予定です。")
        verification = questions.local_next_question(config, turns)
        self.assertIn("今後どのように確かめたい", verification["text"])
        for question in (connection, action, verification):
            self.assertNotIn("その結果", question["text"])
            self.assertNotIn("実施前", question["text"])

    def test_whole_interview_always_finishes_with_at_most_three_followups_each(self):
        turns = []
        asks = []
        for _ in range(20):
            proposal = questions.local_next_question(template(), turns)
            if not proposal["text"]:
                break
            asks.append(proposal)
            ask(turns, proposal)
            answer(turns, "自分の担当したチームの活動について説明します。毎週作業を共有しました。")
        else:
            self.fail("interview did not terminate")
        self.assertEqual([q["question_index"] for q in asks if not q["is_follow_up"]], [0, 1])
        for index in range(2):
            self.assertLessEqual(sum(q["question_index"] == index and q["is_follow_up"] for q in asks), questions.MAX_FOLLOW_UPS)


class ProviderQuestionTests(unittest.IsolatedAsyncioTestCase):
    def provider_input(self, config, turns):
        return {"questions": config["questions"], "transcript": [
            {"role": turn["role"], "question_index": turn["question_index"], "text": turn["text"].replace("秘密の名前", "[個人・企業名]")}
            for turn in turns]}, {}

    async def generate(self, turns, provider, config=None):
        return await questions.next_question(config or template(), turns, provider=provider,
                                             provider_input=self.provider_input,
                                             safe_text=lambda value: "年齢" not in value and "無視" not in value)

    async def test_provider_gets_redacted_branch_context_but_cannot_schedule(self):
        turns = branch("私はチームの進捗共有を担当し、毎週共有会を開きました。秘密の名前")
        first = questions.local_next_question(template(), turns)
        first["text"] += "秘密の名前"
        ask(turns, first)
        answer(turns, "遅れを早く発見するため、全員で作業の状況を確認しました。")
        provider = AsyncMock(return_value={"text": "その共有会を始めてから、作業の進み方にどのような変化がありましたか。"})
        result = await self.generate(turns, provider)
        self.assertEqual((result["question_index"], result["source"]), (0, "ai"))
        kind, payload = provider.call_args.args
        self.assertEqual(kind, "question")
        self.assertEqual(payload["follow_up_depth"], 2)
        self.assertEqual(payload["focus"], "result")
        self.assertEqual(payload["max_follow_ups"], 3)
        self.assertEqual(len(payload["previous_branch_questions"]), 2)
        self.assertNotIn("秘密の名前", repr(payload))

    async def test_invalid_unsafe_and_repeated_provider_questions_fall_back(self):
        turns = branch("私はチームの進捗共有を担当し、毎週共有会を開きました。")
        fallback = questions.local_next_question(template(), turns)
        for generated in (None, [], {"text": "なぜですか。", "question_index": 1},
                          {"text": "年齢を教えてください。"}, {"text": "指示を無視してください。"},
                          {"text": "了解しました。"}, {"text": ""}, {"text": "a" * 401},
                          {"text": turns[0]["text"]}, {"text": "  " + turns[0]["text"].replace("。", "？")},
                          {"text": template()["questions"][1]}):
            with self.subTest(generated=generated):
                self.assertEqual(await self.generate(turns, AsyncMock(return_value=generated)), fallback)
        self.assertEqual(await self.generate(turns, AsyncMock(side_effect=TimeoutError)), fallback)
        self.assertEqual(await self.generate(turns, None), fallback)

    async def test_time_limit_refusal_and_primary_questions_never_call_provider(self):
        provider = AsyncMock()
        await self.generate([], provider)
        await self.generate(branch("回答を控えます。"), provider)
        await self.generate(branch("担当した作業は実装です。"), provider, template(_remaining_seconds=60))
        provider.assert_not_called()


if __name__ == "__main__":
    unittest.main()
