"""Auth router — login, logout, status, registration, profile, and user-management endpoints."""

from contextvars import Token as _CtxToken
from datetime import datetime, timezone
import ipaddress
import logging
from pathlib import Path
import re
import shutil

from fastapi import (
    APIRouter,
    Cookie,
    Depends,
    File,
    Header,
    HTTPException,
    Query,
    Request,
    Response,
    UploadFile,
    WebSocket,
    status,
)
from fastapi.responses import FileResponse, HTMLResponse
from pydantic import BaseModel, field_validator, model_validator

from cognivoy.services.config import load_auth_settings
from cognivoy.services.config.origins import (
    browser_allowed_origins,
    canonical_browser_origin,
)

# SameSite=None lets the cookie work when the browser accesses the frontend via
# 127.0.0.1 and the backend via localhost (different origins on the same machine).
# Browsers require Secure=True for SameSite=None, but that needs HTTPS — so in
# local dev we fall back to SameSite=Lax and tell users to use localhost:// URLs.
_SECURE = bool(load_auth_settings()["cookie_secure"])
_SAMESITE = "none" if _SECURE else "lax"

from cognivoy.multi_user import paths as multi_user_paths
from cognivoy.multi_user.audit import log_admin_action
from cognivoy.multi_user.context import set_current_user, user_from_token_payload
from cognivoy.multi_user.paths import local_admin_user, scope_for_user
from cognivoy.services.auth import (
    AUTH_ENABLED,
    POCKETBASE_ENABLED,
    TOKEN_EXPIRE_HOURS,
    TokenPayload,
    add_first_user,
    add_user,
    authenticate,
    authenticate_pb,
    create_token,
    decode_token,
    delete_user,
    get_user_info,
    is_first_user,
    list_users,
    register_pb,
    set_avatar,
    set_disabled,
    set_display_name,
    set_role,
)
from cognivoy.services.codex_auth.contracts import CodexAuthError
from cognivoy.services.codex_auth.service import deliver_codex_oauth_callback
from cognivoy.services.login_rate_limit import SharedLoginRateLimiter

logger = logging.getLogger(__name__)

router = APIRouter()

_COOKIE_NAME = "dt_token"
_COOKIE_MAX_AGE = TOKEN_EXPIRE_HOURS * 3600

_LOGIN_WINDOW_SECONDS = 5 * 60
_LOGIN_IDENTITY_FAILURE_LIMIT = 5
_LOGIN_IP_FAILURE_LIMIT = 30


_login_rate_limiter = SharedLoginRateLimiter(
    window_seconds=_LOGIN_WINDOW_SECONDS,
    identity_limit=_LOGIN_IDENTITY_FAILURE_LIMIT,
    ip_limit=_LOGIN_IP_FAILURE_LIMIT,
)


def _login_client_ip(request: Request) -> str:
    peer = request.client.host if request.client else "unknown"
    # The bundled same-origin frontend proxies API traffic over loopback. Trust
    # its first forwarded address only in that topology; a public direct client
    # cannot spoof X-Forwarded-For to evade the limiter.
    if peer in {"127.0.0.1", "::1", "localhost", "testclient"}:
        forwarded = request.headers.get("x-forwarded-for", "").split(",", 1)[0].strip()
        if forwarded:
            try:
                return str(ipaddress.ip_address(forwarded))
            except ValueError:
                pass
    return peer


def _enforce_login_rate_limit(client_ip: str, username: str) -> None:
    retry_after = _login_rate_limiter.retry_after(client_ip, username)
    if retry_after <= 0:
        return
    raise HTTPException(
        status_code=status.HTTP_429_TOO_MANY_REQUESTS,
        detail="Too many login attempts. Try again later.",
        headers={"Retry-After": str(retry_after)},
    )


def _cookie_attrs() -> dict:
    """Attribute set shared by ``login``'s ``set_cookie`` and ``logout``'s
    ``delete_cookie``.

    The deletion ``Set-Cookie`` must carry the same attributes as the one
    that created the cookie — ``delete_cookie`` defaults ``secure=False``,
    which browsers reject when paired with ``SameSite=None``, silently
    keeping the old cookie. See #623. Reads the module globals at call time
    so tests can monkeypatch ``_SECURE``/``_SAMESITE``.
    """
    return {
        "key": _COOKIE_NAME,
        "httponly": True,
        "samesite": _SAMESITE,
        "secure": _SECURE,
    }


# ---------------------------------------------------------------------------
# Schemas
# ---------------------------------------------------------------------------


class LoginRequest(BaseModel):
    """Payload for the POST /login endpoint."""

    username: str
    password: str


