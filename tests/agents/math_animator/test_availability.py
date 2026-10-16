from cognivoy.agents.math_animator.availability import get_math_animator_readiness


def test_readiness_reports_isolation_requirement():
    readiness = get_math_animator_readiness()
    assert readiness.available is False
    assert readiness.missing_dependencies == ("isolated-renderer",)
    assert "isolated" in readiness.install_hint
