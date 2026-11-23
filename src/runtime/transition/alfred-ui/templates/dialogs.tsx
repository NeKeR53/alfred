import { type ReactNode, useEffect, useId, useState, useSyncExternalStore } from "react";
import { Button } from "../components/Button";
import { ConfirmDialog } from "../components/ConfirmDialog";
import { CheckboxControl, FormField, SelectControl, TextArea, TextInput } from "../components/FormControls";
import { Modal } from "../components/Modal";
import { Form, Grid } from "../components/page";
import { type Action, useRunAction } from "./actions";
import { releases } from "./host";
import { CHANGED, errorMessage, useFrameServices } from "./services";

/** Une option de liste : la valeur enregistrée et son libellé. */
export interface FieldOption {
  value: string;
  label: string;
}

/**
 * Un champ d’un formulaire déclaratif. Le type choisit le contrôle, sa largeur et sa validation : la page ne
 * dessine aucun champ elle-même.
 */
export interface FormFieldSpec {
  /** Clé de la valeur dans `values`. */
  name: string;
  /** Libellé visible, sans « (facultatif) » : ajouté seul quand `optional`. */
  label: string;
  /**
   * `text` (défaut), `email`, `url`, `tel`, `number`, `date`, `time`, `textarea` (plusieurs lignes), `select`
   * (liste fermée, `options` obligatoire), `checkbox` (oui ou non). Rien d’autre.
   */
  type?: "text" | "email" | "url" | "tel" | "number" | "date" | "time" | "textarea" | "select" | "checkbox";
  options?: ReadonlyArray<FieldOption>;
  /** Le champ peut rester vide. Par défaut, tout champ est obligatoire (sauf `checkbox`). */
  optional?: boolean;
  /** Texte d’exemple, sans « Ex. » : il est ajouté. */
  placeholder?: string;
  /** Aide sous le champ, une phrase. */
  hint?: string;
  /** Contrôle propre au champ : renvoie le message à afficher, ou rien si la valeur convient. */
  validate?: (value: FormValue, values: FormValues) => string | undefined;
}

/** Valeur d’un champ, toujours en texte : `""` pour un champ facultatif laissé vide, `"1"` ou `"0"` pour une case. */
export type FormValue = string;
export type FormValues = Record<string, string>;

export interface FormSpec {
  /** Verbe et objet : « Nouvelle tâche », « Renommer la liste ». */
  title: string;
  /** Une phrase sous le titre, facultative. */
  description?: string;
  fields: ReadonlyArray<FormFieldSpec>;
  /** Valeurs de départ (édition) : l’objet lu en base convient tel quel (`initial: tache`). */
  initial?: object;
  /** Libellé de l’action : « Créer », « Enregistrer », « Inviter ». */
  submitLabel: string;
  /** Enregistre ; une erreur levée est notifiée et laisse la saisie ouverte. */
  onSubmit: (values: FormValues) => unknown | Promise<unknown>;
  /** Notification après la réussite : « Tâche créée ». */
  success?: string;
}

/**
 * Une modale de contenu : un aperçu, une liste à choisir, un détail à lire sans quitter la page. Le contenu est
 * composé de blocs de `@alfred/ui` ; le pied porte « Fermer » et les actions, disposées par Alfred.
 */
export interface ModalSpec {
  /** Ce que montre la modale : « Aperçu de la facture », « Choisir un modèle ». */
  title: string;
  /** Une phrase sous le titre, facultative. */
  description?: string;
  /** `small` : 360 px ; `default` : 480 px ; `wide` : 720 px, pour un tableau ou un aperçu. */
  size?: "small" | "default" | "wide";
  /** Le contenu ; sous forme de fonction, il reçoit `close` (un élément de liste qui choisit puis ferme). */
  content: ReactNode | ((close: () => void) => ReactNode);
  /**
   * Actions du pied, après « Fermer » : l’action `primary` en dernier, en bouton plein. Une action réussie ferme la
   * modale (confirmation, attente, notification et rechargement comme partout).
   */
  actions?: ReadonlyArray<Action>;
  /** Libellé du bouton qui ferme : « Fermer » par défaut, « Annuler » quand une action principale est proposée. */
  closeLabel?: string;
}

