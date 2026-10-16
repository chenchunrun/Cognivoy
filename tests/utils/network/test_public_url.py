from __future__ import annotations

import socket

import pytest

from cognivoy.utils.network.public_url import (
    is_disallowed_public_host,
    pin_public_http_url,
    validate_public_http_url,
)


def _resolved(address: str):
    def resolver(_host, _port, _family, _socktype):
        family = socket.AF_INET6 if ":" in address else socket.AF_INET
        return [(family, socket.SOCK_STREAM, 6, "", (address, 0))]

    return resolver


@pytest.mark.parametrize(
    "address",
    ["127.0.0.1", "10.1.2.3", "169.254.169.254", "::1", "::ffff:127.0.0.1"],
)
def test_disallows_non_public_dns_answers(address: str) -> None:
    assert is_disallowed_public_host("attacker.example", resolver=_resolved(address))


def test_allows_globally_routable_dns_answer() -> None:
    assert not is_disallowed_public_host("example.test", resolver=_resolved("93.184.216.34"))


def test_rejects_credentials_and_non_http_schemes() -> None:
    allowed, error = validate_public_http_url(
        "https://user:secret@example.com/path", host_validator=lambda _host: False
    )
    assert allowed is False
    assert "credentials" in error

    allowed, error = validate_public_http_url(
        "file:///etc/passwd", host_validator=lambda _host: False
    )
    assert allowed is False
    assert "scheme" in error.lower()


def test_pins_public_dns_answer_and_preserves_authority() -> None:
    target, error = pin_public_http_url(
        "https://example.test:8443/path?q=1",
        resolver=_resolved("93.184.216.34"),
    )
    assert error == ""
    assert target is not None
    assert target.connect_url == "https://93.184.216.34:8443/path?q=1"
    assert target.host_header == "example.test:8443"
    assert target.sni_hostname == "example.test"
    assert target.resolved_ip == "93.184.216.34"


def test_pinning_rejects_mixed_public_and_private_dns_answers() -> None:
    def resolver(_host, _port, _family, _socktype):
        return [
            (socket.AF_INET, socket.SOCK_STREAM, 6, "", ("93.184.216.34", 0)),
            (socket.AF_INET, socket.SOCK_STREAM, 6, "", ("127.0.0.1", 0)),
        ]

    target, error = pin_public_http_url("https://example.test/x", resolver=resolver)
    assert target is None
    assert "127.0.0.1" in error


@pytest.mark.parametrize(
    "url",
    [
        "https://example.com\\@127.0.0.1/",
        "https://example.com:99999/path",
        "https://%31%32%37.0.0.1/path",
        "https://example.com/path\nHost: 127.0.0.1",
    ],
)
def test_rejects_parser_differential_and_header_injection_inputs(url: str) -> None:
    allowed, _error = validate_public_http_url(url, host_validator=lambda _host: False)
    assert allowed is False
