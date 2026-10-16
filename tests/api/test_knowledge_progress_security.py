"""Progress streams require KB authorization and physical-workspace isolation."""

import asyncio
from types import SimpleNamespace

import pytest

from cognivoy.api.routers import auth, knowledge
from cognivoy.api.utils.progress_broadcaster import ProgressBroadcaster
from cognivoy.knowledge.progress_tracker import ProgressTracker
from cognivoy.multi_user import knowledge_access
from cognivoy.multi_user.context import reset_current_user, set_current_user
from cognivoy.multi_user.models import CurrentUser, KnowledgeResource, UserScope


class Socket:
    query_params = {}

    def __init__(self):
        self.messages = []
        self.closes = []

    async def accept(self):
        pass

    async def close(self, code=1000):
        self.closes.append(code)

    async def send_json(self, message):
        self.messages.append(message)


@pytest.mark.parametrize("name", ["..", "unregistered", "admin:kb:secret"])
def test_progress_rejects_unresolved_kb_before_filesystem_access(monkeypatch, tmp_path, name):
    async def authenticated(_socket):
        return None

    monkeypatch.setattr(auth, "ws_require_auth", authenticated)
    monkeypatch.setattr(
        knowledge_access,
        "current_kb_manager",
        lambda: SimpleNamespace(list_knowledge_bases=lambda: ["safe"]),
    )
    monkeypatch.setattr(knowledge_access, "_assigned_admin_names", lambda: set())

    def forbidden_tracker(*_args):
        pytest.fail("Unauthorized resource reached filesystem tracker")

    monkeypatch.setattr(knowledge, "ProgressTracker", forbidden_tracker)
    user = CurrentUser("alice", "alice", "user", UserScope("user", "alice", tmp_path))
    token = set_current_user(user)
    socket = Socket()
    try:
        asyncio.run(knowledge.websocket_progress(socket, name))
    finally:
        reset_current_user(token)
    assert socket.closes[0] == 1008
    assert socket.messages == []


def test_progress_uses_authorized_resource_name_and_root(monkeypatch, tmp_path):
    async def authenticated(_socket):
        return None

    monkeypatch.setattr(auth, "ws_require_auth", authenticated)
    resource = KnowledgeResource("admin:kb:shared", "shared", tmp_path, "admin", True, True)
    monkeypatch.setattr(knowledge, "resolve_kb", lambda _name: resource)
    seen = []

    def get_progress(tracker):
        seen.append((tracker.kb_name, tracker.base_dir))
        return {"stage": "completed", "percent": 100}

    monkeypatch.setattr(ProgressTracker, "get_progress", get_progress)
    monkeypatch.setattr(
        knowledge,
        "KnowledgeBaseManager",
        lambda **_kwargs: SimpleNamespace(get_info=lambda _name: {}),
    )
    socket = Socket()
    asyncio.run(knowledge.websocket_progress(socket, "admin:kb:shared"))
    assert seen == [("shared", tmp_path)]
    assert socket.messages[0]["data"]["stage"] == "completed"


def test_same_named_kbs_do_not_receive_each_others_progress(monkeypatch, tmp_path):
    from cognivoy.runtime import mode

    broadcaster = ProgressBroadcaster()
    broadcaster._connections = {}
    broadcaster._lock = asyncio.Lock()
    monkeypatch.setattr(ProgressBroadcaster, "get_instance", lambda: broadcaster)
    monkeypatch.setattr(mode, "is_server", lambda: True)
    alice = ProgressTracker("same-name", tmp_path / "alice")
    bob = ProgressTracker("same-name", tmp_path / "bob")
    alice_socket, bob_socket = Socket(), Socket()

    async def run():
        await broadcaster.connect(alice.stream_key, alice_socket)
        await broadcaster.connect(bob.stream_key, bob_socket)
        alice._notify({"message": "alice-only"})
        await asyncio.sleep(0)

    asyncio.run(run())
    assert alice_socket.messages == [{"type": "progress", "data": {"message": "alice-only"}}]
    assert bob_socket.messages == []
