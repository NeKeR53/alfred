import {
  Button,
  DataTable,
  type DataTableColumn,
  EmptyState,
  FeedbackBanner,
  FormActions,
  FormField,
  IconButton,
  KeyValueList,
  LoadingSkeleton,
  Page,
  RadioControl,
  RefreshButton,
  Row,
  Section,
  SelectControl,
  Stack,
  Text,
  TextInput,
  useConfirm,
} from "@alfred/ui";
import { Monitor, Moon, Sun, Undo2 } from "lucide-react";
import "./space.css";
import { type FormEvent, useCallback, useEffect, useId, useState } from "react";
import { invoke, onNativeEvent } from "../../lib/native";
import { type Commit, type ResolvedPage, SECTION_COLORS, type SectionColor, type Snapshot } from "../../lib/types";
import { notify } from "../../shell/notifications";
import { useShell } from "../../shell/store";

export interface Grant {
  /** `page:module/page`, `function:module/fonction` ou `function:module/*`. */
  subject: string;
  /** `client:<id>` ou `function:<module/fonction>`. */
  resource: string;
  grantedAt: string;
}

export const ACCENT_LABEL: Record<SectionColor, string> = {
  steel: "Acier",
  blue: "Bleu",
  violet: "Violet",
  pink: "Rose",
  red: "Rouge",
  orange: "Orange",
  green: "Vert",
  teal: "Bleu-vert",
};

const dateFormat = new Intl.DateTimeFormat("fr-FR", { dateStyle: "medium", timeStyle: "short" });