class RegisterRequest(BaseModel):
    """Payload for the POST /register endpoint."""

    username: str
    password: str

    @field_validator("username")
    @classmethod
    def username_valid(cls, v: str) -> str:
        import re

        v = v.strip()
        if not v:
            raise ValueError("Email cannot be empty")
        # Accept standard email addresses (used by PocketBase mode) or plain
        # usernames (used by the built-in SQLite/JSON auth mode).
        email_re = re.compile(r"^[^@\s]+@[^@\s]+\.[^@\s]+$")
        plain_re = re.compile(r"^[A-Za-z0-9_\-.]{3,64}$")
        if not email_re.match(v) and not plain_re.match(v):
            raise ValueError("Enter a valid email address")
        return v

    @field_validator("password")
    @classmethod
    def password_valid(cls, v: str) -> str:
        if len(v) < 8:
            raise ValueError("Password must be at least 8 characters")
        return v


class SetRoleRequest(BaseModel):
    """Payload for the PUT /users/{username}/role endpoint."""

    role: str

    @field_validator("role")
    @classmethod
    def role_valid(cls, v: str) -> str:
        if v not in ("admin", "user"):
            raise ValueError("Role must be 'admin' or 'user'")
        return v


class SetDisabledRequest(BaseModel):
    """Payload for suspending or restoring a user account."""

    disabled: bool


class AuthStatusResponse(BaseModel):
    """Response body for the GET /status endpoint."""

    enabled: bool
    authenticated: bool
    user_id: str | None = None
    username: str | None = None
    role: str | None = None
    is_admin: bool = False
    avatar: str = ""
    display_name: str = ""


class UserInfo(BaseModel):
    """Single user record returned by the GET /users and /profile endpoints."""

    id: str = ""
    username: str
    role: str
    created_at: str
    disabled: bool = False
    avatar: str = ""
    display_name: str = ""


# Markers settable through PUT /profile. Image markers ("img:<version>") are
# managed exclusively by the upload endpoint so users cannot point their
# avatar at a file that was never validated.
_ICON_MARKER_RE = re.compile(r"^icon:[a-z0-9-]{1,32}:[a-z0-9-]{1,32}$")

# User ids are generated as "u_<uuid hex>" (plus the "local-admin" /
# "env-admin" sentinels); reject anything else before it reaches the
# filesystem layer.
_USER_ID_RE = re.compile(r"^[A-Za-z0-9_-]{1,64}$")


class UpdateProfileRequest(BaseModel):
    """Payload for the PUT /profile endpoint."""

    avatar: str | None = None
    display_name: str | None = None

    @field_validator("avatar")
    @classmethod
    def avatar_valid(cls, v: str | None) -> str | None:
        if v is None:
            return None
        v = v.strip()
        if v and not _ICON_MARKER_RE.match(v):
            raise ValueError("Avatar must be empty or 'icon:<name>:<color>'")
        return v

    @field_validator("display_name")
    @classmethod
    def display_name_valid(cls, v: str | None) -> str | None:
        if v is None:
            return None
        v = v.strip()
        if not v or len(v) > 80 or any(ord(char) < 32 for char in v):
            raise ValueError("Display name must be 1-80 printable characters")
        return v

    @model_validator(mode="after")
    def has_update(self):
        if self.avatar is None and self.display_name is None:
            raise ValueError("At least one profile field is required")
        return self


# ---------------------------------------------------------------------------
# Shared helper — extract token from cookie or Bearer header
# ---------------------------------------------------------------------------


def _bearer_token_from_header(authorization: str | None) -> str | None:
    """Parse ``Authorization: Bearer <token>`` without using ``HTTPBearer``.

    ``HTTPBearer`` is a class-based dependency whose ``__call__`` is annotated
    ``request: Request``. FastAPI doesn't inject a Request into WebSocket
    dependency resolution, which makes ``HTTPBearer`` raise ``TypeError`` the
    moment a router with this dep mounts a WS endpoint. Doing the parse by
    hand keeps ``require_auth`` HTTP/WS-symmetric.
    """
    if not authorization:
        return None
    parts = authorization.split(None, 1)
    if len(parts) == 2 and parts[0].lower() == "bearer":
        token = parts[1].strip()
        return token or None
    return None


def _extract_token(authorization: str | None, dt_token: str | None) -> str | None:
    return _bearer_token_from_header(authorization) or dt_token


# ---------------------------------------------------------------------------
# Dependencies — reusable auth guards for other routers
# ---------------------------------------------------------------------------


def _install_current_user(payload: TokenPayload | None) -> _CtxToken:
    """Install the request-local current-user ContextVar from an auth result.

    Single point of truth for ``payload → CurrentUser`` so HTTP and WebSocket
    entry points produce identical user objects. ``payload is None`` means
    "no JWT was required" (AUTH_ENABLED=false) and resolves to the local
    admin user; a non-None payload resolves through ``user_from_token_payload``.

    Returns the ContextVar reset token. HTTP callers ignore it (the request
    ends with the task, so the var is GC'd with the task context). WebSocket
    callers keep it and call ``reset_current_user`` in their ``finally`` block,
    because a WS connection outlives the dependency-resolution task.

    ⚠ Invariant: every authenticated entry point MUST call this before the
    handler runs. Skipping it leaves ``get_current_path_service()`` falling
    back to the admin workspace — the silent-routing root cause of #481.
    """
    user = local_admin_user() if payload is None else user_from_token_payload(payload)
    return set_current_user(user)