export interface ConfirmSpec {
  title: string;
  message?: string;
  confirmLabel: string;
  tone?: "danger" | "default";
}

type Request =
  | { id: number; kind: "confirm"; spec: ConfirmSpec; resolve: (accepted: boolean) => void }
  | { id: number; kind: "form"; spec: FormSpec; resolve: (saved: boolean) => void }
  | { id: number; kind: "modal"; spec: ModalSpec; resolve: (acted: boolean) => void };

let nextId = 0;
/** Hôte qui affiche la file : le premier `Page` monté ; les autres ne rendent rien. */
let owner: symbol | null = null;

/**
 * Pile des dialogues ouverts par les gabarits, `openForm`, `openModal` et `confirmAction` : `Page` les affiche
 * tous, le dernier ouvert au-dessus (une confirmation demandée depuis une modale s’affiche sur elle).
 */
let queue: Request[] = [];
const listeners = new Set<() => void>();
const emit = () => {
  for (const listener of listeners) listener();
};
const subscribe = (listener: () => void) => {
  listeners.add(listener);
  return () => listeners.delete(listener);
};
const current = () => queue;
const settle = (request: Request, value: boolean) => {
  queue = queue.filter((item) => item !== request);
  emit();
  request.resolve(value);
};

/**
 * Ouvre un formulaire en modale, dessiné par Alfred d’après `fields`. Renvoie `true` une fois enregistré, `false`
 * si l’utilisateur annule. La page n’a rien à rendre : `Page` (et chaque gabarit) l’affiche.
 */
export function openForm(spec: FormSpec): Promise<boolean> {
  const promise = new Promise<boolean>((resolve) => {
    nextId += 1;
    queue = [...queue, { id: nextId, kind: "form", spec, resolve }];
    emit();
  });
  dialogPromises.add(promise);
  return promise;
}

/**
 * Ouvre une modale de contenu (aperçu, choix, détail). Renvoie `true` quand une de ses actions a réussi, `false`
 * quand l’utilisateur la ferme. Rendue par `Page` : la page n’a rien à poser.
 */
export function openModal(spec: ModalSpec): Promise<boolean> {
  const promise = new Promise<boolean>((resolve) => {
    nextId += 1;
    queue = [...queue, { id: nextId, kind: "modal", spec, resolve }];
    emit();
  });
  dialogPromises.add(promise);
  return promise;
}

/** Demande une confirmation (question qui nomme l’objet, verbe de l’action). Renvoie `true` si elle est acceptée. */
export function confirmAction(spec: ConfirmSpec): Promise<boolean> {
  return new Promise((resolve) => {
    nextId += 1;
    queue = [...queue, { id: nextId, kind: "confirm", spec, resolve }];
    emit();
  });
}

/** Promesses rendues par `openForm` et `openModal` : une action qui en rend une n’affiche pas d’attente. */
const dialogPromises = new WeakSet<Promise<boolean>>();

export function isDialogPromise(value: unknown): value is Promise<boolean> {
  return value instanceof Promise && dialogPromises.has(value);
}

function initialValues(spec: FormSpec): FormValues {
  const values: FormValues = {};
  const initial = (spec.initial ?? {}) as Record<string, unknown>;
  for (const field of spec.fields) {
    const given = initial[field.name];
    if (field.type === "checkbox") values[field.name] = given === true || given === "1" || given === 1 ? "1" : "0";
    else if (given == null || given === false || given === "")
      values[field.name] = field.type === "select" && !field.optional ? (field.options?.[0]?.value ?? "") : "";
    else values[field.name] = String(given);
  }
  return values;
}

/** Message d’erreur d’un champ, ou rien. */
export function validateField(field: FormFieldSpec, value: FormValue, values: FormValues): string | undefined {
  if (field.type === "checkbox") return field.validate?.(value, values);
  const text = value.trim();
  if (!text) {
    if (field.optional) return undefined;
    return field.type === "select"
      ? `Choisissez une valeur pour « ${field.label} ».`
      : `Renseignez le champ « ${field.label} ».`;
  }
  if (field.type === "email" && !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(text))
    return "Saisissez une adresse de courriel, par exemple lea@exemple.fr.";
  if (field.type === "url" && !/^https?:\/\/\S+$/.test(text))
    return "Saisissez une adresse web complète, par exemple https://exemple.fr.";
  if (field.type === "number" && Number.isNaN(Number(text.replace(",", "."))))
    return `Saisissez un nombre dans « ${field.label} ».`;
  return field.validate?.(value, values);
}

