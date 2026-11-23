import { type FormEvent, useEffect, useState } from "react";
import { Button, IconButton } from "../components/Button";
import { ChoiceButton, ChoiceGroup } from "../components/ChoiceButton";
import { Code } from "../components/Content";
import { FeedbackBanner } from "../components/FeedbackBanner";
import { SelectControl, SwitchControl, TextInput } from "../components/FormControls";
import { LoadingSkeleton } from "../components/LoadingSkeleton";
import { Page, Section } from "../components/page";
import { SettingRow, SettingRows } from "../components/SettingRow";
import { StatusBadge } from "../components/StatusBadge";
import { type Action, ActionBar, type ActionIcon, useRunAction } from "./actions";
import type { FieldOption } from "./dialogs";
import { FormattedValue, type ValueOptions } from "./format";
import { errorMessage, useFrameServices } from "./services";
import { useLoad } from "./useLoad";

interface SettingBase {
  /** Identifiant stable du réglage. */
  id: string;
  /** Ce que règle la ligne : « Notifier les retards ». */
  title: string;
  /** Une phrase d’explication, en gris dessous. */
  description?: string;
}

/**
 * Un réglage, décrit par sa valeur et la façon de l’enregistrer. Le type choisit le contrôle : interrupteur, liste
 * (ou boutons segmentés pour trois choix courts au plus), saisie libre avec Enregistrer, bouton d’action, valeur en
 * lecture seule. Un réglage s’applique dès qu’il change ; un échec remet la valeur précédente et le notifie.
 */
export type Setting =
  | (SettingBase & { type: "switch"; value: boolean; save: (value: boolean) => unknown | Promise<unknown> })
  | (SettingBase & {
      type: "select";
      value: string;
      options: ReadonlyArray<FieldOption>;
      save: (value: string) => unknown | Promise<unknown>;
    })
  | (SettingBase & {
      type: "text";
      value: string;
      save: (value: string) => unknown | Promise<unknown>;
      /** `number` : nombre court ; `email`, `url` : adresse vérifiée. */
      inputType?: "text" | "number" | "email" | "url";
      placeholder?: string;
      /** La valeur peut être vide. */
      optional?: boolean;
      validate?: (value: string) => string | undefined;
    })
  | (SettingBase & { type: "action"; action: Action })
  | (SettingBase & {
      /**
       * Un élément d’une liste réglée ici (un environnement, un profil) : son nom, un code court à côté, une
       * explication, des étiquettes d’état (« ✓ Keycloak ») et ses actions de ligne (icônes, puis « ⋯ »).
       */
      type: "item";
      code?: string;
      tags?: ReadonlyArray<{ label: string; tone?: "neutral" | "success" | "warning" | "danger" }>;
      actions?: ReadonlyArray<Action>;
    })
  | (SettingBase & {
      type: "info";
      value: unknown;
      /** Format de la valeur (voir `ValueType`). */
      valueType?: ValueOptions["type"];
      statuses?: ValueOptions["statuses"];
      currency?: string;
    });

export interface SettingsSection {
  title: string;
  description?: string;
  /** Actions du bloc, à droite de son titre (« Nouvel environnement »). */
  actions?: ReadonlyArray<Action>;
  settings: ReadonlyArray<Setting>;
}

function useApply<Value>(initial: Value, save: (value: Value) => unknown | Promise<unknown>) {
  const services = useFrameServices();
  const [value, setValue] = useState(initial);
  useEffect(() => setValue(initial), [initial]);
  const apply = async (next: Value) => {
    const before = value;
    setValue(next);
    try {
      await save(next);
    } catch (error) {
      setValue(before);
      services.notify({ title: "Le réglage n’a pas été enregistré", description: errorMessage(error), tone: "error" });
    }
  };
  return { value, apply };
}

function SwitchSetting({ setting }: { setting: Extract<Setting, { type: "switch" }> }) {
  const { value, apply } = useApply(setting.value, setting.save);
  return (
    <SettingRow title={setting.title} description={setting.description}>
      <SwitchControl
        label=""
        aria-label={setting.title}
        checked={value}
        onChange={(event) => void apply(event.target.checked)}
      />
    </SettingRow>
  );
}

