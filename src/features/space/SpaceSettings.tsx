/**
 * Rubriques « Général » et « Apparence » des Réglages, décrites par données pour `SettingsPage` de Socle : les
 * espaces de travail, les sauvegardes, les modèles locaux, les accès accordés et l’historique ; le mode clair ou
 * sombre, la densité et la couleur d’accent.
 */
import {
  ArrowRightLeft,
  FolderOpen,
  FolderSearch,
  History,
  Pencil,
  RefreshCw,
  RotateCcw,
  Undo2,
  X,
} from "lucide-react";
import { useCallback, useEffect, useState } from "react";
import {
  type ColorScheme,
  Dialog,
  EmptyState,
  type SettingsSection,
  Skeleton,
  SkeletonGroup,
  Table,
  type TableColumn,
  useConfirm,
  useSocle,
} from "socle-ui";
import { Notice } from "../../kit";
import { invoke, onNativeEvent } from "../../lib/native";
import { type Commit, type ResolvedPage, SECTION_COLORS, type SectionColor, type Snapshot } from "../../lib/types";
import { notify } from "../../shell/notifications";
import { useShell } from "../../shell/store";
import { startWelcome } from "../../shell/welcome/store";
import { useBackupsSection } from "./BackupsSection";
import { useDecisionsSection } from "./DecisionsSection";
import { useModelSourceSection } from "./ModelSourceSection";
import { useSemanticSection } from "./SemanticSection";
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

const icon = (Icon: typeof X) => <Icon size={16} aria-hidden="true" />;

const dateFormat = new Intl.DateTimeFormat("fr-FR", { dateStyle: "medium", timeStyle: "short" });

function formatDate(iso: string): string {
  const date = new Date(iso);
  return Number.isNaN(date.getTime()) ? iso : dateFormat.format(date);
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** Nom du gestionnaire de fichiers du système, pour le libellé de l’action. */
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

/**
 * Charge une liste au montage et la relit sur demande ; garde la dernière liste en cas d’échec de relecture. `space`
 * est le chemin de l’espace ouvert : rien n’est lu sans lui, et tout se relit quand il change.
 */
function useList<Item>(command: string, args: Record<string, unknown>, events: string[], space: string | undefined) {
  const [items, setItems] = useState<Item[]>();
  const [error, setError] = useState<string>();
  const [loading, setLoading] = useState(true);
  const key = JSON.stringify(args);
  const eventKey = events.join(",");

  // biome-ignore lint/correctness/useExhaustiveDependencies: `space` relance la lecture quand l’espace change.
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
  }, [command, key, space]);

  useEffect(() => {
    if (!space) return;
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
  }, [load, eventKey, space]);

  return { items, error, loading, reload: load };
}

const openedFormat = new Intl.DateTimeFormat("fr-FR", { dateStyle: "long", timeStyle: "short" });

/** « Ouvert le 17 novembre 2026 à 21:58 » ; rien quand la date manque. */
function openedLabel(iso: string): string | null {
  const date = new Date(iso);
  return iso && !Number.isNaN(date.getTime()) ? `Ouvert le ${openedFormat.format(date)}` : null;
}

/** Squelette d’une section en cours de chargement. */
export function LoadingRows({ label, rows = 2 }: { label: string; rows?: number }) {
  return (
    <SkeletonGroup label={label}>
      {Array.from({ length: rows }, (_, index) => (
        // biome-ignore lint/suspicious/noArrayIndexKey: des formes identiques, sans identité propre.
        <Skeleton key={index} />
      ))}
    </SkeletonGroup>
  );
}

/**
 * Tous les espaces de travail de l’utilisateur, l’ouvert marqué : l’ouvrir, le renommer, l’afficher dans le
 * gestionnaire de fichiers, le supprimer (de la liste, et à la corbeille si on le coche). En tête, ouvrir un autre
 * dossier ou créer un espace ; en bas, fermer l’espace pour revenir à l’accueil.
 */