const widthOf = (type: FormFieldSpec["type"]) =>
  type === "number" ? "sm" : type === "date" || type === "time" ? "sm" : type === "select" ? "auto" : "full";

function FieldControl({
  field,
  value,
  error,
  onChange,
}: {
  field: FormFieldSpec;
  value: FormValue;
  error?: string;
  onChange: (value: FormValue) => void;
}) {
  if (field.type === "checkbox") {
    return (
      <CheckboxControl
        label={field.label}
        checked={value === "1"}
        onChange={(event) => onChange(event.target.checked ? "1" : "0")}
      />
    );
  }
  const label = field.optional ? `${field.label} (facultatif)` : field.label;
  const placeholder = field.placeholder ? `Ex. ${field.placeholder.replace(/^Ex\.\s*/, "")}` : undefined;
  const required = field.optional ? undefined : ("true" as const);
  return (
    <FormField label={label} hint={field.hint} error={error}>
      {field.type === "textarea" ? (
        <TextArea
          aria-required={required}
          placeholder={placeholder}
          value={value}
          onChange={(event) => onChange(event.target.value)}
        />
      ) : field.type === "select" ? (
        <SelectControl
          aria-required={required}
          width={widthOf(field.type)}
          value={value}
          onChange={(event) => onChange(event.target.value)}
        >
          {field.optional ? <option value="">Aucun</option> : null}
          {(field.options ?? []).map((option) => (
            <option key={option.value} value={option.value}>
              {option.label}
            </option>
          ))}
        </SelectControl>
      ) : (
        <TextInput
          type={field.type === "number" ? "text" : (field.type ?? "text")}
          inputMode={field.type === "number" ? "decimal" : undefined}
          aria-required={required}
          width={widthOf(field.type)}
          placeholder={placeholder}
          value={value}
          onChange={(event) => onChange(event.target.value)}
        />
      )}
    </FormField>
  );
}

/**
 * Champs d’un formulaire déclaratif, disposés par Alfred : les champs courts consécutifs (nombre, date, heure,
 * liste) se partagent une ligne, les autres prennent toute la colonne.
 */
export function FormFields({
  fields,
  values,
  errors,
  onChange,
}: {
  fields: ReadonlyArray<FormFieldSpec>;
  values: FormValues;
  errors: Record<string, string | undefined>;
  onChange: (name: string, value: FormValue) => void;
}) {
  const short = (field: FormFieldSpec) => ["number", "date", "time", "select"].includes(field.type ?? "text");
  const groups: FormFieldSpec[][] = [];
  for (const field of fields) {
    const last = groups[groups.length - 1];
    if (last && short(field) && short(last[0]) && last.length < 2) last.push(field);
    else groups.push([field]);
  }
  return (
    <>
      {groups.map((group) => {
        const controls = group.map((field) => (
          <FieldControl
            key={field.name}
            field={field}
            value={values[field.name] ?? ""}
            error={errors[field.name]}
            onChange={(value) => onChange(field.name, value)}
          />
        ));
        return group.length > 1 ? (
          <Grid key={group[0].name} minColumnWidth={160}>
            {controls}
          </Grid>
        ) : (
          controls
        );
      })}
    </>
  );
}

