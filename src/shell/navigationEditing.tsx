/**
 * Gestes de réorganisation de la navigation : application optimiste d’un nouveau `layout`, commit par
 * `space.updateLayout`, retour en arrière si le backend refuse ; menus contextuels et dialogues de la coquille.
 */
import {
  Dialog,
  FormActions,
  FormField,
  Menu,
  MenuGroup,
  MenuItem,
  Row,
  Stack,
  Text,
  TextInput,
  useConfirm,
} from "@alfred/ui";
import { ArrowRightLeft, Check, EyeOff, History, icons, Pencil, Shapes, Trash2 } from "lucide-react";
import { type FormEvent, type ReactNode, useCallback, useEffect, useId, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { create } from "zustand";
import { PageHistoryDialog } from "../features/navigation/PageHistory";
import { invoke } from "../lib/native";
import { SECTION_COLORS, type Snapshot } from "../lib/types";
import { focusStayed } from "../ui/components/AnchoredMenu";
import { useContextMenuDismiss } from "../ui/components/useContextMenuDismiss";
import { DialogHeader } from "./DialogHeader";
import { NamedIcon } from "./icons";
import {
  COLOR_LABELS,
  findPage,
  findSection,
  type LayoutChange,
  movePage,
  project,
  renamePage,
  renameSection,
  SETTINGS_SECTION,
  setPageHidden,
  setSectionColor,
  setSectionHidden,
  setSectionIcon,
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
    <div className="visually-hidden" role="status" aria-live="polite">
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
        description: "Annulable par l’historique de l’espace.",
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
// Menu contextuel
// ---------------------------------------------------------------------------------------------------------------

const MENU_WIDTH = 252;

export interface MenuAnchor {
  x: number;
  y: number;
}

/** Position d’un menu ouvert au clavier : sous l’élément, aligné sur son bord gauche. */
export function anchorOf(element: Element): MenuAnchor {
  const rect = element.getBoundingClientRect();
  return { x: rect.left, y: rect.bottom + 4 };
}

/**
 * Menu ouvert à un point (clic droit, touche Menu, Maj+F10 ou bouton « … »). Échap, Tab ou le choix d’une entrée
 * le ferment et rendent le focus à l’élément qui l’a ouvert ; un clic à côté le ferme simplement.
 */
export function ContextMenu({
  label,
  anchor,
  returnFocus,
  onClose,
  children,
}: {
  label: string;
  anchor: MenuAnchor;
  returnFocus: HTMLElement | null;
  onClose: () => void;
  children: ReactNode;
}) {
  const id = useId();
  const close = useCallback(() => onClose(), [onClose]);
  const closeAndFocus = () => {
    const restore = focusStayed(document.querySelector(`[data-context-menu="${id}"]`));
    onClose();
    if (restore && returnFocus?.isConnected) returnFocus.focus();
  };
  useContextMenuDismiss(true, `[data-context-menu="${id}"]`, close);
  const left = Math.max(8, Math.min(anchor.x, window.innerWidth - MENU_WIDTH - 8));
  const below = anchor.y < window.innerHeight * 0.6;
  return createPortal(
    // biome-ignore lint/a11y/noStaticElementInteractions: les entrées du menu portent le clavier ; ce conteneur ne fait que fermer le menu.
    <span
      data-context-menu={id}
      onClick={(event) => {
        // Remontée, après le `onClick` de l’entrée : fermer pendant la capture rendait le focus, ce qui, dans une
        // vraie fenêtre, rend aussitôt le menu démonté et l’action de l’entrée n’était jamais appelée.
        if (event.target instanceof Element && event.target.closest('[role="menuitem"]:not(:disabled)'))
          closeAndFocus();
      }}
      onKeyDown={(event) => {
        if (event.key === "Escape" || event.key === "Tab") {
          event.preventDefault();
          event.stopPropagation();
          closeAndFocus();
        }
      }}
    >
      <Menu
        label={label}
        className="nav-context-menu"
        style={below ? { top: anchor.y, left } : { bottom: window.innerHeight - anchor.y, left }}
      >
        {children}
      </Menu>
    </span>,
    document.body,
  );
}

// ---------------------------------------------------------------------------------------------------------------
// Dialogues
// ---------------------------------------------------------------------------------------------------------------

function useModal() {
  const dialog = useRef<HTMLDialogElement>(null);
  useEffect(() => {
    const element = dialog.current;
    if (element && !element.open) element.showModal();
  }, []);
  return dialog;
}

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
  const titleId = useId();
  const formId = useId();
  const dialog = useModal();
  const [value, setValue] = useState(initial);
  const submit = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    onSubmit(value);
    dialog.current?.close();
  };
  return (
    <Dialog ref={dialog} className="nav-dialog" aria-labelledby={titleId} onClose={onClose}>
      <form id={formId} noValidate onSubmit={submit}>
        <DialogHeader title={title} titleId={titleId} dialogRef={dialog} />
        <div className="nav-dialog__body">
          <FormField label="Nom" hint="Laisser vide pour revenir au nom donné par le module.">
            <TextInput
              value={value}
              autoComplete="off"
              autoFocus
              onFocus={(event) => event.currentTarget.select()}
              onChange={(event) => setValue(event.target.value)}
            />
          </FormField>
        </div>
        <div className="nav-dialog__footer">
          <FormActions onCancel={() => dialog.current?.close()} submitLabel="Renommer" form={formId} />
        </div>
      </form>
    </Dialog>
  );
}

