"use client";

import { useTranslation } from "react-i18next";
import { ServiceEditor } from "@/components/settings/ServiceEditor";

export default function VideoSettingsPage() {
  const { t } = useTranslation();
  return (
    <ServiceEditor
      service="videogen"
      title={t("Video Generation")}
      description={t("The video model used by the video generation tool.")}
    />
  );
}
