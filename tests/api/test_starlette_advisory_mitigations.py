from __future__ import annotations

import inspect

from starlette.endpoints import HTTPEndpoint
from starlette.routing import Mount
from starlette.staticfiles import StaticFiles

from cognivoy.api.main import app, selective_access_log


def test_no_starlette_static_files_mount_is_exposed() -> None:
    assert not any(
        isinstance(route, Mount) and isinstance(route.app, StaticFiles) for route in app.routes
    )


def test_no_http_endpoint_subclass_is_registered() -> None:
    for route in app.routes:
        endpoint = getattr(route, "endpoint", None)
        assert not (inspect.isclass(endpoint) and issubclass(endpoint, HTTPEndpoint))


def test_access_metrics_use_raw_scope_path() -> None:
    source = inspect.getsource(selective_access_log)
    assert 'request.scope.get("path"' in source
    assert "request.url.path" not in source