/** Change l’icône d’une section : nom Lucide en minuscules et tirets, avec un aperçu. */
export function IconDialog({
  section,
  initial,
  onSubmit,
  onClose,
}: {
  section: string;
  initial: string;
  onSubmit: (value: string) => void;
  onClose: () => void;
}) {
  const titleId = useId();
  const formId = useId();
  const dialog = useModal();
  const [value, setValue] = useState(initial);
  const [error, setError] = useState<string>();
  const name = value.trim();
  const known = name === "" || iconExists(name);
  const submit = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (!known) {
      setError(
        ICON_NAME.test(name)
          ? `Aucune icône Lucide ne s’appelle « ${name} ».`
          : "Écrire le nom en minuscules, chiffres et tirets, par exemple list-checks.",
      );
      return;
    }
    onSubmit(name);
    dialog.current?.close();
  };
  return (
    <Dialog ref={dialog} className="nav-dialog" aria-labelledby={titleId} onClose={onClose}>
      <form id={formId} noValidate onSubmit={submit}>
        <DialogHeader title={`Icône de la section « ${section} »`} titleId={titleId} dialogRef={dialog} />
        <div className="nav-dialog__body">
          <Stack gap="md">
            <FormField
              label="Nom de l’icône"
              hint="Nom d’une icône Lucide en minuscules et tirets, par exemple list-checks. Laisser vide pour revenir à l’icône du module."
              error={error}
            >
              <TextInput
                value={value}
                autoComplete="off"
                spellCheck={false}
                autoFocus
                onChange={(event) => {
                  setValue(event.target.value);
                  setError(undefined);
                }}
              />
            </FormField>
            <Row gap="xs">
              <span className="nav-dialog__preview">{known && name ? <NamedIcon name={name} size={18} /> : null}</span>
              <Text as="span" tone={known ? "muted" : "warning"}>
                {name === "" ? "Aperçu : icône du module" : known ? `Aperçu : ${name}` : "Icône inconnue"}
              </Text>
            </Row>
          </Stack>
        </div>
        <div className="nav-dialog__footer">
          <FormActions onCancel={() => dialog.current?.close()} submitLabel="Enregistrer" form={formId} />
        </div>
      </form>
    </Dialog>
  );
}

// ---------------------------------------------------------------------------------------------------------------
// Menus de la coquille
// ---------------------------------------------------------------------------------------------------------------

type OpenMenu =
  | { kind: "section"; id: string; anchor: MenuAnchor; returnFocus: HTMLElement | null }
  | { kind: "page"; reference: string; anchor: MenuAnchor; returnFocus: HTMLElement | null };

type OpenDialog =
  | { kind: "rename-section"; id: string }
  | { kind: "icon"; id: string }
  | { kind: "rename-page"; reference: string }
  | { kind: "history"; reference: string };

/**
 * Menus et dialogues de la réorganisation, partagés par le menu de gauche et les onglets. `elements` se rend une
 * fois dans la coquille.
 */
