"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { createElement } from "react";
import { ImageUp, Trash2, UserX } from "lucide-react";
import { useTranslation } from "react-i18next";
import { fetchAuthStatus } from "@/lib/auth";
import {
  getProfile,
  removeAvatarImage,
  setAvatarMarker,
  setDisplayName,
  uploadAvatarImage,
  type ProfileInfo,
} from "@/lib/profile-api";
import {
  AVATAR_COLOR_NAMES,
  AVATAR_COLORS,
  AVATAR_ICON_NAMES,
  fallbackAvatarFor,
  parseAvatarMarker,
} from "@/lib/avatar";
import { formatDate, type Language } from "@/lib/datetime";
import {
  Badge,
  Button,
  Card,
  CardContent,
  EmptyState,
  Input,
  Skeleton,
  useToast,
} from "@/components/ui";
import { UserAvatar, AVATAR_ICONS } from "@/components/profile/UserAvatar";
import {
  cropToSquareBlob,
  MAX_AVATAR_SOURCE_BYTES,
} from "@/components/profile/crop-avatar-image";

export default function ProfilePage() {
  const { t, i18n } = useTranslation();
  const { toast } = useToast();
  const [profile, setProfile] = useState<ProfileInfo | null>(null);
  const [accountsDisabled, setAccountsDisabled] = useState(false);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [displayName, setDisplayNameDraft] = useState("");
  const fileInputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      const status = await fetchAuthStatus();
      if (cancelled) return;
      // apiFetch redirects to /login on 401 when auth is enabled, so an
      // unauthenticated session never reaches the profile fetch below.
      if (!status?.enabled) {
        setAccountsDisabled(true);
        setLoading(false);
        return;
      }
      try {
        const info = await getProfile();
        if (!cancelled) {
          setProfile(info);
          setDisplayNameDraft(info.display_name || info.username);
        }
      } catch (err) {
        if (!cancelled) {
          toast({
            title: t("Failed to load profile"),
            description: err instanceof Error ? err.message : undefined,
            variant: "destructive",
          });
        }
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [t, toast]);

  const reportError = useCallback(
    (err: unknown, fallback: string) => {
      toast({
        title: fallback,
        description: err instanceof Error ? err.message : undefined,
        variant: "destructive",
      });
    },
    [toast],
  );

  const applyMarker = useCallback(
    async (marker: string) => {
      setBusy(true);
      try {
        const saved = await setAvatarMarker(marker);
        setProfile((prev) => (prev ? { ...prev, avatar: saved } : prev));
        toast({ title: t("Avatar updated"), variant: "success" });
      } catch (err) {
        reportError(err, t("Failed to update avatar"));
      } finally {
        setBusy(false);
      }
    },
    [reportError, t, toast],
  );

  const handleUpload = useCallback(
    async (file: File) => {
      setBusy(true);
      try {
        if (file.size > MAX_AVATAR_SOURCE_BYTES) {
          throw new Error(t("Image is too large"));
        }
        const blob = await cropToSquareBlob(file);
        const marker = await uploadAvatarImage(blob);
        setProfile((prev) => (prev ? { ...prev, avatar: marker } : prev));
        toast({ title: t("Avatar updated"), variant: "success" });
      } catch (err) {
        reportError(err, t("Failed to upload avatar"));
      } finally {
        setBusy(false);
        if (fileInputRef.current) fileInputRef.current.value = "";
      }
    },
    [reportError, t, toast],
  );

  const handleRemoveImage = useCallback(async () => {
    setBusy(true);
    try {
      await removeAvatarImage();
      setProfile((prev) => (prev ? { ...prev, avatar: "" } : prev));
      toast({ title: t("Avatar removed"), variant: "success" });
    } catch (err) {
      reportError(err, t("Failed to remove avatar"));
    } finally {
      setBusy(false);
    }
  }, [reportError, t, toast]);

  const saveDisplayName = useCallback(async () => {
    const value = displayName.trim();
    if (!value || value.length > 80) return;
    setBusy(true);
    try {
      const saved = await setDisplayName(value);
      setDisplayNameDraft(saved);
      setProfile((prev) => (prev ? { ...prev, display_name: saved } : prev));
      toast({ title: t("Profile updated"), variant: "success" });
    } catch (err) {
      reportError(err, t("Failed to update profile"));
    } finally {
      setBusy(false);
    }
  }, [displayName, reportError, t, toast]);

  const lang: Language = i18n.language?.startsWith("zh") ? "zh" : "en";
  const descriptor = parseAvatarMarker(profile?.avatar);
  const hasImage = descriptor.kind === "image";
  const fallback = fallbackAvatarFor(profile?.username ?? "");
  const selectedIcon =
    descriptor.kind === "icon"
      ? descriptor.icon
      : hasImage
        ? null
        : fallback.icon;
  const selectedColor =
    descriptor.kind === "icon"
      ? descriptor.color
      : hasImage
        ? null
        : fallback.color;

  let joined: string | null = null;
  if (profile?.created_at) {
    const date = new Date(profile.created_at);
    if (!Number.isNaN(date.getTime())) joined = formatDate(date, lang);
  }

  return (
    <div className="mx-auto w-full max-w-2xl px-6 py-10">
      <header>
        <h1 className="display text-2xl font-medium text-foreground">
          {t("Profile")}
        </h1>
        <p className="mt-1.5 text-sm text-muted-foreground">
          {t("View your account and personalize your avatar.")}
        </p>
      </header>

      {loading ? (
        <div className="mt-8 space-y-4" aria-hidden>
          <Card>
            <CardContent className="flex items-center gap-5 p-6">
              <Skeleton className="h-16 w-16 rounded-full" />
              <div className="flex-1 space-y-2">
                <Skeleton className="h-4 w-40" />
                <Skeleton className="h-3 w-24" />
              </div>
            </CardContent>
          </Card>
          <Card>
            <CardContent className="space-y-3 p-6">
              <Skeleton className="h-4 w-32" />
              <Skeleton className="h-9 w-full" />
              <Skeleton className="h-9 w-full" />
            </CardContent>
          </Card>
        </div>
      ) : accountsDisabled ? (
        <Card className="mt-8">
          <EmptyState
            icon={UserX}
            title={t("Accounts are disabled")}
            description={t(
              "This Cognivoy server is running without user accounts, so there is no profile to show.",
            )}
          />
        </Card>
      ) : !profile ? (
        <Card className="mt-8">
          <EmptyState
            icon={UserX}
            title={t("Failed to load profile")}
            description={t("Check your connection and try again.")}
          />
        </Card>
      ) : (
        <div className="mt-8 space-y-4">
          {/* Account card */}
          <Card>
            <CardContent className="flex items-center gap-5 p-6">
              <UserAvatar
                username={profile.username}
                userId={profile.id}
                avatar={profile.avatar}
                size={64}
              />
              <div className="min-w-0">
                <div className="flex items-center gap-2.5">
                  <span className="truncate text-lg font-medium text-foreground">
                    {profile.display_name || profile.username}
                  </span>
                  <Badge
                    variant={
                      profile.role === "admin" ? "primary" : "default"
                    }
                  >
                    {profile.role === "admin" ? t("Admin") : t("User")}
                  </Badge>
                </div>
                {joined && (
                  <p className="mt-1 text-sm text-muted-foreground">
                    {t("Joined {{date}}", { date: joined })}
                  </p>
                )}
              </div>
            </CardContent>
          </Card>

          <Card>
            <CardContent className="p-6">
              <h2 className="text-sm font-medium text-foreground">
                {t("Display name")}
              </h2>
              <p className="mt-0.5 text-sm text-muted-foreground">
                {t("Shown across your profile without changing your login username.")}
              </p>
              <div className="mt-4 flex gap-2">
                <Input
                  aria-label={t("Display name")}
                  value={displayName}
                  maxLength={80}
                  onChange={(event) => setDisplayNameDraft(event.target.value)}
                />
                <Button
                  loading={busy}
                  disabled={!displayName.trim() || displayName.trim() === (profile.display_name || profile.username)}
                  onClick={() => void saveDisplayName()}
                >
                  {t("Save")}
                </Button>
              </div>
            </CardContent>
          </Card>

          {/* Avatar card */}
          <Card>
            <CardContent className="p-6">
              <h2 className="text-sm font-medium text-foreground">
                {t("Avatar")}
              </h2>
              <p className="mt-0.5 text-sm text-muted-foreground">
                {t("Upload a picture or pick an icon.")}
              </p>

              <div className="mt-4 flex flex-wrap items-center gap-2">
                <input
                  ref={fileInputRef}
                  type="file"
                  accept="image/png,image/jpeg,image/webp"
                  className="hidden"
                  onChange={(event) => {
                    const file = event.target.files?.[0];
                    if (file) void handleUpload(file);
                  }}
                />
                <Button
                  variant="outline"
                  size="sm"
                  loading={busy}
                  onClick={() => fileInputRef.current?.click()}
                >
                  <ImageUp size={14} />
                  {t("Upload image")}
                </Button>
                {hasImage && (
                  <Button
                    variant="ghost"
                    size="sm"
                    disabled={busy}
                    onClick={() => void handleRemoveImage()}
                  >
                    <Trash2 size={14} />
                    {t("Remove photo")}
                  </Button>
                )}
              </div>

              <div className="mt-6">
                <p className="mb-2 text-xs font-medium uppercase tracking-wider text-muted-foreground">
                  {t("Or pick an icon")}
                </p>
                <div className="flex flex-wrap gap-2">
                  {AVATAR_ICON_NAMES.map((name) => {
                    const active = !hasImage && name === selectedIcon;
                    const color = selectedColor ?? fallback.color;
                    return (
                      <button
                        key={name}
                        type="button"
                        onClick={() =>
                          void applyMarker(`icon:${name}:${color}`)
                        }
                        disabled={busy}
                        aria-label={name}
                        aria-pressed={active}
                        className={`flex h-10 w-10 items-center justify-center rounded-full text-white transition-all duration-150 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:opacity-50 ${
                          active
                            ? "ring-2 ring-primary ring-offset-2 ring-offset-card"
                            : "opacity-75 hover:opacity-100"
                        }`}
                        style={{ backgroundColor: AVATAR_COLORS[color] }}
                      >
                        {createElement(AVATAR_ICONS[name] ?? AVATAR_ICONS.sparkles, {
                          size: 18,
                          strokeWidth: 1.8,
                        })}
                      </button>
                    );
                  })}
                </div>
                <p className="mb-2 mt-4 text-xs font-medium uppercase tracking-wider text-muted-foreground">
                  {t("Color")}
                </p>
                <div className="flex flex-wrap gap-2">
                  {AVATAR_COLOR_NAMES.map((name) => {
                    const active = !hasImage && name === selectedColor;
                    const icon = selectedIcon ?? fallback.icon;
                    return (
                      <button
                        key={name}
                        type="button"
                        onClick={() => void applyMarker(`icon:${icon}:${name}`)}
                        disabled={busy}
                        aria-label={name}
                        aria-pressed={active}
                        className={`h-7 w-7 rounded-full transition-all duration-150 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:opacity-50 ${
                          active
                            ? "ring-2 ring-primary ring-offset-2 ring-offset-card"
                            : "opacity-75 hover:opacity-100"
                        }`}
                        style={{ backgroundColor: AVATAR_COLORS[name] }}
                      />
                    );
                  })}
                </div>
              </div>
            </CardContent>
          </Card>

          {/* Account info card */}
          <Card>
            <CardContent className="p-6">
              <h2 className="text-sm font-medium text-foreground">
                {t("Account info")}
              </h2>
              <dl className="mt-4 space-y-3 text-sm">
                <div className="flex items-center justify-between gap-4">
                  <dt className="text-muted-foreground">{t("Username")}</dt>
                  <dd className="truncate font-medium text-foreground">
                    {profile.username}
                  </dd>
                </div>
                <div className="flex items-center justify-between gap-4">
                  <dt className="text-muted-foreground">{t("User ID")}</dt>
                  <dd className="truncate font-mono text-xs text-foreground">
                    {profile.id}
                  </dd>
                </div>
                <div className="flex items-center justify-between gap-4">
                  <dt className="text-muted-foreground">{t("Role")}</dt>
                  <dd className="text-foreground">
                    {profile.role === "admin" ? t("Admin") : t("User")}
                  </dd>
                </div>
                {joined && (
                  <div className="flex items-center justify-between gap-4">
                    <dt className="text-muted-foreground">{t("Joined")}</dt>
                    <dd className="text-foreground">{joined}</dd>
                  </div>
                )}
              </dl>
            </CardContent>
          </Card>
        </div>
      )}
    </div>
  );
}
