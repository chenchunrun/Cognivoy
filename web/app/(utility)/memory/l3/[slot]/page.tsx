"use client";

import { useParams, useSearchParams } from "next/navigation";
import { Suspense } from "react";

import { MemoryDocWorkbench } from "@/components/memory/MemoryDocWorkbench";

function MemoryL3DocPageInner() {
  const params = useParams<{ slot?: string }>();
  const search = useSearchParams();
  const slot = typeof params.slot === "string" ? params.slot : undefined;
  return (
    <MemoryDocWorkbench
      layer="L3"
      initialKey={slot}
      initialFocus={search.get("focus") ?? undefined}
    />
  );
}

export default function MemoryL3DocPage() {
  return (
    <Suspense fallback={<MemoryDocWorkbench layer="L3" />}>
      <MemoryL3DocPageInner />
    </Suspense>
  );
}
