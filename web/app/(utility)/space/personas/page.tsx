"use client";

import * as React from "react";
import { useTranslation } from "react-i18next";
import { Pencil, Plus, Trash2, UserRound } from "lucide-react";
import {
  Badge,
  Button,
  ConfirmDialog,
  EmptyState,
  Skeleton,
  useToast,
} from "@/components/ui";
import { SpaceHeader } from "@/components/space/SpaceHeader";
import {
  PersonaFormDialog,
  type PersonaFormValues,
} from "@/components/space/PersonaFormDialog";
import {
  createPersona,
  deletePersona,
  getPersona,
  listPersonas,
  updatePersona,
  type PersonaDetail,
  type PersonaInfo,
} from "@/lib/personas-api";

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export default function SpacePersonasPage() {
  const { t } = useTranslation();
  const { toast } = useToast();

  const [personas, setPersonas] = React.useState<PersonaInfo[]>([]);
  const [loading, setLoading] = React.useState(true);
  const [formOpen, setFormOpen] = React.useState(false);
  const [formTarget, setFormTarget] = React.useState<PersonaDetail | null>(null);
  const [deleteTarget, setDeleteTarget] = React.useState<PersonaInfo | null>(
    null,
  );
  const [deleting, setDeleting] = React.useState(false);

  const load = React.useCallback(
    async (force = false) => {
      setLoading(true);
      try {
        setPersonas(await listPersonas({ force }));
      } catch (error) {
        toast({
          variant: "destructive",
          title: t("Failed to load personas"),
          description: errorMessage(error),
        });
      } finally {
        setLoading(false);
      }
    },
    [t, toast],
  );

  React.useEffect(() => {
    void load();
  }, [load]);

  const openEditor = async (persona: PersonaInfo) => {
    try {
      setFormTarget(await getPersona(persona.name));
      setFormOpen(true);
    } catch (error) {
      toast({
        variant: "destructive",
        title: t("Failed to load persona"),
        description: errorMessage(error),
      });
    }
  };

  const handleSubmit = async (values: PersonaFormValues) => {
    try {
      if (formTarget) {
        await updatePersona(formTarget.name, {
          description: values.description,
          content: values.content,
          language: values.language,
          style: values.style,
          icon: values.icon,
          ...(values.name !== formTarget.name
            ? { rename_to: values.name }
            : {}),
        });
        toast({ variant: "success", title: t("Persona updated") });
      } else {
        await createPersona(values);
        toast({ variant: "success", title: t("Persona created") });
      }
      await load(true);
    } catch (error) {
      toast({
        variant: "destructive",
        title: formTarget
          ? t("Failed to update persona")
          : t("Failed to create persona"),
        description: errorMessage(error),
      });
      throw error;
    }
  };

  const handleDelete = async () => {
    if (!deleteTarget) return;
    setDeleting(true);
    try {
      await deletePersona(deleteTarget.name);
      toast({ variant: "success", title: t("Persona deleted") });
      setDeleteTarget(null);
      await load(true);
    } catch (error) {
      toast({
        variant: "destructive",
        title: t("Failed to delete persona"),
        description: errorMessage(error),
      });
    } finally {
      setDeleting(false);
    }
  };

  return (
    <div className="mx-auto max-w-4xl px-6 py-8">
      <SpaceHeader
        back
        title={t("Personas")}
        description={t(
          "Behavior presets you can apply per conversation to shape how the tutor responds.",
        )}
        actions={
          <Button
            size="sm"
            onClick={() => {
              setFormTarget(null);
              setFormOpen(true);
            }}
          >
            <Plus size={14} aria-hidden="true" />
            {t("New persona")}
          </Button>
        }
      />

      {loading ? (
        <div className="grid gap-3 sm:grid-cols-2">
          {Array.from({ length: 4 }).map((_, i) => (
            <Skeleton key={i} className="h-24 w-full" />
          ))}
        </div>
      ) : personas.length === 0 ? (
        <div className="surface">
          <EmptyState
            icon={UserRound}
            title={t("No personas yet")}
            description={t(
              "Create a persona to give the tutor a consistent voice and behavior.",
            )}
            action={
              <Button
                size="sm"
                onClick={() => {
                  setFormTarget(null);
                  setFormOpen(true);
                }}
              >
                <Plus size={14} aria-hidden="true" />
                {t("New persona")}
              </Button>
            }
          />
        </div>
      ) : (
        <div className="grid gap-3 sm:grid-cols-2">
          {personas.map((persona) => (
            <div key={persona.name} className="surface flex flex-col p-4">
              <div className="flex items-start justify-between gap-2">
                <div className="min-w-0">
                  <h3 className="truncate text-sm font-medium text-foreground">
                    {persona.name}
                  </h3>
                  <p className="mt-1 line-clamp-2 text-xs leading-relaxed text-muted-foreground">
                    {persona.description || t("No description")}
                  </p>
                  <div className="mt-2 flex flex-wrap gap-1">
                    <Badge variant="outline">{persona.language === "auto" ? t("Follow user language") : persona.language.toUpperCase()}</Badge>
                    {persona.style && <Badge variant="outline">{persona.style}</Badge>}
                    <Badge variant="outline">{t("Icon: {{icon}}", { icon: persona.icon })}</Badge>
                  </div>
                </div>
                {persona.source === "admin" && (
                  <Badge variant="outline" className="shrink-0">
                    {t("Admin")}
                  </Badge>
                )}
              </div>
              <div className="mt-3 flex items-center justify-end gap-1">
                {persona.read_only ? (
                  <span className="text-xs text-muted-foreground">
                    {t("Read-only")}
                  </span>
                ) : (
                  <>
                    <Button
                      variant="ghost"
                      size="sm"
                      onClick={() => void openEditor(persona)}
                    >
                      <Pencil size={13} aria-hidden="true" />
                      {t("Edit")}
                    </Button>
                    <Button
                      variant="ghost"
                      size="sm"
                      onClick={() => setDeleteTarget(persona)}
                      className="text-muted-foreground hover:text-destructive"
                    >
                      <Trash2 size={13} aria-hidden="true" />
                      {t("Delete")}
                    </Button>
                  </>
                )}
              </div>
            </div>
          ))}
        </div>
      )}

      <PersonaFormDialog
        open={formOpen}
        onClose={() => setFormOpen(false)}
        persona={formTarget}
        onSubmit={handleSubmit}
      />
      <ConfirmDialog
        open={Boolean(deleteTarget)}
        onClose={() => setDeleteTarget(null)}
        onConfirm={() => void handleDelete()}
        title={t("Delete persona")}
        description={t('Delete the persona "{{name}}"? This cannot be undone.', {
          name: deleteTarget?.name ?? "",
        })}
        confirmText={t("Delete")}
        destructive
        loading={deleting}
      />
    </div>
  );
}
