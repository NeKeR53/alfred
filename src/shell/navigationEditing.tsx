/**
 * Gestes de réorganisation de la navigation : application optimiste d’un nouveau `layout`, commit par
 * `space.updateLayout`, retour en arrière si le backend refuse ; menus contextuels et dialogues de la coquille.
 */
import { ArrowDown, ArrowUp, EyeOff, icons, Pencil, Settings2, Shapes } from "lucide-react";
import { type ReactNode, useCallback, useState } from "react";
import { type Action, Button, Dialog, Menu, TextField, useConfirm, useOpenForm } from "socle-ui";
import { create } from "zustand";
import { PageHistoryDialog } from "../features/navigation/PageHistory";
import { openModuleSettings } from "../features/settings/open";
import { inTauri, invoke, openPageWindow } from "../lib/native";
import type { Snapshot } from "../lib/types";
import { IconPicker } from "./IconPicker";
import { isImageIcon } from "./icons";
import {
  baseReference,
  findPage,
  findSection,
  type LayoutChange,
  movePage,
  pagesOf,
  project,
  renamePage,
  renameSection,
  reorderSections,
  reorderTabs,
  SETTINGS_SECTION,
  setPageHidden,
  setSectionHidden,
  setSectionIcon,
  shift,
} from "./navigationLayout";
import { notify } from "./notifications";
import { useShell } from "./store";

// ---------------------------------------------------------------------------------------------------------------
// Annonces aux lecteurs d’écran
// ---------------------------------------------------------------------------------------------------------------

const useAnnouncements = create<{ text: string; key: number }>(() => ({ text: "", key: 0 }));

export function announce(text: string) {
  useAnnouncements.setState((state) => ({ text, key: state.key + 1 }));
}

/** Région vivante où la coquille annonce le résultat d’un geste fait au clavier. */
export function NavigationAnnouncer() {
  const { text, key } = useAnnouncements();
  return (
    <div className="sr-only" role="status" aria-live="polite">
      <span key={key}>{text}</span>
    </div>
  );
}

// ---------------------------------------------------------------------------------------------------------------
// Commits de la navigation
// ---------------------------------------------------------------------------------------------------------------

const errorText = (error: unknown) => (error instanceof Error ? error.message : String(error));

let queue: Promise<unknown> = Promise.resolve();
/** Change à chaque refus : les gestes calculés sur l’état refusé ne sont pas envoyés. */
let epoch = 0;
let inFlight = 0;

/**
 * Applique un geste : l’affichage change tout de suite, puis le backend enregistre le `layout` complet et en fait
 * un commit de l’espace. En cas de refus, l’affichage revient à l’état d’avant et une notification l’explique.
 * Renvoie vrai si le geste a été enregistré.
 */
export function applyLayoutChange(build: (snapshot: Snapshot) => LayoutChange | null): Promise<boolean> {
  const previous = useShell.getState().snapshot;
  if (!previous) return Promise.resolve(false);
  const change = build(previous);
  if (!change) return Promise.resolve(false);
  const optimistic = project(previous, change.layout);
  useShell.setState({ snapshot: optimistic });
  if (change.announce) announce(change.announce);
  const startedAt = epoch;
  inFlight += 1;
  const run = queue.then(async () => {
    try {
      if (startedAt !== epoch) return false;
      try {
        const next = await invoke<Snapshot>("space.updateLayout", { layout: change.layout, message: change.message });
        // Un geste suivant déjà affiché garde la main ; sa propre réponse arrivera.
        if (inFlight === 1) useShell.setState({ snapshot: next });
        return true;
      } catch (error) {
        epoch += 1;
        useShell.setState({ snapshot: previous });
        notify({ tone: "error", title: "La navigation n’a pas été modifiée", description: errorText(error) });
        return false;
      }
    } finally {
      inFlight -= 1;
    }
  });
  queue = run.catch(() => undefined);
  return run;
}