function SelectSetting({ setting }: { setting: Extract<Setting, { type: "select" }> }) {
  const { value, apply } = useApply(setting.value, setting.save);
  const segmented = setting.options.length <= 3 && setting.options.every((option) => option.label.length <= 14);
  return (
    <SettingRow title={setting.title} description={setting.description}>
      {segmented ? (
        <ChoiceGroup label={setting.title} appearance="segmented">
          {setting.options.map((option) => (
            <ChoiceButton
              key={option.value}
              variant="label"
              size="compact"
              label={option.label}
              selected={value === option.value}
              onClick={() => void apply(option.value)}
            >
              {option.label}
            </ChoiceButton>
          ))}
        </ChoiceGroup>
      ) : (
        <SelectControl aria-label={setting.title} value={value} onChange={(event) => void apply(event.target.value)}>
          {setting.options.map((option) => (
            <option key={option.value} value={option.value}>
              {option.label}
            </option>
          ))}
        </SelectControl>
      )}
    </SettingRow>
  );
}

function TextSetting({ setting }: { setting: Extract<Setting, { type: "text" }> }) {
  const services = useFrameServices();
  const [saved, setSaved] = useState(setting.value);
  const [draft, setDraft] = useState(setting.value);
  const [error, setError] = useState<string>();
  const [pending, setPending] = useState(false);
  useEffect(() => {
    setSaved(setting.value);
    setDraft(setting.value);
  }, [setting.value]);
  const check = (text: string) => {
    if (!text) return setting.optional ? undefined : "Saisissez une valeur.";
    if (setting.inputType === "number" && Number.isNaN(Number(text.replace(",", ".")))) return "Saisissez un nombre.";
    if (setting.inputType === "email" && !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(text))
      return "Saisissez une adresse de courriel, par exemple lea@exemple.fr.";
    if (setting.inputType === "url" && !/^https?:\/\/\S+$/.test(text))
      return "Saisissez une adresse web complète, par exemple https://exemple.fr.";
    return setting.validate?.(text);
  };
  const submit = async (event: FormEvent) => {
    event.preventDefault();
    const text = draft.trim();
    const problem = check(text);
    if (problem) {
      setError(problem);
      return;
    }
    setPending(true);
    try {
      await setting.save(text);
      setSaved(text);
      setDraft(text);
      services.notify({ title: "Réglage enregistré", tone: "success" });
    } catch (failure) {
      services.notify({
        title: "Le réglage n’a pas été enregistré",
        description: errorMessage(failure),
        tone: "error",
      });
    } finally {
      setPending(false);
    }
  };
  return (
    <SettingRow title={setting.title} description={error ?? setting.description}>
      <form noValidate onSubmit={(event) => void submit(event)}>
        <TextInput
          aria-label={setting.title}
          aria-invalid={error ? true : undefined}
          type={setting.inputType === "number" ? "text" : (setting.inputType ?? "text")}
          inputMode={setting.inputType === "number" ? "decimal" : undefined}
          width={setting.inputType === "number" ? "xs" : "md"}
          placeholder={setting.placeholder ? `Ex. ${setting.placeholder.replace(/^Ex\.\s*/, "")}` : undefined}
          value={draft}
          onChange={(event) => {
            setDraft(event.target.value);
            setError(undefined);
          }}
        />
        {draft !== saved ? (
          <>
            <Button
              disabled={pending}
              onClick={() => {
                setDraft(saved);
                setError(undefined);
              }}
            >
              Annuler
            </Button>
            <Button type="submit" variant="primary" loading={pending} loadingLabel="Enregistrement…">
              Enregistrer
            </Button>
          </>
        ) : null}
      </form>
    </SettingRow>
  );
}

function ActionSetting({ setting }: { setting: Extract<Setting, { type: "action" }> }) {
  const { run, running } = useRunAction();
  const action = setting.action;
  return (
    <SettingRow title={setting.title} description={setting.description}>
      <Button
        variant={action.danger ? "danger" : action.primary ? "primary" : "secondary"}
        disabled={action.disabled}
        loading={running === action.label}
        onClick={() => void run(action)}
      >
        {action.label}
      </Button>
    </SettingRow>
  );
}

