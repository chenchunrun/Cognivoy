"use client";

import * as React from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useTranslation } from "react-i18next";
import { Info } from "lucide-react";

import { checkIsFirstUser, fetchAuthStatus, register } from "@/lib/auth";
import { Button, Input, Spinner } from "@/components/ui";

export default function RegisterPage() {
  const { t } = useTranslation();
  const router = useRouter();

  const [checking, setChecking] = React.useState(true);
  const [isFirstUser, setIsFirstUser] = React.useState(false);
  const [username, setUsername] = React.useState("");
  const [password, setPassword] = React.useState("");
  const [confirm, setConfirm] = React.useState("");
  const [error, setError] = React.useState<string | null>(null);
  const [submitting, setSubmitting] = React.useState(false);

  React.useEffect(() => {
    let cancelled = false;
    fetchAuthStatus().then((status) => {
      if (cancelled) return;
      // Auth disabled (app runs without login) or already signed in.
      if (status && (!status.enabled || status.authenticated)) {
        router.replace("/home");
        return;
      }
      setChecking(false);
    });
    checkIsFirstUser().then((first) => {
      if (!cancelled) setIsFirstUser(first);
    });
    return () => {
      cancelled = true;
    };
  }, [router]);

  const onSubmit = async (event: React.FormEvent) => {
    event.preventDefault();
    if (submitting) return;
    setError(null);
    if (password !== confirm) {
      setError(t("Passwords do not match"));
      return;
    }
    setSubmitting(true);
    const result = await register(username.trim(), password);
    setSubmitting(false);
    if (result.ok) {
      router.replace("/login");
    } else {
      setError(result.error || t("Create failed"));
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
            {t("Create account")}
          </h1>
          {isFirstUser && (
            <p className="mt-3 flex items-start gap-2 rounded-lg border border-border bg-muted px-3 py-2 text-xs text-muted-foreground">
              <Info size={14} className="mt-0.5 shrink-0" />
              {t(
                "You will be granted admin privileges and can manage other users from the admin dashboard.",
              )}
            </p>
          )}
          <form onSubmit={onSubmit} className="mt-5 space-y-4">
            <div className="space-y-1.5">
              <label
                htmlFor="register-username"
                className="text-sm font-medium text-foreground"
              >
                {t("Username")}
              </label>
              <Input
                id="register-username"
                autoComplete="username"
                value={username}
                onChange={(event) => setUsername(event.target.value)}
                required
              />
            </div>
            <div className="space-y-1.5">
              <label
                htmlFor="register-password"
                className="text-sm font-medium text-foreground"
              >
                {t("Password (≥ 8 chars)")}
              </label>
              <Input
                id="register-password"
                type="password"
                autoComplete="new-password"
                minLength={8}
                value={password}
                onChange={(event) => setPassword(event.target.value)}
                required
              />
            </div>
            <div className="space-y-1.5">
              <label
                htmlFor="register-confirm"
                className="text-sm font-medium text-foreground"
              >
                {t("Confirm password")}
              </label>
              <Input
                id="register-confirm"
                type="password"
                autoComplete="new-password"
                minLength={8}
                value={confirm}
                onChange={(event) => setConfirm(event.target.value)}
                required
              />
            </div>
            {error && <p className="text-sm text-destructive">{error}</p>}
            <Button type="submit" className="w-full" loading={submitting}>
              {submitting ? t("Creating account…") : t("Create account")}
            </Button>
          </form>
          <p className="mt-5 text-center text-sm text-muted-foreground">
            {t("Already have an account?")}{" "}
            <Link href="/login" className="text-primary hover:underline">
              {t("Sign in")}
            </Link>
          </p>
        </>
      )}
    </div>
  );
}
