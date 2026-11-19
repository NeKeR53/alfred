import { Button, FormField, TextInput, useConfirm } from "@alfred/ui";
import { FolderOpen, FolderPlus, type LucideIcon } from "lucide-react";
import { type FormEvent, type ReactNode, useId, useState } from "react";
import { confirmLeaving } from "../../features/space/switchGuard";
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

function ChoiceCard({
  icon: Icon,
  title,
  description,
  selected,
  onSelect,
}: {
  icon: LucideIcon;
  title: string;
  description: string;
  selected: boolean;
  onSelect: () => void;
}) {
  return (
    // biome-ignore lint/a11y/useSemanticElements: une grande carte cliquable, dont la description se lit avec le titre ; le groupe gère la sélection.
    <button
      type="button"
      role="radio"
      aria-checked={selected}
      tabIndex={selected ? 0 : -1}
      className={`welcome-card${selected ? " is-selected" : ""}`}
      onClick={onSelect}
    >
      <Icon size={20} aria-hidden="true" className="welcome-card__icon" />
      <span className="welcome-card__title">{title}</span>
      <span className="welcome-card__description">{description}</span>
    </button>
  );
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
  const { confirm, confirmDialog } = useConfirm();
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
    <Button type="submit" form={formId} variant="primary" loading={busy} disabled={!ready}>
      {mode === "keep" ? extraChoice?.submitLabel : mode === "create" ? "Créer l’espace" : "Ouvrir l’espace"}
    </Button>
  );

  return (
    <>
      <div
        className="welcome-cards"
        role="radiogroup"
        aria-label="Votre espace de travail"
        onKeyDown={(event) => {
          // Comme des boutons radio : les flèches passent d’une carte à l’autre et la choisissent.
          const step = { ArrowRight: 1, ArrowDown: 1, ArrowLeft: -1, ArrowUp: -1 }[event.key];
          if (!step) return;
          const cards = Array.from(event.currentTarget.querySelectorAll<HTMLButtonElement>('[role="radio"]'));
          const index = cards.indexOf(document.activeElement as HTMLButtonElement);
          const target = cards[(Math.max(0, index) + step + cards.length) % cards.length];
          event.preventDefault();
          target.focus();
          target.click();
        }}
      >
        {extraChoice ? (
          <ChoiceCard
            icon={FolderOpen}
            title={extraChoice.title}
            description={extraChoice.description}
            selected={mode === "keep"}
            onSelect={() => select("keep")}
          />
        ) : null}
        <ChoiceCard
          icon={FolderPlus}
          title="Créer un nouvel espace"
          description="Pour commencer de zéro."
          selected={mode === "create"}
          onSelect={() => select("create")}
        />
        <ChoiceCard
          icon={FolderOpen}
          title="Ouvrir un espace existant"
          description="Un dossier déjà créé avec Alfred."
          selected={mode === "open"}
          onSelect={() => select("open")}
        />
      </div>
      <form id={formId} className="welcome-form" noValidate onSubmit={(event) => void submit(event)}>
        {mode === "create" ? (
          <>
            <FormField label="Nom de l’espace" hint="Par exemple « Travail » ou « Maison ».">
              <TextInput
                value={name}
                autoComplete="off"
                spellCheck={false}
                autoFocus
                onChange={(event) => {
                  setName(event.target.value);
                  setError(null);
                }}
              />
            </FormField>
            <div className="welcome-form__path">
              <FormField label="Dossier" error={error ?? undefined}>
                <TextInput
                  value={shownCreatePath}
                  spellCheck={false}
                  autoCapitalize="off"
                  onChange={(event) => {
                    setCreatePath(event.target.value);
                    setPathEdited(true);
                    setError(null);
                  }}
                />
              </FormField>
              {inTauri ? <Button onClick={() => void browse()}>Parcourir…</Button> : null}
            </div>
          </>
        ) : mode === "open" ? (
          <div className="welcome-form__path">
            <FormField label="Dossier de l’espace" error={error ?? undefined}>
              <TextInput
                value={openPath}
                spellCheck={false}
                autoCapitalize="off"
                autoFocus
                placeholder={home ? `${home}${separatorOf(home)}Alfred${separatorOf(home)}…` : undefined}
                onChange={(event) => {
                  setOpenPath(event.target.value);
                  setError(null);
                }}
              />
            </FormField>
            {inTauri ? <Button onClick={() => void browse()}>Parcourir…</Button> : null}
          </div>
        ) : null}
      </form>
      {footer(primary)}
      {confirmDialog}
    </>
  );
}