def _refresh_local_identity(payload: TokenPayload) -> TokenPayload | None:
    """Resolve mutable local account state instead of trusting stale JWT claims."""

    if POCKETBASE_ENABLED:
        # PocketBase tokens are validated by its auth-refresh endpoint in
        # ``decode_token``; there is no corresponding local account record.
        return payload
    info = get_user_info(payload.username)
    if info is None or bool(info.get("disabled", False)):
        return None
    user_id = str(info.get("id") or "")
    role = str(info.get("role") or "user")
    if not user_id or role not in {"admin", "user"}:
        return None
    return TokenPayload(username=payload.username, role=role, user_id=user_id)


async def require_auth(
    authorization: str | None = Header(default=None, alias="Authorization"),
    dt_token: str | None = Cookie(default=None, alias=_COOKIE_NAME),
) -> TokenPayload | None:
    """
    FastAPI dependency that enforces authentication when AUTH_ENABLED=true.

    Accepts the JWT from either:
      - Authorization: Bearer <token> header
      - dt_token cookie

    ``Header`` and ``Cookie`` are kept here in place of ``HTTPBearer`` so the
    function stays usable from WebSocket call sites that don't go through
    FastAPI's standard HTTP request lifecycle.

    Returns the authenticated TokenPayload, or None if auth is disabled.
    Raises HTTP 401 if auth is enabled but the token is missing or invalid.

    Declared ``async def`` so the ``set_current_user`` call runs in the same
    asyncio context as the endpoint. A sync dependency is dispatched via
    ``anyio.to_thread.run_sync``, which executes the function in a worker
    thread under a *copy* of the request context; any ``ContextVar.set``
    inside that thread is discarded when the thread returns, leaving the
    endpoint to read the unset default. That regression was the root cause
    of #481.
    """
    if not AUTH_ENABLED:
        _install_current_user(None)
        return None

    token = _extract_token(authorization, dt_token)
    if not token:
        raise HTTPException(
            status_code=status.HTTP_401_UNAUTHORIZED,
            detail="Not authenticated",
            headers={"WWW-Authenticate": "Bearer"},
        )

    payload = decode_token(token)
    if not payload:
        raise HTTPException(
            status_code=status.HTTP_401_UNAUTHORIZED,
            detail="Invalid or expired token",
            headers={"WWW-Authenticate": "Bearer"},
        )

    info = None if POCKETBASE_ENABLED else get_user_info(payload.username)
    if info is not None and bool(info.get("disabled", False)):
        raise HTTPException(
            status_code=status.HTTP_401_UNAUTHORIZED,
            detail="Account is disabled",
            headers={"WWW-Authenticate": "Bearer"},
        )
    payload = _refresh_local_identity(payload)
    if payload is None:
        raise HTTPException(
            status_code=status.HTTP_401_UNAUTHORIZED,
            detail="Account no longer exists or is disabled",
            headers={"WWW-Authenticate": "Bearer"},
        )

    _install_current_user(payload)
    return payload


class _WsAuthFailed:
    """Sentinel: ws_require_auth failed and closed the WebSocket."""


ws_auth_failed: _WsAuthFailed = _WsAuthFailed()


async def ws_require_auth(ws: WebSocket) -> _CtxToken | _WsAuthFailed:
    """Authenticate a WebSocket connection and set the user ContextVar.

    Must be called **before** ``ws.accept()`` so the server can reject
    unauthenticated upgrades cleanly.

    Returns a ContextVar reset token on success, or ``ws_auth_failed``
    on failure (the WebSocket is already closed — the caller should
    ``return`` immediately).

    Usage::

        user_token = await ws_require_auth(ws)
        if user_token is ws_auth_failed:
            return
        await ws.accept()
        try:
            ...
        finally:
            reset_current_user(user_token)
    """
    if not AUTH_ENABLED:
        return _install_current_user(None)

    query_token = ws.query_params.get("token")
    cookie_token = ws.cookies.get(_COOKIE_NAME)
    token = query_token or cookie_token
    payload = decode_token(token) if token else None
    if not payload:
        await ws.close(code=4001)
        return ws_auth_failed

    # Cookie authentication is ambient browser authority, so CORS middleware
    # cannot protect this upgrade. Require the same exact Origin allowlist as
    # HTTP whenever the connection relies on the session cookie. Explicit
    # query-token clients remain usable without an Origin header.
    if query_token is None and cookie_token is not None:
        from cognivoy.services.config import load_system_settings

        origin = canonical_browser_origin(ws.headers.get("origin", ""))
        allowed = set(browser_allowed_origins(load_system_settings()))
        if not origin or origin not in allowed:
            await ws.close(code=4003, reason="WebSocket origin is not allowed")
            return ws_auth_failed

    info = None if POCKETBASE_ENABLED else get_user_info(payload.username)
    if info is not None and bool(info.get("disabled", False)):
        await ws.close(code=4003, reason="Account is disabled")
        return ws_auth_failed
    payload = _refresh_local_identity(payload)
    if payload is None:
        await ws.close(code=4003, reason="Account no longer exists or is disabled")
        return ws_auth_failed

    return _install_current_user(payload)