function FormDialog({ spec, onDone }: { spec: FormSpec; onDone: (saved: boolean) => void }) {
  const services = useFrameServices();
  const id = useId();
  const [values, setValues] = useState(() => initialValues(spec));
  const [errors, setErrors] = useState<Record<string, string | undefined>>({});
  const [busy, setBusy] = useState(false);
  const submit = async () => {
    const found: Record<string, string | undefined> = {};
    for (const field of spec.fields) found[field.name] = validateField(field, values[field.name] ?? "", values);
    setErrors(found);
    if (Object.values(found).some(Boolean)) return;
    const cleaned: FormValues = {};
    for (const field of spec.fields) cleaned[field.name] = (values[field.name] ?? "").trim();
    setBusy(true);
    try {
      await spec.onSubmit(cleaned);
      if (spec.success) services.notify({ title: spec.success, tone: "success" });
      services.send(CHANGED);
      onDone(true);
    } catch (error) {
      services.notify({
        title: `« ${spec.submitLabel} » n’a pas abouti`,
        description: errorMessage(error),
        tone: "error",
      });
    } finally {
      setBusy(false);
    }
  };
  return (
    <Modal
      open
      busy={busy}
      size={spec.fields.length > 4 || spec.fields.some((field) => field.type === "textarea") ? "default" : "small"}
      title={spec.title}
      description={spec.description}
      onClose={() => onDone(false)}
      actions={
        <>
          <Button disabled={busy} onClick={() => onDone(false)}>
            Annuler
          </Button>
          <Button type="submit" form={id} variant="primary" loading={busy}>
            {spec.submitLabel}
          </Button>
        </>
      }
    >
      <Form id={id} onSubmit={() => void submit()}>
        <FormFields
          fields={spec.fields}
          values={values}
          errors={errors}
          onChange={(name, value) => {
            setValues((current) => ({ ...current, [name]: value }));
            setErrors((current) => ({ ...current, [name]: undefined }));
          }}
        />
      </Form>
    </Modal>
  );
}

/**
 * La première `Page` montée héberge les dialogues et les sous-pages ; les autres (une page dans une sous-page, un
 * gabarit dans un autre) ne rendent rien. Quand l’hôte disparaît, ce qui restait ouvert est abandonné.
 */
export function useDialogOwner(): boolean {
  const [me] = useState(() => Symbol("hôte"));
  const [active, setActive] = useState(false);
  useEffect(() => {
    if (owner !== null) return;
    owner = me;
    setActive(true);
    return () => {
      owner = null;
      for (const pending of queue) pending.resolve(false);
      queue = [];
      for (const release of releases) release();
    };
  }, [me]);
  return active;
}

/** Affiche les dialogues ouverts, le dernier au-dessus. Rendu par `Page` : une page n’a jamais à le poser. */
export function TemplateDialogHost() {
  const requests = useSyncExternalStore(subscribe, current, current);
  return (
    <>
      {requests.map((request) =>
        request.kind === "confirm" ? (
          <ConfirmDialog
            key={request.id}
            open
            title={request.spec.title}
            message={request.spec.message}
            confirmLabel={request.spec.confirmLabel}
            tone={request.spec.tone}
            onConfirm={() => settle(request, true)}
            onCancel={() => settle(request, false)}
          />
        ) : request.kind === "form" ? (
          <FormDialog key={request.id} spec={request.spec} onDone={(saved) => settle(request, saved)} />
        ) : (
          <ContentDialog key={request.id} spec={request.spec} onDone={(acted) => settle(request, acted)} />
        ),
      )}
    </>
  );
}

/** Modale de contenu ouverte par `openModal`. */
function ContentDialog({ spec, onDone }: { spec: ModalSpec; onDone: (acted: boolean) => void }) {
  const { run, running } = useRunAction(() => onDone(true));
  const actions = (spec.actions ?? []).filter((action) => !action.hidden);
  const primary = actions.find((action) => action.primary && !action.danger);
  const others = actions.filter((action) => action !== primary);
  const close = () => onDone(false);
  return (
    <Modal
      open
      busy={running !== null}
      size={spec.size ?? "default"}
      title={spec.title}
      description={spec.description}
      onClose={close}
      actions={
        <>
          <Button disabled={running !== null} onClick={close}>
            {spec.closeLabel ?? (primary ? "Annuler" : "Fermer")}
          </Button>
          {[...others, ...(primary ? [primary] : [])].map((action) => (
            <Button
              key={action.label}
              variant={action === primary ? "primary" : action.danger ? "danger" : "secondary"}
              disabled={action.disabled || (running !== null && running !== action.label)}
              loading={running === action.label}
              onClick={() => void run(action)}
            >
              {action.label}
            </Button>
          ))}
        </>
      }
    >
      {typeof spec.content === "function" ? spec.content(close) : spec.content}
    </Modal>
  );
}
