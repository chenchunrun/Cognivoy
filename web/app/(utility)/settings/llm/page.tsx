"use client";

import { useTranslation } from "react-i18next";
import { ServiceEditor } from "@/components/settings/ServiceEditor";
import { CodexOAuthCard } from "@/components/settings/CodexOAuthCard";

export default function LlmSettingsPage() {
  const { t } = useTranslation();
  return (
    <div>
      <ServiceEditor
        service="llm"
        title={t("LLM")}
        description={t(
          "Connect the language model that powers chat, solve, research, and every other capability.",
        )}
      />
      <div className="mt-8">
        <CodexOAuthCard />
      </div>
    </div>
  );
}
