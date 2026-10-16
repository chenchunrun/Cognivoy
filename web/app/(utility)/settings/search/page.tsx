"use client";

import { useTranslation } from "react-i18next";
import { ServiceEditor } from "@/components/settings/ServiceEditor";

export default function SearchSettingsPage() {
  const { t } = useTranslation();
  return (
    <ServiceEditor
      service="search"
      title={t("Search")}
      description={t(
        "The web search provider behind the web_search tool and deep research.",
      )}
    />
  );
}