/** Supprime une page de son module, après confirmation de l’appelant. Refusé par le backend en lecture seule. */
export function deletePage(reference: string): Promise<boolean> {
  const previous = useShell.getState().snapshot;
  const found = previous ? findPage(previous, reference) : undefined;
  if (!previous || !found) return Promise.resolve(false);
  const without = (pages: Snapshot["settingsPages"]) => pages.filter((page) => page.reference !== reference);
  useShell.setState({
    snapshot: {
      ...previous,
      sections: previous.sections.map((section) => ({ ...section, pages: without(section.pages) })),
      settingsPages: without(previous.settingsPages),
    },
  });
  const run = queue.then(async () => {
    try {
      await invoke("space.deletePage", { reference });
      announce(`Page ${found.page.title} supprimée.`);
      notify({
        tone: "success",
        title: `Page « ${found.page.title} » supprimée`,
        description: "Annulable par l’historique de l’espace de travail.",
      });
      await useShell
        .getState()
        .refresh()
        .catch(() => undefined);
      return true;
    } catch (error) {
      epoch += 1;
      useShell.setState({ snapshot: previous });
      notify({
        tone: "error",
        title: `La page « ${found.page.title} » n’a pas été supprimée`,
        description: errorText(error),
      });
      return false;
    }
  });
  queue = run.catch(() => undefined);
  return run;
}

// ---------------------------------------------------------------------------------------------------------------
// Icônes
// ---------------------------------------------------------------------------------------------------------------

export const ICON_NAME = /^[a-z0-9]+(-[a-z0-9]+)*$/;

/** Vrai si le nom désigne une icône Lucide (« list-checks »). */
export function iconExists(name: string): boolean {
  if (!ICON_NAME.test(name)) return false;
  const key = name
    .split("-")
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
    .join("");
  return key in icons;
}

// ---------------------------------------------------------------------------------------------------------------
// Dialogue de renommage
// ---------------------------------------------------------------------------------------------------------------

/** Renomme une section ou une page. Un champ vide rend le nom d’origine du module. */
export function RenameDialog({
  title,
  initial,
  onSubmit,
  onClose,
}: {
  title: string;
  initial: string;
  onSubmit: (value: string) => void;
  onClose: () => void;
}) {
  const [value, setValue] = useState(initial);
  const submit = () => {
    onSubmit(value);
    onClose();
  };
  return (
    <Dialog
      isOpen
      size="sm"
      title={title}
      onOpenChange={(open) => {
        if (!open) onClose();
      }}
      footer={
        <>
          <Button onPress={onClose}>Annuler</Button>
          <Button variant="primary" onPress={submit}>
            Renommer
          </Button>
        </>
      }
    >
      <form
        onSubmit={(event) => {
          event.preventDefault();
          submit();
        }}
      >
        <TextField
          label="Nom"
          description="Laisser vide pour revenir au nom donné par le module."
          value={value}
          onChange={setValue}
          autoComplete="off"
          maxLength={120}
          autoFocus
        />
      </form>
    </Dialog>
  );
}

// ---------------------------------------------------------------------------------------------------------------
// Dialogue d’icône
// ---------------------------------------------------------------------------------------------------------------

/**
 * Change l’icône d’une section : une grille d’icônes avec une recherche, et « Par défaut » pour revenir à celle du
 * module (ou au logo du service).
 */
export function IconDialog({
  section,
  initial,
  logo,
  fallbackIcon,
  onSubmit,
  onClose,
}: {
  section: string;
  initial: string;
  /** Logo du service en place (adresse `data:`) : une icône le remplace, « Par défaut » le garde. */
  logo?: string | null;
  /** Icône Lucide du module, que « Par défaut » rend. */
  fallbackIcon?: string | null;
  onSubmit: (value: string) => void;
  onClose: () => void;
}) {
  const [value, setValue] = useState(iconExists(initial) ? initial : "");
  return (
    <Dialog
      isOpen
      title={`Icône de « ${section} »`}
      onOpenChange={(open) => {
        if (!open) onClose();
      }}
      footer={
        <>
          <Button onPress={onClose}>Annuler</Button>
          <Button
            variant="primary"
            onPress={() => {
              onSubmit(value);
              onClose();
            }}
          >
            Enregistrer
          </Button>
        </>
      }
    >
      <IconPicker value={value} onChange={setValue} fallback={{ icon: fallbackIcon, iconUrl: logo }} />
    </Dialog>
  );
}

// ---------------------------------------------------------------------------------------------------------------
// Menus de la coquille
// ---------------------------------------------------------------------------------------------------------------

type OpenDialog = { kind: "icon"; id: string } | { kind: "history"; reference: string };

const icon16 = (Icon: typeof Pencil) => <Icon size={16} aria-hidden="true" />;

const windowError = (error: unknown) =>
  notify({
    title: "La fenêtre n’a pas pu s’ouvrir",
    description: error instanceof Error ? error.message : String(error),
    tone: "error",
  });

