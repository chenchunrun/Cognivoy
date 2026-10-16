"use client";

import { useTranslation } from "react-i18next";
import { ServiceEditor } from "@/components/settings/ServiceEditor";

export default function TtsSettingsPage() {
  const { t } = useTranslation();
  return (
    <ServiceEditor
      service="tts"
      title={t("Text-to-Speech")}
      description={t("The voice model used to read chat replies aloud.")}
    />
  );
}
