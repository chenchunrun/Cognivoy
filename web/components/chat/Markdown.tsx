"use client";

/**
 * Rich markdown renderer for assistant message content.
 *
 * - GFM tables/strikethrough, KaTeX math, raw HTML.
 * - Security: sanitization happens HERE, in this component — raw HTML is
 *   parsed by rehype-raw and then cleaned by rehype-sanitize with the
 *   KaTeX-aware schema below (no script/iframe/form/event handlers), and
 *   `markdownUrlTransform` drops unsafe URL schemes. The regex-based
 *   cleanup in `normalizeMarkdownForDisplay` (lib/markdown-display.ts)
 *   still runs on the history-hydration path but is only a display
 *   pre-filter, not the security boundary — streamed content goes straight
 *   through this component.
 * - Fenced code blocks via react-syntax-highlighter (one-light / one-dark
 *   follow the active theme).
 * - ```mermaid blocks render to inline SVG (mermaid is dynamically
 *   imported and initialized once per theme).
 * - ```chart / ```chartjs blocks holding a Chart.js JSON spec render via
 *   react-chartjs-2 (Bar / Line / Pie / Doughnut by the spec's `type`).
 */

import * as React from "react";
import ReactMarkdown, { type Components } from "react-markdown";
import remarkGfm from "remark-gfm";
import remarkMath from "remark-math";
import rehypeKatex from "rehype-katex";
import rehypeRaw from "rehype-raw";
import rehypeSanitize, { defaultSchema } from "rehype-sanitize";
import { Prism as SyntaxHighlighter } from "react-syntax-highlighter";
import oneDark from "react-syntax-highlighter/dist/esm/styles/prism/one-dark";
import oneLight from "react-syntax-highlighter/dist/esm/styles/prism/one-light";
import { useAppShell } from "@/context/AppShellContext";
import { markdownUrlTransform } from "@/lib/markdown-display";
import { initializeMermaid, renderMermaid } from "@/lib/mermaid-render";
import "katex/dist/katex.min.css";

/* ------------------------------------------------------------------ */
/*  Sanitization schema (GitHub baseline + what our renderers emit)    */
/* ------------------------------------------------------------------ */

// Extends hast-util-sanitize's defaultSchema so the HTML we *deliberately*
// generate survives while hostile raw HTML does not:
// - KaTeX (rehype-katex runs before sanitize) emits classed `<span>`s with
//   occasional inline styles, a MathML tree (<math>/<semantics>/<annotation>/
//   mrow/mi/mo/…), and inline <svg>/<path> for stretchy accents.
// - `[label](attachment:NAME)` generated-file cards need the attachment:
//   protocol kept on href/src (everything else — script, iframe, form,
//   on* handlers, javascript:/data-html URLs — stays stripped).
const sanitizeSchema = {
  ...defaultSchema,
  attributes: {
    ...defaultSchema.attributes,
    span: [
      ...(defaultSchema.attributes?.span ?? []),
      "className",
      "style",
      "ariaHidden",
    ],
    div: [...(defaultSchema.attributes?.div ?? []), "className"],
    pre: [...(defaultSchema.attributes?.pre ?? []), "className"],
    math: ["xmlns", "display"],
    annotation: ["encoding"],
    svg: [
      "xmlns",
      "width",
      "height",
      "viewBox",
      "preserveAspectRatio",
      "style",
      "className",
      "ariaHidden",
      "focusable",
      "role",
    ],
    path: ["d", "stroke", "strokeWidth", "fill", "fillRule", "transform"],
    line: ["x1", "y1", "x2", "y2", "stroke", "strokeWidth"],
    video: [
      "src",
      "controls",
      "poster",
      "preload",
      "loop",
      "muted",
      "autoPlay",
      "playsInline",
    ],
    audio: ["src", "controls", "preload", "loop", "muted"],
    track: ["src", "kind", "srcLang", "default"],
  },
  tagNames: [
    ...(defaultSchema.tagNames ?? []),
    // MathML emitted by KaTeX
    "math",
    "semantics",
    "annotation",
    "mrow",
    "mi",
    "mo",
    "mn",
    "mtext",
    "ms",
    "mspace",
    "mstyle",
    "mfrac",
    "msqrt",
    "mroot",
    "msub",
    "msup",
    "msubsup",
    "munder",
    "mover",
    "munderover",
    "mtable",
    "mtr",
    "mtd",
    "mlabeledtr",
    "menclose",
    "mpadded",
    "mphantom",
    "mglyph",
    // Inline SVG emitted by KaTeX for stretchy accents
    "svg",
    "path",
    "line",
    // Passive media (allowed by lib/markdown-display.ts's tag list)
    "video",
    "audio",
    "track",
  ],
  protocols: {
    ...defaultSchema.protocols,
    href: [...(defaultSchema.protocols?.href ?? []), "attachment"],
    src: [...(defaultSchema.protocols?.src ?? []), "attachment"],
  },
};

