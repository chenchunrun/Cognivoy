from cognivoy.services.prompt.language import infer_response_language


def test_follows_natural_chinese_and_english_turns() -> None:
    assert infer_response_language("请解释后训练", "en") == "zh"
    assert infer_response_language("继续", "en") == "zh"
    assert infer_response_language("Explain post-training", "zh") == "en"
    assert infer_response_language("continue", "zh") == "en"


def test_explicit_language_request_wins_over_message_language() -> None:
    assert infer_response_language("请用英文回答：什么是后训练？", "zh") == "en"
    assert infer_response_language("Please explain RAG, but answer in Chinese", "en") == "zh"


def test_ambiguous_code_and_symbols_keep_saved_preference() -> None:
    assert infer_response_language("x=1", "zh") == "zh"
    assert infer_response_language("?", "en") == "en"