function useSpacesSection(snapshot: Snapshot | null): SettingsSection {
  const recent = useShell((state) => state.recentSpaces);
  const platform = useShell((state) => state.info?.platform);
  const closeSpace = useShell((state) => state.closeSpace);
  const actions = useSpaceActions();
  const spaces = snapshot ? spaceList(recent, snapshot) : [];

  const reveal = async (path: string) => {
    try {
      await invoke("files.reveal", { path });
    } catch (failure) {
      notify({ title: "Le dossier n’a pas pu être affiché", description: errorMessage(failure), tone: "error" });
    }
  };

  const close = async () => {
    try {
      await closeSpace();
    } catch (failure) {
      notify({ title: "L’espace de travail n’a pas été fermé", description: errorMessage(failure), tone: "error" });
    }
  };

  return {
    id: "spaces",
    title: "Espaces de travail",
    description:
      "Chacun est un dossier qui garde ses modules, ses pages et son historique. Passez de l’un à l’autre, renommez-les, ou retirez ceux dont vous n’avez plus besoin.",
    actions: [
      {
        id: "create",
        label: "Créer un espace de travail…",
        primary: true,
        isDisabled: actions.busy,
        onPress: actions.create,
      },
      {
        id: "open-other",
        label: "Ouvrir un autre dossier…",
        icon: icon(FolderOpen),
        isDisabled: actions.busy,
        onPress: actions.openOther,
      },
      {
        id: "welcome",
        label: "Revoir l’accueil",
        icon: icon(RotateCcw),
        onPress: () => startWelcome(true),
      },
    ],
    settings: [
      ...spaces.map((space) => {
        const current = space.path === snapshot?.path;
        const opened = openedLabel(space.openedAt);
        return {
          id: `space:${space.path}`,
          type: "item" as const,
          label: space.name,
          description: opened && !current ? `${space.path} · ${opened}` : space.path,
          tags: current ? [{ label: "Ouvert", tone: "success" as const }] : undefined,
          actions: [
            {
              id: "open",
              label: "Ouvrir",
              icon: icon(ArrowRightLeft),
              isHidden: current,
              isDisabled: actions.busy,
              onPress: () => actions.open(space.path, undefined, true),
            },
            { id: "rename", label: "Renommer…", icon: icon(Pencil), onPress: () => actions.rename(space) },
            {
              id: "reveal",
              label: `Afficher dans ${fileManager(platform)}`,
              icon: icon(FolderSearch),
              onPress: () => reveal(space.path),
            },
            // La confirmation, avec la case « corbeille », est celle de `remove`.
            { id: "remove", label: "Supprimer…", isDisabled: actions.busy, onPress: () => actions.remove(space) },
          ],
        };
      }),
      {
        id: "close",
        type: "action",
        label: "Fermer l’espace de travail",
        description:
          "Revenir à l’accueil d’Alfred. Rien n’est supprimé : l’espace de travail se rouvre depuis cette liste.",
        action: {
          id: "close",
          label: "Fermer l’espace de travail",
          isDisabled: actions.busy,
          confirm: {
            title: `Fermer l’espace de travail « ${snapshot?.name ?? ""} » ?`,
            message:
              "Alfred revient à l’accueil pour ouvrir ou créer un autre espace de travail. Rien n’est supprimé : cet espace de travail se rouvre depuis l’accueil ou depuis cette liste.",
            confirmLabel: "Fermer l’espace de travail",
          },
          onPress: close,
        },
      },
    ],
    content: actions.elements,
  };
}

const THEMES: Array<{ id: ColorScheme; label: string }> = [
  { id: "system", label: "Comme l’ordinateur" },
  { id: "light", label: "Clair" },
  { id: "dark", label: "Sombre" },
];

/**
 * Mode clair ou sombre, densité et couleur d’accent ; repris par l’accueil. Alfred garde le thème (`appearance.theme`,
 * transmis aux pages des modules) et Socle le reçoit aussi ; la densité est un choix de Socle, mémorisé par lui.
 */
export function useAppearance() {
  const snapshot = useShell((state) => state.snapshot);
  const theme = useShell((state) => state.theme);
  const followsSystem = useShell((state) => state.themeFollowsSystem);
  const setTheme = useShell((state) => state.setTheme);
  const socle = useSocle();
  const scheme: ColorScheme = followsSystem ? "system" : theme;

  const changeScheme = (next: string) => {
    const chosen = (THEMES.find((candidate) => candidate.id === next)?.id ?? "system") as ColorScheme;
    setTheme(chosen === "system" ? null : chosen);
    socle.setColorScheme(chosen);
  };

  /** Un échec rejette la promesse : la ligne de réglage reprend l’ancienne valeur et le signale (D-204). */
  const changeAccent = async (next: string) => {
    const accent = next === "default" ? null : next;
    await invoke("space.updateLayout", {
      accent,
      message: accent
        ? `Couleur d’accent : ${ACCENT_LABEL[accent as SectionColor] ?? accent}`
        : "Couleur d’accent par défaut",
    });
    await useShell.getState().refresh();
  };

  return {
    scheme,
    changeScheme,
    density: socle.density,
    changeDensity: (next: string) => socle.setDensity(next === "web" ? "web" : "desktop"),
    accent: snapshot?.accent ?? "default",
    changeAccent,
    hasSpace: Boolean(snapshot),
  };
}

