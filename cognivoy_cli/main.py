"""CLI entry point for the standalone ``cognivoy-cli`` package."""

from __future__ import annotations

from pathlib import Path

import typer

from cognivoy.logging import configure_logging
from cognivoy.runtime.mode import RunMode, set_mode

from .book import register as register_book
from .chat import register as register_chat
from .common import build_turn_request, console, maybe_run
from .config_cmd import register as register_config
from .init_cmd import register as register_init
from .kb import register as register_kb
from .memory import register as register_memory
from .notebook import register as register_notebook
from .partner import register as register_partner
from .plugin import register as register_plugin
from .provider_cmd import register as register_provider
from .session_cmd import register as register_session
from .skill import register as register_skill

set_mode(RunMode.CLI)
configure_logging()

app = typer.Typer(
    name="cognivoy",
    help="Cognivoy CLI – agent-first interface for capabilities, tools, and knowledge.",
    no_args_is_help=True,
    add_completion=False,
)

partner_app = typer.Typer(help="Manage partners (IM-connected companions).")
chat_app = typer.Typer(help="Interactive chat REPL.")
kb_app = typer.Typer(help="Manage knowledge bases.")
skill_app = typer.Typer(help="Manage skills and install from hubs (ClawHub, …).")
memory_app = typer.Typer(help="View and manage lightweight memory.")
plugin_app = typer.Typer(help="List plugins.")
config_app = typer.Typer(help="Inspect configuration.")
session_app = typer.Typer(help="Manage shared sessions.")
notebook_app = typer.Typer(help="Manage notebooks and imported markdown records.")
provider_app = typer.Typer(help="Manage provider OAuth login.")
book_app = typer.Typer(help="Manage interactive Books (BookEngine).")

app.add_typer(partner_app, name="partner")
app.add_typer(chat_app, name="chat")
app.add_typer(kb_app, name="kb")
app.add_typer(skill_app, name="skill")
app.add_typer(skill_app, name="skills")  # alias: `cognivoy skills …`
app.add_typer(memory_app, name="memory")
app.add_typer(plugin_app, name="plugin")
app.add_typer(config_app, name="config")
app.add_typer(session_app, name="session")
app.add_typer(notebook_app, name="notebook")
app.add_typer(provider_app, name="provider")
app.add_typer(book_app, name="book")

register_partner(partner_app)
register_chat(chat_app)
register_kb(kb_app)
register_skill(skill_app)
register_memory(memory_app)
register_plugin(plugin_app)
register_config(config_app)
register_session(session_app)
register_notebook(notebook_app)
register_provider(provider_app)
register_book(book_app)
register_init(app)


@app.command("run")
def run_capability(
    capability: str = typer.Argument(
        ...,
        help=(
            "Capability name (e.g. chat, deep_solve, deep_question, "
            "deep_research, visualize, math_animator, mastery_path)."
        ),
    ),
    message: str = typer.Argument(..., help="Message to send."),
    session: str | None = typer.Option(None, "--session", help="Existing session id."),
    tool: list[str] = typer.Option([], "--tool", "-t", help="Enabled tool(s)."),
    kb: list[str] = typer.Option([], "--kb", help="Knowledge base name."),
    notebook_ref: list[str] = typer.Option([], "--notebook-ref", help="Notebook references."),
    history_ref: list[str] = typer.Option([], "--history-ref", help="Referenced session ids."),
    memory_ref: list[str] = typer.Option(
        [], "--memory-ref", help="Memory layer to include (profile/preferences/recent/scope)."
    ),
    question_ref: list[int] = typer.Option(
        [], "--question-ref", help="Question notebook entry id."
    ),
    book_ref_json: list[str] = typer.Option(
        [], "--book-ref-json", help="Book reference as a JSON object."
    ),
    skill: list[str] = typer.Option([], "--skill", help="Skill manifest name to expose."),
    persona: str = typer.Option("", "--persona", help="Persona name for this turn."),
    language: str = typer.Option("en", "--language", "-l", help="Response language."),
    config: list[str] = typer.Option([], "--config", help="Capability config key=value."),
    config_json: str | None = typer.Option(
        None, "--config-json", help="Capability config as JSON."
    ),
    fmt: str = typer.Option("rich", "--format", "-f", help="Output format: rich | json."),
    json_output: bool = typer.Option(False, "--json", help="Shortcut for --format json."),
) -> None:
    """Run any capability in a single turn (agent-first entry point)."""
    from cognivoy.app import CognivoyApp

    from .common import run_turn_and_render

    request = build_turn_request(
        content=message,
        capability=capability,
        session_id=session,
        tools=tool,
        knowledge_bases=kb,
        language=language,
        config_items=config,
        config_json=config_json,
        notebook_refs=notebook_ref,
        history_refs=history_ref,
        memory_refs=memory_ref,
        question_refs=question_ref,
        book_ref_json=book_ref_json,
        skills=skill,
        persona=persona,
    )
    maybe_run(
        run_turn_and_render(app=CognivoyApp(), request=request, fmt="json" if json_output else fmt)
    )