export function useNavigationEditor() {
  const snapshot = useShell((state) => state.snapshot);
  const [menu, setMenu] = useState<OpenMenu>();
  const [dialog, setDialog] = useState<OpenDialog>();
  const { confirm, confirmDialog } = useConfirm();
  const closeMenu = useCallback(() => setMenu(undefined), []);

  const openSectionMenu = useCallback((id: string, anchor: MenuAnchor, returnFocus: HTMLElement | null) => {
    setMenu({ kind: "section", id, anchor, returnFocus });
  }, []);
  const openPageMenu = useCallback((reference: string, anchor: MenuAnchor, returnFocus: HTMLElement | null) => {
    setMenu({ kind: "page", reference, anchor, returnFocus });
  }, []);

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
      });
      if (hide) void applyLayoutChange((state) => setPageHidden(state, reference, true));
      return;
    }
    const accepted = await confirm({
      title: `Supprimer la page « ${page.title} » ?`,
      message:
        "Son fichier et son entrée sont retirés du module. La suppression reste annulable par l’historique de l’espace.",
      confirmLabel: "Supprimer",
      tone: "danger",
    });
    if (accepted) void deletePage(reference);
  };

  let menuElement: ReactNode = null;
  if (snapshot && menu?.kind === "section") {
    const section = findSection(snapshot, menu.id);
    if (section) {
      const color = section.color ?? "steel";
      menuElement = (
        <ContextMenu
          label={`Actions de la section ${section.label}`}
          anchor={menu.anchor}
          returnFocus={menu.returnFocus}
          onClose={closeMenu}
        >
          <MenuItem onClick={() => setDialog({ kind: "rename-section", id: section.id })}>
            <Pencil size={16} aria-hidden="true" />
            Renommer…
          </MenuItem>
          <MenuItem onClick={() => setDialog({ kind: "icon", id: section.id })}>
            <Shapes size={16} aria-hidden="true" />
            Changer l’icône…
          </MenuItem>
          <MenuGroup label="Couleur">
            {SECTION_COLORS.map((candidate) => (
              <MenuItem
                key={candidate}
                aria-current={candidate === color ? "true" : undefined}
                onClick={() => void applyLayoutChange((state) => setSectionColor(state, section.id, candidate))}
              >
                <span className={`nav-swatch product-color--${candidate}`} aria-hidden="true" />
                <span className="nav-menu__label">{COLOR_LABELS[candidate].replace(/^./, (c) => c.toUpperCase())}</span>
                {candidate === color ? (
                  <>
                    <Check size={14} aria-hidden="true" />
                    <span className="visually-hidden">(couleur actuelle)</span>
                  </>
                ) : null}
              </MenuItem>
            ))}
          </MenuGroup>
          <MenuItem onClick={() => void applyLayoutChange((state) => setSectionHidden(state, section.id, true))}>
            <EyeOff size={16} aria-hidden="true" />
            Masquer la section
          </MenuItem>
        </ContextMenu>
      );
    }
  } else if (snapshot && menu?.kind === "page") {
    const found = findPage(snapshot, menu.reference);
    if (found) {
      const { page, section } = found;
      const targets = snapshot.sections.filter((candidate) => candidate.id !== section?.id);
      menuElement = (
        <ContextMenu
          label={`Actions de l’onglet ${page.title}`}
          anchor={menu.anchor}
          returnFocus={menu.returnFocus}
          onClose={closeMenu}
        >
          <MenuItem onClick={() => setDialog({ kind: "rename-page", reference: page.reference })}>
            <Pencil size={16} aria-hidden="true" />
            Renommer…
          </MenuItem>
          <MenuGroup label="Déplacer vers">
            {targets.map((target) => (
              <MenuItem
                key={target.id}
                onClick={() =>
                  void applyLayoutChange((state) =>
                    movePage(state, page.reference, { kind: "tab", section: target.id }),
                  )
                }
              >
                <ArrowRightLeft size={16} aria-hidden="true" />
                {target.label}
                {target.hidden ? " (masquée)" : ""}
              </MenuItem>
            ))}
            {section ? (
              <MenuItem
                onClick={() => void applyLayoutChange((state) => movePage(state, page.reference, { kind: "settings" }))}
              >
                <ArrowRightLeft size={16} aria-hidden="true" />
                Réglages
              </MenuItem>
            ) : null}
          </MenuGroup>
          <MenuItem onClick={() => setDialog({ kind: "history", reference: page.reference })}>
            <History size={16} aria-hidden="true" />
            Historique…
          </MenuItem>
          <MenuItem onClick={() => void applyLayoutChange((state) => setPageHidden(state, page.reference, true))}>
            <EyeOff size={16} aria-hidden="true" />
            Masquer l’onglet
          </MenuItem>
          <MenuItem className="nav-menu__danger" onClick={() => void askDelete(page.reference)}>
            <Trash2 size={16} aria-hidden="true" />
            Supprimer la page…
          </MenuItem>
        </ContextMenu>
      );
    }
  }

  let dialogElement: ReactNode = null;
  const closeDialog = () => setDialog(undefined);
  if (snapshot && dialog?.kind === "rename-section") {
    const section = findSection(snapshot, dialog.id);
    if (section)
      dialogElement = (
        <RenameDialog
          title={`Renommer la section « ${section.label} »`}
          initial={section.label}
          onSubmit={(value) => void applyLayoutChange((state) => renameSection(state, section.id, value))}
          onClose={closeDialog}
        />
      );
  } else if (snapshot && dialog?.kind === "icon") {
    const section = findSection(snapshot, dialog.id);
    if (section)
      dialogElement = (
        <IconDialog
          section={section.label}
          initial={section.icon ?? ""}
          onSubmit={(value) => void applyLayoutChange((state) => setSectionIcon(state, section.id, value))}
          onClose={closeDialog}
        />
      );
  } else if (snapshot && dialog?.kind === "history") {
    const found = findPage(snapshot, dialog.reference);
    if (found) dialogElement = <PageHistoryDialog page={found.page} onClose={closeDialog} />;
  } else if (snapshot && dialog?.kind === "rename-page") {
    const found = findPage(snapshot, dialog.reference);
    if (found)
      dialogElement = (
        <RenameDialog
          title={`Renommer la page « ${found.page.title} »`}
          initial={found.page.title}
          onSubmit={(value) => void applyLayoutChange((state) => renamePage(state, dialog.reference, value))}
          onClose={closeDialog}
        />
      );
  }

  return {
    openSectionMenu,
    openPageMenu,
    menuOpenFor: menu?.kind === "section" ? menu.id : menu?.kind === "page" ? menu.reference : undefined,
    elements: (
      <>
        {menuElement}
        {dialogElement}
        {confirmDialog}
        <NavigationAnnouncer />
      </>
    ),
  };
}

export { SETTINGS_SECTION };
