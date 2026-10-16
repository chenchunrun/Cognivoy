import type { Metadata, Viewport } from "next";
import { cookies } from "next/headers";
import Script from "next/script";

import { ThemeScript } from "@/components/ThemeScript";
import { I18nProvider } from "@/i18n/I18nProvider";
import { normalizeLanguage } from "@/i18n/language";

import "./globals.css";

export const metadata: Metadata = {
  title: "Cognivoy",
  description: "Your agent-native learning journey.",
};

export const viewport: Viewport = {
  width: "device-width",
  initialScale: 1,
};

export default async function RootLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  const cookieStore = await cookies();
  const language = normalizeLanguage(cookieStore.get("cognivoy-lang")?.value ?? "en");
  // The client bundle only embeds English statically; forward the request
  // language's bundle with the page so the SSR pass (and client hydration)
  // renders translated strings on the very first paint instead of flashing
  // English until the client effect loads them.
  const initialResources =
    language === "zh"
      ? ((await import("@/locales/zh/app.json")).default as Record<
          string,
          unknown
        >)
      : null;

  return (
    <html
      lang={language}
      suppressHydrationWarning
    >
      <head>
        <Script src="/brand-migration.js" strategy="beforeInteractive" />
        <ThemeScript />
      </head>
      <body>
        <I18nProvider language={language} initialResources={initialResources}>
          {children}
        </I18nProvider>
      </body>
    </html>
  );
}
