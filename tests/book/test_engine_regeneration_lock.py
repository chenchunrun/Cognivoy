from __future__ import annotations

import asyncio

import pytest

from cognivoy.book.engine import BookEngine
from cognivoy.book.storage import BookStorage


@pytest.mark.asyncio
async def test_regenerate_block_serializes_mutations_for_same_book(monkeypatch) -> None:
    engine = BookEngine(storage=BookStorage())
    active = 0
    max_active = 0

    async def fake_regenerate(**_kwargs):
        nonlocal active, max_active
        active += 1
        max_active = max(max_active, active)
        await asyncio.sleep(0.01)
        active -= 1
        return None

    monkeypatch.setattr(engine, "_regenerate_block_unlocked", fake_regenerate)

    await asyncio.gather(
        engine.regenerate_block(book_id="book-1", page_id="page-1", block_id="a"),
        engine.regenerate_block(book_id="book-1", page_id="page-1", block_id="b"),
    )

    assert max_active == 1


@pytest.mark.asyncio
async def test_regenerate_block_keeps_different_books_independent(monkeypatch) -> None:
    engine = BookEngine(storage=BookStorage())
    both_started = asyncio.Event()
    active = 0
    max_active = 0

    async def fake_regenerate(**_kwargs):
        nonlocal active, max_active
        active += 1
        max_active = max(max_active, active)
        if active == 2:
            both_started.set()
        await asyncio.wait_for(both_started.wait(), timeout=0.2)
        active -= 1
        return None

    monkeypatch.setattr(engine, "_regenerate_block_unlocked", fake_regenerate)

    await asyncio.gather(
        engine.regenerate_block(book_id="book-1", page_id="page-1", block_id="a"),
        engine.regenerate_block(book_id="book-2", page_id="page-2", block_id="b"),
    )

    assert max_active == 2


@pytest.mark.asyncio
async def test_all_block_mutations_share_the_same_book_lock(monkeypatch) -> None:
    engine = BookEngine(storage=BookStorage())
    active = 0
    max_active = 0

    async def record_async(**_kwargs):
        nonlocal active, max_active
        active += 1
        max_active = max(max_active, active)
        await asyncio.sleep(0.01)
        active -= 1
        return None

    def record_sync(**_kwargs):
        nonlocal active, max_active
        active += 1
        max_active = max(max_active, active)
        active -= 1
        return True

    monkeypatch.setattr(engine, "_insert_block_unlocked", record_async)
    monkeypatch.setattr(engine, "_change_block_type_unlocked", record_async)
    monkeypatch.setattr(engine, "_delete_block_unlocked", record_sync)
    monkeypatch.setattr(engine, "_move_block_unlocked", record_sync)

    await asyncio.gather(
        engine.insert_block(
            book_id="book-1",
            page_id="page-1",
            block_type="text",  # type: ignore[arg-type]
        ),
        engine.delete_block(book_id="book-1", page_id="page-1", block_id="a"),
        engine.move_block(book_id="book-1", page_id="page-1", block_id="b", new_position=0),
        engine.change_block_type(
            book_id="book-1",
            page_id="page-1",
            block_id="c",
            new_type="text",  # type: ignore[arg-type]
        ),
    )

    assert max_active == 1
