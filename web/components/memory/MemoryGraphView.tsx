"use client";

// Memory graph — all three layers at once, rendered with cytoscape using
// the precomputed concentric-cluster layout from lib/memory-graph.
// Click a node to open the doc preview drawer; soft (dashed) edges are
// surface-level citations, strong (solid) edges point at specific entries.

import Link from "next/link";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { AnimatePresence, motion } from "framer-motion";
import cytoscape from "cytoscape";
import {
  Maximize2,
  List as ListIcon,
  Network,
  RefreshCw,
  Search,
  X,
  ZoomIn,
  ZoomOut,
} from "lucide-react";
import { useTranslation } from "react-i18next";

import {
  buildGraph,
  filterMemoryGraphNodes,
  fetchMemorySnapshot,
  type ClusterMeta,
  type GraphNode,
  type Layer,
  type MemoryGraph,
} from "@/lib/memory-graph";
import {
  Badge,
  Button,
  Card,
  EmptyState,
  Input,
  Skeleton,
  useToast,
} from "@/components/ui";
import { MemorySubNav } from "./MemorySubNav";

// ── Theme colours ────────────────────────────────────────────────────
// Cytoscape paints on a <canvas>, so CSS variables must be resolved to
// concrete values. We re-create the graph when the theme flips.

interface GraphColors {
  primary: string;
  foreground: string;
  muted: string;
  edge: string;
  label: string;
}

function resolveColors(): GraphColors {
  const css = getComputedStyle(document.documentElement);
  const read = (name: string, fallback: string) =>
    css.getPropertyValue(name).trim() || fallback;
  return {
    primary: read("--primary", "#c15a2e"),
    foreground: read("--foreground", "#1f1c18"),
    muted: read("--muted-foreground", "#6b645a"),
    edge: read("--border", "#e8e2d6"),
    label: read("--muted-foreground", "#6b645a"),
  };
}

const LAYER_ORDER: Layer[] = ["L3", "L2", "L1"];

function nodeColor(layer: Layer, c: GraphColors): string {
  if (layer === "L3") return c.primary;
  if (layer === "L2") return c.primary;
  return c.muted;
}

function nodeOpacity(layer: Layer): number {
  if (layer === "L3") return 1;
  if (layer === "L2") return 0.72;
  return 0.5;
}

// ── Component ────────────────────────────────────────────────────────

