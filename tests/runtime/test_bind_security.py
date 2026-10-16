from __future__ import annotations

import pytest

from cognivoy.runtime.bind_security import is_loopback_bind, require_authenticated_remote_bind


@pytest.mark.parametrize("host", ["127.0.0.1", "::1", "[::1]", "localhost"])
def test_loopback_bind_is_local(host: str) -> None:
    assert is_loopback_bind(host)
    require_authenticated_remote_bind(host, auth_enabled=False)


@pytest.mark.parametrize("host", ["0.0.0.0", "::", "192.168.1.10", "server.local"])
def test_remote_bind_requires_authentication(host: str) -> None:
    assert not is_loopback_bind(host)
    with pytest.raises(RuntimeError, match="authentication is disabled"):
        require_authenticated_remote_bind(host, auth_enabled=False)
    require_authenticated_remote_bind(host, auth_enabled=True)
