import {
  Button,
  ChoiceButton,
  ChoiceGroup,
  DataTable,
  type DataTableColumn,
  EmptyState,
  FeedbackBanner,
  IconButton,
  LoadingSkeleton,
  MenuItem,
  OverflowMenu,
  Page,
  RefreshButton,
  Section,
  SelectControl,
  SettingRow,
  SettingRows,
  StatusBadge,
  useConfirm,
} from "@alfred/ui";
import { Monitor, Moon, Sun, Undo2 } from "lucide-react";
import "./space.css";
import { useCallback, useEffect, useState } from "react";
import { invoke, onNativeEvent } from "../../lib/native";
import { type Commit, type ResolvedPage, SECTION_COLORS, type SectionColor, type Snapshot } from "../../lib/types";
import { notify } from "../../shell/notifications";
import { useShell } from "../../shell/store";
import { BackupsSection } from "./BackupsSection";
import { DecisionsSection } from "./DecisionsSection";
import { ModelSourceSection } from "./ModelSourceSection";
import { SemanticSection } from "./SemanticSection";
import { spaceList, useSpaceActions } from "./spaceActions";

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
  if (kind === "command") return `Programme « ${reference} »`;
  if (kind === "event") {
    const [module, item] = reference.split("/");
    return `Événement « ${item ?? reference} » (module ${moduleName(snapshot, module)})`;
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

const openedFormat = new Intl.DateTimeFormat("fr-FR", { dateStyle: "long", timeStyle: "short" });

/** « Ouvert le 17 novembre 2026 à 21:58 » ; rien quand la date manque. */
function openedLabel(iso: string): string | null {
  const date = new Date(iso);
  return iso && !Number.isNaN(date.getTime()) ? `Ouvert le ${openedFormat.format(date)}` : null;
}

/**
 * Tous les espaces de travail de l’utilisateur, l’ouvert marqué : l’ouvrir, le renommer, l’afficher dans le
 * gestionnaire de fichiers, le supprimer (de la liste, et à la corbeille si on le coche). En tête, ouvrir un autre
 * dossier ou créer un espace ; en bas, fermer l’espace pour revenir à l’accueil.
 */
function SpacesSection({
  snapshot,
  confirm,
}: {
  snapshot: Snapshot;
  confirm: ReturnType<typeof useConfirm>["confirm"];
}) {
  const recent = useShell((state) => state.recentSpaces);
  const platform = useShell((state) => state.info?.platform);
  const closeSpace = useShell((state) => state.closeSpace);
  const actions = useSpaceActions();
  const [opening, setOpening] = useState<string | null>(null);
  const spaces = spaceList(recent, snapshot);
  const busy = actions.busy || opening !== null;

  const open = async (path: string) => {
    setOpening(path);
    try {
      await actions.open(path, undefined, true);
    } finally {
      setOpening(null);
    }
  };

  const reveal = async (path: string) => {
    try {
      await invoke("files.reveal", { path });
    } catch (failure) {
      notify({ title: "Le dossier n’a pas pu être affiché", description: errorMessage(failure), tone: "error" });
    }
  };

  const close = async () => {
    const confirmed = await confirm({
      title: `Fermer l’espace de travail « ${snapshot.name} » ?`,
      message:
        "Alfred revient à l’accueil pour ouvrir ou créer un autre espace de travail. Rien n’est supprimé : cet espace de travail se rouvre depuis l’accueil ou depuis cette liste.",
      confirmLabel: "Fermer l’espace de travail",
    });
    if (!confirmed) return;
    try {
      await closeSpace();
    } catch (failure) {
      notify({ title: "L’espace de travail n’a pas été fermé", description: errorMessage(failure), tone: "error" });
    }
  };

  return (
    <Section
      title="Général"
      description="Vos espaces de travail : chacun est un dossier qui garde ses modules, ses pages et son historique. Passez de l’un à l’autre, renommez-les, ou retirez ceux dont vous n’avez plus besoin."
      actions={
        <>
          <Button disabled={busy} onClick={actions.openOther}>
            Ouvrir un autre dossier…
          </Button>
          <Button disabled={busy} onClick={actions.create}>
            Créer un espace de travail…
          </Button>
        </>
      }
    >
      <SettingRows label="Vos espaces de travail">
        {spaces.map((space) => {
          const current = space.path === snapshot.path;
          const opened = openedLabel(space.openedAt);
          return (
            <SettingRow
              key={space.path}
              title={
                <span className="space-row__title">
                  <span>{space.name}</span>
                  {current ? (
                    <StatusBadge tone="success" size="compact">
                      Ouvert
                    </StatusBadge>
                  ) : null}
                </span>
              }
              description={
                <span className="space-row__details">
                  <span className="space-row__path" title={space.path}>
                    {space.path}
                  </span>
                  {opened && !current ? <span>{opened}</span> : null}
                </span>
              }
            >
              {current ? null : (
                <Button
                  aria-label={`Ouvrir l’espace de travail ${space.name}`}
                  loading={opening === space.path}
                  disabled={busy}
                  onClick={() => void open(space.path)}
                >
                  Ouvrir
                </Button>
              )}
              <OverflowMenu label={`Actions de l’espace de travail ${space.name}`} disabled={busy} size="small">
                <MenuItem onClick={() => actions.rename(space)}>Renommer…</MenuItem>
                <MenuItem onClick={() => void reveal(space.path)}>Afficher dans {fileManager(platform)}</MenuItem>
                <MenuItem tone="danger" onClick={() => actions.remove(space)}>
                  Supprimer…
                </MenuItem>
              </OverflowMenu>
            </SettingRow>
          );
        })}
        <SettingRow
          title="Fermer l’espace de travail"
          description="Revenir à l’accueil d’Alfred. Rien n’est supprimé : l’espace de travail se rouvre depuis cette liste."
        >
          <Button disabled={busy} onClick={() => void close()}>
            Fermer l’espace de travail
          </Button>
        </SettingRow>
      </SettingRows>
      {actions.elements}
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
      description="S’applique tout de suite. Le reste du thème (police, tailles, couleurs des états) est fixé par Alfred pour que toutes les pages restent lisibles et cohérentes."
    >
      <SettingRows>
        <SettingRow title="Thème" description="Clair, sombre, ou le même que votre ordinateur.">
          <ChoiceGroup label="Thème" appearance="segmented">
            {themes.map(({ value, label, Icon }) => (
              <ChoiceButton
                key={value}
                variant="label"
                label={label}
                selected={themeChoice === value}
                onClick={() => setTheme(value === "system" ? null : value)}
              >
                <Icon size={14} aria-hidden="true" />
                {label}
              </ChoiceButton>
            ))}
          </ChoiceGroup>
        </SettingRow>
        <SettingRow title="Couleur d’accent" description="Elle marque le focus, la sélection et le choix actif.">
          <SelectControl
            aria-label="Couleur d’accent"
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
        </SettingRow>
      </SettingRows>
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
      description="Chaque tour d’agent et chaque réglage de l’espace de travail est enregistré. Annuler une modification la défait sans effacer l’historique."
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
          description="Les modifications de l’espace de travail apparaissent ici dès que l’agent ou un réglage le change."
        />
      ) : (
        <DataTable
          label="Historique de l’espace de travail"
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
/** Rubrique « Apparence » des Réglages : thème clair ou sombre, couleur d’accent. */
export function AppearanceSettings() {
  const snapshot = useShell((state) => state.snapshot);
  if (!snapshot) return null;
  return (
    <Page width="text">
      <AppearanceSection snapshot={snapshot} />
    </Page>
  );
}

export function SpaceSettings() {
  const snapshot = useShell((state) => state.snapshot);
  const { confirm, confirmDialog } = useConfirm();

  if (snapshot === undefined) {
    return (
      <Page width="text">
        <LoadingSkeleton label="Chargement de l’espace de travail…" />
      </Page>
    );
  }
  if (snapshot === null) {
    return (
      <Page width="text">
        <EmptyState
          title="Aucun espace de travail ouvert"
          description="Ouvrez ou créez un espace de travail depuis l’accueil d’Alfred."
        />
      </Page>
    );
  }

  return (
    <Page width="text">
      <SpacesSection snapshot={snapshot} confirm={confirm} />
      <HistorySection confirm={confirm} />
      <BackupsSection snapshot={snapshot} confirm={confirm} />
      <SemanticSection />
      <DecisionsSection />
      <ModelSourceSection />
      <GrantsSection snapshot={snapshot} confirm={confirm} />
      {confirmDialog}
    </Page>
  );
}