function formatDate(iso: string): string {
  const date = new Date(iso);
  return Number.isNaN(date.getTime()) ? iso : dateFormat.format(date);
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** Nom du gestionnaire de fichiers du système, pour le libellé du bouton. */
function fileManager(platform: string | undefined): string {
  if (platform === "macos") return "le Finder";
  if (platform === "windows") return "l’Explorateur";
  return "le gestionnaire de fichiers";
}

function allPages(snapshot: Snapshot): ResolvedPage[] {
  const pages = [...snapshot.sections.flatMap((section) => section.pages), ...snapshot.settingsPages];
  return [...pages, ...pages.flatMap((page) => (page.panel ? [page.panel] : []))];
}

function moduleName(snapshot: Snapshot | null | undefined, id: string): string {
  return snapshot?.modules.find((module) => module.id === id)?.name ?? id;
}

/** Rend lisible le demandeur d’un accès : une page (ou son panneau) ou les fonctions d’un module. */
export function describeSubject(subject: string, snapshot: Snapshot | null | undefined): string {
  const [kind, ...rest] = subject.split(":");
  const reference = rest.join(":");
  const [module, item] = reference.split("/");
  if (kind === "page") {
    const page = snapshot ? allPages(snapshot).find((candidate) => candidate.reference === reference) : undefined;
    return `Page « ${page?.title ?? item ?? reference} » (module ${moduleName(snapshot, module)})`;
  }
  if (kind === "function") {
    if (!item || item === "*") return `Fonctions du module ${moduleName(snapshot, module)}`;
    return `Fonction « ${item} » (module ${moduleName(snapshot, module)})`;
  }
  return subject;
}

/** Rend lisible la ressource accordée : un client ou une fonction d’un autre module. */
export function describeResource(resource: string, snapshot: Snapshot | null | undefined): string {
  const [kind, ...rest] = resource.split(":");
  const reference = rest.join(":");
  if (kind === "client") {
    const client = snapshot?.modules
      .flatMap((module) => module.clients)
      .find((candidate) => candidate.id === reference);
    return `Client « ${client?.label ?? reference} »`;
  }
  if (kind === "function") {
    const [module, item] = reference.split("/");
    return `Fonction « ${item ?? reference} » (module ${moduleName(snapshot, module)})`;
  }
  return resource;
}

/** Charge une liste au montage et la relit sur demande ; garde la dernière liste en cas d’échec de relecture. */
function useList<Item>(command: string, args: Record<string, unknown>, events: string[]) {
  const [items, setItems] = useState<Item[]>();
  const [error, setError] = useState<string>();
  const [loading, setLoading] = useState(true);
  const key = JSON.stringify(args);
  const eventKey = events.join(",");

  const load = useCallback(async () => {
    setLoading(true);
    try {
      setItems(await invoke<Item[]>(command, JSON.parse(key)));
      setError(undefined);
    } catch (failure) {
      setError(errorMessage(failure));
    } finally {
      setLoading(false);
    }
  }, [command, key]);

  useEffect(() => {
    void load();
    let timer: ReturnType<typeof setTimeout> | undefined;
    const stops = eventKey
      .split(",")
      .filter(Boolean)
      .map((name) =>
        onNativeEvent(name, () => {
          clearTimeout(timer);
          timer = setTimeout(() => void load(), 250);
        }),
      );
    return () => {
      clearTimeout(timer);
      for (const stop of stops) stop();
    };
  }, [load, eventKey]);

  return { items, error, loading, reload: () => void load() };
}

function SpaceSection({
  snapshot,
  confirm,
}: {
  snapshot: Snapshot;
  confirm: ReturnType<typeof useConfirm>["confirm"];
}) {
  const formId = useId();
  const platform = useShell((state) => state.info?.platform);
  const closeSpace = useShell((state) => state.closeSpace);
  const [name, setName] = useState(snapshot.name);
  const [nameError, setNameError] = useState<string>();
  const [saving, setSaving] = useState(false);

  // Un renommage fait ailleurs (agent, autre onglet) remplace la saisie tant qu’elle n’a pas été modifiée.
  const [shownName, setShownName] = useState(snapshot.name);
  if (shownName !== snapshot.name) {
    setShownName(snapshot.name);
    if (name === shownName) setName(snapshot.name);
  }

  const rename = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const next = name.trim();
    if (!next) {
      setNameError("Saisissez le nom de l’espace.");
      return;
    }
    setNameError(undefined);
    if (next === snapshot.name) return;
    setSaving(true);
    try {
      await invoke("space.updateLayout", { name: next, message: `Renommage de l’espace en « ${next} »` });
      await useShell.getState().refresh();
      notify({ title: "Espace renommé", tone: "success" });
    } catch (failure) {
      notify({ title: "L’espace n’a pas été renommé", description: errorMessage(failure), tone: "error" });
    } finally {
      setSaving(false);
    }
  };

  const reveal = async () => {
    try {
      await invoke("files.reveal", { path: snapshot.path });
    } catch (failure) {
      notify({ title: "Le dossier n’a pas pu être affiché", description: errorMessage(failure), tone: "error" });
    }
  };

  const changeSpace = async () => {
    const confirmed = await confirm({
      title: `Fermer l’espace « ${snapshot.name} » ?`,
      message:
        "Alfred revient à l’accueil pour ouvrir ou créer un autre espace. Rien n’est supprimé : cet espace se rouvre depuis l’accueil.",
      confirmLabel: "Changer d’espace",
    });
    if (!confirmed) return;
    try {
      await closeSpace();
    } catch (failure) {
      notify({ title: "L’espace n’a pas été fermé", description: errorMessage(failure), tone: "error" });
    }
  };

  return (
    <Section
      title="Espace"
      description="L’espace rassemble tout ce que vous construisez avec l’agent, dans un dossier."
    >
      <Stack gap="lg">
        <form id={formId} noValidate onSubmit={rename}>
          <Stack gap="md">
            <FormField label="Nom de l’espace" error={nameError}>
              <TextInput
                value={name}
                aria-required="true"
                autoComplete="off"
                onChange={(event) => {
                  setName(event.target.value);
                  setNameError(undefined);
                }}
              />
            </FormField>
            <FormActions
              form={formId}
              submitLabel="Enregistrer"
              pendingLabel="Enregistrement…"
              pending={saving}
              disabled={name.trim() === snapshot.name}
            />
          </Stack>
        </form>
        <KeyValueList items={[{ label: "Dossier", value: <Text as="span">{snapshot.path}</Text> }]} />
        <Row gap="sm" wrap>
          <Button onClick={() => void reveal()}>Afficher dans {fileManager(platform)}</Button>
          <Button onClick={() => void changeSpace()}>Changer d’espace</Button>
        </Row>
      </Stack>
    </Section>
  );
}

