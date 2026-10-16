"use client";

/**
 * New partner: a single-page creation form —
 * identity (name / description), one optional channel rendered from its
 * JSON schema, and the soul (library template, chat persona, or custom).
 * Further channels, model routing and tools are configured afterwards on
 * the partner's Config tab.
 */

import * as React from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { ArrowLeft, Sparkles } from "lucide-react";
import { useTranslation } from "react-i18next";
import {
  createPartner,
  getChannelSchemas,
  type ChannelsSchemaResponse,
  type SoulSpec,
} from "@/lib/partners-api";
import { Button, Input, Select, Skeleton, useToast } from "@/components/ui";
import { SoulPicker } from "@/components/partners/soul-picker";
import {
  ChannelConfigFields,
  useSecretReveal,
} from "@/components/partners/channel-config-fields";
import { validateChannelConfig } from "@/lib/partner-channel-validation";

export default function NewPartnerPage() {
  const router = useRouter();
  const { t } = useTranslation();
  const { toast } = useToast();

  const [name, setName] = React.useState("");
  const [description, setDescription] = React.useState("");
  const [soul, setSoul] = React.useState<SoulSpec>({ source: "default" });

  const [catalog, setCatalog] = React.useState<ChannelsSchemaResponse | null>(
    null,
  );
  const [channelName, setChannelName] = React.useState("");
  const [channelConfig, setChannelConfig] = React.useState<Record<
    string,
    unknown
  > | null>(null);
  const { revealed, toggleSecret } = useSecretReveal();

  const [creating, setCreating] = React.useState(false);

  React.useEffect(() => {
    void getChannelSchemas()
      .then(setCatalog)
      .catch(() => setCatalog({ channels: {} }));
  }, []);

  const channelEntries = catalog ? Object.entries(catalog.channels) : [];
  const activeEntry = channelName ? catalog?.channels[channelName] : undefined;

  const selectChannel = (next: string) => {
    setChannelName(next);
    if (!next) {
      setChannelConfig(null);
      return;
    }
    const entry = catalog?.channels[next];
    // Seed the form with the channel's defaults, enabled — the user picked
    // this channel, so default it to on; they can still flip the toggle.
    setChannelConfig(
      entry ? { ...entry.default_config, enabled: true } : { enabled: true },
    );
  };

  const submit = async () => {
    if (!name.trim()) return;
    if (activeEntry && channelConfig) {
      const missing = validateChannelConfig(activeEntry, channelConfig);
      if (missing.length > 0) {
        toast({
          title: t("Complete required channel settings"),
          description: missing.join(", "),
          variant: "destructive",
        });
        return;
      }
    }
    setCreating(true);
    try {
      const result = await createPartner({
        name: name.trim(),
        description: description.trim() || undefined,
        soul,
        channels:
          channelName && channelConfig
            ? { [channelName]: channelConfig }
            : undefined,
        start: true,
      });
      toast({
        title: t("{{name}} is ready", { name: result.name }),
        variant: "success",
      });
      router.push(`/partners/${result.partner_id}`);
    } catch (e) {
      toast({
        title: e instanceof Error ? e.message : t("Create failed"),
        variant: "destructive",
      });
      setCreating(false);
    }
  };

  return (
    <div className="mx-auto h-full max-w-2xl overflow-y-auto px-6 py-8">
      <Link
        href="/partners"
        className="mb-6 inline-flex items-center gap-1.5 text-sm text-muted-foreground transition-colors hover:text-foreground"
      >
        <ArrowLeft className="h-4 w-4" />
        {t("Partners")}
      </Link>

      <header className="mb-8">
        <h1 className="display text-2xl font-medium tracking-tight text-foreground">
          {t("New partner")}
        </h1>
        <p className="mt-1.5 text-sm leading-relaxed text-muted-foreground">
          {t(
            "A name, a soul, and optionally a channel — everything else can be tuned later.",
          )}
        </p>
      </header>

      <div className="space-y-6">
        <section className="surface space-y-4 p-5">
          <div>
            <span className="mb-1.5 block text-sm font-medium text-foreground">
              {t("Name")}
              <span className="ml-0.5 text-destructive">*</span>
            </span>
            <Input
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder={t("e.g. Ada")}
              autoFocus
            />
          </div>
          <div>
            <span className="mb-1.5 block text-sm font-medium text-foreground">
              {t("Description")}
            </span>
            <Input
              value={description}
              onChange={(e) => setDescription(e.target.value)}
              placeholder={t("What is this partner for?")}
            />
          </div>
        </section>

        <section className="surface space-y-4 p-5">
          <div>
            <h3 className="text-sm font-medium text-foreground">
              {t("Channel")}
            </h3>
            <p className="mt-0.5 text-xs leading-relaxed text-muted-foreground">
              {t(
                "Optionally wire this partner to an IM channel right away — you can connect more later.",
              )}
            </p>
          </div>
          {!catalog ? (
            <Skeleton className="h-9 w-56" />
          ) : channelEntries.length === 0 ? (
            <p className="text-sm text-muted-foreground">
              {t("No channels are available on the server.")}
            </p>
          ) : (
            <>
              <Select
                value={channelName}
                onChange={(e) => selectChannel(e.target.value)}
                className="w-64"
                aria-label={t("Channel")}
              >
                <option value="">{t("No channel for now")}</option>
                {channelEntries.map(([key, entry]) => (
                  <option
                    key={key}
                    value={key}
                    disabled={entry.available === false}
                  >
                    {entry.display_name || key}
                  </option>
                ))}
              </Select>
              {activeEntry && channelConfig && (
                <ChannelConfigFields
                  entry={activeEntry}
                  value={channelConfig}
                  onChange={setChannelConfig}
                  revealed={revealed}
                  toggleSecret={toggleSecret}
                />
              )}
            </>
          )}
        </section>

        <section className="surface space-y-4 p-5">
          <div>
            <h3 className="text-sm font-medium text-foreground">{t("Soul")}</h3>
            <p className="mt-0.5 text-xs leading-relaxed text-muted-foreground">
              {t(
                "Who this partner is. Start from a template, clone a chat persona, or write it yourself.",
              )}
            </p>
          </div>
          <SoulPicker value={soul} onChange={setSoul} />
        </section>

        <div className="flex items-center justify-end gap-3 pb-4">
          <Button variant="outline" onClick={() => router.push("/partners")}>
            {t("Cancel")}
          </Button>
          <Button
            onClick={() => void submit()}
            loading={creating}
            disabled={!name.trim()}
          >
            <Sparkles className="h-4 w-4" />
            {t("Create partner")}
          </Button>
        </div>
      </div>
    </div>
  );
}
