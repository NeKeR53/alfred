/**
 * Palette de commandes : Cmd+K (macOS) ou Ctrl+K l’ouvre et la ferme. Elle mène à chaque page et onglet, lance les
 * fonctions de l’espace, ouvre les conversations avec l’agent et bascule le thème. La liste se recalcule à chaque
 * ouverture : une page créée par l’agent y apparaît d’elle-même.
 */
import { Button, Dialog, FormField, IconButton, TextArea } from "@alfred/ui";
import { Command } from "cmdk";
import { Bot, MessageSquare, MessageSquarePlus, Moon, Play, Settings, Sun, X } from "lucide-react";
import { type FormEvent, type ReactNode, useEffect, useId, useRef, useState } from "react";
import { create } from "zustand";
import { invoke } from "../../lib/native";
import type { ResolvedFunction } from "../../lib/types";
import { NamedIcon } from "../../shell/icons";
import { notify } from "../../shell/notifications";
import { useShell } from "../../shell/store";
import { useAgents } from "../agent/store";
import { settingsTabs } from "../settings/tabs";
import "./palette.css";

interface PaletteState {
  open: boolean;
  setOpen: (open: boolean) => void;
  toggle: () => void;
}

export const usePalette = create<PaletteState>((set) => ({
  open: false,
  setOpen: (open) => set({ open }),
  toggle: () => set((state) => ({ open: !state.open })),
}));

/** Minuscules sans accents : « Réglages » se trouve en tapant « regl ». */
export const fold = (text: string) =>
  text
    .normalize("NFD")
    .replace(/\p{Diacritic}/gu, "")
    .toLowerCase();

/** Filtre de cmdk : chaque mot cherché doit apparaître ; un libellé qui commence par la recherche passe devant. */
export function paletteFilter(value: string, search: string, keywords: string[] = []): number {
  const haystack = fold([value, ...keywords].join(" "));
  const words = fold(search).split(/\s+/).filter(Boolean);
  if (words.length === 0) return 1;
  if (!words.every((word) => haystack.includes(word))) return 0;
  return fold(keywords[0] ?? value).startsWith(words[0]) ? 1 : 0.5;
}

const isMac = () => {
  const platform = useShell.getState().info?.platform;
  if (platform) return platform === "macos";
  return typeof navigator !== "undefined" && /Mac|iPhone|iPad/.test(navigator.platform || navigator.userAgent);
};

type Schema = { type?: string; required?: unknown; properties?: Record<string, Schema>; default?: unknown } | null;

const requiredInputs = (schema: unknown): string[] => {
  const required = (schema as Schema)?.required;
  return Array.isArray(required) ? required.filter((key): key is string => typeof key === "string") : [];
};

function sample(schema: Schema | undefined): unknown {
  if (schema?.default !== undefined) return schema.default;
  switch (schema?.type) {
    case "string":
      return "";
    case "number":
    case "integer":
      return 0;
    case "boolean":
      return false;
    case "array":
      return [];
    case "object":
      return {};
    default:
      return null;
  }
}

/** Entrée à compléter : les champs requis, avec une valeur vide de leur type. */
function template(schema: unknown): string {
  const properties = (schema as Schema)?.properties ?? {};
  const input = Object.fromEntries(requiredInputs(schema).map((key) => [key, sample(properties[key])]));
  return JSON.stringify(input, null, 2);
}

function summarize(result: unknown): string {
  if (result === undefined || result === null) return "Aucun résultat renvoyé.";
  const text = typeof result === "string" ? result : JSON.stringify(result, null, 1);
  return text.length > 400 ? `${text.slice(0, 399)}…` : text;
}

async function runFunction(fn: ResolvedFunction, input: unknown) {
  try {
    const result = await invoke("functions.call", { function: fn.reference, input });
    notify({
      tone: "success",
      title: `Fonction ${fn.reference} terminée`,
      description: summarize(result),
      source: "Palette de commandes",
    });
  } catch (error) {
    notify({
      tone: "error",
      title: `La fonction ${fn.reference} a échoué`,
      description: error instanceof Error ? error.message : String(error),
      source: "Palette de commandes",
    });
  }
}

function Item({
  value,
  keywords,
  icon,
  meta,
  onSelect,
  children,
}: {
  value: string;
  keywords: string[];
  icon: ReactNode;
  meta?: string;
  onSelect: () => void;
  children: ReactNode;
}) {
  return (
    <Command.Item value={value} keywords={keywords} onSelect={onSelect}>
      <span className="command-palette__icon">{icon}</span>
      <span className="command-palette__label">{children}</span>
      {meta ? <span className="command-palette__meta">{meta}</span> : null}
    </Command.Item>
  );
}

