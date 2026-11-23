import { type FormEvent, type ReactNode, useId, useState } from "react";
import { Button, Checkbox, Code, Dialog, TextField, useConfirm } from "socle-ui";
import { Row, Stack, Text } from "../../kit";
import { inTauri, invoke, pickFolder } from "../../lib/native";
import { notify } from "../../shell/notifications";
import { type RecentSpace, useShell } from "../../shell/store";
import { confirmLeaving } from "./switchGuard";

const errorMessage = (failure: unknown) => (failure instanceof Error ? failure.message : String(failure));

const folderName = (path: string) => path.split(/[\\/]/).filter(Boolean).pop() ?? path;

/** Tous les espaces connus, le plus récemment ouvert d’abord ; l’espace ouvert y figure toujours. */
export function spaceList(recent: RecentSpace[], open: { path: string; name: string } | null | undefined) {
  if (!open || recent.some((space) => space.path === open.path)) return recent;
  return [{ path: open.path, name: open.name, openedAt: "" }, ...recent];
}

type DialogState = { mode: "create" | "open" } | { mode: "rename"; space: RecentSpace };

/**
 * Ce qu’on fait d’un espace de travail, depuis le menu de gauche comme depuis les Réglages : l’ouvrir (après la garde
 * des travaux en cours), ouvrir un autre dossier, en créer un, le renommer, le supprimer. `elements` porte les modales
 * et doit être rendu par le composant qui utilise ces actions.
 */
export function useSpaceActions(onDialogClosed?: () => void) {
  const [busy, setBusy] = useState(false);
  const [dialog, setDialog] = useState<DialogState>();
  const confirm = useConfirm();

  /**
   * Ouvre un espace après la garde : `true` quand il est ouvert (ou l’était déjà). `existing` pour un espace de la
   * liste : un dossier qui n’en est plus un est refusé au lieu d’être recréé vide.
   */
  const open = async (path: string, name?: string, existing = false): Promise<boolean> => {
    const shell = useShell.getState();
    if (path === shell.snapshot?.path) return true;
    const target = name ?? shell.recentSpaces.find((space) => space.path === path)?.name ?? folderName(path);
    if (!(await confirmLeaving(target, confirm))) return false;
    setBusy(true);
    try {
      await shell.openSpace(path, name, { existing });
      return true;
    } catch (failure) {
      notify({
        title: "L’espace de travail n’a pas pu être ouvert",
        description: errorMessage(failure),
        tone: "error",
      });
      return false;
    } finally {
      setBusy(false);
    }
  };

  const openOther = async () => {
    if (!inTauri) {
      setDialog({ mode: "open" });
      return;
    }
    const path = await pickFolder("Choisir le dossier de l’espace de travail");
    if (path) await open(path);
  };

  const rename = async (space: RecentSpace, name: string): Promise<boolean> => {
    try {
      const result = await invoke<{ name: string }>("spaces.rename", { path: space.path, name });
      const shell = useShell.getState();
      shell.renameRecent(space.path, result.name);
      if (shell.snapshot?.path === space.path) await shell.refresh();
      notify({ title: "Espace de travail renommé", description: `« ${result.name} »`, tone: "success" });
      return true;
    } catch (failure) {
      notify({ title: "L’espace de travail n’a pas été renommé", description: errorMessage(failure), tone: "error" });
      return false;
    }
  };

  /**
   * Retire un espace de la liste ; son dossier ne part à la corbeille que si on l’a coché. L’espace ouvert cède
   * d’abord la place au plus récent des autres, ou à l’accueil s’il n’en reste aucun.
   */
  const remove = async (space: RecentSpace) => {
    const shell = useShell.getState();
    const isOpen = space.path === shell.snapshot?.path;
    const others = shell.recentSpaces.filter((candidate) => candidate.path !== space.path);
    const choice = { trash: false };
    const confirmed = await confirm({
      title: `Supprimer l’espace de travail « ${space.name} » ?`,
      tone: "danger",
      confirmLabel: "Supprimer",
      message: (
        <RemoveMessage
          space={space}
          next={isOpen ? (others[0]?.name ?? null) : undefined}
          onTrashChange={(trash) => {
            choice.trash = trash;
          }}
        />
      ),
    });
    if (!confirmed) return;
    if (isOpen) {
      if (!(await confirmLeaving(others[0]?.name ?? "l’accueil", confirm))) return;
      setBusy(true);
      try {
        let opened = false;
        for (const candidate of others) {
          try {
            await useShell.getState().openSpace(candidate.path, undefined, { existing: true });
            opened = true;
            break;
          } catch {
            // Dossier déplacé ou supprimé : l’espace suivant de la liste prend la place.
          }
        }
        if (!opened) await useShell.getState().closeSpace();
      } catch (failure) {
        notify({
          title: "L’espace de travail n’a pas été supprimé",
          description: errorMessage(failure),
          tone: "error",
        });
        return;
      } finally {
        setBusy(false);
      }
    }
    useShell.getState().forgetSpace(space.path);
    if (!choice.trash) {
      notify({
        title: `« ${space.name} » est retiré de la liste`,
        description: "Son dossier reste en place : vous pouvez le rouvrir avec « Ouvrir un autre dossier… ».",
        tone: "success",
      });
      return;
    }
    try {
      await invoke("spaces.trash", { path: space.path });
      notify({
        title: `« ${space.name} » est à la corbeille`,
        description: "Son dossier se récupère depuis la corbeille du système.",
        tone: "success",
      });
    } catch (failure) {
      notify({
        title: "Le dossier n’a pas été mis à la corbeille",
        description: `${errorMessage(failure)} L’espace est retiré de la liste ; son dossier reste en place.`,
        tone: "error",
      });
    }
  };

  const elements: ReactNode = (
    <>
      {dialog ? (
        <SpaceDialog
          mode={dialog.mode}
          near={useShell.getState().snapshot?.path ?? ""}
          initialName={dialog.mode === "rename" ? dialog.space.name : undefined}
          onSubmit={(path, name) => (dialog.mode === "rename" ? rename(dialog.space, name ?? "") : open(path, name))}
          onClose={() => {
            setDialog(undefined);
            onDialogClosed?.();
          }}
        />
      ) : null}
    </>
  );

  return {
    busy,
    open,
    openOther: () => void openOther(),
    create: () => setDialog({ mode: "create" }),
    rename: (space: RecentSpace) => setDialog({ mode: "rename", space }),
    remove: (space: RecentSpace) => void remove(space),
    elements,
  };
}