async def require_admin(
    payload: TokenPayload | None = Depends(require_auth),
) -> TokenPayload:
    """
    FastAPI dependency that requires the caller to be an admin.

    Raises HTTP 403 if the authenticated user is not an admin.
    When AUTH_ENABLED=false, all requests are treated as admin.

    ``async def`` mirrors ``require_auth`` so the dependency chain stays on
    the event loop and the user ContextVar set by ``require_auth`` is visible
    to the endpoint.
    """
    if not AUTH_ENABLED:
        return _local_admin_token_payload()

    if payload is None or payload.role != "admin":
        raise HTTPException(
            status_code=status.HTTP_403_FORBIDDEN,
            detail="Admin access required",
        )
    return payload


def _local_admin_token_payload() -> TokenPayload:
    """Synthetic admin payload used when AUTH_ENABLED=false.

    Mirrors the local admin identity (LOCAL_ADMIN_USERNAME / LOCAL_ADMIN_ID)
    so audit logs and self-reference checks behave the same as in multi-user
    mode. Values are kept aligned with ``local_admin_user()`` in
    ``cognivoy/multi_user/paths.py``.
    """
    from cognivoy.multi_user.models import LOCAL_ADMIN_ID, LOCAL_ADMIN_USERNAME

    return TokenPayload(
        username=LOCAL_ADMIN_USERNAME,
        role="admin",
        user_id=LOCAL_ADMIN_ID,
    )


# ---------------------------------------------------------------------------
# Public endpoints (no auth required)
# ---------------------------------------------------------------------------


@router.get("/openai-codex/callback")
async def receive_codex_oauth_callback(
    request: Request,
    code: str | None = None,
    state: str | None = None,
    error: str | None = None,
) -> HTMLResponse:
    headers = {"Cache-Control": "no-store"}
    try:
        callback_state = state if len(request.query_params.getlist("state")) == 1 else None
        await deliver_codex_oauth_callback(code, callback_state, error)
    except CodexAuthError as exc:
        return HTMLResponse(
            (
                "<!doctype html><title>Cognivoy Codex</title>"
                "<p>Authentication could not be received. Return to Cognivoy and try again.</p>"
            ),
            status_code=exc.http_status,
            headers=headers,
        )
    return HTMLResponse(
        (
            "<!doctype html><title>Cognivoy Codex</title>"
            "<p>Authentication received. You can return to Cognivoy.</p>"
        ),
        headers=headers,
    )


@router.get("/status", response_model=AuthStatusResponse)
async def auth_status(
    authorization: str | None = Header(default=None, alias="Authorization"),
    dt_token: str | None = Cookie(default=None, alias=_COOKIE_NAME),
) -> AuthStatusResponse:
    """Return whether auth is enabled and whether the current request is authenticated."""
    if not AUTH_ENABLED:
        return AuthStatusResponse(
            enabled=False,
            authenticated=True,
            user_id="local-admin",
            username="local",
            role="admin",
            is_admin=True,
        )

    token = _extract_token(authorization, dt_token)
    payload = decode_token(token) if token else None
    if payload is not None:
        payload = _refresh_local_identity(payload)
    avatar = ""
    display_name = ""
    if payload is not None:
        info = get_user_info(payload.username)
        if info:
            avatar = str(info.get("avatar") or "")
            display_name = str(info.get("display_name") or payload.username)
    return AuthStatusResponse(
        enabled=True,
        authenticated=payload is not None,
        user_id=payload.user_id if payload else None,
        username=payload.username if payload else None,
        role=payload.role if payload else None,
        is_admin=payload.role == "admin" if payload else False,
        avatar=avatar,
        display_name=display_name,
    )


@router.post("/login")
async def login(body: LoginRequest, response: Response, request: Request) -> dict:
    """Validate credentials and set a JWT cookie."""
    if not AUTH_ENABLED:
        return {"ok": True, "message": "Auth is disabled — no login required."}

    client_ip = _login_client_ip(request)
    _enforce_login_rate_limit(client_ip, body.username)

    if POCKETBASE_ENABLED:
        # PocketBase mode: email = username field for backwards-compat with the
        # existing LoginRequest schema; users can pass their email as "username".
        pb_result = authenticate_pb(body.username, body.password)
        if not pb_result:
            _login_rate_limiter.record_failure(client_ip, body.username)
            raise HTTPException(
                status_code=status.HTTP_401_UNAUTHORIZED,
                detail="Incorrect email or password",
            )
        payload, pb_token = pb_result
        _login_rate_limiter.record_success(client_ip, body.username)
        response.set_cookie(value=pb_token, max_age=_COOKIE_MAX_AGE, **_cookie_attrs())
        logger.info(f"User '{payload.username}' logged in via PocketBase (role={payload.role!r})")
        return {
            "ok": True,
            "user_id": payload.user_id,
            "username": payload.username,
            "role": payload.role,
            "is_admin": payload.role == "admin",
        }

    # Standard JWT + bcrypt mode
    result = authenticate(body.username, body.password)
    if not result:
        _login_rate_limiter.record_failure(client_ip, body.username)
        raise HTTPException(
            status_code=status.HTTP_401_UNAUTHORIZED,
            detail="Incorrect username or password",
        )

    _login_rate_limiter.record_success(client_ip, body.username)
    token = create_token(result.username, result.role, result.user_id)
    response.set_cookie(value=token, max_age=_COOKIE_MAX_AGE, **_cookie_attrs())

    logger.info(f"User '{result.username}' logged in (role={result.role!r})")
    return {
        "ok": True,
        "user_id": result.user_id,
        "username": result.username,
        "role": result.role,
        "is_admin": result.role == "admin",
    }