function FunctionInput({
  fn,
  onBack,
  onRun,
}: {
  fn: ResolvedFunction;
  onBack: () => void;
  onRun: (input: unknown) => void;
}) {
  const formId = useId();
  const [text, setText] = useState(() => template(fn.input));
  const [error, setError] = useState<string>();
  const submit = (event?: FormEvent) => {
    event?.preventDefault();
    try {
      onRun(JSON.parse(text));
    } catch {
      setError("JSON invalide : vérifier les guillemets, virgules et accolades.");
    }
  };
  return (
    <form id={formId} className="command-palette__input-form" noValidate onSubmit={submit}>
      <FormField
        label={`Entrée de ${fn.reference}`}
        hint={`${fn.description ? `${fn.description} ` : ""}Champs requis : ${requiredInputs(fn.input).join(", ")}. Ctrl+Entrée pour lancer.`}
        error={error}
      >
        <TextArea
          value={text}
          spellCheck={false}
          rows={8}
          autoFocus
          onChange={(event) => {
            setText(event.target.value);
            setError(undefined);
          }}
          onKeyDown={(event) => {
            if (event.key === "Enter" && (event.ctrlKey || event.metaKey)) {
              event.preventDefault();
              submit();
            }
          }}
        />
      </FormField>
      <div className="form-actions">
        <Button onClick={onBack}>Retour</Button>
        <Button variant="primary" type="submit" form={formId}>
          Lancer
        </Button>
      </div>
    </form>
  );
}