@app.command()
def start(
    home: Path | None = typer.Option(None, "--home", help="Runtime workspace root."),
    host: str = typer.Option(
        "127.0.0.1",
        help="Bind address. Use 0.0.0.0 explicitly only behind authentication or a firewall.",
    ),
    dev: bool = typer.Option(
        False,
        "--dev",
        help="Use the Next.js development server for frontend work.",
    ),
) -> None:
    """Launch backend + frontend together. Source installs default to production."""
    from cognivoy.runtime.launcher import start as start_web

    start_web(home=home, dev=dev, host=host)


@app.command()
def serve(
    host: str = typer.Option(
        "127.0.0.1",
        help="Bind address. Use 0.0.0.0 explicitly only behind authentication or a firewall.",
    ),
    port: int | None = typer.Option(None, help="Port number."),
    reload: bool = typer.Option(False, help="Enable auto-reload for development."),
) -> None:
    """Start the Cognivoy API server."""
    import asyncio
    import sys

    host = host.strip() or "127.0.0.1"

    set_mode(RunMode.SERVER)
    if port is None:
        from cognivoy.services.setup import get_backend_port

        port = get_backend_port()

    # Windows: uvicorn defaults to SelectorEventLoop which does not support
    # asyncio.create_subprocess_exec.  Switch to ProactorEventLoop so that
    # child-process APIs (used by Math Animator renderer, etc.) work correctly.
    if sys.platform == "win32":
        asyncio.set_event_loop_policy(asyncio.WindowsProactorEventLoopPolicy())

    try:
        import uvicorn
    except ImportError:
        console.print(
            "[bold red]Error:[/] API server dependencies not installed.\n"
            "Run: pip install -U cognivoy"
        )
        raise typer.Exit(code=1)

    from cognivoy.runtime.bind_security import require_authenticated_remote_bind
    from cognivoy.services.config import (
        HTTP_KEEP_ALIVE_TIMEOUT,
        get_ws_max_size,
        load_auth_settings,
    )

    try:
        require_authenticated_remote_bind(
            host,
            auth_enabled=bool(load_auth_settings()["enabled"]),
        )
    except RuntimeError as exc:
        console.print(f"[bold red]Error:[/] {exc}")
        raise typer.Exit(code=2) from exc

    # ws_max_size tracks the configured chat-attachment total so base64
    # uploads fit in one WS frame (uvicorn defaults to 16MB).
    uvicorn.run(
        "cognivoy.api.main:app",
        host=host,
        port=port,
        reload=reload,
        reload_excludes=["web/*", "data/*"] if reload else None,
        ws_max_size=get_ws_max_size(),
        timeout_keep_alive=HTTP_KEEP_ALIVE_TIMEOUT,
    )


def main() -> None:
    app()


if __name__ == "__main__":
    main()