/* ------------------------------------------------------------------ */
/*  Theme detection (observes the `.dark` class on <html>)            */
/* ------------------------------------------------------------------ */

function useIsDark(): boolean {
  const [isDark, setIsDark] = React.useState(
    () =>
      typeof document !== "undefined" &&
      document.documentElement.classList.contains("dark"),
  );
  React.useEffect(() => {
    const root = document.documentElement;
    const observer = new MutationObserver(() => {
      setIsDark(root.classList.contains("dark"));
    });
    observer.observe(root, { attributes: true, attributeFilter: ["class"] });
    return () => observer.disconnect();
  }, []);
  return isDark;
}

/* ------------------------------------------------------------------ */
/*  Mermaid                                                           */
/* ------------------------------------------------------------------ */

type MermaidApi = typeof import("mermaid").default;

let mermaidPromise: Promise<MermaidApi> | null = null;
let mermaidTheme: string | null = null;

async function getMermaid(theme: "default" | "dark"): Promise<MermaidApi> {
  if (!mermaidPromise) {
    mermaidPromise = import("mermaid").then((mod) => mod.default);
  }
  const mermaid = await mermaidPromise;
  if (mermaidTheme !== theme) {
    // Strict mode treats labels as text and disables click callbacks; the
    // app does not rely on Mermaid interactions.
    initializeMermaid(mermaid, theme);
    mermaidTheme = theme;
  }
  return mermaid;
}

let mermaidRenderSeq = 0;

function MermaidBlock({ code, isDark }: { code: string; isDark: boolean }) {
  const [svg, setSvg] = React.useState<string | null>(null);
  const [failed, setFailed] = React.useState(false);

  React.useEffect(() => {
    let alive = true;
    setSvg(null);
    setFailed(false);
    const id = `mermaid-${Date.now()}-${mermaidRenderSeq++}`;
    getMermaid(isDark ? "dark" : "default")
      .then((mermaid) => renderMermaid(mermaid, id, code))
      .then((svg) => {
        if (alive) setSvg(svg);
      })
      .catch(() => {
        if (alive) setFailed(true);
      });
    return () => {
      alive = false;
    };
  }, [code, isDark]);

  if (svg) {
    return (
      <div
        className="my-3 flex justify-center overflow-x-auto rounded-lg border border-border bg-card p-4 [&_svg]:max-w-full"
        // Mermaid-generated SVG from trusted backend content.
        dangerouslySetInnerHTML={{ __html: svg }}
      />
    );
  }
  // While rendering (or on failure) fall back to the raw diagram source.
  return (
    <pre className={failed ? undefined : "animate-pulse"}>
      <code>{code}</code>
    </pre>
  );
}

/* ------------------------------------------------------------------ */
/*  Chart.js (```chart / ```chartjs fenced JSON)                      */
/* ------------------------------------------------------------------ */

interface ChartSpec {
  type?: string;
  data?: Record<string, unknown>;
  options?: Record<string, unknown>;
  [key: string]: unknown;
}

type ChartComponents = {
  Bar: React.ComponentType<{ data: unknown; options?: unknown }>;
  Line: React.ComponentType<{ data: unknown; options?: unknown }>;
  Pie: React.ComponentType<{ data: unknown; options?: unknown }>;
  Doughnut: React.ComponentType<{ data: unknown; options?: unknown }>;
};

let chartModulesPromise: Promise<ChartComponents> | null = null;

async function getChartComponents(): Promise<ChartComponents> {
  if (!chartModulesPromise) {
    chartModulesPromise = Promise.all([
      import("chart.js"),
      import("react-chartjs-2"),
    ]).then(([chartjs, reactChartjs]) => {
      chartjs.Chart.register(
        chartjs.CategoryScale,
        chartjs.LinearScale,
        chartjs.BarElement,
        chartjs.PointElement,
        chartjs.LineElement,
        chartjs.ArcElement,
        chartjs.Tooltip,
        chartjs.Legend,
      );
      return {
        Bar: reactChartjs.Bar as ChartComponents["Bar"],
        Line: reactChartjs.Line as ChartComponents["Line"],
        Pie: reactChartjs.Pie as ChartComponents["Pie"],
        Doughnut: reactChartjs.Doughnut as ChartComponents["Doughnut"],
      };
    });
  }
  const components = await chartModulesPromise;
  const chartjs = await import("chart.js");
  // Chart.js paints on a <canvas>, so theme CSS variables must be resolved
  // to concrete values (same pattern as MemoryGraphView). Fallbacks mirror
  // the globals.css `:root` light values.
  const css = getComputedStyle(document.documentElement);
  const readToken = (name: string, fallback: string) =>
    css.getPropertyValue(name).trim() || fallback;
  chartjs.Chart.defaults.color = readToken("--muted-foreground", "#6b645a");
  chartjs.Chart.defaults.borderColor = readToken("--border", "#e8e2d6");
  return components;
}

