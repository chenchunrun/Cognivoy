"use client";

// Resolver landing page for ``m_<ULID>`` citations clicked from an L3 doc.
// The id alone is not enough to navigate — the backend resolver looks up
// which L2 surface owns it; this page is just the redirect shim.

import Link from "next/link";
import { useRouter, useSearchParams } from "next/navigation";
import { Suspense, useEffect, useState } from "react";
import { Loader2 } from "lucide-react";
import { useTranslation } from "react-i18next";

import { Button, Card } from "@/components/ui";
import { resolveEntry } from "@/components/memory/api";

function ResolveInner() {
  const { t } = useTranslation();
  const params = useSearchParams();
  const router = useRouter();
  const id = params.get("id");
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!id) return;
    let cancelled = false;
    (async () => {
      try {
        const data = await resolveEntry(id);
        if (cancelled) return;
        router.replace(
          `/memory/${data.layer.toLowerCase()}/${encodeURIComponent(data.key)}?focus=${encodeURIComponent(data.entry_id)}`,
        );
      } catch (e) {
        if (cancelled) return;
        setError(
          e instanceof Error
            ? e.message
            : t("Entry {{id}} not found in any L2 doc — it may have been deleted.", { id }),
        );
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [id, router, t]);

  const message = !id ? t("Missing ?id= in URL") : error;

  if (message) {
    return (
      <div className="grid min-h-[60vh] place-items-center px-6 py-10">
        <Card className="max-w-md space-y-4 p-6 text-center">
          <p className="text-sm text-foreground">{message}</p>
          <Link href="/memory">
            <Button variant="outline" size="sm">
              {t("Back to memory")}
            </Button>
          </Link>
        </Card>
      </div>
    );
  }

  return (
    <div className="grid min-h-[60vh] place-items-center px-6 py-10 text-muted-foreground">
      <div className="flex items-center gap-2 text-sm">
        <Loader2 size={16} className="animate-spin" />
        <span>{t("Resolving entry…")}</span>
      </div>
    </div>
  );
}

export default function MemoryResolvePage() {
  return (
    <Suspense
      fallback={
        <div className="grid min-h-[60vh] place-items-center text-muted-foreground">
          <Loader2 size={16} className="animate-spin" />
        </div>
      }
    >
      <ResolveInner />
    </Suspense>
  );
}
