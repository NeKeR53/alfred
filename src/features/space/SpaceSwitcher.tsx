import { IconButton, MenuGroup, MenuItem } from "@alfred/ui";
import { Check, ChevronDown, FolderOpen, FolderPlus } from "lucide-react";
import { useCallback, useEffect, useId, useRef, useState } from "react";
import { useShell } from "../../shell/store";
import { AnchoredMenu } from "../../ui/components/AnchoredMenu";
import { spaceList, useSpaceActions } from "./spaceActions";

const isMac = () => typeof navigator !== "undefined" && /Mac|iPhone|iPad/.test(navigator.platform);

/** Cmd+Maj+O (Ctrl+Maj+O ailleurs) : ouvre le menu des espaces de travail. */
export function isSwitchShortcut(event: Pick<KeyboardEvent, "key" | "metaKey" | "ctrlKey" | "altKey" | "shiftKey">) {
  if (event.key.toLowerCase() !== "o" || !event.shiftKey || event.altKey) return false;
  return isMac() ? event.metaKey && !event.ctrlKey : event.ctrlKey && !event.metaKey;
}

/**
 * Première entrée du menu de gauche : l’icône de l’espace ouvert, son nom et une petite flèche, qui ouvrent un menu pour
 * passer à un espace récent, ouvrir un autre dossier ou créer un espace, sans revenir à l’accueil ni redémarrer. Menu
 * replié : seule l’icône reste, à la même place, et ouvre le même menu ; le nom passe dans l’infobulle.
 */
export function SpaceSwitcher() {
  const snapshot = useShell((state) => state.snapshot);
  const recent = useShell((state) => state.recentSpaces);
  const settingsOpen = useShell((state) => state.view.kind === "settings");
  const collapsed = useShell((state) => state.sidebarCollapsed);
  const menuId = useId();
  const button = useRef<HTMLButtonElement>(null);
  const [anchor, setAnchor] = useState<HTMLElement>();
  const actions = useSpaceActions(() => button.current?.focus());
  const opening = actions.busy;

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

  const label = `Espace de travail : ${snapshot.name}`;
  return (
    <>
      <IconButton
        buttonRef={button}
        data-menu-anchor={menuId}
        appearance="navigation"
        className="sidebar-space"
        label={`${label}. Changer d’espace de travail`}
        tooltip={collapsed && !anchor ? snapshot.name : false}
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
        <span className="sidebar-space__mark" aria-hidden="true">
          {spaceInitial(snapshot.name)}
        </span>
        <span className="sidebar__label sidebar__brand" title={snapshot.path}>
          {snapshot.name}
        </span>
        <ChevronDown className="sidebar__label sidebar-space__chevron" size={12} aria-hidden="true" />
      </IconButton>
      {anchor ? (
        <AnchoredMenu
          id={menuId}
          anchor={anchor}
          label="Espaces de travail"
          placement="below"
          align="start"
          onClose={closeMenu}
        >
          <MenuGroup label="Espaces de travail récents">
            {spaceList(recent, snapshot).map((space) => {
              const current = space.path === snapshot.path;
              return (
                <MenuItem
                  key={space.path}
                  className="space-switcher__item"
                  title={space.path}
                  aria-current={current ? "true" : undefined}
                  onClick={() => {
                    if (!current) void actions.open(space.path, undefined, true);
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
            <MenuItem onClick={actions.openOther}>
              <FolderOpen size={16} aria-hidden="true" />
              Ouvrir un autre dossier…
            </MenuItem>
            <MenuItem onClick={actions.create}>
              <FolderPlus size={16} aria-hidden="true" />
              Créer un espace de travail…
            </MenuItem>
          </MenuGroup>
        </AnchoredMenu>
      ) : null}
      {actions.elements}
    </>
  );
}

/** Lettre de l’icône d’un espace : la première lettre ou le premier chiffre de son nom, en capitale. */
export function spaceInitial(name: string): string {
  const letter = Array.from(name).find((character) => /[\p{L}\p{N}]/u.test(character));
  return (letter ?? "·").toLocaleUpperCase("fr");
}