function AppearanceSection({ snapshot }: { snapshot: Snapshot }) {
  const theme = useShell((state) => state.theme);
  const followsSystem = useShell((state) => state.themeFollowsSystem);
  const setTheme = useShell((state) => state.setTheme);
  const [accent, setAccent] = useState<string | null>(snapshot.accent);
  const [savingAccent, setSavingAccent] = useState(false);

  const [shownAccent, setShownAccent] = useState(snapshot.accent);
  if (shownAccent !== snapshot.accent) {
    setShownAccent(snapshot.accent);
    setAccent(snapshot.accent);
  }

  const themeChoice = followsSystem ? "system" : theme;
  // Cartes de thème reprises des Préférences de OneApp : le système d’abord, puis clair et sombre.
  const themes = [
    { value: "system", label: "Système", description: "Suit le thème du système", Icon: Monitor },
    { value: "light", label: "Clair", description: "Utilise le thème clair", Icon: Sun },
    { value: "dark", label: "Sombre", description: "Utilise le thème sombre", Icon: Moon },
  ] as const;

  const changeAccent = async (next: string | null) => {
    const previous = accent;
    setAccent(next);
    setSavingAccent(true);
    try {
      await invoke("space.updateLayout", {
        accent: next,
        message: next
          ? `Couleur d’accent : ${ACCENT_LABEL[next as SectionColor] ?? next}`
          : "Couleur d’accent par défaut",
      });
      await useShell.getState().refresh();
    } catch (failure) {
      setAccent(previous);
      notify({ title: "La couleur d’accent n’a pas été changée", description: errorMessage(failure), tone: "error" });
    } finally {
      setSavingAccent(false);
    }
  };

  return (
    <Section
      title="Apparence"
      description="Ces réglages s’appliquent dès qu’ils sont modifiés. Le reste du thème (police, tailles, couleurs des états) est fixé par Alfred pour que toutes les pages restent lisibles et cohérentes."
    >
      <Stack gap="md">
        <fieldset className="theme-choice-fieldset">
          <legend>Thème</legend>
          <div className="theme-options" role="radiogroup" aria-label="Thème">
            {themes.map(({ value, label, description, Icon }) => (
              <RadioControl
                key={value}
                className={`theme-option${themeChoice === value ? " is-selected" : ""}`}
                name="theme"
                value={value}
                checked={themeChoice === value}
                onChange={() => setTheme(value === "system" ? null : value)}
                label={
                  <span className="theme-option-content">
                    <span className="theme-option-icon">
                      <Icon size={18} aria-hidden="true" />
                    </span>
                    <span>
                      <strong title={label}>{label}</strong>
                      <small title={description}>{description}</small>
                    </span>
                  </span>
                }
              />
            ))}
          </div>
        </fieldset>
        <FormField label="Couleur d’accent" hint="Elle marque le focus, la sélection et le choix actif.">
          <SelectControl
            value={accent ?? ""}
            disabled={savingAccent}
            onChange={(event) => void changeAccent(event.target.value || null)}
          >
            <option value="">Par défaut</option>
            {SECTION_COLORS.map((color) => (
              <option key={color} value={color}>
                {ACCENT_LABEL[color]}
              </option>
            ))}
          </SelectControl>
        </FormField>
      </Stack>
    </Section>
  );
}

