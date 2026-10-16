"use client";

import { Lock, RefreshCw, WifiOff } from "lucide-react";
import { usePathname } from "next/navigation";
import { useTranslation } from "react-i18next";

import { useCapabilityAccess } from "./CapabilityAccessContext";
import { CAPABILITY_LABEL, capabilityForPath } from "@/lib/capability-routes";

export function CapabilityGate({ children }: { children: React.ReactNode }) {
  const { t } = useTranslation();
  const pathname = usePathname() ?? "";
  const capability = capabilityForPath(pathname);
  const { has, loading, refresh, verificationError } = useCapabilityAccess();
  if (capability && verificationError) {
    return (
      <div className="flex min-h-[70vh] items-center justify-center p-6">
        <div className="surface max-w-md p-8 text-center" role="alert">
          <span className="mx-auto flex h-12 w-12 items-center justify-center rounded-full bg-muted text-muted-foreground">
            <WifiOff size={20} />
          </span>
          <h1 className="display mt-4 text-xl font-semibold text-foreground">
            {t("Could not verify feature access")}
          </h1>
          <p className="mt-2 text-sm leading-relaxed text-muted-foreground">
            {t("Cognivoy could not reach the access service. Your permissions have not been changed.")}
          </p>
          <button
            type="button"
            onClick={() => void refresh()}
            disabled={loading}
            className="mt-5 inline-flex items-center gap-2 rounded-lg bg-primary px-4 py-2 text-sm font-medium text-primary-foreground disabled:opacity-60"
          >
            <RefreshCw size={14} className={loading ? "animate-spin" : undefined} />
            {loading ? t("Checking access…") : t("Retry access check")}
          </button>
        </div>
      </div>
    );
  }
  if (!capability || has(capability)) return <>{children}</>;
  return (
    <div className="flex min-h-[70vh] items-center justify-center p-6">
      <div className="surface max-w-md p-8 text-center">
        <span className="mx-auto flex h-12 w-12 items-center justify-center rounded-full bg-muted text-muted-foreground"><Lock size={20} /></span>
        <h1 className="display mt-4 text-xl font-semibold text-foreground">{t("Feature locked")}</h1>
        <p className="mt-2 text-sm leading-relaxed text-muted-foreground">
          {t("Your account doesn't have {{model}} assigned yet. Please contact your administrator to get access.", { model: t(CAPABILITY_LABEL[capability]) })}
        </p>
      </div>
    </div>
  );
}
