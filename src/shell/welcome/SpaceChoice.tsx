import { type FormEvent, type ReactNode, useId, useState } from "react";
import { Button, RadioButtonGroup, TextInput, useConfirm } from "socle-ui";
import { confirmLeaving } from "../../features/space/switchGuard";
import { Row, Stack } from "../../kit";
import { inTauri, pickFolder } from "../../lib/native";
import { useShell } from "../store";

export type SpaceMode = "create" | "open";

const errorText = (failure: unknown) => (failure instanceof Error ? failure.message : String(failure));

/** Le message du backend parle d’un espace « déplacé ou supprimé » de la liste : ici, on ouvre un dossier choisi. */
function openError(failure: unknown): string {
  const message = errorText(failure);
  return message.includes("n’est plus un espace de travail")
    ? "Ce dossier n’est pas un espace de travail Alfred. Choisissez le dossier qui contient alfred.json, ou créez un nouvel espace."
    : message;
}

function separatorOf(path: string | null | undefined) {
  return path?.includes("\\") ? "\\" : "/";
}

/** Dossier proposé pour un nouvel espace : `~/Alfred/<nom>`. */
export function defaultSpacePath(home: string | null | undefined, name: string) {
  const separator = separatorOf(home);
  const base = home ? `${home}${separator}Alfred` : "Alfred";
  return name.trim() ? `${base}${separator}${name.trim()}` : base;
}

/**
 * Créer un espace ou en ouvrir un : deux grandes cartes, puis le formulaire de la carte choisie. Rendu par l’accueil
 * complet comme par sa version courte. `footer` reçoit le bouton principal (le seul de l’écran) pour le placer en
 * bas, avec les boutons secondaires du parcours ; `onOpened` suit l’ouverture réussie.
 */
export function SpaceChoice({
  footer,
  onOpened,
  extraChoice,
}: {
  footer: (primary: ReactNode) => ReactNode;
  onOpened?: () => void;
  /** Une troisième carte, sélectionnée d’office (« Garder « taff » » quand l’accueil est relancé). */
  extraChoice?: { title: string; description: string; submitLabel: string; onSubmit: () => void };
}) {
  const home = useShell((state) => state.info?.home ?? null);
  const openSpace = useShell((state) => state.openSpace);
  const confirm = useConfirm();
  const [mode, setMode] = useState<SpaceMode | "keep">(extraChoice ? "keep" : "create");
  const [name, setName] = useState("");
  const [createPath, setCreatePath] = useState("");
  const [pathEdited, setPathEdited] = useState(false);
  const [openPath, setOpenPath] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const formId = useId();

  const shownCreatePath = pathEdited ? createPath : defaultSpacePath(home, name);
  const ready =
    mode === "keep"
      ? true
      : mode === "create"
        ? Boolean(name.trim() && shownCreatePath.trim())
        : Boolean(openPath.trim());

  const select = (next: SpaceMode | "keep") => {
    setMode(next);
    setError(null);
  };

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    if (busy || !ready) return;
    if (mode === "keep") {
      extraChoice?.onSubmit();
      return;
    }
    const path = (mode === "create" ? shownCreatePath : openPath).trim();
    setBusy(true);
    setError(null);
    try {
      // Un espace déjà ouvert (accueil relancé) : les travaux en cours sont d’abord confirmés, comme ailleurs.
      if (useShell.getState().snapshot && !(await confirmLeaving(mode === "create" ? name.trim() : path, confirm))) {
        return;
      }
      if (mode === "create") await openSpace(path, name.trim());
      else await openSpace(path, undefined, { existing: true });
      onOpened?.();
    } catch (failure) {
      setError(mode === "open" ? openError(failure) : errorText(failure));
    } finally {
      setBusy(false);
    }
  };

  const browse = async () => {
    if (mode === "create") {
      const selected = await pickFolder("Choisir où créer l’espace de travail");
      if (!selected) return;
      setCreatePath(name.trim() ? `${selected}${separatorOf(selected)}${name.trim()}` : selected);
      setPathEdited(true);
    } else {
      const selected = await pickFolder("Choisir le dossier de l’espace de travail");
      if (selected) setOpenPath(selected);
    }
    setError(null);
  };

  const primary = (
    <Button type="submit" form={formId} variant="primary" isPending={busy} isDisabled={!ready}>
      {mode === "keep"
        ? (extraChoice?.submitLabel ?? "Continuer")
        : mode === "create"
          ? "Créer l’espace"
          : "Ouvrir l’espace"}
    </Button>
  );

  const browseButton = inTauri ? (
    <Row>
      <Button size="sm" onPress={() => void browse()}>
        Parcourir…
      </Button>
    </Row>
  ) : null;

  return (
    <>
      <RadioButtonGroup
        label="Votre espace de travail"
        hideLabel
        value={mode}
        onChange={(value) => select(value as SpaceMode | "keep")}
      >
        {extraChoice ? (
          <RadioButtonGroup.Option value="keep" description={extraChoice.description}>
            {extraChoice.title}
          </RadioButtonGroup.Option>
        ) : null}
        <RadioButtonGroup.Option value="create" description="Pour commencer de zéro.">
          Créer un nouvel espace
        </RadioButtonGroup.Option>
        <RadioButtonGroup.Option value="open" description="Un dossier déjà créé avec Alfred.">
          Ouvrir un espace existant
        </RadioButtonGroup.Option>
      </RadioButtonGroup>
      <form id={formId} noValidate onSubmit={(event) => void submit(event)}>
        {mode === "create" ? (
          <Stack gap="md">
            <TextInput
              label="Nom de l’espace"
              isRequired
              description="Par exemple « Travail » ou « Maison »."
              value={name}
              autoComplete="off"
              autoFocus
              onChange={(value) => {
                setName(value);
                setError(null);
              }}
            />
            <Stack gap="xs">
              <TextInput
                label="Dossier"
                isRequired
                value={shownCreatePath}
                error={error ?? undefined}
                onChange={(value) => {
                  setCreatePath(value);
                  setPathEdited(true);
                  setError(null);
                }}
              />
              {browseButton}
            </Stack>
          </Stack>
        ) : mode === "open" ? (
          <Stack gap="xs">
            <TextInput
              label="Dossier de l’espace"
              isRequired
              value={openPath}
              autoFocus
              error={error ?? undefined}
              placeholder={home ? `${home}${separatorOf(home)}Alfred${separatorOf(home)}…` : undefined}
              onChange={(value) => {
                setOpenPath(value);
                setError(null);
              }}
            />
            {browseButton}
          </Stack>
        ) : null}
      </form>
      {footer(primary)}
    </>
  );
}
