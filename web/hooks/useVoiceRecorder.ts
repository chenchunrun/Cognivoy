"use client";

import { useCallback, useEffect, useRef, useState } from "react";

import { apiFetch, apiUrl } from "@/lib/api";

export type RecorderState = "idle" | "recording" | "transcribing";

export interface VoiceRecorderMessages {
  unsupported: string;
  permissionDenied: string;
  unavailable: string;
  preflightFailed: string;
  transcriptionFailed: string;
  transcriptionHttp: (status: number) => string;
}

/**
 * Microphone capture → backend transcription. Records via MediaRecorder, posts
 * the clip to ``/api/v1/voice/stt`` (which uses the admin-configured STT
 * provider), and hands the transcript back through ``onTranscript``.
 */
export function useVoiceRecorder(
  onTranscript: (text: string) => void,
  messages: VoiceRecorderMessages,
) {
  const [state, setState] = useState<RecorderState>("idle");
  const [error, setError] = useState<string | null>(null);
  const recorderRef = useRef<MediaRecorder | null>(null);
  const chunksRef = useRef<Blob[]>([]);
  const streamRef = useRef<MediaStream | null>(null);
  const unmountedRef = useRef(false);
  const transcribeAbortRef = useRef<AbortController | null>(null);
  const onTranscriptRef = useRef(onTranscript);

  useEffect(() => {
    onTranscriptRef.current = onTranscript;
  }, [onTranscript]);

  const releaseStream = useCallback(() => {
    streamRef.current?.getTracks().forEach((track) => track.stop());
    streamRef.current = null;
  }, []);

  const start = useCallback(async () => {
    if (state !== "idle") return;
    setError(null);
    if (
      typeof navigator === "undefined" ||
      !navigator.mediaDevices?.getUserMedia ||
      typeof MediaRecorder === "undefined"
    ) {
      setError(messages.unsupported);
      return;
    }
    try {
      const response = await apiFetch(apiUrl("/api/v1/system/dependencies"), {
        cache: "no-store",
      });
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      const payload = (await response.json()) as {
        dependencies?: { media?: { stt?: { status?: string } } };
      };
      if (payload.dependencies?.media?.stt?.status !== "configured") {
        setError(messages.unavailable);
        return;
      }
    } catch {
      setError(messages.preflightFailed);
      return;
    }
    let stream: MediaStream;
    try {
      stream = await navigator.mediaDevices.getUserMedia({ audio: true });
    } catch {
      setError(messages.permissionDenied);
      return;
    }
    streamRef.current = stream;
    const recorder = new MediaRecorder(stream);
    chunksRef.current = [];
    recorder.ondataavailable = (event) => {
      if (event.data && event.data.size > 0) chunksRef.current.push(event.data);
    };
    recorder.onstop = async () => {
      const mimeType = recorder.mimeType || "audio/webm";
      releaseStream();
      // Unmount cleanup stops the recorder too — don't transcribe the
      // partial clip (or setState) after the component is gone.
      if (unmountedRef.current) {
        chunksRef.current = [];
        return;
      }
      const blob = new Blob(chunksRef.current, { type: mimeType });
      chunksRef.current = [];
      if (!blob.size) {
        setState("idle");
        return;
      }
      setState("transcribing");
      // Cancellable + unmount-aware: aborting mid-flight must not setState on
      // an unmounted component nor deliver the transcript to a dead consumer.
      const controller = new AbortController();
      transcribeAbortRef.current = controller;
      try {
        const ext = mimeType.includes("ogg")
          ? "ogg"
          : mimeType.includes("mp4")
            ? "mp4"
            : "webm";
        const form = new FormData();
        form.append("file", blob, `recording.${ext}`);
        const resp = await apiFetch(apiUrl("/api/v1/voice/stt"), {
          method: "POST",
          body: form,
          signal: controller.signal,
        });
        if (!resp.ok) {
          throw new Error(messages.transcriptionHttp(resp.status));
        }
        const data = (await resp.json()) as { text?: string };
        if (unmountedRef.current) return;
        const text = (data.text || "").trim();
        if (text) onTranscriptRef.current(text);
      } catch (err) {
        if (unmountedRef.current || controller.signal.aborted) return;
        setError(
          err instanceof Error ? err.message : messages.transcriptionFailed,
        );
      } finally {
        if (transcribeAbortRef.current === controller) {
          transcribeAbortRef.current = null;
        }
        if (!unmountedRef.current) setState("idle");
      }
    };
    recorder.start();
    recorderRef.current = recorder;
    setState("recording");
  }, [messages, releaseStream, state]);

  const stop = useCallback(() => {
    const recorder = recorderRef.current;
    if (recorder && recorder.state !== "inactive") {
      recorder.stop(); // fires onstop → transcribe
    }
  }, []);

  const toggle = useCallback(() => {
    if (state === "recording") stop();
    else if (state === "idle") void start();
  }, [start, state, stop]);

  // Stop the mic and abort any in-flight transcription if the component
  // unmounts mid-recording / mid-transcribing.
  useEffect(() => {
    unmountedRef.current = false;
    return () => {
      unmountedRef.current = true;
      transcribeAbortRef.current?.abort();
      transcribeAbortRef.current = null;
      const recorder = recorderRef.current;
      if (recorder && recorder.state !== "inactive") recorder.stop();
      streamRef.current?.getTracks().forEach((track) => track.stop());
    };
  }, []);

  return { state, error, toggle, start, stop };
}
