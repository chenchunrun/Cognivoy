export type VoiceAutoplayOverride = "default" | "on" | "off";

const PREFIX = "chat_voice_autoplay:";

export function effectiveVoiceAutoplay(
  globalValue: boolean,
  override: VoiceAutoplayOverride,
): boolean {
  return override === "default" ? globalValue : override === "on";
}

/** Convert the public dependency payload into a tri-state TTS readiness flag. */
export function ttsConfiguredFromDependencies(payload: unknown): boolean | null {
  if (!payload || typeof payload !== "object") return null;
  const dependencies = (payload as { dependencies?: unknown }).dependencies;
  if (!dependencies || typeof dependencies !== "object") return null;
  const media = (dependencies as { media?: unknown }).media;
  if (!media || typeof media !== "object") return null;
  const tts = (media as { tts?: unknown }).tts;
  if (!tts || typeof tts !== "object") return null;
  const status = (tts as { status?: unknown }).status;
  if (status === "configured") return true;
  return typeof status === "string" ? false : null;
}

/** Recognize the backend's actionable missing-TTS response without matching every 400. */
export function isMissingTtsConfiguration(status: number, detail: string): boolean {
  return status === 400 && /active TTS model/i.test(detail);
}

export function loadVoiceAutoplayOverride(
  sessionId: string | null,
): VoiceAutoplayOverride {
  if (!sessionId || typeof window === "undefined") return "default";
  const value = window.localStorage.getItem(`${PREFIX}${sessionId}`);
  return value === "on" || value === "off" ? value : "default";
}

export function saveVoiceAutoplayOverride(
  sessionId: string | null,
  override: VoiceAutoplayOverride,
): void {
  if (!sessionId || typeof window === "undefined") return;
  const key = `${PREFIX}${sessionId}`;
  if (override === "default") window.localStorage.removeItem(key);
  else window.localStorage.setItem(key, override);
}