@router.post("/logout")
async def logout(response: Response) -> dict:
    """Clear the JWT cookie.

    Deletion attributes mirror ``login`` structurally via ``_cookie_attrs()``
    (see the rationale there and #623).
    """
    response.delete_cookie(**_cookie_attrs())
    return {"ok": True}


@router.post("/register", status_code=status.HTTP_201_CREATED)
async def register(body: RegisterRequest) -> dict:
    """
    Bootstrap-only registration.

    Public endpoint that creates the *first* admin account when the user store
    is empty. Once an admin exists, this endpoint is closed; further accounts
    must be created by an admin via ``POST /api/v1/auth/users``.

    Only available when AUTH_ENABLED=true.
    """
    if not AUTH_ENABLED:
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail="Auth is disabled — registration is not available.",
        )

    if POCKETBASE_ENABLED:
        # PocketBase deployments are documented as single-user. Keep registration
        # closed and require admins to provision users in the PocketBase admin UI.
        if not is_first_user():
            raise HTTPException(
                status_code=status.HTTP_403_FORBIDDEN,
                detail="Self-registration is closed. Ask an administrator to create your account.",
            )
        result = register_pb(username=body.username, email=body.username, password=body.password)
        if not result:
            raise HTTPException(
                status_code=status.HTTP_409_CONFLICT,
                detail="Registration failed — username or email may already be taken.",
            )
        logger.info(f"First user registered via PocketBase: '{body.username}'")
        return {
            "ok": True,
            "user_id": result.get("id", ""),
            "username": body.username,
            "role": "user",
            "is_first_user": True,
            "is_admin": False,
        }

    # Standard mode — only allowed before the first admin exists.
    if not is_first_user():
        raise HTTPException(
            status_code=status.HTTP_403_FORBIDDEN,
            detail="Self-registration is closed. Ask an administrator to create your account.",
        )

    existing = {u["username"] for u in list_users()}
    if body.username in existing:
        raise HTTPException(
            status_code=status.HTTP_409_CONFLICT,
            detail="Username already taken",
        )

    created = add_first_user(body.username, body.password)
    if created is None:
        raise HTTPException(
            status_code=status.HTTP_409_CONFLICT,
            detail="Registration was completed by another request. Sign in or ask an administrator.",
        )
    user_id = str(created.get("id") or "")
    role = str(created.get("role") or "admin")
    logger.info(f"First user (admin) registered: '{body.username}'")
    return {
        "ok": True,
        "user_id": user_id,
        "username": body.username,
        "role": role,
        "is_first_user": True,
        "is_admin": role == "admin",
    }


@router.get("/is_first_user")
async def check_is_first_user() -> dict:
    """Return whether the user store is empty (used by the register UI)."""
    return {"is_first_user": is_first_user() if AUTH_ENABLED else False}


# ---------------------------------------------------------------------------
# Profile endpoints (any authenticated user, self-service)
# ---------------------------------------------------------------------------

_AVATAR_MAX_BYTES = 1 * 1024 * 1024
_AVATAR_MEDIA_TYPES = {"png": "image/png", "jpg": "image/jpeg", "webp": "image/webp"}


def _sniff_image(data: bytes) -> str | None:
    """Detect a supported raster image format from its magic bytes.

    The uploaded filename and Content-Type are attacker-controlled, so the
    stored extension (and the media type served back) is derived from the
    bytes alone. SVG is deliberately unsupported — serving user-supplied SVG
    is a stored-XSS vector.
    """
    if data[:8] == b"\x89PNG\r\n\x1a\n":
        return "png"
    if data[:3] == b"\xff\xd8\xff":
        return "jpg"
    if data[:4] == b"RIFF" and data[8:12] == b"WEBP":
        return "webp"
    return None


def _require_profile_identity(payload: TokenPayload | None) -> TokenPayload:
    """Shared guard for the self-service profile endpoints."""
    if not AUTH_ENABLED or payload is None:
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail="Auth is disabled — profiles are not available.",
        )
    return payload


