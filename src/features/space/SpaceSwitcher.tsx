import {
  Button,
  Dialog,
  FormActions,
  FormField,
  IconButton,
  MenuGroup,
  MenuItem,
  TextInput,
  useConfirm,
} from "@alfred/ui";
import { Check, ChevronsUpDown, FolderOpen, FolderPlus, Layers } from "lucide-react";
import { type FormEvent, useCallback, useEffect, useId, useRef, useState } from "react";
import { inTauri, pickFolder } from "../../lib/native";
import { DialogHeader } from "../../shell/DialogHeader";
import { notify } from "../../shell/notifications";
import { useShell } from "../../shell/store";
import { AnchoredMenu } from "../../ui/components/AnchoredMenu";
import { confirmLeaving } from "./switchGuard";

const isMac = () => typeof navigator !== "undefined" && /Mac|iPhone|iPad/.test(navigator.platform);

/** Cmd+Maj+O (Ctrl+Maj+O ailleurs) : ouvre le menu des espaces de travail. */
export function isSwitchShortcut(event: Pick<KeyboardEvent, "key" | "metaKey" | "ctrlKey" | "altKey" | "shiftKey">) {
  if (event.key.toLowerCase() !== "o" || !event.shiftKey || event.altKey) return false;
  return isMac() ? event.metaKey && !event.ctrlKey : event.ctrlKey && !event.metaKey;
}

const shortcutText = () => (isMac() ? "⌘⇧O" : "Ctrl Maj O");

const errorMessage = (failure: unknown) => (failure instanceof Error ? failure.message : String(failure));

/**
 * Entrée du bas du menu de gauche, avec Agent et Réglages : le nom de l’espace ouvert, et un menu pour passer à un
 * espace récent, ouvrir un autre dossier ou créer un espace, sans revenir à l’accueil ni redémarrer.
 */
export function SpaceSwitcher() {
  const snapshot = useShell((state) => state.snapshot);
  const recent = useShell((state) => state.recentSpaces);
  const collapsed = useShell((state) => state.sidebarCollapsed);
  const settingsOpen = useShell((state) => state.view.kind === "settings");
  const menuId = useId();
  const button = useRef<HTMLButtonElement>(null);
  const [anchor, setAnchor] = useState<HTMLElement>();
  const [dialog, setDialog] = useState<"create" | "open">();
  const [opening, setOpening] = useState(false);
  const { confirm, confirmDialog } = useConfirm();

  const closeMenu = useCallback((restoreFocus: boolean) => {
    setAnchor(undefined);
    if (restoreFocus) button.current?.focus();
  }, []);

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (!isSwitchShortcut(event) || useShell.getState().view.kind === "settings") return;
      event.preventDefault();
      setAnchor((current) => (current ? undefined : (button.current ?? undefined)));
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, []);

  if (!snapshot) return null;

  /** Ouvre un espace après la garde : `true` quand il est ouvert. */
  const open = async (path: string, name?: string): Promise<boolean> => {
    if (path === snapshot.path) return true;
    const target = name ?? recent.find((space) => space.path === path)?.name ?? path.split(/[\\/]/).pop() ?? path;
    if (!(await confirmLeaving(target, confirm))) return false;
    setOpening(true);
    try {
      await useShell.getState().openSpace(path, name);
      return true;
    } catch (failure) {
      notify({
        title: "L’espace de travail n’a pas pu être ouvert",
        description: errorMessage(failure),
        tone: "error",
      });
      return false;
    } finally {
      setOpening(false);
    }
  };

  const openOther = async () => {
    if (!inTauri) {
      setDialog("open");
      return;
    }
    const path = await pickFolder("Choisir le dossier de l’espace de travail");
    if (path) await open(path);
  };

  const label = `Espace de travail : ${snapshot.name}`;
  return (
    <>
      <IconButton
        buttonRef={button}
        data-menu-anchor={menuId}
        appearance="navigation"
        className="sidebar-space"
        label={`${label}. Changer d’espace de travail`}
        tooltip={anchor ? false : collapsed ? `${snapshot.name} · Changer d’espace (${shortcutText()})` : false}
        tooltipPlacement="right"
        aria-haspopup="menu"
        aria-expanded={Boolean(anchor)}
        aria-keyshortcuts={isMac() ? "Meta+Shift+O" : "Control+Shift+O"}
        aria-busy={opening || undefined}
        disabled={opening || settingsOpen}
        onClick={(event) => setAnchor(anchor ? undefined : event.currentTarget)}
        onKeyDown={(event) => {
          if (!anchor && (event.key === "ArrowDown" || event.key === "ArrowUp")) {
            event.preventDefault();
            setAnchor(event.currentTarget);
          }
        }}
      >
        <Layers size={16} aria-hidden="true" />
        <span className="sidebar__label" title={snapshot.path}>
          {snapshot.name}
        </span>
        <ChevronsUpDown className="sidebar__label sidebar-space__chevron" size={14} aria-hidden="true" />
      </IconButton>
      {anchor ? (
        <AnchoredMenu
          id={menuId}
          anchor={anchor}
          label="Espaces de travail"
          placement="above"
          align="start"
          onClose={closeMenu}
        >
          <MenuGroup label="Espaces de travail récents">
            {(recent.some((space) => space.path === snapshot.path)
              ? recent
              : [{ path: snapshot.path, name: snapshot.name, openedAt: "" }, ...recent]
            ).map((space) => {
              const current = space.path === snapshot.path;
              return (
                <MenuItem
                  key={space.path}
                  className="space-switcher__item"
                  title={space.path}
                  aria-current={current ? "true" : undefined}
                  onClick={() => {
                    if (!current) void open(space.path);
                  }}
                >
                  <span className="space-switcher__check" aria-hidden="true">
                    {current ? <Check size={16} /> : null}
                  </span>
                  <span className="space-switcher__name">{space.name}</span>
                </MenuItem>
              );
            })}
          </MenuGroup>
          <MenuGroup label="Autre espace de travail">
            <MenuItem onClick={() => void openOther()}>
              <FolderOpen size={16} aria-hidden="true" />
              Ouvrir un autre dossier…
            </MenuItem>
            <MenuItem onClick={() => setDialog("create")}>
              <FolderPlus size={16} aria-hidden="true" />
              Créer un espace de travail…
            </MenuItem>
          </MenuGroup>
        </AnchoredMenu>
      ) : null}
      {dialog ? (
        <SpaceDialog
          mode={dialog}
          near={snapshot.path}
          onSubmit={(path, name) => open(path, name)}
          onClose={() => {
            setDialog(undefined);
            button.current?.focus();
          }}
        />
      ) : null}
      {confirmDialog}
    </>
  );
}

