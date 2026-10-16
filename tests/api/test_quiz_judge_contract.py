from cognivoy.api.routers.quiz_judge import parse_judge_result_line


def test_parse_judge_result_line_validates_structured_assessment() -> None:
    assessment = parse_judge_result_line(
        'JUDGE_RESULT: {"verdict":"partial","confidence":0.68,"score":2.5,"max_score":4}'
    )

    assert assessment == {
        "verdict": "partial",
        "confidence": 0.68,
        "score": 2.5,
        "max_score": 4.0,
        "review_recommended": True,
    }


def test_parse_judge_result_line_rejects_untrusted_or_out_of_range_values() -> None:
    assert parse_judge_result_line("✅ Correct") is None
    assert (
        parse_judge_result_line(
            'JUDGE_RESULT: {"verdict":"correct","confidence":2,"score":1,"max_score":1}'
        )
        is None
    )