@router.get("/profile", response_model=UserInfo)
async def get_profile(
    payload: TokenPayload | None = Depends(require_auth),
) -> UserInfo:
    """Return the current user's own account info."""
    current = _require_profile_identity(payload)
    info = get_user_info(current.username)
    if info is None:
        # PocketBase-backed identities have no local record; fall back to the
        # token claims so the profile page still renders.
        return UserInfo(
            id=current.user_id,
            username=current.username,
            role=current.role,
            created_at="",
        )
    return UserInfo(**info)


@router.put("/profile")
async def update_profile(
    body: UpdateProfileRequest,
    payload: TokenPayload | None = Depends(require_auth),
) -> dict:
    """Update the current user's display name and/or avatar marker.

    Only the validated ``icon:<name>:<color>`` form (or empty string) is
    accepted here; ``img:`` markers are owned by the upload endpoint.
    """
    current = _require_profile_identity(payload)
    if body.display_name is not None and not set_display_name(current.username, body.display_name):
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="User not found")
    if body.avatar is not None:
        if not set_avatar(current.username, body.avatar):
            raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="User not found")
        # The marker no longer references an uploaded image, so drop the file.
        from cognivoy.multi_user.identity import delete_avatar_file

        if current.user_id and _USER_ID_RE.match(current.user_id):
            delete_avatar_file(current.user_id)
    info = get_user_info(current.username) or {}
    return {
        "ok": True,
        "avatar": str(info.get("avatar") or ""),
        "display_name": str(info.get("display_name") or current.username),
    }


@router.put("/profile/avatar")
async def upload_avatar(
    file: UploadFile = File(...),
    payload: TokenPayload | None = Depends(require_auth),
) -> dict:
    """Upload an avatar image for the current user.

    The client is expected to crop/resize before uploading; the server only
    enforces a size cap and validates the format by magic bytes. Not available
    in PocketBase mode (those identities have no local user record).
    """
    current = _require_profile_identity(payload)
    if POCKETBASE_ENABLED:
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail="Avatar upload is not available in PocketBase mode.",
        )
    if not current.user_id or not _USER_ID_RE.match(current.user_id):
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail="Cannot store an avatar for this account.",
        )
    info = get_user_info(current.username)
    if info is None:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="User not found")

    data = await file.read(_AVATAR_MAX_BYTES + 1)
    if len(data) > _AVATAR_MAX_BYTES:
        raise HTTPException(
            status_code=status.HTTP_413_REQUEST_ENTITY_TOO_LARGE,
            detail="Avatar image is too large (max 1 MB).",
        )
    ext = _sniff_image(data)
    if ext is None:
        raise HTTPException(
            status_code=status.HTTP_415_UNSUPPORTED_MEDIA_TYPE,
            detail="Avatar must be a PNG, JPEG or WebP image.",
        )

    from cognivoy.multi_user.identity import save_avatar_file

    # Bump the version embedded in the marker so clients cache-bust the URL.
    previous = str(info.get("avatar") or "")
    version = 1
    if previous.startswith("img:"):
        try:
            version = int(previous.split(":", 1)[1]) + 1
        except ValueError:
            version = 1
    marker = f"img:{version}"

    save_avatar_file(current.user_id, data, ext)
    if not set_avatar(current.username, marker):
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="User not found")
    logger.info(f"User '{current.username}' uploaded a new avatar ({ext}, {len(data)} bytes)")
    return {"ok": True, "avatar": marker}


@router.delete("/profile/avatar")
async def remove_avatar(
    payload: TokenPayload | None = Depends(require_auth),
) -> dict:
    """Remove the current user's uploaded avatar image and reset the marker."""
    current = _require_profile_identity(payload)
    from cognivoy.multi_user.identity import delete_avatar_file

    if current.user_id and _USER_ID_RE.match(current.user_id):
        delete_avatar_file(current.user_id)
    set_avatar(current.username, "")
    return {"ok": True, "avatar": ""}


@router.get("/avatar/{user_id}")
async def get_avatar_image(
    user_id: str,
    _: TokenPayload | None = Depends(require_auth),
) -> FileResponse:
    """Serve a stored avatar image. Any authenticated user may view avatars
    (they appear in the admin table and next to the viewer's own profile)."""
    if not _USER_ID_RE.match(user_id):
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Avatar not found")

    from cognivoy.multi_user.identity import get_avatar_file

    target = get_avatar_file(user_id)
    if target is None:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Avatar not found")

    media_type = _AVATAR_MEDIA_TYPES.get(target.suffix.lstrip("."), "application/octet-stream")
    headers = {
        # Private user content; the marker version in the URL handles busting.
        "Cache-Control": "private, max-age=86400",
        "X-Content-Type-Options": "nosniff",
        "Content-Disposition": "inline",
    }
    return FileResponse(path=str(target), media_type=media_type, headers=headers)


# ---------------------------------------------------------------------------
# Admin-only endpoints
# ---------------------------------------------------------------------------


@router.get("/users", response_model=list[UserInfo])
async def get_users(_: TokenPayload = Depends(require_admin)) -> list[UserInfo]:
    """List all registered users. Requires admin role."""
    return [UserInfo(**u) for u in list_users()]