function ChartBlock({ code, isDark }: { code: string; isDark: boolean }) {
  const [components, setComponents] = React.useState<ChartComponents | null>(
    null,
  );
  const spec = React.useMemo<ChartSpec | null>(() => {
    try {
      const parsed = JSON.parse(code) as unknown;
      return parsed && typeof parsed === "object"
        ? (parsed as ChartSpec)
        : null;
    } catch {
      return null;
    }
  }, [code]);

  React.useEffect(() => {
    if (!spec) return;
    let alive = true;
    getChartComponents().then((mods) => {
      if (alive) setComponents({ ...mods });
    });
    return () => {
      alive = false;
    };
  }, [spec, isDark]);

  const type = (spec?.type || "bar").toLowerCase();
  const ChartComponent =
    components &&
    (type === "line"
      ? components.Line
      : type === "pie"
        ? components.Pie
        : type === "doughnut"
          ? components.Doughnut
          : type.startsWith("bar")
            ? components.Bar
            : null);

  if (!spec || !ChartComponent) {
    // Invalid spec (or unsupported type): show the JSON source.
    return (
      <pre>
        <code>{code}</code>
      </pre>
    );
  }
  return (
    <div className="my-3 rounded-lg border border-border bg-card p-4">
      <div className="relative h-64">
        <ChartComponent
          data={spec.data}
          options={{
            responsive: true,
            maintainAspectRatio: false,
            ...(spec.options || {}),
          }}
        />
      </div>
    </div>
  );
}

/* ------------------------------------------------------------------ */
/*  Code block                                                        */
/* ------------------------------------------------------------------ */

function CodeBlock({
  language,
  code,
  isDark,
  showLineNumbers,
  wrapLongLines,
}: {
  language: string;
  code: string;
  isDark: boolean;
  showLineNumbers: boolean;
  wrapLongLines: boolean;
}) {
  if (language === "mermaid") return <MermaidBlock code={code} isDark={isDark} />;
  if (language === "chart" || language === "chartjs") {
    return <ChartBlock code={code} isDark={isDark} />;
  }
  return (
    <SyntaxHighlighter
      language={language}
      style={isDark ? oneDark : oneLight}
      customStyle={{
        margin: 0,
        padding: 0,
        background: "transparent",
        fontSize: "inherit",
        lineHeight: "inherit",
      }}
      codeTagProps={{
        style: { background: "transparent", fontFamily: "inherit" },
      }}
      PreTag="div"
      showLineNumbers={showLineNumbers}
      wrapLongLines={wrapLongLines}
    >
      {code}
    </SyntaxHighlighter>
  );
}

/* ------------------------------------------------------------------ */
/*  Markdown                                                          */
/* ------------------------------------------------------------------ */

function MarkdownInner({ content }: { content: string }) {
  const isDark = useIsDark();
  const { codeBlockShowLineNumbers, codeBlockWrapLongLines } = useAppShell();

  const components = React.useMemo<Components>(
    () => ({
      code({ className, children }) {
        const match = /language-([\w-]+)/.exec(className || "");
        if (!match) {
          // Inline code (or a language-less fence) — .prose-cognivoy styles it.
          return <code className={className}>{children}</code>;
        }
        return (
          <CodeBlock
            language={match[1].toLowerCase()}
            code={String(children).replace(/\n$/, "")}
            isDark={isDark}
            showLineNumbers={codeBlockShowLineNumbers}
            wrapLongLines={codeBlockWrapLongLines}
          />
        );
      },
      // Mermaid / chart blocks render their own frame — for those, unwrap
      // the <pre> so they aren't double-framed. Everything else keeps the
      // .prose-cognivoy pre styling (border, card background) around the
      // highlighted code.
      pre({ children }) {
        const child = React.isValidElement(children)
          ? (children as React.ReactElement<{ className?: string }>)
          : null;
        const lang = /language-([\w-]+)/.exec(child?.props.className || "")?.[1];
        if (lang === "mermaid" || lang === "chart" || lang === "chartjs") {
          return <>{children}</>;
        }
        return <pre>{children}</pre>;
      },
    }),
    [codeBlockShowLineNumbers, codeBlockWrapLongLines, isDark],
  );

  return (
    <ReactMarkdown
      remarkPlugins={[remarkGfm, remarkMath]}
      // Order matters: parse raw HTML, render KaTeX, then sanitize the whole
      // tree (schema above keeps KaTeX/MathML/attachment: but strips scripts,
      // event handlers, forms and unsafe protocols). urlTransform is the
      // second, scheme-level gate on markdown link/image URLs.
      rehypePlugins={[rehypeRaw, rehypeKatex, [rehypeSanitize, sanitizeSchema]]}
      urlTransform={markdownUrlTransform}
      components={components}
    >
      {content}
    </ReactMarkdown>
  );
}

export const Markdown = React.memo(MarkdownInner);
export default Markdown;