export const THEME_OPTIONS = THEMES;
export const DENSITY_OPTIONS = [
  { id: "desktop", label: "Compacte" },
  { id: "web", label: "Confortable" },
];
export const ACCENT_OPTIONS = [
  { id: "default", label: "Par défaut" },
  ...SECTION_COLORS.map((color) => ({ id: color, label: ACCENT_LABEL[color] })),
];

/** Rubrique « Apparence » : mode, densité, couleur d’accent. */
export function useAppearanceSections(): SettingsSection[] {
  const appearance = useAppearance();
  return [
    {
      id: "appearance",
      description:
        "S’applique tout de suite. Le reste du thème (police, tailles, couleurs des états) est fixé pour que toutes les pages restent lisibles et cohérentes.",
      settings: [
        {
          id: "theme",
          type: "select",
          label: "Mode",
          description: "Clair, sombre, ou le même que votre ordinateur.",
          value: appearance.scheme,
          options: THEMES,
          onChange: appearance.changeScheme,
        },
        {
          id: "density",
          type: "select",
          label: "Densité",
          description: "Compacte : des lignes plus serrées, comme une application de bureau.",
          value: appearance.density,
          options: DENSITY_OPTIONS,
          onChange: appearance.changeDensity,
        },
        {
          id: "accent",
          type: "select",
          label: "Couleur d’accent",
          description: "Elle marque le focus, la sélection et le choix actif dans les pages de cet espace de travail.",
          value: appearance.accent,
          options: ACCENT_OPTIONS,
          isDisabled: !appearance.hasSpace,
          onChange: appearance.changeAccent,
        },
      ],
    },
  ];
}

/** Dernières modifications montrées dans la rubrique ; le reste s’ouvre avec « Tout voir ». */
const RECENT = 5;

const count = (value: number) => new Intl.NumberFormat("fr-FR").format(value);

function commitDescription(commit: Commit) {
  return `${formatDate(commit.date)} · ${count(commit.files.length)} fichier${commit.files.length > 1 ? "s" : ""}`;
}

type CommitRow = Commit & { when: string; files_: string };

const HISTORY_COLUMNS: TableColumn[] = [
  { id: "message", label: "Modification" },
  { id: "when", label: "Date", width: 170 },
  { id: "files_", label: "Fichiers", width: 90, align: "end" },
];

function useHistorySection(snapshot: Snapshot | null): SettingsSection {
  const history = useList<Commit>("space.history", { limit: 50 }, ["space:changed"], snapshot?.path);
  const confirm = useConfirm();
  const [all, setAll] = useState(false);
  const items = history.items ?? [];

  const confirmation = (commit: Commit) => ({
    title: `Annuler la modification « ${commit.message} » ?`,
    message:
      "Alfred enregistre une nouvelle modification qui défait celle-ci. Cette annulation apparaît à son tour dans l’historique et peut elle-même être annulée.",
    confirmLabel: "Annuler la modification",
  });

  const undo = async (commit: Commit) => {
    try {
      await invoke("space.undo", { commit: commit.id });
      notify({ title: "Modification annulée", description: commit.message, tone: "success" });
      await history.reload();
      await useShell.getState().refresh();
    } catch (failure) {
      notify({ title: "La modification n’a pas été annulée", description: errorMessage(failure), tone: "error" });
    }
  };

  const rows: CommitRow[] = items.map((commit) => ({
    ...commit,
    when: formatDate(commit.date),
    files_: count(commit.files.length),
  }));

  return {
    id: "history",
    title: "Historique",
    description: "Chaque tour d’agent et chaque réglage est enregistré, et s’annule.",
    actions: [
      {
        id: "all",
        label: `Tout voir (${count(items.length)})`,
        icon: icon(History),
        isHidden: items.length <= RECENT,
        onPress: () => setAll(true),
      },
    ],
    emptyMessage: history.items && !history.error ? "Aucune modification enregistrée pour l’instant." : undefined,
    settings: items.slice(0, RECENT).map((commit) => ({
      id: commit.id,
      type: "item" as const,
      label: commit.message,
      description: commitDescription(commit),
      actions: [
        {
          id: "undo",
          label: "Annuler la modification",
          icon: icon(Undo2),
          confirm: confirmation(commit),
          onPress: () => undo(commit),
        },
      ],
    })),
    content: (
      <>
        {history.error ? (
          <Notice tone="danger" title="L’historique n’a pas pu être lu">
            {history.error}
          </Notice>
        ) : history.items === undefined ? (
          <LoadingRows label="Chargement de l’historique…" rows={3} />
        ) : null}
        <Dialog
          isOpen={all}
          onOpenChange={setAll}
          size="lg"
          title="Historique de l’espace de travail"
          description="Les dernières modifications, la plus récente d’abord. Annuler une modification la défait sans effacer l’historique."
        >
          <Table
            label="Historique de l’espace de travail"
            columns={HISTORY_COLUMNS}
            rows={rows}
            density="compact"
            rowActions={(commit) => [
              {
                icon: icon(Undo2),
                label: `Annuler « ${commit.message} »`,
                onPress: () =>
                  void confirm(confirmation(commit)).then((accepted) => (accepted ? undo(commit) : undefined)),
              },
            ]}
          />
        </Dialog>
      </>
    ),
  };
}

