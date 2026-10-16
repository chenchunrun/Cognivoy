from cognivoy.services.config.capabilities_settings import (
    _apply_chat_into_agents_yaml,
    _build_chat_block,
)


def test_extra_rounds_default_round_trip_disable_and_clamp():
    cfg = {}
    assert _build_chat_block(cfg)["max_extra_rounds"] == 8
    _apply_chat_into_agents_yaml(cfg, {"max_extra_rounds": 12})
    assert _build_chat_block(cfg)["max_extra_rounds"] == 12
    _apply_chat_into_agents_yaml(cfg, {"max_extra_rounds": 0})
    assert _build_chat_block(cfg)["max_extra_rounds"] == 0
    _apply_chat_into_agents_yaml(cfg, {"max_extra_rounds": 999})
    assert _build_chat_block(cfg)["max_extra_rounds"] == 24
    _apply_chat_into_agents_yaml(cfg, {"max_extra_rounds": -1})
    assert _build_chat_block(cfg)["max_extra_rounds"] == 0


def test_partial_settings_write_preserves_unrelated_chat_values():
    cfg = {"capabilities": {"chat": {"max_rounds": 11, "responding": {"max_tokens": 9000}}}}
    _apply_chat_into_agents_yaml(cfg, {"max_extra_rounds": 4})
    result = _build_chat_block(cfg)
    assert result["max_rounds"] == 11
    assert result["stage_budgets"]["responding"] == 9000
    assert _build_chat_block({})["stage_budgets"]["responding"] == 8000