/**
 * Actions d’un élément : une action `danger` qui a une icône reste visible en icône rouge (la corbeille de OneApp),
 * confirmée avant de s’exécuter ; les autres suivent la barre d’une ligne (icônes, puis « ⋯ »).
 */
function ItemActions({ actions, subject }: { actions: ReadonlyArray<Action>; subject: string }) {
  const { run, running } = useRunAction();
  const shown = actions.filter((action) => !action.hidden);
  const direct = shown.filter((action) => action.danger && action.icon);
  const rest = shown.filter((action) => !direct.includes(action));
  if (!shown.length) return null;
  return (
    <span className="setting-item__actions">
      {rest.length ? <ActionBar actions={rest} place="row" subject={subject} /> : null}
      {direct.map((action) => {
        const Icon = action.icon as ActionIcon;
        return (
          <IconButton
            key={action.label}
            label={`${action.label} : ${subject}`}
            tooltip={action.label}
            size="small"
            appearance="table"
            tone="danger"
            disabled={action.disabled}
            loading={running === action.label}
            loadingLabel={`${action.label}…`}
            onClick={() => void run(action)}
          >
            <Icon size={16} aria-hidden="true" />
          </IconButton>
        );
      })}
    </span>
  );
}

function ItemSetting({ setting }: { setting: Extract<Setting, { type: "item" }> }) {
  return (
    <SettingRow
      title={setting.title}
      badge={setting.code ? <Code>{setting.code}</Code> : undefined}
      description={
        setting.description || setting.tags?.length ? (
          <>
            {setting.description ? <span className="setting-item__text">{setting.description}</span> : null}
            {setting.tags?.length ? (
              <span className="setting-item__tags">
                {setting.tags.map((tag) => (
                  <StatusBadge key={tag.label} tone={tag.tone ?? "neutral"} size="compact">
                    {tag.label}
                  </StatusBadge>
                ))}
              </span>
            ) : null}
          </>
        ) : undefined
      }
    >
      <ItemActions actions={setting.actions ?? []} subject={setting.title} />
    </SettingRow>
  );
}

function SettingLine({ setting }: { setting: Setting }) {
  switch (setting.type) {
    case "switch":
      return <SwitchSetting setting={setting} />;
    case "select":
      return <SelectSetting setting={setting} />;
    case "text":
      return <TextSetting setting={setting} />;
    case "action":
      return <ActionSetting setting={setting} />;
    case "item":
      return <ItemSetting setting={setting} />;
    case "info":
      return (
        <SettingRow title={setting.title} description={setting.description}>
          <FormattedValue
            value={setting.value}
            options={{ type: setting.valueType, statuses: setting.statuses, currency: setting.currency }}
          />
        </SettingRow>
      );
  }
}

/**
 * Gabarit d’un onglet de Réglages : des blocs titrés de lignes de réglage, chargés d’un coup. Chaque ligne a son
 * contrôle choisi par Alfred d’après son type ; la page fournit les valeurs et la façon de les enregistrer. Il prend
 * toute la largeur de la rubrique, avec les marges et les titres des rubriques intégrées (`settings-surface.css`).
 */
export function SettingsPage<Values>({
  load,
  sections,
}: {
  /** Lit les valeurs enregistrées (une requête, une fonction) ; sans lui, `sections` reçoit `undefined`. */
  load?: () => Promise<Values>;
  sections: (values: Values) => ReadonlyArray<SettingsSection>;
}) {
  const state = useLoad(async () => (load ? load() : (undefined as Values)), []);
  if (state.error) {
    return (
      <Page>
        <FeedbackBanner tone="danger" action={<Button onClick={state.reload}>Réessayer</Button>}>
          {`Les réglages n’ont pas pu être chargés. ${state.error.message}`}
        </FeedbackBanner>
      </Page>
    );
  }
  if (state.loading && state.data === undefined && load) {
    return (
      <Page>
        <LoadingSkeleton rows={4} label="Chargement des réglages…" />
      </Page>
    );
  }
  return (
    <Page>
      {sections(state.data as Values).map((section) => (
        <Section key={section.title} title={section.title} description={section.description} actions={section.actions}>
          <SettingRows>
            {section.settings.map((setting) => (
              <SettingLine key={setting.id} setting={setting} />
            ))}
          </SettingRows>
        </Section>
      ))}
    </Page>
  );
}
