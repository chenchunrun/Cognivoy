"use client";

import { useTranslation } from "react-i18next";
import { ServiceEditor } from "@/components/settings/ServiceEditor";

export default function SttSettingsPage() {
  const { t } = useTranslation();
  return (
    <ServiceEditor
      service="stt"
      title={t("Speech-to-Text")}
      description={t("The transcription model used for voice input.")}
    />
  );
}
