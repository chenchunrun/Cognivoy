"use client";

import { useTranslation } from "react-i18next";
import { ServiceEditor } from "@/components/settings/ServiceEditor";

export default function ImageSettingsPage() {
  const { t } = useTranslation();
  return (
    <ServiceEditor
      service="imagegen"
      title={t("Image Generation")}
      description={t("The image model used by the image generation tool.")}
    />
  );
}