/** Dossier parent d’un chemin, séparateur compris (« /Users/a/ » pour « /Users/a/Alfred »). */
function parentOf(path: string) {
  const index = Math.max(path.lastIndexOf("/"), path.lastIndexOf("\\"));
  return index >= 0 ? path.slice(0, index + 1) : "";
}

/**
 * Créer un espace (un nom, un dossier), ou en ouvrir un en écrivant son chemin quand le sélecteur de dossiers n’est
 * pas disponible. Le dossier d’un nouvel espace suit son nom, à côté de l’espace ouvert, tant qu’on ne l’a pas changé.
 */
export function SpaceDialog({
  mode,
  near,
  onSubmit,
  onClose,
}: {
  mode: "create" | "open";
  /** Chemin de l’espace ouvert : un nouvel espace se crée à côté. */
  near: string;
  onSubmit: (path: string, name?: string) => Promise<boolean>;
  onClose: () => void;
}) {
  const titleId = useId();
  const formId = useId();
  const dialog = useRef<HTMLDialogElement>(null);
  const parent = parentOf(near);
  const [name, setName] = useState("");
  const [path, setPath] = useState(mode === "create" ? "" : parent);
  const [pathEdited, setPathEdited] = useState(mode === "open");
  const [busy, setBusy] = useState(false);
  const shownPath = pathEdited ? path : name.trim() ? `${parent}${name.trim()}` : "";

  useEffect(() => {
    const element = dialog.current;
    if (element && !element.open) element.showModal();
  }, []);

  const submit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const target = shownPath.trim();
    if (!target || busy) return;
    setBusy(true);
    const opened = await onSubmit(target, mode === "create" && name.trim() ? name.trim() : undefined);
    setBusy(false);
    if (opened) dialog.current?.close();
  };

  const browse = async () => {
    const selected = await pickFolder(
      mode === "create" ? "Choisir où créer l’espace de travail" : "Choisir le dossier de l’espace de travail",
    );
    if (selected) {
      setPath(
        mode === "create" && name.trim()
          ? `${selected}${selected.includes("\\") ? "\\" : "/"}${name.trim()}`
          : selected,
      );
      setPathEdited(true);
    }
  };

  return (
    <Dialog
      ref={dialog}
      className="nav-dialog"
      aria-labelledby={titleId}
      onClose={onClose}
      onCancel={(event) => {
        if (busy) event.preventDefault();
      }}
    >
      <form id={formId} noValidate onSubmit={(event) => void submit(event)}>
        <DialogHeader
          title={mode === "create" ? "Créer un espace de travail" : "Ouvrir un espace de travail"}
          titleId={titleId}
          dialogRef={dialog}
        />
        <div className="nav-dialog__body space-dialog__body">
          {mode === "create" ? (
            <FormField label="Nom">
              <TextInput
                value={name}
                autoComplete="off"
                autoFocus
                spellCheck={false}
                onChange={(event) => setName(event.target.value)}
              />
            </FormField>
          ) : null}
          <FormField
            label="Dossier"
            hint={
              mode === "create"
                ? "Un dossier nouveau ou vide. Je l’ouvre aussitôt, avec ses modules et ses pages."
                : "Le dossier d’un espace de travail existant. Je l’ouvre aussitôt, avec ses modules et ses pages."
            }
          >
            <div className="welcome__path">
              <TextInput
                value={shownPath}
                autoComplete="off"
                autoFocus={mode === "open"}
                spellCheck={false}
                onChange={(event) => {
                  setPath(event.target.value);
                  setPathEdited(true);
                }}
              />
              {inTauri ? <Button onClick={() => void browse()}>Parcourir…</Button> : null}
            </div>
          </FormField>
        </div>
        <div className="nav-dialog__footer">
          <FormActions
            onCancel={() => dialog.current?.close()}
            submitLabel={mode === "create" ? "Créer l’espace de travail" : "Ouvrir l’espace de travail"}
            pendingLabel="Ouverture…"
            pending={busy}
            disabled={!shownPath.trim()}
            form={formId}
          />
        </div>
      </form>
    </Dialog>
  );
}
