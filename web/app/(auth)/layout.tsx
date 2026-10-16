"use client";

import { useTranslation } from "react-i18next";

export default function AuthLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  const { t } = useTranslation();
  return (
    <main className="flex min-h-screen flex-col items-center justify-center bg-background px-4 py-10">
      <div className="mb-8 text-center">
        <div className="display text-3xl font-semibold text-foreground">
          Cognivoy
        </div>
        <p className="mt-2 text-sm font-medium text-foreground">
          {t("个人智能学习伙伴")}
        </p>
        <p className="mt-1 text-sm text-muted-foreground">
          {t("Your agent-native learning journey.")}
        </p>
      </div>
      {children}
    </main>
  );
}