/** Message de la confirmation de suppression : ce qui se passe, et la corbeille en option, dossier nommé. */
function RemoveMessage({
  space,
  next,
  onTrashChange,
}: {
  space: RecentSpace;
  /** Espace ouvert supprimé : celui qui prend la place (`null` : l’accueil). `undefined` : un autre espace. */
  next: string | null | undefined;
  onTrashChange: (trash: boolean) => void;
}) {
  const [trash, setTrash] = useState(false);
  return (
    <Stack gap="sm">
      <Text>
        {trash
          ? "L’espace de travail est retiré de la liste et son dossier part à la corbeille du système, d’où il se récupère."
          : "L’espace de travail est retiré de la liste d’Alfred. Son dossier reste en place : rien n’est effacé."}
        {next === null
          ? " C’est l’espace ouvert : Alfred revient à l’accueil."
          : next
            ? ` C’est l’espace ouvert : Alfred passe sur « ${next} ».`
            : ""}
      </Text>
      <Checkbox
        isSelected={trash}
        onChange={(checked) => {
          setTrash(checked);
          onTrashChange(checked);
        }}
      >
        Mettre aussi le dossier à la corbeille
      </Checkbox>
      <Code>{space.path}</Code>
    </Stack>
  );
}

/** Dossier parent d’un chemin, séparateur compris (« /Users/a/ » pour « /Users/a/Alfred »). */
function parentOf(path: string) {
  const index = Math.max(path.lastIndexOf("/"), path.lastIndexOf("\\"));
  return index >= 0 ? path.slice(0, index + 1) : "";
}

const DIALOG_TEXT = {
  create: { title: "Créer un espace de travail", submit: "Créer l’espace de travail", pending: "Ouverture…" },
  open: { title: "Ouvrir un espace de travail", submit: "Ouvrir l’espace de travail", pending: "Ouverture…" },
  rename: { title: "Renommer l’espace de travail", submit: "Renommer", pending: "Renommage…" },
} as const;

