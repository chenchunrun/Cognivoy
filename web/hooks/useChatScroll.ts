"use client";

import { useCallback, useLayoutEffect, useRef, useState } from "react";

const BOTTOM_TOLERANCE = 1;

/** Keep stream layout and its scroll correction in the same painted frame.
 * Only this scrollport is moved; the composer and outer page never scroll.
 */
export function useChatScroll(sessionId: string | null, historyStart: number) {
  const containerRef = useRef<HTMLDivElement | null>(null);
  const contentRef = useRef<HTMLDivElement | null>(null);
  const followingRef = useRef(true);
  const pausedByIntentRef = useRef(false);
  const sessionRef = useRef(sessionId);
  const positionRef = useRef({ top: 0 });
  const prependRef = useRef<{ top: number; height: number; start: number } | null>(null);
  const touchYRef = useRef<number | null>(null);
  const [showJump, setShowJump] = useState(false);

  const setFollowing = useCallback((following: boolean) => {
    followingRef.current = following;
    // Browser anchoring remains useful when reading older messages. While
    // following, the bottom position is owned exclusively by this hook.
    if (containerRef.current) {
      containerRef.current.style.overflowAnchor = following ? "none" : "auto";
    }
    setShowJump(!following);
  }, []);

  const correctPosition = useCallback(() => {
    const el = containerRef.current;
    if (!el || !followingRef.current) return;
    const height = el.scrollHeight;
    const bottom = Math.max(0, height - el.clientHeight);
    // Scrollbar drags can move the DOM before the queued scroll event reaches
    // React. Respect that movement even if a stream commit wins the race.
    // A clamp caused by shrinking content is already at bottom, not scrollback.
    if (
      el.scrollTop < positionRef.current.top - BOTTOM_TOLERANCE &&
      el.scrollTop < bottom - BOTTOM_TOLERANCE
    ) {
      positionRef.current = { top: el.scrollTop };
      setFollowing(false);
      return;
    }
    if (Math.abs(bottom - el.scrollTop) > BOTTOM_TOLERANCE) {
      // No smooth animation per token: it would keep restarting as the answer
      // grows. Skip writes entirely for chunks that do not change the height.
      el.scrollTop = bottom;
    }
    positionRef.current = { top: el.scrollTop };
  }, [setFollowing]);

  const scrollToBottom = useCallback(() => {
    pausedByIntentRef.current = false;
    prependRef.current = null;
    positionRef.current = { top: containerRef.current?.scrollTop ?? 0 };
    setFollowing(true);
    correctPosition();
  }, [correctPosition, setFollowing]);

  const pauseFollowing = useCallback(() => {
    const el = containerRef.current;
    if (!el || el.scrollHeight <= el.clientHeight + BOTTOM_TOLERANCE) return;
    pausedByIntentRef.current = true;
    setFollowing(false);
  }, [setFollowing]);

  const handleScroll = useCallback(() => {
    const el = containerRef.current;
    if (!el) return;
    const top = el.scrollTop;
    const height = el.scrollHeight;
    const atBottom = height - top - el.clientHeight <= BOTTOM_TOLERANCE;
    if (!atBottom) {
      pausedByIntentRef.current = false;
      // A scroll event queued by our own write may arrive after another chunk
      // changed the height. That is not a user opting out of following.
      if (Math.abs(top - positionRef.current.top) > BOTTOM_TOLERANCE) {
        setFollowing(false);
      }
    } else if (!pausedByIntentRef.current && !prependRef.current) {
      setFollowing(true);
    }
    positionRef.current = { top };
  }, [setFollowing]);

  const preservePrepend = useCallback(() => {
    const el = containerRef.current;
    if (!el || prependRef.current) return;
    prependRef.current = { top: el.scrollTop, height: el.scrollHeight, start: historyStart };
    setFollowing(false);
  }, [historyStart, setFollowing]);

  // Run after every commit (including status/footer changes), before paint.
  // Unlike a passive effect, no frame displays the newly taller answer at the
  // previous scroll offset. No state update is needed for normal stream chunks.
  useLayoutEffect(() => {
    const el = containerRef.current;
    if (!el) return;
    if (sessionRef.current !== sessionId) {
      sessionRef.current = sessionId;
      prependRef.current = null;
      pausedByIntentRef.current = false;
      positionRef.current = { top: el.scrollTop };
      setFollowing(true);
    }
    const prepend = prependRef.current;
    if (prepend && historyStart < prepend.start) {
      el.scrollTop = prepend.top + el.scrollHeight - prepend.height;
      positionRef.current = { top: el.scrollTop };
      prependRef.current = null;
    }
    correctPosition();
  });

  useLayoutEffect(() => {
    const el = containerRef.current;
    const content = contentRef.current;
    if (!el || !content) return;
    el.style.overflowAnchor = followingRef.current ? "none" : "auto";
    // Images, expanded cards, lazy renderers and composer/viewport resizes can
    // change geometry without a ChatMessages render. ResizeObserver callbacks
    // also run before paint; scheduling another frame here would reintroduce
    // the one-frame jump. scrollTop does not resize either observed box.
    const observer = typeof ResizeObserver === "undefined"
      ? null
      : new ResizeObserver(correctPosition);
    observer?.observe(content);
    observer?.observe(el);
    const wheel = (event: WheelEvent) => {
      if (!event.ctrlKey && event.deltaY < 0) pauseFollowing();
    };
    const touchStart = (event: TouchEvent) => {
      touchYRef.current = event.touches.length === 1 ? event.touches[0].clientY : null;
    };
    const touchMove = (event: TouchEvent) => {
      const y = event.touches.length === 1 ? event.touches[0].clientY : null;
      if (y !== null && touchYRef.current !== null && y > touchYRef.current) pauseFollowing();
      touchYRef.current = y;
    };
    const keyDown = (event: KeyboardEvent) => {
      if (event.target instanceof Element && event.target.closest("input, textarea, select, [contenteditable]")) return;
      if (["ArrowUp", "PageUp", "Home"].includes(event.key) || (event.key === " " && event.shiftKey)) pauseFollowing();
    };
    el.addEventListener("wheel", wheel, { passive: true });
    el.addEventListener("touchstart", touchStart, { passive: true });
    el.addEventListener("touchmove", touchMove, { passive: true });
    el.addEventListener("keydown", keyDown);
    return () => {
      observer?.disconnect();
      el.removeEventListener("wheel", wheel);
      el.removeEventListener("touchstart", touchStart);
      el.removeEventListener("touchmove", touchMove);
      el.removeEventListener("keydown", keyDown);
    };
  }, [correctPosition, pauseFollowing]);

  return { containerRef, contentRef, showJump, handleScroll, preservePrepend, scrollToBottom };
}