export function MemoryGraphView() {
  const { t } = useTranslation();
  const { toast } = useToast();
  const containerRef = useRef<HTMLDivElement | null>(null);
  const cyRef = useRef<cytoscape.Core | null>(null);
  const [graph, setGraph] = useState<MemoryGraph | null>(null);
  const [loading, setLoading] = useState(true);
  const [selected, setSelected] = useState<GraphNode | null>(null);
  const [themeTick, setThemeTick] = useState(0);
  const [query, setQuery] = useState("");
  const [layers, setLayers] = useState<Set<Layer>>(
    () => new Set(LAYER_ORDER),
  );
  const [view, setView] = useState<"graph" | "list">("graph");

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const snap = await fetchMemorySnapshot();
      setGraph(buildGraph(snap));
    } catch (e) {
      toast({
        variant: "destructive",
        title: t("Failed to load memory graph"),
        description: e instanceof Error ? e.message : String(e),
      });
      setGraph(null);
    } finally {
      setLoading(false);
    }
  }, [t, toast]);

  useEffect(() => {
    void load();
  }, [load]);

  // Rebuild on theme change (canvas colours are baked in).
  useEffect(() => {
    if (typeof document === "undefined") return;
    const observer = new MutationObserver(() => setThemeTick((n) => n + 1));
    observer.observe(document.documentElement, {
      attributes: true,
      attributeFilter: ["class"],
    });
    return () => observer.disconnect();
  }, []);

  // (Re)create the cytoscape instance whenever data or theme changes.
  useEffect(() => {
    const container = containerRef.current;
    if (!container || !graph) return;

    const colors = resolveColors();
    const positions = new Map<string, { x: number; y: number }>();
    const elements: cytoscape.ElementDefinition[] = [];

    for (const node of graph.nodes) {
      positions.set(node.id, { x: node.x, y: node.y });
      if (node.r === 0) {
        // Synthetic surface anchor — invisible hit-target for soft edges.
        elements.push({
          data: { id: node.id },
          classes: "anchor",
        });
        continue;
      }
      elements.push({
        data: {
          id: node.id,
          size: node.r * 2,
          layer: node.layer,
        },
        classes: `layer-${node.layer}`,
      });
    }
    // Cluster labels sit just outside each pie slice.
    for (const cluster of graph.clusters) {
      if (cluster.count === 0 && cluster.layer !== "L3") continue;
      const id = `__label__:${cluster.id}`;
      positions.set(id, labelPosition(cluster));
      elements.push({
        data: { id, name: cluster.label },
        classes: "cluster-label",
      });
    }
    for (const edge of graph.edges) {
      elements.push({
        data: {
          id: `e:${edge.source}->${edge.target}`,
          source: edge.source,
          target: edge.target,
        },
        classes: edge.kind === "soft" ? "edge-soft" : "edge-strong",
      });
    }

    const cy = cytoscape({
      container,
      elements,
      layout: {
        name: "preset",
        positions: (nodeId) => positions.get(nodeId) ?? { x: 0, y: 0 },
        fit: true,
        padding: 48,
        animate: false,
      },
      style: [
        {
          selector: "node",
          style: {
            width: "data(size)",
            height: "data(size)",
            "border-width": 0,
          },
        },
        {
          selector: "node.layer-L3",
          style: {
            "background-color": nodeColor("L3", colors),
            "background-opacity": nodeOpacity("L3"),
          },
        },
        {
          selector: "node.layer-L2",
          style: {
            "background-color": nodeColor("L2", colors),
            "background-opacity": nodeOpacity("L2"),
          },
        },
        {
          selector: "node.layer-L1",
          style: {
            "background-color": nodeColor("L1", colors),
            "background-opacity": nodeOpacity("L1"),
          },
        },
        {
          selector: "node.anchor",
          style: { opacity: 0, width: 1, height: 1, events: "no" },
        },
        {
          selector: "node.cluster-label",
          style: {
            label: "data(name)",
            color: colors.label,
            "font-size": 22,
            "font-weight": 600,
            "text-valign": "center",
            "text-halign": "center",
            width: 1,
            height: 1,
            opacity: 0,
            "text-opacity": 0.9,
            events: "no",
          },
        },
        {
          selector: "edge",
          style: {
            width: 1.5,
            "line-color": colors.edge,
            "curve-style": "bezier",
            opacity: 0.8,
          },
        },
        {
          selector: "edge.edge-soft",
          style: {
            "line-style": "dashed",
            "line-color": colors.primary,
            opacity: 0.35,
          },
        },
        {
          selector: "edge.edge-strong",
          style: { "line-color": colors.muted, opacity: 0.45 },
        },
        {
          selector: "node.hover",
          style: { "background-opacity": 1, "border-width": 2, "border-color": colors.primary },
        },
        {
          selector: ".dim",
          style: { opacity: 0.08 },
        },
        {
          selector: ".filtered",
          style: { display: "none" },
        },
        {
          selector: "edge.dim",
          style: { opacity: 0.04 },
        },
      ],
      minZoom: 0.2,
      maxZoom: 4,
      wheelSensitivity: 0.25,
      boxSelectionEnabled: false,
    });

    cy.on("tap", "node", (evt) => {
      const id: string = evt.target.id();
      const node = graph.nodes.find((n) => n.id === id);
      if (node && node.r > 0) setSelected(node);
    });
    cy.on("tap", (evt) => {
      if (evt.target === cy) setSelected(null);
    });
    // Hover: light up the node's neighbourhood, dim the rest.
    cy.on("mouseover", "node", (evt) => {
      const id: string = evt.target.id();
      if (id.startsWith("__label__")) return;
      container.style.cursor = "pointer";
      evt.target.addClass("hover");
      const neighbourhood = new Set(graph.adjacency.get(id) ?? []);
      neighbourhood.add(id);
      cy.batch(() => {
        for (const ele of cy.elements()) {
          if (ele.isNode() && ele.id().startsWith("__label__")) continue;
          if (!neighbourhood.has(ele.id()) && !(ele.isEdge() && neighbourhood.has(ele.source().id()) && neighbourhood.has(ele.target().id()))) {
            ele.addClass("dim");
          }
        }
      });
    });
    cy.on("mouseout", "node", (evt) => {
      container.style.cursor = "";
      evt.target.removeClass("hover");
      cy.batch(() => cy.elements().removeClass("dim"));
    });

    cyRef.current = cy;
    return () => {
      cyRef.current = null;
      cy.destroy();
    };
  }, [graph, themeTick]);

  const visibleIds = useMemo(
    () => (graph ? filterMemoryGraphNodes(graph, query, layers) : new Set<string>()),
    [graph, layers, query],
  );
  const filteredNodes = useMemo(
    () =>
      graph?.nodes.filter((node) => node.r > 0 && visibleIds.has(node.id)) ?? [],
    [graph, visibleIds],
  );

  useEffect(() => {
    const cy = cyRef.current;
    if (!cy || !graph) return;
    cy.batch(() => {
      for (const node of cy.nodes()) {
        const id = node.id();
        if (id.startsWith("__label__:")) {
          const clusterId = id.slice("__label__:".length);
          const cluster = graph.clusters.find((item) => item.id === clusterId);
          node.toggleClass("filtered", !cluster || !layers.has(cluster.layer));
        } else {
          node.toggleClass("filtered", !visibleIds.has(id));
        }
      }
      for (const edge of cy.edges()) {
        edge.toggleClass(
          "filtered",
          !visibleIds.has(edge.source().id()) ||
            !visibleIds.has(edge.target().id()),
        );
      }
    });
  }, [graph, layers, visibleIds]);

  const visibleNodeCount = useMemo(
    () => filteredNodes.length,
    [filteredNodes],
  );

  const zoomBy = useCallback((factor: number) => {
    const cy = cyRef.current;
    if (!cy) return;
    cy.zoom({
      level: cy.zoom() * factor,
      renderedPosition: {
        x: cy.width() / 2,
        y: cy.height() / 2,
      },
    });
  }, []);

  const fit = useCallback(() => {
    cyRef.current?.fit(undefined, 48);
  }, []);

  return (
    <div className="mx-auto flex h-full max-w-7xl flex-col px-6 py-8">
      <header className="mb-6">
        <h1 className="display flex items-center gap-2.5 text-2xl font-semibold text-foreground">
          <Network size={22} className="text-primary" />
          {t("Memory graph")}
        </h1>
        <p className="mt-1 text-sm text-muted-foreground">
          {t(
            "L3 synthesis at the centre, L2 facts in the middle, L1 traces on the outside. Click any node for a preview.",
          )}
        </p>
        <div className="mt-4">
          <MemorySubNav />
        </div>
      </header>

      <div className="mb-4 flex flex-wrap items-center gap-2" role="search">
        <div className="relative min-w-56 flex-1">
          <Search
            size={15}
            aria-hidden="true"
            className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-muted-foreground"
          />
          <Input
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            placeholder={t("Search memory nodes")}
            aria-label={t("Search memory nodes")}
            className="pl-9"
          />
        </div>
        <div className="flex items-center gap-1" aria-label={t("Memory layers")}>
          {LAYER_ORDER.map((layer) => (
            <Button
              key={layer}
              size="sm"
              variant={layers.has(layer) ? "primary" : "outline"}
              aria-pressed={layers.has(layer)}
              onClick={() =>
                setLayers((current) => {
                  if (current.has(layer) && current.size === 1) return current;
                  const next = new Set(current);
                  if (next.has(layer)) next.delete(layer);
                  else next.add(layer);
                  return next;
                })
              }
            >
              {layer}
            </Button>
          ))}
        </div>
        <div className="flex items-center gap-1" aria-label={t("Graph display mode")}>
          <Button
            size="icon"
            variant={view === "graph" ? "primary" : "outline"}
            aria-label={t("Graph view")}
            aria-pressed={view === "graph"}
            onClick={() => setView("graph")}
          >
            <Network size={15} />
          </Button>
          <Button
            size="icon"
            variant={view === "list" ? "primary" : "outline"}
            aria-label={t("List view")}
            aria-pressed={view === "list"}
            onClick={() => setView("list")}
          >
            <ListIcon size={15} />
          </Button>
        </div>
      </div>

      {loading ? (
        <Card className="p-5">
          <Skeleton className="h-[520px] w-full rounded-xl" />
        </Card>
      ) : !graph || graph.nodes.every((node) => node.r === 0) ? (
        <Card>
          <EmptyState
            icon={Network}
            title={t("No memory yet")}
            description={t(
              "Interact with Cognivoy, then run Update on a memory doc — the graph lights up as facts accumulate.",
            )}
            action={
              <Link href="/memory/l2">
                <Button variant="outline" size="sm">
                  {t("Open L2 workbench")}
                </Button>
              </Link>
            }
          />
        </Card>
      ) : visibleNodeCount === 0 ? (
        <Card>
          <EmptyState
            icon={Search}
            title={t("No matching memory")}
            description={t("Try a different search or enable another memory layer.")}
          />
        </Card>
      ) : view === "list" ? (
        <Card className="min-h-0 flex-1 overflow-y-auto p-3">
          <ul className="divide-y divide-border" aria-label={t("Memory node list")}>
            {filteredNodes.map((node) => (
              <li key={node.id}>
                <Link
                  href={node.href}
                  className="flex items-start gap-3 rounded-lg px-3 py-3 transition-colors hover:bg-muted focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                >
                  <Badge variant="primary">{node.layer}</Badge>
                  <div className="min-w-0 flex-1">
                    <p className="text-sm font-medium text-foreground">{node.label}</p>
                    {node.section && (
                      <p className="text-xs text-muted-foreground">{node.section}</p>
                    )}
                    <p className="mt-1 line-clamp-2 text-sm text-muted-foreground">
                      {node.preview || t("No preview available.")}
                    </p>
                  </div>
                </Link>
              </li>
            ))}
          </ul>
        </Card>
      ) : (
        <Card className="relative min-h-[560px] flex-1 overflow-hidden">
          <div ref={containerRef} className="absolute inset-0" />

          {/* Controls */}
          <div className="absolute right-3 top-3 flex items-center gap-1">
            <Button
              variant="outline"
              size="icon"
              className="h-8 w-8 bg-card"
              onClick={() => zoomBy(1.25)}
              aria-label={t("Zoom in")}
            >
              <ZoomIn size={14} />
            </Button>
            <Button
              variant="outline"
              size="icon"
              className="h-8 w-8 bg-card"
              onClick={() => zoomBy(0.8)}
              aria-label={t("Zoom out")}
            >
              <ZoomOut size={14} />
            </Button>
            <Button
              variant="outline"
              size="icon"
              className="h-8 w-8 bg-card"
              onClick={fit}
              aria-label={t("Fit to view")}
            >
              <Maximize2 size={14} />
            </Button>
            <Button
              variant="outline"
              size="icon"
              className="h-8 w-8 bg-card"
              onClick={() => void load()}
              aria-label={t("Reload")}
            >
              <RefreshCw size={14} />
            </Button>
          </div>

          {/* Legend */}
          <div className="absolute bottom-3 left-3 flex items-center gap-3 rounded-lg border border-border bg-card px-3 py-1.5 text-[11px] text-muted-foreground">
            {LAYER_ORDER.map((layer) => (
              <span key={layer} className="inline-flex items-center gap-1.5">
                <span
                  className="inline-block h-2 w-2 rounded-full"
                  style={{
                    backgroundColor:
                      layer === "L1"
                        ? "var(--muted-foreground)"
                        : "var(--primary)",
                    opacity: nodeOpacity(layer),
                  }}
                />
                {layer}
              </span>
            ))}
            <span className="hidden sm:inline">
              {t("{{n}} nodes", { n: visibleNodeCount })}
            </span>
          </div>

          {/* Node preview drawer */}
          <AnimatePresence>
            {selected && visibleIds.has(selected.id) && (
              <motion.aside
                key={selected.id}
                initial={{ x: 24, opacity: 0 }}
                animate={{ x: 0, opacity: 1 }}
                exit={{ x: 24, opacity: 0 }}
                transition={{ duration: 0.15 }}
                className="absolute bottom-3 right-3 top-14 w-[320px] overflow-y-auto rounded-xl border border-border bg-card p-4 shadow-hairline"
              >
                <div className="flex items-start justify-between gap-2">
                  <div className="flex items-center gap-2">
                    <Badge variant="primary">{selected.layer}</Badge>
                    <span className="text-[11px] text-muted-foreground">
                      {selected.cluster.split(":").slice(1).join(":")}
                    </span>
                  </div>
                  <Button
                    variant="ghost"
                    size="icon"
                    className="h-7 w-7"
                    onClick={() => setSelected(null)}
                    aria-label={t("Close")}
                  >
                    <X size={14} />
                  </Button>
                </div>
                <h3 className="display mt-3 text-sm font-medium text-foreground">
                  {selected.label}
                </h3>
                {selected.section && (
                  <p className="mt-0.5 text-[11px] uppercase tracking-wide text-muted-foreground">
                    {selected.section}
                  </p>
                )}
                <p className="mt-2 whitespace-pre-wrap break-words text-[13px] leading-relaxed text-foreground">
                  {selected.preview || t("No preview available.")}
                </p>
                <div className="mt-4">
                  <Link href={selected.href}>
                    <Button variant="outline" size="sm" className="w-full">
                      {t("Open in workbench")}
                    </Button>
                  </Link>
                </div>
              </motion.aside>
            )}
          </AnimatePresence>
        </Card>
      )}
    </div>
  );
}

function labelPosition(cluster: ClusterMeta): { x: number; y: number } {
  const mid = (cluster.startAngle + cluster.endAngle) / 2;
  const r = cluster.outerRadius + 34;
  // Cluster cx/cy are the slice-centroid at mid radius; recover the graph
  // centre by projecting back, then out to the label radius.
  const midR = (cluster.innerRadius + cluster.outerRadius) / 2;
  const cx = cluster.cx - Math.cos(mid) * midR;
  const cy = cluster.cy - Math.sin(mid) * midR;
  return { x: cx + Math.cos(mid) * r, y: cy + Math.sin(mid) * r };
}