/**
 * Menus et dialogues de la réorganisation : le menu « … » d’une section (Sidebar), les actions de la page affichée
 * (barre du haut, menu « … » de l’`ActionBar`). `elements` se rend une fois dans la coquille.
 */
export function useNavigationEditor() {
  const snapshot = useShell((state) => state.snapshot);
  const [dialog, setDialog] = useState<OpenDialog>();
  const confirm = useConfirm();
  const openForm = useOpenForm();

  const rename = useCallback(
    (title: string, initial: string, apply: (value: string) => void) =>
      void openForm({
        title,
        fields: [
          {
            name: "name",
            label: "Nom",
            description: "Laisser vide pour revenir au nom donné par le module.",
            autoComplete: "off",
            maxLength: 120,
          },
        ],
        initialValues: { name: initial },
        submitLabel: "Renommer",
        onSubmit: (values) => apply(String(values.name ?? "")),
      }),
    [openForm],
  );

  const askDelete = async (reference: string) => {
    const current = useShell.getState().snapshot;
    const found = current ? findPage(current, reference) : undefined;
    if (!current || !found) return;
    const { page } = found;
    if (page.readOnly) {
      const module = current.modules.find((candidate) => candidate.id === page.module)?.name ?? page.module;
      const hide = await confirm({
        title: `La page « ${page.title} » ne peut pas être supprimée`,
        message: `Elle vient du module installé « ${module} », en lecture seule. La masquer la retire de la navigation sans toucher au module.`,
        confirmLabel: "Masquer la page",
        tone: "default",
      });
      if (hide) void applyLayoutChange((state) => setPageHidden(state, reference, true));
      return;
    }
    const accepted = await confirm({
      title: `Supprimer la page « ${page.title} » ?`,
      message:
        "Son fichier et son entrée sont retirés du module. La suppression reste annulable par l’historique de l’espace de travail.",
      confirmLabel: "Supprimer",
      tone: "danger",
    });
    if (accepted) void deletePage(reference);
  };

  /** Entrées du menu « … » d’une section de la navigation. */
  const sectionMenu = (id: string): ReactNode => {
    if (!snapshot) return null;
    const section = findSection(snapshot, id);
    if (!section) return null;
    // Importé d’un marketplace ou masqué, le module a sa fiche ; une section sans module connu n’en a pas.
    const module = snapshot.modules.find((candidate) => candidate.id === section.module);
    const order = snapshot.sections.filter((candidate) => !candidate.hidden).map((candidate) => candidate.id);
    const move = (offset: -1 | 1) => {
      const next = shift(order, id, offset);
      if (next) void applyLayoutChange((state) => reorderSections(state, next, id));
    };
    const index = order.indexOf(id);
    return (
      <>
        {module ? (
          <Menu.Item
            label="Configurer le module…"
            icon={icon16(Settings2)}
            onAction={() => openModuleSettings(module.id)}
          />
        ) : null}
        <Menu.Item
          label="Renommer…"
          icon={icon16(Pencil)}
          onAction={() =>
            rename(
              `Renommer la section « ${section.label} »`,
              section.label,
              (value) => void applyLayoutChange((state) => renameSection(state, section.id, value)),
            )
          }
        />
        <Menu.Item label="Changer l’icône…" icon={icon16(Shapes)} onAction={() => setDialog({ kind: "icon", id })} />
        <Menu.Item label="Monter" icon={icon16(ArrowUp)} isDisabled={index <= 0} onAction={() => move(-1)} />
        <Menu.Item
          label="Descendre"
          icon={icon16(ArrowDown)}
          isDisabled={index < 0 || index >= order.length - 1}
          onAction={() => move(1)}
        />
        <Menu.Separator />
        <Menu.Item
          label="Masquer la section"
          icon={icon16(EyeOff)}
          onAction={() => void applyLayoutChange((state) => setSectionHidden(state, section.id, true))}
        />
      </>
    );
  };

  /** Actions de la page affichée (onglet), rangées dans le « … » de la barre du haut. */
  const pageActions = (reference: string, sectionId: string): Action[] => {
    if (!snapshot) return [];
    const found = findPage(snapshot, reference);
    if (!found) return [];
    const { page, section } = found;
    // Un onglet va dans n’importe quelle autre section ; une copie (`…@suffixe`) ne va pas dans les Réglages.
    const copy = page.reference.includes("@");
    const targets = snapshot.sections.filter((candidate) => candidate.id !== section?.id);
    const order = pagesOf(snapshot, sectionId)
      .filter((candidate) => !candidate.hidden)
      .map((candidate) => candidate.reference);
    const index = order.indexOf(reference);
    const moveTab = (offset: -1 | 1) => {
      const next = shift(order, reference, offset);
      if (!next) return;
      void applyLayoutChange((state) => {
        const all = pagesOf(state, sectionId).map((candidate) => candidate.reference);
        const visible = new Set(next);
        const queue = [...next];
        return reorderTabs(
          state,
          sectionId,
          all.map((id) => (visible.has(id) ? (queue.shift() ?? id) : id)),
          reference,
        );
      });
    };
    const destinations = [
      ...targets.map((target) => ({
        id: target.id,
        label: `${target.label}${target.hidden ? " (masquée)" : ""}`,
      })),
      ...(section && !copy ? [{ id: SETTINGS_SECTION, label: "Réglages" }] : []),
    ];
    return [
      {
        id: "page-rename",
        label: "Renommer l’onglet…",
        onPress: () =>
          rename(
            `Renommer la page « ${page.title} »`,
            page.title,
            (value) => void applyLayoutChange((state) => renamePage(state, reference, value)),
          ),
      },
      {
        id: "page-window",
        label: "Ouvrir dans une nouvelle fenêtre",
        isHidden: !inTauri,
        onPress: () => void openPageWindow(page.reference).catch(windowError),
      },
      {
        id: "page-left",
        label: "Déplacer l’onglet vers la gauche",
        isHidden: order.length < 2,
        isDisabled: index <= 0,
        onPress: () => moveTab(-1),
      },
      {
        id: "page-right",
        label: "Déplacer l’onglet vers la droite",
        isHidden: order.length < 2,
        isDisabled: index < 0 || index >= order.length - 1,
        onPress: () => moveTab(1),
      },
      {
        id: "page-move",
        label: "Déplacer vers une autre section…",
        isHidden: destinations.length === 0,
        onPress: () =>
          void openForm({
            title: `Déplacer « ${page.title} »`,
            fields: [{ type: "select", name: "target", label: "Section", options: destinations, isRequired: true }],
            submitLabel: "Déplacer",
            onSubmit: (values) => {
              const target = String(values.target ?? "");
              void applyLayoutChange((state) =>
                movePage(
                  state,
                  page.reference,
                  target === SETTINGS_SECTION ? { kind: "settings" } : { kind: "tab", section: target },
                ),
              );
            },
          }),
      },
      {
        id: "page-history",
        label: "Historique…",
        onPress: () => setDialog({ kind: "history", reference: baseReference(page.reference) }),
      },
      {
        id: "page-hide",
        label: "Masquer l’onglet",
        onPress: () => void applyLayoutChange((state) => setPageHidden(state, page.reference, true)),
      },
      {
        id: "page-delete",
        label: "Supprimer la page…",
        // Une page d’un module installé ne se supprime pas : l’action explique et propose de la masquer.
        danger: !page.readOnly,
        confirm: page.readOnly
          ? undefined
          : {
              title: `Supprimer la page « ${page.title} » ?`,
              message:
                "Son fichier et son entrée sont retirés du module. La suppression reste annulable par l’historique de l’espace de travail.",
              confirmLabel: "Supprimer",
            },
        onPress: () =>
          page.readOnly ? askDelete(baseReference(page.reference)) : deletePage(baseReference(page.reference)),
      },
    ];
  };

  let dialogElement: ReactNode = null;
  const closeDialog = () => setDialog(undefined);
  if (snapshot && dialog?.kind === "icon") {
    const section = findSection(snapshot, dialog.id);
    if (section)
      dialogElement = (
        <IconDialog
          section={section.label}
          initial={isImageIcon(section.icon) ? "" : (section.icon ?? "")}
          logo={section.iconUrl}
          onSubmit={(value) => {
            // Laisser le champ vide garde le logo en place : rien à enregistrer.
            if (value === "" && isImageIcon(section.icon)) return;
            void applyLayoutChange((state) => setSectionIcon(state, section.id, value));
          }}
          onClose={closeDialog}
        />
      );
  } else if (snapshot && dialog?.kind === "history") {
    const found = findPage(snapshot, dialog.reference);
    if (found) dialogElement = <PageHistoryDialog page={found.page} onClose={closeDialog} />;
  }

  return {
    sectionMenu,
    pageActions,
    rename,
    elements: (
      <>
        {dialogElement}
        <NavigationAnnouncer />
      </>
    ),
  };
}

export { SETTINGS_SECTION };