export function CommandPalette() {
  const open = usePalette((state) => state.open);
  const setOpen = usePalette((state) => state.setOpen);
  const snapshot = useShell((state) => state.snapshot);
  const theme = useShell((state) => state.theme);
  const headers = useAgents((state) => state.headers);
  const dialog = useRef<HTMLDialogElement>(null);
  const search = useRef<HTMLInputElement>(null);
  const returnFocus = useRef<HTMLElement | null>(null);
  const [query, setQuery] = useState("");
  const [inputFor, setInputFor] = useState<ResolvedFunction>();

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key.toLowerCase() !== "k" || event.altKey || event.shiftKey) return;
      if (!(isMac() ? event.metaKey && !event.ctrlKey : event.ctrlKey && !event.metaKey)) return;
      event.preventDefault();
      usePalette.getState().toggle();
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, []);

  useEffect(() => {
    const element = dialog.current;
    if (!element) return;
    if (open && !element.open) {
      returnFocus.current = document.activeElement instanceof HTMLElement ? document.activeElement : null;
      element.showModal();
      search.current?.focus();
    } else if (!open && element.open) {
      element.close();
    }
  }, [open]);

  const close = () => setOpen(false);
  const closed = () => {
    setOpen(false);
    setQuery("");
    setInputFor(undefined);
    const target = returnFocus.current;
    returnFocus.current = null;
    requestAnimationFrame(() => {
      if (target?.isConnected && !document.querySelector("dialog[open]")) target.focus();
    });
  };
  /** Ferme la palette puis lance l’action : une navigation garde le focus qu’elle donne. */
  const run =
    (action: () => void, restoreFocus = false) =>
    () => {
      if (!restoreFocus) returnFocus.current = null;
      close();
      action();
    };

  const shell = useShell.getState;
  const sections = (snapshot?.sections ?? []).filter((section) => !section.hidden);
  const settingsPages = (snapshot?.settingsPages ?? []).filter((page) => !page.hidden);
  const functions = (snapshot?.functions ?? []).filter((fn) => !fn.missing);
  const conversations = headers
    .filter((header) => header.started && !header.archived)
    .sort((left, right) => right.updatedAt - left.updatedAt)
    .slice(0, 12);

  const call = (fn: ResolvedFunction) => {
    if (requiredInputs(fn.input).length > 0) {
      setInputFor(fn);
      return;
    }
    run(() => void runFunction(fn, {}), true)();
  };

  return (
    <Dialog ref={dialog} className="command-dialog" aria-label="Palette de commandes" onClose={closed}>
      {open ? (
        <Command
          className="command-palette"
          label="Rechercher une page, une fonction ou une commande"
          filter={paletteFilter}
          loop
        >
          <div className="command-dialog__heading">
            <strong>{inputFor ? `Lancer ${inputFor.reference}` : "Commandes"}</strong>
            <IconButton label="Fermer la palette" tooltip="Fermer · Échap" onClick={close}>
              <X size={16} aria-hidden="true" />
            </IconButton>
          </div>
          {inputFor ? (
            <FunctionInput
              fn={inputFor}
              onBack={() => {
                setInputFor(undefined);
                requestAnimationFrame(() => search.current?.focus());
              }}
              onRun={(input) => run(() => void runFunction(inputFor, input), true)()}
            />
          ) : (
            <>
              <Command.Input
                ref={search}
                placeholder="Rechercher une page, une fonction ou une commande…"
                value={query}
                onValueChange={setQuery}
              />
              <Command.List className="command-palette__list">
                <Command.Empty className="command-dialog__empty">Aucun résultat.</Command.Empty>
                <Command.Group heading="Aller à">
                  <Item
                    value="aller:agent"
                    keywords={["Agent", "conversation"]}
                    icon={<Bot size={16} aria-hidden="true" />}
                    onSelect={run(() => shell().setView({ kind: "agent" }))}
                  >
                    Agent
                  </Item>
                  {sections.map((section) => (
                    <Item
                      key={section.id}
                      value={`aller:section:${section.id}`}
                      keywords={[section.label, "section"]}
                      icon={<NamedIcon name={section.icon} size={16} />}
                      meta="Section"
                      onSelect={run(() => shell().setView({ kind: "section", id: section.id }))}
                    >
                      {section.label}
                    </Item>
                  ))}
                  {sections.flatMap((section) =>
                    section.pages
                      .filter((page) => !page.hidden)
                      .map((page) => (
                        <Item
                          key={page.reference}
                          value={`aller:page:${page.reference}`}
                          keywords={[page.title, section.label, page.description]}
                          icon={<NamedIcon name={page.icon ?? section.icon} size={16} />}
                          meta={section.label}
                          onSelect={run(() => shell().openPage(page.reference))}
                        >
                          {page.title}
                        </Item>
                      )),
                  )}
                  {settingsTabs.map((tab) => (
                    <Item
                      key={tab.id}
                      value={`aller:réglages:${tab.id}`}
                      keywords={[tab.label, "Réglages"]}
                      icon={<Settings size={16} aria-hidden="true" />}
                      meta="Réglages"
                      onSelect={run(() => {
                        shell().setView({ kind: "settings" });
                        shell().setActiveTab("réglages", tab.id);
                      })}
                    >
                      {tab.label}
                    </Item>
                  ))}
                  {settingsPages.map((page) => (
                    <Item
                      key={page.reference}
                      value={`aller:page:${page.reference}`}
                      keywords={[page.title, "Réglages", page.description]}
                      icon={<NamedIcon name={page.icon} size={16} />}
                      meta="Réglages"
                      onSelect={run(() => shell().openPage(page.reference))}
                    >
                      {page.title}
                    </Item>
                  ))}
                </Command.Group>
                {functions.length > 0 ? (
                  <Command.Group heading="Lancer une fonction">
                    {functions.map((fn) => (
                      <Item
                        key={fn.reference}
                        value={`fonction:${fn.reference}`}
                        keywords={[fn.reference, fn.description, "fonction lancer"]}
                        icon={<Play size={16} aria-hidden="true" />}
                        meta={requiredInputs(fn.input).length > 0 ? "Entrée requise" : undefined}
                        onSelect={() => call(fn)}
                      >
                        {fn.reference}
                      </Item>
                    ))}
                  </Command.Group>
                ) : null}
                <Command.Group heading="Agent">
                  <Item
                    value="agent:nouvelle"
                    keywords={["Nouvelle conversation", "agent"]}
                    icon={<MessageSquarePlus size={16} aria-hidden="true" />}
                    onSelect={run(() => {
                      const agents = useAgents.getState();
                      const conversation = agents.create();
                      void agents.open(conversation.id);
                      shell().setView({ kind: "agent" });
                    })}
                  >
                    Nouvelle conversation
                  </Item>
                  {conversations.map((conversation) => (
                    <Item
                      key={conversation.id}
                      value={`agent:conversation:${conversation.id}`}
                      keywords={[conversation.title, "conversation"]}
                      icon={<MessageSquare size={16} aria-hidden="true" />}
                      meta="Conversation"
                      onSelect={run(() => {
                        void useAgents.getState().open(conversation.id);
                        shell().setView({ kind: "agent" });
                      })}
                    >
                      {conversation.title}
                    </Item>
                  ))}
                </Command.Group>
                <Command.Group heading="Apparence">
                  <Item
                    value="apparence:theme"
                    keywords={[theme === "dark" ? "Thème clair" : "Thème sombre", "apparence mode"]}
                    icon={
                      theme === "dark" ? <Sun size={16} aria-hidden="true" /> : <Moon size={16} aria-hidden="true" />
                    }
                    onSelect={run(() => shell().setTheme(theme === "dark" ? "light" : "dark"), true)}
                  >
                    {theme === "dark" ? "Passer au thème clair" : "Passer au thème sombre"}
                  </Item>
                </Command.Group>
              </Command.List>
              <div className="command-dialog__footer">
                <span>Flèches pour choisir · Entrée pour valider · Échap pour fermer</span>
                <kbd>{isMac() ? "⌘K" : "Ctrl+K"}</kbd>
              </div>
            </>
          )}
        </Command>
      ) : null}
    </Dialog>
  );
}
