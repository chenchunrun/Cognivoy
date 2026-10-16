type MermaidTheme = "default" | "dark" | "neutral";

export const MERMAID_BASE_CONFIG = {
  startOnLoad: false,
  securityLevel: "strict" as const,
  suppressErrorRendering: true,
};

/** Normalize LLM output that may still include a Markdown code fence. */
export function stripMermaidFence(source: string): string {
  const trimmed = source.trim();
  const fenced = /^```(?:mermaid)?[ \t]*\r?\n([\s\S]*?)\r?\n?[ \t]*```$/i.exec(
    trimmed,
  );
  return (fenced?.[1] ?? trimmed).trim();
}

/** Mermaid uses these temporary ids when render() has no container. */
export function removeMermaidArtifacts(id: string): void {
  document.getElementById(id)?.remove();
  document.getElementById(`d${id}`)?.remove();
  document.getElementById(`i${id}`)?.remove();
}

/** Remove error containers left in body by renders from older app versions. */
export function removeStaleMermaidArtifacts(): void {
  document.body
    .querySelectorAll<HTMLElement>(
      ':scope > [id^="dmermaid-"], :scope > [id^="ddt-"], :scope > [id^="imermaid-"], :scope > [id^="idt-"]',
    )
    .forEach((element) => element.remove());
}

export function initializeMermaid(
  mermaid: typeof import("mermaid").default,
  theme: MermaidTheme,
): void {
  removeStaleMermaidArtifacts();
  mermaid.initialize({
    ...MERMAID_BASE_CONFIG,
    theme,
    fontFamily: "inherit",
  });
}

export async function renderMermaid(
  mermaid: typeof import("mermaid").default,
  id: string,
  source: string,
): Promise<string> {
  const code = stripMermaidFence(source);
  const parsed = await mermaid.parse(code, { suppressErrors: true });
  if (!parsed) throw new Error("Invalid Mermaid diagram syntax");

  try {
    return (await mermaid.render(id, code)).svg;
  } finally {
    // Defensive cleanup for Mermaid versions/configurations that leave a
    // body-level render container behind after a parser or renderer error.
    removeMermaidArtifacts(id);
  }
}