function HistorySection({ confirm }: { confirm: ReturnType<typeof useConfirm>["confirm"] }) {
  const history = useList<Commit>("space.history", { limit: 50 }, ["space:changed"]);
  const [undoing, setUndoing] = useState<string | null>(null);

  const undo = async (commit: Commit) => {
    const confirmed = await confirm({
      title: `Annuler la modification « ${commit.message} » ?`,
      message:
        "Alfred enregistre une nouvelle modification qui défait celle-ci. Cette annulation apparaît à son tour dans l’historique et peut elle-même être annulée.",
      confirmLabel: "Annuler la modification",
      cancelLabel: "Ne rien changer",
    });
    if (!confirmed) return;
    setUndoing(commit.id);
    try {
      await invoke("space.undo", { commit: commit.id });
      notify({ title: "Modification annulée", description: commit.message, tone: "success" });
      history.reload();
      await useShell.getState().refresh();
    } catch (failure) {
      notify({ title: "La modification n’a pas été annulée", description: errorMessage(failure), tone: "error" });
    } finally {
      setUndoing(null);
    }
  };

  const columns: DataTableColumn<Commit>[] = [
    {
      key: "date",
      header: "Date",
      width: "150px",
      render: (commit) => formatDate(commit.date),
      sortValue: (commit) => commit.date,
    },
    { key: "message", header: "Modification" },
    {
      key: "files",
      header: "Fichiers",
      width: "80px",
      align: "end",
      render: (commit) => new Intl.NumberFormat("fr-FR").format(commit.files.length),
      sortValue: (commit) => commit.files.length,
    },
    {
      key: "actions",
      header: "Actions",
      width: "72px",
      align: "end",
      sortable: false,
      render: (commit) => (
        <IconButton
          label={`Annuler la modification « ${commit.message} »`}
          tooltip="Annuler cette modification"
          size="small"
          loading={undoing === commit.id}
          disabled={undoing !== null}
          onClick={() => void undo(commit)}
        >
          <Undo2 size={16} aria-hidden="true" />
        </IconButton>
      ),
    },
  ];

  return (
    <Section
      title="Historique"
      description="Chaque tour d’agent et chaque réglage de l’espace est enregistré. Annuler une modification la défait sans effacer l’historique."
      actions={<RefreshButton label="Actualiser l’historique" loading={history.loading} onClick={history.reload} />}
    >
      {history.error ? (
        <FeedbackBanner
          tone="error"
          appearance="contained"
          action={<Button onClick={history.reload}>Réessayer</Button>}
        >
          L’historique n’a pas pu être lu : {history.error}
        </FeedbackBanner>
      ) : null}
      {history.items === undefined ? (
        history.error ? null : (
          <LoadingSkeleton rows={4} label="Chargement de l’historique…" />
        )
      ) : history.items.length === 0 ? (
        <EmptyState
          size="compact"
          title="Aucune modification enregistrée"
          description="Les modifications de l’espace apparaissent ici dès que l’agent ou un réglage le change."
        />
      ) : (
        <DataTable
          label="Historique de l’espace"
          columns={columns}
          rows={history.items}
          rowKey={(commit) => commit.id}
          loading={history.loading}
        />
      )}
    </Section>
  );
}