/**
 * Créer un espace (un nom, un dossier), en ouvrir un en écrivant son chemin quand le sélecteur de dossiers n’est pas
 * disponible, ou renommer un espace (le nom seul, jamais le dossier). Le dossier d’un nouvel espace suit son nom, à
 * côté de l’espace ouvert, tant qu’on ne l’a pas changé.
 */
export function SpaceDialog({
  mode,
  near,
  initialName = "",
  onSubmit,
  onClose,
}: {
  mode: "create" | "open" | "rename";
  /** Chemin de l’espace ouvert : un nouvel espace se crée à côté. */
  near: string;
  initialName?: string;
  onSubmit: (path: string, name?: string) => Promise<boolean>;
  onClose: () => void;
}) {
  const formId = useId();
  const parent = parentOf(near);
  const [name, setName] = useState(initialName);
  const [nameError, setNameError] = useState<string>();
  const [path, setPath] = useState(mode === "open" ? parent : "");
  const [pathEdited, setPathEdited] = useState(mode === "open");
  const [busy, setBusy] = useState(false);
  const shownPath = pathEdited ? path : name.trim() ? `${parent}${name.trim()}` : "";
  const text = DIALOG_TEXT[mode];

  const submit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (busy) return;
    if (mode === "rename") {
      if (!name.trim()) {
        setNameError("Saisissez le nom de l’espace de travail.");
        return;
      }
      if (name.trim() === initialName) {
        onClose();
        return;
      }
    }
    const target = shownPath.trim();
    if (mode !== "rename" && !target) return;
    setBusy(true);
    const done = await onSubmit(target, mode !== "open" && name.trim() ? name.trim() : undefined);
    setBusy(false);
    if (done) onClose();
  };

  const browse = async () => {
    const selected = await pickFolder(
      mode === "create" ? "Choisir où créer l’espace de travail" : "Choisir le dossier de l’espace de travail",
    );
    if (!selected) return;
    const separator = selected.includes("\\") ? "\\" : "/";
    setPath(mode === "create" && name.trim() ? `${selected}${separator}${name.trim()}` : selected);
    setPathEdited(true);
  };

  return (
    <Dialog
      isOpen
      onOpenChange={(open) => {
        if (!open) onClose();
      }}
      size="sm"
      title={text.title}
      isBusy={busy}
      footer={
        <>
          <Button isDisabled={busy} onPress={onClose}>
            Annuler
          </Button>
          <Button
            variant="primary"
            type="submit"
            form={formId}
            isPending={busy}
            isDisabled={mode === "rename" ? !name.trim() : !shownPath.trim()}
          >
            {text.submit}
          </Button>
        </>
      }
    >
      <form id={formId} noValidate onSubmit={(event) => void submit(event)}>
        <Stack gap="md">
          {mode !== "open" ? (
            <TextField
              label="Nom"
              isRequired
              value={name}
              autoComplete="off"
              autoFocus
              error={nameError}
              description={
                mode === "rename" ? "Le nom affiché dans le menu de gauche. Le dossier ne change pas." : undefined
              }
              onChange={(value) => {
                setName(value);
                setNameError(undefined);
              }}
            />
          ) : null}
          {mode !== "rename" ? (
            <Stack gap="xs">
              <TextField
                label="Dossier"
                isRequired
                value={shownPath}
                autoComplete="off"
                autoFocus={mode === "open"}
                description={
                  mode === "create"
                    ? "Un dossier nouveau ou vide. Je l’ouvre aussitôt, avec ses modules et ses pages."
                    : "Le dossier d’un espace de travail existant. Je l’ouvre aussitôt, avec ses modules et ses pages."
                }
                onChange={(value) => {
                  setPath(value);
                  setPathEdited(true);
                }}
              />
              {inTauri ? (
                <Row>
                  <Button size="sm" onPress={() => void browse()}>
                    Parcourir…
                  </Button>
                </Row>
              ) : null}
            </Stack>
          ) : null}
        </Stack>
      </form>
    </Dialog>
  );
}
