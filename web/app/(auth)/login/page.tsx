"use client";

import * as React from "react";
import Link from "next/link";
import { useRouter, useSearchParams } from "next/navigation";
import { useTranslation } from "react-i18next";

import { fetchAuthStatus, login } from "@/lib/auth";
import { safeNextPath } from "@/lib/auth-redirect";
import { Button, Input, Spinner } from "@/components/ui";

/**
 * The `?next=` post-login redirect must stay on this origin: accept only
 * root-relative paths (`/...`) and reject protocol-relative `//host`
 * (which browsers resolve cross-origin). Anything else falls back to /home.
 */
function LoginForm() {
  const { t } = useTranslation();
  const router = useRouter();
  const searchParams = useSearchParams();
  const next = safeNextPath(searchParams.get("next"));

  const [checking, setChecking] = React.useState(true);
  const [username, setUsername] = React.useState("");
  const [password, setPassword] = React.useState("");
  const [error, setError] = React.useState<string | null>(null);
  const [submitting, setSubmitting] = React.useState(false);

  React.useEffect(() => {
    let cancelled = false;
    fetchAuthStatus().then((status) => {
      if (cancelled) return;
      // Auth disabled (app runs without login) or already signed in.
      if (status && (!status.enabled || status.authenticated)) {
        router.replace(next);
        return;
      }
      setChecking(false);
    });
    return () => {
      cancelled = true;
    };
  }, [next, router]);

  const onSubmit = async (event: React.FormEvent) => {
    event.preventDefault();
    if (submitting) return;
    setError(null);
    setSubmitting(true);
    const result = await login(username.trim(), password);
    setSubmitting(false);
    if (result.ok) {
      router.replace(next);
    } else {
      setError(result.error || t("Sign in"));
    }
  };

  return (
    <div className="surface w-full max-w-sm p-6">
      {checking ? (
        <div className="flex justify-center py-10">
          <Spinner size={20} />
        </div>
      ) : (
        <>
          <h1 className="display text-xl font-medium text-foreground">
            {t("Sign in")}
          </h1>
          <form onSubmit={onSubmit} className="mt-5 space-y-4">
            <div className="space-y-1.5">
              <label
                htmlFor="login-username"
                className="text-sm font-medium text-foreground"
              >
                {t("Username")}
              </label>
              <Input
                id="login-username"
                autoComplete="username"
                value={username}
                onChange={(event) => setUsername(event.target.value)}
                required
              />
            </div>
            <div className="space-y-1.5">
              <label
                htmlFor="login-password"
                className="text-sm font-medium text-foreground"
              >
                {t("Password")}
              </label>
              <Input
                id="login-password"
                type="password"
                autoComplete="current-password"
                value={password}
                onChange={(event) => setPassword(event.target.value)}
                required
              />
            </div>
            {error && <p className="text-sm text-destructive">{error}</p>}
            <Button type="submit" className="w-full" loading={submitting}>
              {submitting ? t("Signing in…") : t("Sign in")}
            </Button>
          </form>
          <p className="mt-5 text-center text-sm text-muted-foreground">
            {t("Don't have an account?")}{" "}
            <Link href="/register" className="text-primary hover:underline">
              {t("Create account")}
            </Link>
          </p>
        </>
      )}
    </div>
  );
}

export default function LoginPage() {
  return (
    <React.Suspense fallback={null}>
      <LoginForm />
    </React.Suspense>
  );
}