function GrantsSection({
  snapshot,
  confirm,
}: {
  snapshot: Snapshot;
  confirm: ReturnType<typeof useConfirm>["confirm"];
}) {
  const grants = useList<Grant>("grants.list", {}, []);
  const [revoking, setRevoking] = useState<string | null>(null);

  const revoke = async (grant: Grant) => {
    const who = describeSubject(grant.subject, snapshot);
    const what = describeResource(grant.resource, snapshot);
    const confirmed = await confirm({
      title: `Retirer l’accès de ${who} à ${what} ?`,
      message: "Au prochain usage, Alfred vous redemandera votre accord avant de laisser faire.",
      confirmLabel: "Retirer",
      tone: "danger",
    });
    if (!confirmed) return;
    const key = `${grant.subject}|${grant.resource}`;
    setRevoking(key);
    try {
      await invoke("grants.revoke", { subject: grant.subject, resource: grant.resource });
      notify({ title: "Accès retiré", description: `${who} → ${what}`, tone: "success" });
      grants.reload();
    } catch (failure) {
      notify({ title: "L’accès n’a pas été retiré", description: errorMessage(failure), tone: "error" });
    } finally {
      setRevoking(null);
    }
  };

  const columns: DataTableColumn<Grant>[] = [
    {
      key: "subject",
      header: "Qui",
      render: (grant) => describeSubject(grant.subject, snapshot),
      sortValue: (grant) => describeSubject(grant.subject, snapshot),
    },
    {
      key: "resource",
      header: "Accès à",
      render: (grant) => describeResource(grant.resource, snapshot),
      sortValue: (grant) => describeResource(grant.resource, snapshot),
    },
    {
      key: "grantedAt",
      header: "Depuis",
      width: "150px",
      render: (grant) => formatDate(grant.grantedAt),
    },
    {
      key: "actions",
      header: "Actions",
      width: "96px",
      align: "end",
      sortable: false,
      render: (grant) => {
        const key = `${grant.subject}|${grant.resource}`;
        return (
          <Button
            variant="danger"
            loading={revoking === key}
            disabled={revoking !== null && revoking !== key}
            aria-label={`Retirer l’accès de ${describeSubject(grant.subject, snapshot)} à ${describeResource(grant.resource, snapshot)}`}
            onClick={() => void revoke(grant)}
          >
            Retirer
          </Button>
        );
      },
    },
  ];

  return (
    <Section
      title="Accès accordés"
      description="Quand une page ou une fonction veut utiliser un client ou la fonction d’un autre module, Alfred vous demande votre accord une fois, puis s’en souvient."
      actions={<RefreshButton label="Actualiser les accès" loading={grants.loading} onClick={grants.reload} />}
    >
      {grants.error ? (
        <FeedbackBanner tone="error" appearance="contained" action={<Button onClick={grants.reload}>Réessayer</Button>}>
          Les accès accordés n’ont pas pu être lus : {grants.error}
        </FeedbackBanner>
      ) : null}
      {grants.items === undefined ? (
        grants.error ? null : (
          <LoadingSkeleton rows={2} label="Chargement des accès…" />
        )
      ) : grants.items.length === 0 ? (
        <EmptyState
          size="compact"
          title="Aucun accès accordé"
          description="Aucune page n’a encore demandé d’accès à un client ou à une fonction d’un autre module."
        />
      ) : (
        <DataTable
          label="Accès accordés"
          columns={columns}
          rows={grants.items}
          rowKey={(grant) => `${grant.subject}|${grant.resource}`}
          loading={grants.loading}
        />
      )}
    </Section>
  );
}

/** Onglet « Espace » des Réglages : nom et dossier, apparence, historique des modifications, accès accordés. */
export function SpaceSettings() {
  const snapshot = useShell((state) => state.snapshot);
  const { confirm, confirmDialog } = useConfirm();

  if (snapshot === undefined) {
    return (
      <Page width="text">
        <LoadingSkeleton label="Chargement de l’espace…" />
      </Page>
    );
  }
  if (snapshot === null) {
    return (
      <Page width="text">
        <EmptyState title="Aucun espace ouvert" description="Ouvrez ou créez un espace depuis l’accueil d’Alfred." />
      </Page>
    );
  }

  return (
    <Page width="text">
      <SpaceSection snapshot={snapshot} confirm={confirm} />
      <AppearanceSection snapshot={snapshot} />
      <HistorySection confirm={confirm} />
      <GrantsSection snapshot={snapshot} confirm={confirm} />
      {confirmDialog}
    </Page>
  );
}