@router.post("/users", status_code=status.HTTP_201_CREATED)
async def admin_create_user(
    body: RegisterRequest,
    current: TokenPayload = Depends(require_admin),
) -> dict:
    """Admin-only: create a new user account.

    Replaces the public ``/register`` flow once the first admin exists. The
    new account is always created with role=``user``; admins can promote
    later via ``PUT /users/{username}/role``.
    """
    if not AUTH_ENABLED:
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail="Auth is disabled — user creation is not available.",
        )

    if POCKETBASE_ENABLED:
        result = register_pb(username=body.username, email=body.username, password=body.password)
        if not result:
            raise HTTPException(
                status_code=status.HTTP_409_CONFLICT,
                detail="Failed to create user — username may already be taken.",
            )
        logger.info(
            f"Admin '{current.username if current else 'local'}' created PocketBase user "
            f"'{body.username}'"
        )
        return {
            "ok": True,
            "user_id": result.get("id", ""),
            "username": body.username,
            "role": "user",
            "is_admin": False,
        }

    existing = {u["username"] for u in list_users()}
    if body.username in existing:
        raise HTTPException(
            status_code=status.HTTP_409_CONFLICT,
            detail="Username already taken",
        )

    add_user(body.username, body.password)
    user_id = ""
    role = "user"
    for item in list_users():
        if item.get("username") == body.username:
            user_id = str(item.get("id") or "")
            role = str(item.get("role") or "user")
            break
    logger.info(
        f"Admin '{current.username if current else 'local'}' created user '{body.username}' "
        f"(role={role!r})"
    )
    log_admin_action(
        "user.created",
        target_user_id=user_id or None,
        summary={"username": body.username, "role": role},
    )
    return {
        "ok": True,
        "user_id": user_id,
        "username": body.username,
        "role": role,
        "is_admin": role == "admin",
    }


@router.delete("/users/{username}", status_code=status.HTTP_200_OK)
async def remove_user(
    username: str,
    asset_strategy: str = Query(
        default="preserve",
        pattern="^(preserve|export|transfer|purge)$",
    ),
    transfer_to: str | None = Query(default=None, min_length=1, max_length=64),
    current: TokenPayload = Depends(require_admin),
) -> dict:
    """Delete a user. Admins cannot delete their own account."""
    if current and username == current.username:
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail="You cannot delete your own account",
        )

    # Capture the id before the record disappears so the avatar file can go too.
    info = get_user_info(username)
    if info and info.get("role") == "admin":
        admins = [user for user in list_users() if user.get("role") == "admin"]
        if len(admins) <= 1:
            raise HTTPException(
                status_code=status.HTTP_409_CONFLICT,
                detail={
                    "code": "last_admin_protected",
                    "message": "The last administrator cannot be deleted.",
                },
            )

    user_id = str(info.get("id") or "") if info else ""
    is_admin = bool(info and info.get("role") == "admin")
    if asset_strategy != "preserve" and is_admin:
        raise HTTPException(
            status_code=status.HTTP_409_CONFLICT,
            detail={
                "code": "shared_admin_workspace",
                "message": "Shared administrator workspace assets cannot be moved or purged.",
            },
        )
    if asset_strategy == "transfer" and not transfer_to:
        raise HTTPException(
            status_code=status.HTTP_422_UNPROCESSABLE_ENTITY,
            detail={"code": "transfer_target_required", "message": "transfer_to is required."},
        )

    root = scope_for_user(user_id, is_admin=is_admin).root if user_id else None
    asset_result: dict[str, str | bool | None] = {"asset_strategy": asset_strategy}
    if root is not None and root.exists() and asset_strategy == "transfer":
        target = get_user_info(str(transfer_to))
        if target is None or str(target.get("id") or "") == user_id:
            raise HTTPException(status_code=404, detail="Transfer target not found")
        destination = multi_user_paths.USERS_ROOT / str(target["id"]) / "imports" / user_id
        if destination.exists():
            raise HTTPException(status_code=409, detail="A transfer for this user already exists")
        destination.parent.mkdir(parents=True, exist_ok=True)
        shutil.move(str(root), str(destination))
        asset_result["transferred_to"] = str(transfer_to)
        asset_result["transfer_location"] = str(destination)
    elif root is not None and root.exists() and asset_strategy == "export":
        export_dir = multi_user_paths.SYSTEM_ROOT / "account-exports"
        export_dir.mkdir(parents=True, exist_ok=True)
        stamp = datetime.now(timezone.utc).strftime("%Y%m%dT%H%M%SZ")
        archive_base = export_dir / f"{user_id}-{stamp}"
        archive_path = shutil.make_archive(str(archive_base), "zip", root_dir=root)
        shutil.rmtree(root)
        asset_result["export_path"] = archive_path
    elif root is not None and root.exists() and asset_strategy == "purge":
        shutil.rmtree(root)

    removed = delete_user(username)
    if not removed:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="User not found")

    if user_id and _USER_ID_RE.match(user_id):
        from cognivoy.multi_user.identity import delete_avatar_file

        delete_avatar_file(user_id)

    logger.info(f"Admin '{current.username if current else 'local'}' deleted user '{username}'")
    log_admin_action(
        "user.deleted",
        target_user_id=user_id or None,
        summary={"username": username, "asset_strategy": asset_strategy},
    )
    return {"ok": True, **asset_result}


