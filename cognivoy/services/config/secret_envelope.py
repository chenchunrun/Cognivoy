"""Authenticated encryption for credentials persisted by Cognivoy.

The application stores only a versioned AES-GCM envelope in ordinary JSON
files.  A deployment may inject ``COGNIVOY_MASTER_KEY``; local installs get
an owner-only random key below ``data/system/private``.  The latter protects
credentials from accidental workspace exposure and copied settings files,
while production backups should keep the master key in an external secret
manager.
"""

from __future__ import annotations

import base64
import hashlib
import json
import os
from pathlib import Path
import stat
from typing import Any

from cryptography.hazmat.primitives.ciphers.aead import AESGCM

_FORMAT = "cognivoy-aesgcm-v1"
_LEGACY_FORMATS = frozenset({"openmentor-aesgcm-v1"})
_ENV_KEY = "COGNIVOY_MASTER_KEY"


class SecretEnvelopeError(RuntimeError):
    """The encrypted payload or deployment key is unavailable or invalid."""


def is_encrypted_envelope(value: Any) -> bool:
    return isinstance(value, dict) and value.get("_encrypted") in {_FORMAT, *_LEGACY_FORMATS}


def _key_path() -> Path:
    from cognivoy.multi_user import paths

    return Path(paths.SYSTEM_ROOT) / "private" / "master.key"


def _decode_file_key(raw: bytes) -> bytes:
    try:
        key = base64.urlsafe_b64decode(raw.strip())
    except Exception as exc:
        raise SecretEnvelopeError("The Cognivoy master key file is invalid.") from exc
    if len(key) != 32:
        raise SecretEnvelopeError("The Cognivoy master key must decode to 32 bytes.")
    return key


def _master_key() -> bytes:
    configured = os.environ.get(_ENV_KEY, "")
    if configured:
        # A deployment secret may be a 32-byte urlsafe key or a high-entropy
        # passphrase supplied by its secret manager.  Hashing gives AES-GCM a
        # fixed-size key without writing the source secret to disk.
        try:
            decoded = base64.urlsafe_b64decode(configured.encode("ascii"))
        except Exception:
            decoded = b""
        return decoded if len(decoded) == 32 else hashlib.sha256(configured.encode()).digest()

    path = _key_path()
    path.parent.mkdir(parents=True, exist_ok=True)
    try:
        os.chmod(path.parent, stat.S_IRWXU)
    except OSError:
        pass
    try:
        return _decode_file_key(path.read_bytes())
    except FileNotFoundError:
        encoded = base64.urlsafe_b64encode(AESGCM.generate_key(bit_length=256))
        try:
            descriptor = os.open(path, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
        except FileExistsError:
            return _decode_file_key(path.read_bytes())
        with os.fdopen(descriptor, "wb") as handle:
            handle.write(encoded + b"\n")
            handle.flush()
            os.fsync(handle.fileno())
        return _decode_file_key(encoded)


def encrypt_json(value: dict[str, Any], *, purpose: str) -> dict[str, str]:
    nonce = os.urandom(12)
    plaintext = json.dumps(value, ensure_ascii=False, sort_keys=True).encode("utf-8")
    ciphertext = AESGCM(_master_key()).encrypt(nonce, plaintext, purpose.encode("utf-8"))
    return {
        "_encrypted": _FORMAT,
        "nonce": base64.urlsafe_b64encode(nonce).decode("ascii"),
        "ciphertext": base64.urlsafe_b64encode(ciphertext).decode("ascii"),
    }


def decrypt_json(value: dict[str, Any], *, purpose: str) -> dict[str, Any]:
    if not is_encrypted_envelope(value):
        raise SecretEnvelopeError("The value is not a Cognivoy secret envelope.")
    try:
        nonce = base64.urlsafe_b64decode(str(value["nonce"]).encode("ascii"))
        ciphertext = base64.urlsafe_b64decode(str(value["ciphertext"]).encode("ascii"))
        plaintext = AESGCM(_master_key()).decrypt(nonce, ciphertext, purpose.encode("utf-8"))
        decoded = json.loads(plaintext.decode("utf-8"))
    except Exception as exc:
        raise SecretEnvelopeError("The encrypted credential store cannot be decrypted.") from exc
    if not isinstance(decoded, dict):
        raise SecretEnvelopeError("The decrypted credential store is not an object.")
    return decoded


def seal_sensitive_fields(
    value: Any,
    *,
    purpose: str,
    sensitive_names: frozenset[str],
    path: tuple[str, ...] = (),
) -> Any:
    """Encrypt non-empty values whose field name is explicitly sensitive."""
    if isinstance(value, dict):
        sealed: dict[str, Any] = {}
        for raw_key, item in value.items():
            key = str(raw_key)
            item_path = (*path, key)
            if key.lower() in sensitive_names and item not in (None, "", {}, []):
                sealed[key] = {
                    "$secret": encrypt_json(
                        {"value": item}, purpose=f"{purpose}:{'/'.join(item_path)}"
                    )
                }
            else:
                sealed[key] = seal_sensitive_fields(
                    item,
                    purpose=purpose,
                    sensitive_names=sensitive_names,
                    path=item_path,
                )
        return sealed
    if isinstance(value, list):
        return [
            seal_sensitive_fields(
                item,
                purpose=purpose,
                sensitive_names=sensitive_names,
                path=(*path, str(index)),
            )
            for index, item in enumerate(value)
        ]
    return value


def unseal_sensitive_fields(value: Any, *, purpose: str, path: tuple[str, ...] = ()) -> Any:
    """Reverse :func:`seal_sensitive_fields`, rejecting tampered envelopes."""
    if isinstance(value, dict):
        if set(value) == {"$secret"} and isinstance(value["$secret"], dict):
            decoded = decrypt_json(value["$secret"], purpose=f"{purpose}:{'/'.join(path)}")
            return decoded.get("value")
        return {
            str(key): unseal_sensitive_fields(item, purpose=purpose, path=(*path, str(key)))
            for key, item in value.items()
        }
    if isinstance(value, list):
        return [
            unseal_sensitive_fields(item, purpose=purpose, path=(*path, str(index)))
            for index, item in enumerate(value)
        ]
    return value


def has_plaintext_sensitive_fields(value: Any, *, sensitive_names: frozenset[str]) -> bool:
    """Return whether a legacy object still contains an unsealed secret value."""
    if isinstance(value, dict):
        for raw_key, item in value.items():
            key = str(raw_key).lower()
            if key in sensitive_names and item not in (None, "", {}, []):
                if not (
                    isinstance(item, dict)
                    and set(item) == {"$secret"}
                    and isinstance(item.get("$secret"), dict)
                ):
                    return True
            if has_plaintext_sensitive_fields(item, sensitive_names=sensitive_names):
                return True
    elif isinstance(value, list):
        return any(
            has_plaintext_sensitive_fields(item, sensitive_names=sensitive_names) for item in value
        )
    return False


__all__ = [
    "SecretEnvelopeError",
    "decrypt_json",
    "encrypt_json",
    "has_plaintext_sensitive_fields",
    "is_encrypted_envelope",
    "seal_sensitive_fields",
    "unseal_sensitive_fields",
]
