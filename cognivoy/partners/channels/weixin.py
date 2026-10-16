"""Personal WeChat (微信) channel using HTTP long-poll API.

Uses the ilinkai.weixin.qq.com API for personal WeChat messaging.
No WebSocket, no local WeChat client needed — just HTTP requests with a
bot token obtained via QR code login.

Protocol reverse-engineered from ``@tencent-weixin/openclaw-weixin`` v1.0.3.
"""

from __future__ import annotations

import asyncio
import base64
from collections import OrderedDict
from contextlib import suppress
import json
import os
from pathlib import Path
import random
import re
import time
from typing import Any
import uuid

import httpx
from loguru import logger
from pydantic import Field

from cognivoy.partners.bus.events import OutboundMessage
from cognivoy.partners.bus.queue import MessageBus
from cognivoy.partners.channels.base import BaseChannel
from cognivoy.partners.config.paths import get_runtime_subdir
from cognivoy.partners.config.schema import DeliveryOverrides
from cognivoy.partners.helpers import split_message

# ---------------------------------------------------------------------------
# Protocol constants (from openclaw-weixin types.ts)
# ---------------------------------------------------------------------------

# MessageItemType
ITEM_TEXT = 1
ITEM_IMAGE = 2
ITEM_VOICE = 3
ITEM_FILE = 4
ITEM_VIDEO = 5

# MessageType  (1 = inbound from user, 2 = outbound from bot)
MESSAGE_TYPE_BOT = 2

# MessageState
MESSAGE_STATE_FINISH = 2

WEIXIN_MAX_MESSAGE_LEN = 4000
WEIXIN_CHANNEL_VERSION = "2.1.1"
ILINK_APP_ID = "bot"


def _build_client_version(version: str) -> int:
    """Encode semantic version as 0x00MMNNPP (major/minor/patch in one uint32)."""
    parts = version.split(".")

    def _as_int(idx: int) -> int:
        try:
            return int(parts[idx])
        except Exception:
            return 0

    major = _as_int(0)
    minor = _as_int(1)
    patch = _as_int(2)
    return ((major & 0xFF) << 16) | ((minor & 0xFF) << 8) | (patch & 0xFF)


ILINK_APP_CLIENT_VERSION = _build_client_version(WEIXIN_CHANNEL_VERSION)
BASE_INFO: dict[str, str] = {"channel_version": WEIXIN_CHANNEL_VERSION}

# Session-expired error code
ERRCODE_SESSION_EXPIRED = -14
SESSION_PAUSE_DURATION_S = 60 * 60

# iLink context_token is observed to expire server-side after ~90-160s of
# agent inactivity (openclaw/openclaw#61174). Proactively refresh before
# sending if the cached token is older than this threshold.
CONTEXT_TOKEN_MAX_AGE_S = 60


# Retry constants (matching the reference plugin's monitor.ts)
MAX_CONSECUTIVE_FAILURES = 3
BACKOFF_DELAY_S = 30
RETRY_DELAY_S = 2
MAX_QR_REFRESH_COUNT = 3
TYPING_STATUS_TYPING = 1
TYPING_STATUS_CANCEL = 2
TYPING_TICKET_TTL_S = 24 * 60 * 60
TYPING_KEEPALIVE_INTERVAL_S = 5
CONFIG_CACHE_INITIAL_RETRY_S = 2
CONFIG_CACHE_MAX_RETRY_S = 60 * 60

# Default long-poll timeout; overridden by server via longpolling_timeout_ms.
DEFAULT_LONG_POLL_TIMEOUT_S = 35

WEIXIN_MEDIA_DISABLED_MESSAGE = (
    "WeChat media transfer is disabled for security. Please use text chat or the Web app. "
    "微信媒体传输因安全原因暂时禁用，请使用文字聊天或网页应用。"
)

# Media-type codes for getuploadurl  (1=image, 2=video, 3=file, 4=voice)
UPLOAD_MEDIA_IMAGE = 1
UPLOAD_MEDIA_VIDEO = 2
UPLOAD_MEDIA_FILE = 3
UPLOAD_MEDIA_VOICE = 4

# File extensions considered as images / videos for outbound media
_IMAGE_EXTS = {".jpg", ".jpeg", ".png", ".gif", ".bmp", ".webp", ".tiff", ".ico", ".svg"}
_VIDEO_EXTS = {".mp4", ".avi", ".mov", ".mkv", ".webm", ".flv"}
_VOICE_EXTS = {".mp3", ".wav", ".amr", ".silk", ".ogg", ".m4a", ".aac", ".flac"}


def _has_downloadable_media_locator(media: dict[str, Any] | None) -> bool:
    if not isinstance(media, dict):
        return False
    return bool(
        str(media.get("encrypt_query_param", "") or "")
        or str(media.get("full_url", "") or "").strip()
    )