type GrantRow = Grant & { id: string; who: string; what: string; since: string };

const GRANT_COLUMNS: TableColumn[] = [
  { id: "who", label: "Qui", sortable: true },
  { id: "what", label: "Accès à", sortable: true },
  { id: "since", label: "Depuis", width: 150 },
];

function useGrantsSection(snapshot: Snapshot | null): SettingsSection {
  const grants = useList<Grant>("grants.list", {}, [], snapshot?.path);
  const confirm = useConfirm();

  const revoke = async (grant: GrantRow) => {
    const accepted = await confirm({
      title: `Retirer l’accès de ${grant.who} à ${grant.what} ?`,
      message: "Au prochain usage, Alfred vous redemandera votre accord avant de laisser faire.",
      confirmLabel: "Retirer",
      tone: "danger",
    });
    if (!accepted) return;
    try {
      await invoke("grants.revoke", { subject: grant.subject, resource: grant.resource });
      notify({ title: "Accès retiré", description: `${grant.who} → ${grant.what}`, tone: "success" });
      await grants.reload();
    } catch (failure) {
      notify({ title: "L’accès n’a pas été retiré", description: errorMessage(failure), tone: "error" });
    }
  };

  const rows: GrantRow[] = (grants.items ?? []).map((grant) => ({
    ...grant,
    id: `${grant.subject}|${grant.resource}`,
    who: describeSubject(grant.subject, snapshot),
    what: describeResource(grant.resource, snapshot),
    since: formatDate(grant.grantedAt),
  }));

  return {
    id: "grants",
    title: "Accès accordés",
    description:
      "Quand une page ou une fonction veut utiliser un client ou la fonction d’un autre module, Alfred vous demande votre accord une fois, puis s’en souvient.",
    actions: [{ id: "reload", label: "Actualiser les accès", icon: icon(RefreshCw), onPress: grants.reload }],
    content: grants.error ? (
      <Notice tone="danger" title="Les accès accordés n’ont pas pu être lus">
        {grants.error}
      </Notice>
    ) : grants.items === undefined ? (
      <LoadingRows label="Chargement des accès…" />
    ) : rows.length === 0 ? (
      <EmptyState
        size="compact"
        title="Aucun accès accordé"
        description="Aucune page n’a encore demandé d’accès à un client ou à une fonction d’un autre module."
      />
    ) : (
      <Table
        label="Accès accordés"
        columns={GRANT_COLUMNS}
        rows={rows}
        density="compact"
        isLoading={grants.loading}
        rowActions={(grant) => [
          {
            icon: icon(X),
            label: `Retirer l’accès de ${grant.who} à ${grant.what}`,
            onPress: () => void revoke(grant),
          },
        ]}
      />
    ),
  };
}

/**
 * Rubrique « Général » : les espaces de travail, les sauvegardes, les modèles locaux, les accès et l’historique.
 * Sans espace ouvert, une seule section le dit ; les crochets tournent quand même, sans rien lire.
 */
export function useSpaceSections(): SettingsSection[] {
  const snapshot = useShell((state) => state.snapshot);
  const sections = [
    useSpacesSection(snapshot ?? null),
    useBackupsSection(snapshot ?? null),
    useSemanticSection(),
    useDecisionsSection(),
    useModelSourceSection(),
    useGrantsSection(snapshot ?? null),
    useHistorySection(snapshot ?? null),
  ];
  if (snapshot === undefined) {
    return [{ id: "loading", content: <LoadingRows label="Chargement de l’espace de travail…" rows={4} /> }];
  }
  if (snapshot === null) {
    return [
      {
        id: "none",
        content: (
          <EmptyState
            title="Aucun espace de travail ouvert"
            description="Ouvrez ou créez un espace de travail depuis l’accueil d’Alfred."
          />
        ),
      },
    ];
  }
  return sections;
}
