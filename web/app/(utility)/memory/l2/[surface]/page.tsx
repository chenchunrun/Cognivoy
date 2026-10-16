"use client";

// ``?focus=m_xxx`` scrolls + flashes the cited entry after render —
// linked from L3 footnotes via /memory/resolve.

import { useParams, useSearchParams } from "next/navigation";
import { Suspense } from "react";

import { MemoryDocWorkbench } from "@/components/memory/MemoryDocWorkbench";

function MemoryL2DocPageInner() {
  const params = useParams<{ surface?: string }>();
  const search = useSearchParams();
  const surface = typeof params.surface === "string" ? params.surface : undefined;
  return (
    <MemoryDocWorkbench
      layer="L2"
      initialKey={surface}
      initialFocus={search.get("focus") ?? undefined}
    />
  );
}

export default function MemoryL2DocPage() {
  return (
    <Suspense fallback={<MemoryDocWorkbench layer="L2" />}>
      <MemoryL2DocPageInner />
    </Suspense>
  );
}