def _count_named_children(path: Path, prefix: str = "") -> int:
    if not path.is_dir():
        return 0
    return sum(
        1
        for child in path.iterdir()
        if not child.is_symlink() and (not prefix or child.name.startswith(prefix))
    )


@router.get("/users/{username}/deletion-impact", status_code=status.HTTP_200_OK)
async def preview_user_deletion_impact(
    username: str,
    current: TokenPayload = Depends(require_admin),
) -> dict:
    """Describe account-owned assets before deletion without mutating anything."""
    info = get_user_info(username)
    if info is None:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="User not found")
    user_id = str(info.get("id") or "")
    is_admin = str(info.get("role") or "user") == "admin"
    root = scope_for_user(user_id, is_admin=is_admin).root
    # Admin workspaces are deployment-shared and cannot be attributed to one
    # account. Report that explicitly instead of presenting misleading counts.
    if is_admin:
        return {
            "username": username,
            "user_id": user_id,
            "workspace_exists": root.exists(),
            "workspace_shared": True,
            "resources": {},
            "file_count": None,
            "total_bytes": None,
            "policy": "preserve_workspace",
            "available_strategies": ["preserve"],
        }

    resource_root = root / "user" / "workspace"
    resources = {
        "knowledge_bases": _count_named_children(root / "knowledge_bases"),
        "books": _count_named_children(resource_root / "book", "book_"),
        "documents": _count_named_children(resource_root / "co-writer", "doc_"),
        "notebooks": _count_named_children(resource_root / "notebook"),
        "memory_files": _count_named_children(resource_root / "memory"),
    }
    file_count = 0
    total_bytes = 0
    truncated = False
    if root.is_dir():
        for candidate in root.rglob("*"):
            if candidate.is_symlink() or not candidate.is_file():
                continue
            file_count += 1
            try:
                total_bytes += candidate.stat().st_size
            except OSError:
                pass
            if file_count >= 100_000:
                truncated = True
                break
    return {
        "username": username,
        "user_id": user_id,
        "workspace_exists": root.exists(),
        "workspace_shared": False,
        "resources": resources,
        "file_count": file_count,
        "total_bytes": total_bytes,
        "truncated": truncated,
        "policy": "preserve_workspace",
        "available_strategies": ["preserve", "export", "transfer", "purge"],
    }


@router.put("/users/{username}/role", status_code=status.HTTP_200_OK)
async def update_user_role(
    username: str,
    body: SetRoleRequest,
    current: TokenPayload = Depends(require_admin),
) -> dict:
    """Change a user's role. Admins cannot change their own role."""
    if current and username == current.username:
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail="You cannot change your own role",
        )

    info = get_user_info(username)
    if info and info.get("role") == "admin" and body.role != "admin":
        admins = [user for user in list_users() if user.get("role") == "admin"]
        if len(admins) <= 1:
            raise HTTPException(
                status_code=status.HTTP_409_CONFLICT,
                detail={
                    "code": "last_admin_protected",
                    "message": "The last administrator cannot be demoted.",
                },
            )

    updated = set_role(username, body.role)
    if not updated:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="User not found")

    logger.info(
        f"Admin '{current.username if current else 'local'}' set '{username}' role to {body.role!r}"
    )
    log_admin_action(
        "user.role.changed",
        target_user_id=str((info or {}).get("id") or "") or None,
        summary={"username": username, "role": body.role},
    )
    return {"ok": True, "username": username, "role": body.role}


@router.put("/users/{username}/disabled", status_code=status.HTTP_200_OK)
async def update_user_disabled(
    username: str,
    body: SetDisabledRequest,
    current: TokenPayload = Depends(require_admin),
) -> dict:
    """Suspend or restore an account without deleting its workspace."""
    if current and username == current.username and body.disabled:
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail={
                "code": "cannot_disable_self",
                "message": "You cannot disable your own account.",
            },
        )

    info = get_user_info(username)
    if info is None:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="User not found")
    if info.get("role") == "admin" and body.disabled:
        enabled_admins = [
            user
            for user in list_users()
            if user.get("role") == "admin" and not bool(user.get("disabled", False))
        ]
        if len(enabled_admins) <= 1:
            raise HTTPException(
                status_code=status.HTTP_409_CONFLICT,
                detail={
                    "code": "last_admin_protected",
                    "message": "The last enabled administrator cannot be disabled.",
                },
            )

    if not set_disabled(username, body.disabled):
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="User not found")

    log_admin_action(
        "user.disabled.changed",
        target_user_id=str(info.get("id") or "") or None,
        summary={"username": username, "disabled": body.disabled},
    )
    return {"ok": True, "username": username, "disabled": body.disabled}