class WeixinConfig(DeliveryOverrides):
    """Personal WeChat channel configuration."""

    enabled: bool = False
    allow_from: list[str] = Field(default_factory=list)
    base_url: str = "https://ilinkai.weixin.qq.com"
    cdn_base_url: str = "https://novac2c.cdn.weixin.qq.com/c2c"
    route_tag: str | int | None = None
    token: str = ""  # Manually set token, or obtained via QR login
    state_dir: str = ""  # Default: data/partners/weixin/
    poll_timeout: int = DEFAULT_LONG_POLL_TIMEOUT_S  # seconds for long-poll


class WeixinChannel(BaseChannel):
    """
    Personal WeChat channel using HTTP long-poll.

    Connects to ilinkai.weixin.qq.com API to receive and send personal
    WeChat messages. Authentication is via QR code login which produces
    a bot token.
    """

    name = "weixin"
    display_name = "WeChat"

    @classmethod
    def default_config(cls) -> dict[str, Any]:
        return WeixinConfig().model_dump(by_alias=True)

    def __init__(self, config: Any, bus: MessageBus):
        if isinstance(config, dict):
            config = WeixinConfig.model_validate(config)
        super().__init__(config, bus)
        self.config: WeixinConfig = config
        self.logger = logger.bind(channel=self.name)

        # State
        self._client: httpx.AsyncClient | None = None
        self._get_updates_buf: str = ""
        self._context_tokens: dict[str, str] = {}  # from_user_id -> context_token
        self._processed_ids: OrderedDict[str, None] = OrderedDict()
        self._state_dir: Path | None = None
        self._token: str = ""
        self._poll_task: asyncio.Task | None = None
        self._next_poll_timeout_s: int = DEFAULT_LONG_POLL_TIMEOUT_S
        self._session_pause_until: float = 0.0
        self._typing_tasks: dict[str, asyncio.Task] = {}
        self._typing_tickets: dict[str, dict[str, Any]] = {}
        self._context_token_at: dict[str, float] = {}
        self._pending_tool_hints: dict[str, list[str]] = {}

    # ------------------------------------------------------------------
    # State persistence
    # ------------------------------------------------------------------

    def _get_state_dir(self) -> Path:
        if self._state_dir:
            return self._state_dir
        if self.config.state_dir:
            d = Path(self.config.state_dir).expanduser()
        else:
            d = get_runtime_subdir("weixin")
        d.mkdir(parents=True, exist_ok=True)
        self._state_dir = d
        return d

    def _load_state(self) -> bool:
        """Load saved account state. Returns True if a valid token was found."""
        state_file = self._get_state_dir() / "account.json"
        if not state_file.exists():
            return False
        try:
            data = json.loads(state_file.read_text())
            self._token = data.get("token", "")
            self._get_updates_buf = data.get("get_updates_buf", "")
            context_tokens = data.get("context_tokens", {})
            if isinstance(context_tokens, dict):
                self._context_tokens = {
                    str(user_id): str(token)
                    for user_id, token in context_tokens.items()
                    if str(user_id).strip() and str(token).strip()
                }
            else:
                self._context_tokens = {}
            typing_tickets = data.get("typing_tickets", {})
            if isinstance(typing_tickets, dict):
                self._typing_tickets = {
                    str(user_id): ticket
                    for user_id, ticket in typing_tickets.items()
                    if str(user_id).strip() and isinstance(ticket, dict)
                }
            else:
                self._typing_tickets = {}
            base_url = data.get("base_url", "")
            if base_url:
                self.config.base_url = base_url
            return bool(self._token)
        except Exception:
            self.logger.error("Failed to load Weixin account state", exc_info=True)
            return False

    def _save_state(self) -> None:
        state_file = self._get_state_dir() / "account.json"
        with suppress(Exception):
            data = {
                "token": self._token,
                "get_updates_buf": self._get_updates_buf,
                "context_tokens": self._context_tokens,
                "typing_tickets": self._typing_tickets,
                "base_url": self.config.base_url,
            }
            state_file.write_text(json.dumps(data, ensure_ascii=False))

    # ------------------------------------------------------------------
    # HTTP helpers  (matches api.ts buildHeaders / apiFetch)
    # ------------------------------------------------------------------

    @staticmethod
    def _random_wechat_uin() -> str:
        """X-WECHAT-UIN: random uint32 → decimal string → base64.

        Matches the reference plugin's ``randomWechatUin()`` in api.ts.
        Generated fresh for **every** request (same as reference).
        """
        uint32 = int.from_bytes(os.urandom(4), "big")
        return base64.b64encode(str(uint32).encode()).decode()

    def _make_headers(self, *, auth: bool = True) -> dict[str, str]:
        """Build per-request headers (new UIN each call, matching reference)."""
        headers: dict[str, str] = {
            "X-WECHAT-UIN": self._random_wechat_uin(),
            "Content-Type": "application/json",
            "AuthorizationType": "ilink_bot_token",
            "iLink-App-Id": ILINK_APP_ID,
            "iLink-App-ClientVersion": str(ILINK_APP_CLIENT_VERSION),
        }
        if auth and self._token:
            headers["Authorization"] = f"Bearer {self._token}"
        if self.config.route_tag is not None and str(self.config.route_tag).strip():
            headers["SKRouteTag"] = str(self.config.route_tag).strip()
        return headers

    @staticmethod
    def _is_retryable_media_download_error(err: Exception) -> bool:
        if isinstance(err, httpx.TimeoutException | httpx.TransportError):
            return True
        if isinstance(err, httpx.HTTPStatusError):
            status_code = err.response.status_code if err.response is not None else 0
            return status_code >= 500
        return False

    async def _api_get(
        self,
        endpoint: str,
        params: dict | None = None,
        *,
        auth: bool = True,
        extra_headers: dict[str, str] | None = None,
    ) -> dict:
        assert self._client is not None
        url = f"{self.config.base_url}/{endpoint}"
        hdrs = self._make_headers(auth=auth)
        if extra_headers:
            hdrs.update(extra_headers)
        resp = await self._client.get(url, params=params, headers=hdrs)
        resp.raise_for_status()
        return resp.json()

    async def _api_get_with_base(
        self,
        *,
        base_url: str,
        endpoint: str,
        params: dict | None = None,
        auth: bool = True,
        extra_headers: dict[str, str] | None = None,
    ) -> dict:
        """GET helper that allows overriding base_url for QR redirect polling."""
        assert self._client is not None
        url = f"{base_url.rstrip('/')}/{endpoint}"
        hdrs = self._make_headers(auth=auth)
        if extra_headers:
            hdrs.update(extra_headers)
        resp = await self._client.get(url, params=params, headers=hdrs)
        resp.raise_for_status()
        return resp.json()

    async def _api_post(
        self,
        endpoint: str,
        body: dict | None = None,
        *,
        auth: bool = True,
    ) -> dict:
        assert self._client is not None
        url = f"{self.config.base_url}/{endpoint}"
        payload = body or {}
        if "base_info" not in payload:
            payload["base_info"] = BASE_INFO
        resp = await self._client.post(url, json=payload, headers=self._make_headers(auth=auth))
        resp.raise_for_status()
        return resp.json()

    # ------------------------------------------------------------------
    # QR Code Login  (matches login-qr.ts)
    # ------------------------------------------------------------------

    async def _fetch_qr_code(self) -> tuple[str, str]:
        """Fetch a fresh QR code. Returns (qrcode_id, scan_url)."""
        data = await self._api_get(
            "ilink/bot/get_bot_qrcode",
            params={"bot_type": "3"},
            auth=False,
        )
        qrcode_img_content = data.get("qrcode_img_content", "")
        qrcode_id = data.get("qrcode", "")
        if not qrcode_id:
            raise RuntimeError(f"Failed to get QR code from WeChat API: {data}")
        return qrcode_id, (qrcode_img_content or qrcode_id)

    async def _qr_login(self) -> bool:
        """Perform QR code login flow. Returns True on success."""
        try:
            refresh_count = 0
            qrcode_id, scan_url = await self._fetch_qr_code()
            self._print_qr_code(scan_url)
            current_poll_base_url = self.config.base_url

            while self._running:
                try:
                    status_data = await self._api_get_with_base(
                        base_url=current_poll_base_url,
                        endpoint="ilink/bot/get_qrcode_status",
                        params={"qrcode": qrcode_id},
                        auth=False,
                    )
                except Exception as e:
                    if self._is_retryable_qr_poll_error(e):
                        await asyncio.sleep(1)
                        continue
                    raise

                if not isinstance(status_data, dict):
                    await asyncio.sleep(1)
                    continue

                status = status_data.get("status", "")
                if status == "confirmed":
                    token = status_data.get("bot_token", "")
                    bot_id = status_data.get("ilink_bot_id", "")
                    base_url = status_data.get("baseurl", "")
                    user_id = status_data.get("ilink_user_id", "")
                    if token:
                        self._token = token
                        if base_url:
                            self.config.base_url = base_url
                        self._save_state()
                        self.logger.info(
                            "login successful! bot_id={} user_id={}",
                            bot_id,
                            user_id,
                        )
                        return True
                    else:
                        self.logger.error("Login confirmed but no bot_token in response")
                        return False
                elif status == "scaned_but_redirect":
                    redirect_host = str(status_data.get("redirect_host", "") or "").strip()
                    if redirect_host:
                        if redirect_host.startswith("http://") or redirect_host.startswith(
                            "https://"
                        ):
                            redirected_base = redirect_host
                        else:
                            redirected_base = f"https://{redirect_host}"
                        if redirected_base != current_poll_base_url:
                            current_poll_base_url = redirected_base
                elif status == "expired":
                    refresh_count += 1
                    if refresh_count > MAX_QR_REFRESH_COUNT:
                        self.logger.warning(
                            "QR code expired too many times ({}/{}), giving up.",
                            refresh_count - 1,
                            MAX_QR_REFRESH_COUNT,
                        )
                        return False
                    qrcode_id, scan_url = await self._fetch_qr_code()
                    current_poll_base_url = self.config.base_url
                    self._print_qr_code(scan_url)
                    continue
                # status == "wait" — keep polling

                await asyncio.sleep(1)

        except Exception:
            self.logger.exception("QR login failed")

        return False

    @staticmethod
    def _is_retryable_qr_poll_error(err: Exception) -> bool:
        if isinstance(err, httpx.TimeoutException | httpx.TransportError):
            return True
        if isinstance(err, httpx.HTTPStatusError):
            status_code = err.response.status_code if err.response is not None else 0
            if status_code >= 500:
                return True
        return False

    @staticmethod
    def _print_qr_code(url: str) -> None:
        try:
            import qrcode as qr_lib

            qr = qr_lib.QRCode(border=1)
            qr.add_data(url)
            qr.make(fit=True)
            qr.print_ascii(invert=True)
        except ImportError:
            print(f"\nLogin URL: {url}\n")

    # ------------------------------------------------------------------
    # Channel lifecycle
    # ------------------------------------------------------------------

    async def login(self, force: bool = False) -> bool:
        """Perform QR code login and save token. Returns True on success."""
        if force:
            self._token = ""
            self._get_updates_buf = ""
            state_file = self._get_state_dir() / "account.json"
            if state_file.exists():
                state_file.unlink()
        if self._token or self._load_state():
            return True

        # Initialize HTTP client for the login flow
        self._client = httpx.AsyncClient(
            timeout=httpx.Timeout(60, connect=30),
            follow_redirects=True,
        )
        self._running = True  # Enable polling loop in _qr_login()
        try:
            return await self._qr_login()
        finally:
            self._running = False
            if self._client:
                await self._client.aclose()
                self._client = None

    async def start(self) -> None:
        self._running = True
        self._next_poll_timeout_s = self.config.poll_timeout
        self._client = httpx.AsyncClient(
            timeout=httpx.Timeout(self._next_poll_timeout_s + 10, connect=30),
            follow_redirects=True,
        )

        if self.config.token:
            self._token = self.config.token
        elif not self._load_state():
            if not await self._qr_login():
                self.logger.error(
                    "login failed. open the Weixin channel and scan the QR code to authenticate."
                )
                self._running = False
                return

        self.logger.info("channel starting with long-poll...")

        consecutive_failures = 0
        while self._running:
            try:
                await self._poll_once()
                consecutive_failures = 0
            except httpx.TimeoutException:
                # Normal for long-poll, just retry
                continue
            except Exception:
                if not self._running:
                    break
                self.logger.exception("WeChat poll loop error")
                consecutive_failures += 1
                if consecutive_failures >= MAX_CONSECUTIVE_FAILURES:
                    consecutive_failures = 0
                    await asyncio.sleep(BACKOFF_DELAY_S)
                else:
                    await asyncio.sleep(RETRY_DELAY_S)

    async def stop(self) -> None:
        self._running = False
        self._pending_tool_hints.clear()
        if self._poll_task and not self._poll_task.done():
            self._poll_task.cancel()
        for chat_id in list(self._typing_tasks):
            await self._stop_typing(chat_id, clear_remote=False)
        if self._client:
            await self._client.aclose()
            self._client = None
        self._save_state()

    # ------------------------------------------------------------------
    # Polling  (matches monitor.ts monitorWeixinProvider)
    # ------------------------------------------------------------------

    def _pause_session(self, duration_s: int = SESSION_PAUSE_DURATION_S) -> None:
        self._session_pause_until = time.time() + duration_s

    def _session_pause_remaining_s(self) -> int:
        remaining = int(self._session_pause_until - time.time())
        if remaining <= 0:
            self._session_pause_until = 0.0
            return 0
        return remaining

    def _assert_session_active(self) -> None:
        remaining = self._session_pause_remaining_s()
        if remaining > 0:
            remaining_min = max((remaining + 59) // 60, 1)
            raise RuntimeError(
                f"WeChat session paused, {remaining_min} min remaining (errcode {ERRCODE_SESSION_EXPIRED})"
            )

    async def _poll_once(self) -> None:
        remaining = self._session_pause_remaining_s()
        if remaining > 0:
            await asyncio.sleep(remaining)
            return

        body: dict[str, Any] = {
            "get_updates_buf": self._get_updates_buf,
            "base_info": BASE_INFO,
        }

        # Adjust httpx timeout to match the current poll timeout
        assert self._client is not None
        self._client.timeout = httpx.Timeout(self._next_poll_timeout_s + 10, connect=30)

        data = await self._api_post("ilink/bot/getupdates", body)

        # Check for API-level errors (monitor.ts checks both ret and errcode)
        ret = data.get("ret", 0)
        errcode = data.get("errcode", 0)

        is_error = (ret is not None and ret != 0) or (errcode is not None and errcode != 0)

        if is_error:
            if errcode == ERRCODE_SESSION_EXPIRED or ret == ERRCODE_SESSION_EXPIRED:
                self._pause_session()
                remaining = self._session_pause_remaining_s()
                self.logger.warning(
                    "session expired (errcode {}). Pausing {} min.",
                    errcode,
                    max((remaining + 59) // 60, 1),
                )
                return
            raise RuntimeError(
                f"getUpdates failed: ret={ret} errcode={errcode} errmsg={data.get('errmsg', '')}"
            )

        # Honour server-suggested poll timeout (monitor.ts:102-105)
        server_timeout_ms = data.get("longpolling_timeout_ms")
        if server_timeout_ms and server_timeout_ms > 0:
            self._next_poll_timeout_s = max(server_timeout_ms // 1000, 5)

        # Update cursor
        new_buf = data.get("get_updates_buf", "")
        if new_buf:
            self._get_updates_buf = new_buf
            self._save_state()

        # Process messages (WeixinMessage[] from types.ts)
        msgs: list[dict] = data.get("msgs", []) or []
        for msg in msgs:
            try:
                await self._process_message(msg)
            except Exception:
                self.logger.exception("Failed to process WeChat message")

    # ------------------------------------------------------------------
    # Inbound message processing  (matches inbound.ts + process-message.ts)
    # ------------------------------------------------------------------

    async def _process_message(self, msg: dict) -> None:
        """Process a single WeixinMessage from getUpdates."""
        # Skip bot's own messages (message_type 2 = BOT)
        if msg.get("message_type") == MESSAGE_TYPE_BOT:
            return

        msg_id = str(msg.get("message_id", "") or msg.get("seq", ""))
        if not msg_id:
            msg_id = f"{msg.get('from_user_id', '')}_{msg.get('create_time_ms', '')}"

        from_user_id = msg.get("from_user_id", "") or ""
        if not from_user_id:
            return

        if not self.is_allowed(from_user_id):
            return

        # Deduplication by message_id
        if msg_id in self._processed_ids:
            return
        self._processed_ids[msg_id] = None
        while len(self._processed_ids) > 1000:
            self._processed_ids.popitem(last=False)

        # Cache context_token (required for all replies — inbound.ts:23-27)
        ctx_token = msg.get("context_token", "")
        if ctx_token:
            self._context_tokens[from_user_id] = ctx_token
            self._context_token_at[from_user_id] = time.time()
            self._save_state()

        # Parse item_list (WeixinMessage.item_list — types.ts:161)
        item_list: list[dict] = msg.get("item_list") or []
        content_parts: list[str] = []
        media_paths: list[str] = []

        for item in item_list:
            item_type = item.get("type", 0)

            if item_type == ITEM_TEXT:
                text = (item.get("text_item") or {}).get("text", "")
                if text:
                    # Handle quoted/ref messages (inbound.ts:86-98)
                    ref = item.get("ref_msg")
                    if ref:
                        ref_item = ref.get("message_item")
                        # If quoted message is media, just pass the text
                        if ref_item and ref_item.get("type", 0) in (
                            ITEM_IMAGE,
                            ITEM_VOICE,
                            ITEM_FILE,
                            ITEM_VIDEO,
                        ):
                            content_parts.append(text)
                        else:
                            parts: list[str] = []
                            if ref.get("title"):
                                parts.append(ref["title"])
                            if ref_item:
                                ref_text = (ref_item.get("text_item") or {}).get("text", "")
                                if ref_text:
                                    parts.append(ref_text)
                            if parts:
                                content_parts.append(f"[引用: {' | '.join(parts)}]\n{text}")
                            else:
                                content_parts.append(text)
                    else:
                        content_parts.append(text)

            elif item_type in (ITEM_IMAGE, ITEM_VOICE, ITEM_FILE, ITEM_VIDEO):
                content_parts.append(WEIXIN_MEDIA_DISABLED_MESSAGE)

        content = "\n".join(content_parts)
        if not content:
            return

        self.logger.info(
            "inbound: from={} items={} bodyLen={}",
            from_user_id,
            ",".join(str(i.get("type", 0)) for i in item_list),
            len(content),
        )

        await self._start_typing(from_user_id, ctx_token)

        await self._handle_message(
            sender_id=from_user_id,
            chat_id=from_user_id,
            content=content,
            media=media_paths or None,
            metadata={"message_id": msg_id},
        )

    # ------------------------------------------------------------------
    # Media download  (matches media-download.ts + pic-decrypt.ts)
    # ------------------------------------------------------------------

    async def _download_media_item(
        self,
        typed_item: dict,
        media_type: str,
        filename: str | None = None,
    ) -> str | None:
        """Media downloads are disabled; never contact the CDN."""
        return None

    # ------------------------------------------------------------------
    # Outbound  (matches send.ts buildTextMessageReq + sendMessageWeixin)
    # ------------------------------------------------------------------

    async def _get_typing_ticket(self, user_id: str, context_token: str = "") -> str:
        """Get typing ticket with per-user refresh + failure backoff cache."""
        now = time.time()
        entry = self._typing_tickets.get(user_id)
        if entry and now < float(entry.get("next_fetch_at", 0)):
            return str(entry.get("ticket", "") or "")

        body: dict[str, Any] = {
            "ilink_user_id": user_id,
            "context_token": context_token or None,
            "base_info": BASE_INFO,
        }
        data = await self._api_post("ilink/bot/getconfig", body)
        if data.get("ret", 0) == 0:
            ticket = str(data.get("typing_ticket", "") or "")
            self._typing_tickets[user_id] = {
                "ticket": ticket,
                "ever_succeeded": True,
                "next_fetch_at": now + (random.random() * TYPING_TICKET_TTL_S),
                "retry_delay_s": CONFIG_CACHE_INITIAL_RETRY_S,
            }
            return ticket

        prev_delay = (
            float(entry.get("retry_delay_s", CONFIG_CACHE_INITIAL_RETRY_S))
            if entry
            else CONFIG_CACHE_INITIAL_RETRY_S
        )
        next_delay = min(prev_delay * 2, CONFIG_CACHE_MAX_RETRY_S)
        if entry:
            entry["next_fetch_at"] = now + next_delay
            entry["retry_delay_s"] = next_delay
            return str(entry.get("ticket", "") or "")

        self._typing_tickets[user_id] = {
            "ticket": "",
            "ever_succeeded": False,
            "next_fetch_at": now + CONFIG_CACHE_INITIAL_RETRY_S,
            "retry_delay_s": CONFIG_CACHE_INITIAL_RETRY_S,
        }
        return ""

    async def _refresh_context_token_if_stale(self, chat_id: str, context_token: str) -> str:
        """Return a fresh context_token if the cached one is too old.

        iLink context_token expires server-side after a short idle period
        (empirically ~90s). Proactively refreshing before sending prevents
        silent message loss on long agent turns or cron pushes.
        """
        if not context_token:
            return context_token

        now = time.time()
        cached_at = self._context_token_at.get(chat_id, 0)
        age = now - cached_at

        if age < CONTEXT_TOKEN_MAX_AGE_S:
            return context_token

        self.logger.debug(
            "WeChat context_token for {} is {:.0f}s old; refreshing via getconfig",
            chat_id,
            age,
        )

        body: dict[str, Any] = {
            "ilink_user_id": chat_id,
            "context_token": context_token,
            "base_info": BASE_INFO,
        }
        try:
            data = await self._api_post("ilink/bot/getconfig", body)
        except Exception as e:
            self.logger.warning("WeChat getconfig failed for {}: {}", chat_id, e)
            return context_token

        if data.get("ret", 0) != 0:
            self.logger.warning(
                "WeChat getconfig returned ret={} for {}: {}",
                data.get("ret"),
                chat_id,
                data.get("errmsg", ""),
            )
            return context_token

        new_token = str(data.get("context_token", "") or "")
        if new_token and new_token != context_token:
            self.logger.info(
                "WeChat context_token refreshed for {} (age {:.0f}s -> fresh)",
                chat_id,
                age,
            )
            self._context_tokens[chat_id] = new_token
            self._context_token_at[chat_id] = now
            self._save_state()
            return new_token

        return context_token

    async def _flush_tool_hints(self, chat_id: str) -> None:
        """Send any buffered tool hints for *chat_id* as a single message.

        Tool hints are coalesced to reduce message count and avoid hitting the
        WeChat iLink rate limit (~7 msgs / 5 min).  Failures are logged but
        not raised so that the main message send is never blocked.
        """
        hints = self._pending_tool_hints.pop(chat_id, None)
        if not hints:
            return

        self.logger.info(
            "Flushing {} buffered tool hint(s) for {}",
            len(hints),
            chat_id,
        )

        ctx_token = self._context_tokens.get(chat_id, "")
        ctx_token = await self._refresh_context_token_if_stale(chat_id, ctx_token)
        if not ctx_token:
            self.logger.warning(
                "Dropped {} buffered tool hint(s) for {}: no context_token",
                len(hints),
                chat_id,
            )
            return

        try:
            await self._send_text(chat_id, "\n\n".join(hints), ctx_token)
        except Exception:
            self.logger.exception("Failed to flush buffered tool hints for {}", chat_id)

    async def _send_typing(self, user_id: str, typing_ticket: str, status: int) -> None:
        """Best-effort sendtyping wrapper."""
        if not typing_ticket:
            return
        body: dict[str, Any] = {
            "ilink_user_id": user_id,
            "typing_ticket": typing_ticket,
            "status": status,
            "base_info": BASE_INFO,
        }
        await self._api_post("ilink/bot/sendtyping", body)

    async def _typing_keepalive_loop(
        self, user_id: str, typing_ticket: str, stop_event: asyncio.Event
    ) -> None:
        try:
            while not stop_event.is_set():
                await asyncio.sleep(TYPING_KEEPALIVE_INTERVAL_S)
                if stop_event.is_set():
                    break
                with suppress(Exception):
                    await self._send_typing(user_id, typing_ticket, TYPING_STATUS_TYPING)
        finally:
            pass

    async def send(self, msg: OutboundMessage) -> None:
        if not self._client or not self._token:
            raise RuntimeError("WeChat client not initialized or not authenticated")
        self._assert_session_active()

        is_progress = bool((msg.metadata or {}).get("_progress", False))

        # Buffer tool hints to coalesce consecutive ones and avoid burning
        # WeChat iLink rate-limit quota (~7 msgs / 5 min).
        if is_progress and (msg.metadata or {}).get("_tool_hint"):
            if not self.send_tool_hints:
                return
            self._pending_tool_hints.setdefault(msg.chat_id, []).append(msg.content)
            self.logger.debug(
                "Buffered tool hint for {} (count={})",
                msg.chat_id,
                len(self._pending_tool_hints[msg.chat_id]),
            )
            return

        # Reasoning deltas are invisible in WeChat (there is no reasoning
        # UI).  Skip them entirely — do not send and do not flush buffer.
        if is_progress and (msg.metadata or {}).get("_reasoning_delta"):
            self.logger.debug("Dropped invisible reasoning delta for {}", msg.chat_id)
            return

        content = msg.content.strip()

        # Empty progress messages (e.g. after_iteration tool_events) must
        # NOT act as separators — they have no visible content.
        if is_progress and not content and not (msg.media or []):
            self.logger.debug(
                "Skipped empty progress message for {} (no visible content)",
                msg.chat_id,
            )
            return

        # Flush buffered hints before sending any visible message.
        await self._flush_tool_hints(msg.chat_id)

        if not is_progress:
            await self._stop_typing(msg.chat_id, clear_remote=True)

        ctx_token = self._context_tokens.get(msg.chat_id, "")
        ctx_token = await self._refresh_context_token_if_stale(msg.chat_id, ctx_token)
        if not ctx_token:
            raise RuntimeError(
                f"WeChat context_token missing for chat_id={msg.chat_id}, cannot send"
            )

        typing_ticket = ""
        with suppress(Exception):
            typing_ticket = await self._get_typing_ticket(msg.chat_id, ctx_token)

        if typing_ticket:
            with suppress(Exception):
                await self._send_typing(msg.chat_id, typing_ticket, TYPING_STATUS_TYPING)

        typing_keepalive_stop = asyncio.Event()
        typing_keepalive_task: asyncio.Task | None = None
        if typing_ticket:
            typing_keepalive_task = asyncio.create_task(
                self._typing_keepalive_loop(msg.chat_id, typing_ticket, typing_keepalive_stop)
            )

        try:
            if msg.media:
                await self._send_text(msg.chat_id, WEIXIN_MEDIA_DISABLED_MESSAGE, ctx_token)

            # --- Send text content ---
            if not content:
                return

            chunks = split_message(content, WEIXIN_MAX_MESSAGE_LEN)
            for chunk in chunks:
                await self._send_text(msg.chat_id, chunk, ctx_token)
        except Exception:
            self.logger.exception("Error sending message")
            raise
        finally:
            if typing_keepalive_task:
                typing_keepalive_stop.set()
                typing_keepalive_task.cancel()
                with suppress(asyncio.CancelledError):
                    await typing_keepalive_task

            if typing_ticket and not is_progress:
                with suppress(Exception):
                    await self._send_typing(msg.chat_id, typing_ticket, TYPING_STATUS_CANCEL)

    async def send_delta(
        self, chat_id: str, delta: str, metadata: dict[str, Any] | None = None
    ) -> None:
        """Weixin iLink does not support native streaming deltas.

        We only hook ``_stream_end`` so buffered tool hints are flushed even
        when the final answer carries the ``_streamed`` flag and bypasses
        :meth:`send`.
        """
        if metadata and metadata.get("_stream_end"):
            await self._flush_tool_hints(chat_id)

    async def _start_typing(self, chat_id: str, context_token: str = "") -> None:
        """Start typing indicator immediately when a message is received."""
        if not self._client or not self._token or not chat_id:
            return
        await self._stop_typing(chat_id, clear_remote=False)
        try:
            ticket = await self._get_typing_ticket(chat_id, context_token)
            if not ticket:
                return
            await self._send_typing(chat_id, ticket, TYPING_STATUS_TYPING)
        except Exception as e:
            self.logger.debug("typing indicator start failed for {}: {}", chat_id, e)
            return

        stop_event = asyncio.Event()

        async def keepalive() -> None:
            try:
                while not stop_event.is_set():
                    await asyncio.sleep(TYPING_KEEPALIVE_INTERVAL_S)
                    if stop_event.is_set():
                        break
                    with suppress(Exception):
                        await self._send_typing(chat_id, ticket, TYPING_STATUS_TYPING)
            finally:
                pass

        task = asyncio.create_task(keepalive())
        task._typing_stop_event = stop_event  # type: ignore[attr-defined]
        self._typing_tasks[chat_id] = task

    async def _stop_typing(self, chat_id: str, *, clear_remote: bool) -> None:
        """Stop typing indicator for a chat."""
        task = self._typing_tasks.pop(chat_id, None)
        if task and not task.done():
            stop_event = getattr(task, "_typing_stop_event", None)
            if stop_event:
                stop_event.set()
            task.cancel()
            with suppress(asyncio.CancelledError):
                await task
        if not clear_remote:
            return
        entry = self._typing_tickets.get(chat_id)
        ticket = str(entry.get("ticket", "") or "") if isinstance(entry, dict) else ""
        if not ticket:
            return
        try:
            await self._send_typing(chat_id, ticket, TYPING_STATUS_CANCEL)
        except Exception as e:
            self.logger.debug("typing clear failed for {}: {}", chat_id, e)

    async def _send_text(
        self,
        to_user_id: str,
        text: str,
        context_token: str,
    ) -> None:
        """Send a text message matching the exact protocol from send.ts."""
        client_id = f"cognivoy-{uuid.uuid4().hex[:12]}"

        item_list: list[dict] = []
        if text:
            item_list.append({"type": ITEM_TEXT, "text_item": {"text": text}})

        weixin_msg: dict[str, Any] = {
            "from_user_id": "",
            "to_user_id": to_user_id,
            "client_id": client_id,
            "message_type": MESSAGE_TYPE_BOT,
            "message_state": MESSAGE_STATE_FINISH,
        }
        if item_list:
            weixin_msg["item_list"] = item_list
        if context_token:
            weixin_msg["context_token"] = context_token

        body: dict[str, Any] = {
            "msg": weixin_msg,
            "base_info": BASE_INFO,
        }

        data = await self._api_post("ilink/bot/sendmessage", body)
        ret = data.get("ret", 0)
        errcode = data.get("errcode", 0)
        if (ret is not None and ret != 0) or (errcode is not None and errcode != 0):
            raise RuntimeError(
                f"WeChat send text error (ret={ret}, errcode={errcode}): {data.get('errmsg', '')}"
            )

    async def _send_media_file(
        self,
        to_user_id: str,
        media_path: str,
        context_token: str,
    ) -> None:
        """Fail closed before reading files or sending media bytes."""
        raise RuntimeError(WEIXIN_MEDIA_DISABLED_MESSAGE)


# ---------------------------------------------------------------------------
# AES-128-ECB encryption / decryption  (matches pic-decrypt.ts / aes-ecb.ts)
# ---------------------------------------------------------------------------


def _parse_aes_key(aes_key_b64: str) -> bytes:
    """Parse a base64-encoded AES key, handling both encodings seen in the wild.

    From ``pic-decrypt.ts parseAesKey``:

    * ``base64(raw 16 bytes)``            → images (media.aes_key)
    * ``base64(hex string of 16 bytes)``  → file / voice / video

    In the second case base64-decoding yields 32 ASCII hex chars which must
    then be parsed as hex to recover the actual 16-byte key.
    """
    decoded = base64.b64decode(aes_key_b64)
    if len(decoded) == 16:
        return decoded
    if len(decoded) == 32 and re.fullmatch(rb"[0-9a-fA-F]{32}", decoded):
        # hex-encoded key: base64 → hex string → raw bytes
        return bytes.fromhex(decoded.decode("ascii"))
    raise ValueError(
        f"aes_key must decode to 16 raw bytes or 32-char hex string, got {len(decoded)} bytes"
    )


def _encrypt_aes_ecb(data: bytes, aes_key_b64: str) -> bytes:
    """Legacy entry point retained only to fail closed."""
    raise RuntimeError(WEIXIN_MEDIA_DISABLED_MESSAGE)


def _decrypt_aes_ecb(data: bytes, aes_key_b64: str) -> bytes:
    """Legacy entry point retained only to fail closed."""
    raise RuntimeError(WEIXIN_MEDIA_DISABLED_MESSAGE)


def _pkcs7_unpad_safe(data: bytes, block_size: int = 16) -> bytes:
    """Safely remove PKCS7 padding when valid; otherwise return original bytes."""
    if not data:
        return data
    if len(data) % block_size != 0:
        return data
    pad_len = data[-1]
    if pad_len < 1 or pad_len > block_size:
        return data
    if data[-pad_len:] != bytes([pad_len]) * pad_len:
        return data
    return data[:-pad_len]


def _ext_for_type(media_type: str) -> str:
    return {
        "image": ".jpg",
        "voice": ".silk",
        "video": ".mp4",
        "file": "",
    }.get(media_type, "")
