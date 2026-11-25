/**
 * Traite les demandes d’un cadre isolé. L’identité du demandeur (module, page) est fixée par la coquille à partir
 * du cadre qui a émis le message, jamais par le contenu du message : une page ne peut pas se faire passer pour une
 * autre.
 */

import { requestReveal } from "../features/vault/SecretReveal";
import {
  AlfredError,
  invoke,
  notifySystem,
  openExternal,
  openPageWindow,
  pickFiles,
  pickFolder,
  pickSaveFile,
} from "../lib/native";
import { isKnownPage } from "./badges";
import { SECTION_ZONE, sectionZone, takePendingEntryActions, useMenuZones } from "./menuZones";
import { findPage } from "./navigationLayout";
import { type NotificationAction, notify } from "./notifications";
import { cleanView, closeView, type OpenedView, openView, sectionOfPage, useOpenViews, viewKey } from "./openViews";
import { loadDurablePageMemory, pageMemoryOf, rememberPageValue } from "./pageMemory";
import { pageWindowParams, pageWindowReference } from "./pageWindowMode";
import { useShell } from "./store";
import { setTopBarActions } from "./topBarActions";
import { declareTopBarSearch, removeTopBarSearch, setTopBarQuery, topBarQueryOf } from "./topBarSearchStore";

export interface FrameIdentity {
  kind: "page" | "panel" | "function";
  module: string;
  /** `module/page` ou `module/fonction`. */
  reference: string;
  /** Pour un panneau : la page hôte. */
  host?: string;
  /** Compte que montre la page quand elle n’en a qu’un (ou celui qu’elle suit) : `usePageContext().instance`. */
  instance?: string;
  /**
   * Comptes choisis pour la page, par besoin (`jira` → `acme`) ; pour un cadre de fonctions, ceux de la page qui l’a
   * appelé. `client(besoin)` y vise d’office le compte choisi.
   */
  accounts?: Record<string, string>;
  /**
   * Le cadre montre des données d’exemple : ses fonctions de connecteur rendent leurs exemples et aucune requête ne
   * part vers un service. La coquille le fixe, jamais le cadre.
   */
  examples?: boolean;
  /** Cadre invisible chargé pour une capture de l’agent : il lit la recherche de la page sans prendre la barre. */
  capture?: boolean;
  /**
   * Onglet ouvert sur un élément (`views.open`) que montre la page (ou la page d’un panneau), avec la section qui le
   * porte : `usePageContext().view`.
   */
  view?: OpenedView & { section: string };
}

/** Référence déclarée de la page (son modèle), sans le suffixe de sa copie (`module/page@recette`). */
export function declaredReference(identity: FrameIdentity): string {
  return identity.reference.replace(/@[^@/]*$/, "");
}

/** Suffixe de la copie que montre le cadre (`recette` pour `module/page@recette`), s’il en a un. */
function copySuffix(identity: FrameIdentity): string | undefined {
  return /@([^@/]*)$/.exec(identity.host ?? identity.reference)?.[1];
}

const selections = new Map<string, unknown>();
const selectionListeners = new Set<(page: string) => void>();

export function selectionOf(page: string): unknown {
  return selections.get(page) ?? null;
}

export function onSelectionChange(listener: (page: string) => void): () => void {
  selectionListeners.add(listener);
  return () => {
    selectionListeners.delete(listener);
  };
}

/**
 * Entrée du menu ouverte dans la page (ou dans la page d’un panneau) : `usePageContext().entry`, avec la section créée
 * qui la porte (`menu.addSection`), s’il y a lieu.
 */
function entryOf(identity: FrameIdentity): { id: string; label: string; section?: string } | null {
  if (identity.kind === "function") return null;
  const opened = useShell.getState().activeEntry[identity.host ?? identity.reference];
  if (!opened) return null;
  const section = opened.zone.startsWith(SECTION_ZONE) ? opened.zone.split("/").slice(1).join("/") : undefined;
  return section ? { id: opened.id, label: opened.label, section } : { id: opened.id, label: opened.label };
}

/** Page d’un cadre, sans son module ni son suffixe de copie (« projet ») : la page par défaut d’une section créée. */
function ownPageId(identity: FrameIdentity): string {
  return (identity.host ?? identity.reference).replace(/@[^@/]*$/, "").slice(identity.module.length + 1);
}

/** Paramètres de la fenêtre ouverte sur un élément précis, pour sa page et son panneau ; ailleurs `null`. */
function paramsOf(identity: FrameIdentity): Record<string, unknown> | null {
  if (identity.kind === "function") return null;
  const shown = pageWindowReference();
  return shown && shown === (identity.host ?? identity.reference) ? pageWindowParams() : null;
}

/** Page de l’espace nommée par une page : « module/page », ou « page » de son propre module. */
function namedPage(identity: FrameIdentity, page: unknown): string {
  const name = String(page ?? "");
  const reference = name.includes("/") ? name : `${identity.module}/${name}`;
  if (!isKnownPage(useShell.getState().snapshot, reference))
    throw new AlfredError({ message: `La page « ${reference} » n’existe pas dans l’espace de travail.` });
  return reference;
}

/** Options d’une fenêtre ouverte sur un élément : `params` (objet), `key` et `title`, vérifiés. */
function windowOptions(params: Params) {
  const value = params.params;
  if (value !== undefined && value !== null && (typeof value !== "object" || Array.isArray(value)))
    throw new AlfredError({ message: "Les paramètres d’une fenêtre sont un objet : { params: { build: 42 } }." });
  return {
    ...(value ? { params: value as Record<string, unknown> } : {}),
    ...(params.key !== undefined && params.key !== null ? { key: String(params.key) } : {}),
    ...(params.title ? { title: String(params.title) } : {}),
  };
}

const failed = (title: string) => (error: unknown) =>
  notify({ title, description: error instanceof Error ? error.message : String(error), tone: "error" });

/**
 * Actions d’une notification (`shell.notify({ actions })`), deux au plus, vérifiées au moment de la notification :
 * ouvrir une page (avec une entrée de sa zone), ouvrir une fenêtre sur un élément, ou appeler une fonction du module.
 */
function notificationActions(identity: FrameIdentity, raw: unknown): NotificationAction[] {
  if (raw === undefined || raw === null) return [];
  if (!Array.isArray(raw)) throw new AlfredError({ message: "Les actions d’une notification sont une liste." });
  if (raw.length > 2) throw new AlfredError({ message: "Une notification porte au plus deux actions." });
  return raw.map((item: Params) => {
    const label = String(item?.label ?? "").trim();
    if (!label) throw new AlfredError({ message: "Une action de notification a un libellé : « Journal »." });
    if (item.navigate) {
      const page = namedPage(identity, item.navigate);
      const entry = item.entry === undefined || item.entry === null ? undefined : String(item.entry);
      return {
        label,
        run: () => {
          if (!entry) return useShell.getState().openPage(page);
          // Le libellé de l’entrée est celui de la zone qui la porte, s’il est connu.
          const zones = useMenuZones.getState().zones;
          const zone = Object.keys(zones).find(
            (candidate) =>
              candidate.startsWith(`${identity.module}/`) &&
              zones[candidate].entries.some((known) => known.id === entry),
          );
          const known = zone ? zones[zone].entries.find((candidate) => candidate.id === entry) : undefined;
          useShell.getState().openEntry(page, { id: entry, label: known?.label ?? entry, zone: zone ?? page });
        },
      };
    }
    if (item.window && typeof item.window === "object") {
      const target = item.window as Params;
      const page = namedPage(identity, target.page);
      const options = windowOptions(target);
      return {
        label,
        run: () => void openPageWindow(page, options).catch(failed("La fenêtre n’a pas pu s’ouvrir")),
      };
    }
    if (item.function && typeof item.function === "object") {
      const call = item.function as Params;
      const name = String(call.id ?? "");
      const reference = name.includes("/") ? name : `${identity.module}/${name}`;
      if (reference.split("/")[0] !== identity.module)
        throw new AlfredError({ message: "Une notification n’appelle qu’une fonction de son propre module." });
      const input = call.input ?? {};
      return {
        label,
        run: () => {
          if (!frameServices.callFunction) return;
          void frameServices.callFunction(identity, reference, input).catch(failed(`« ${label} » n’a pas abouti`));
        },
      };
    }
    throw new AlfredError({
      message: "Une action de notification ouvre une page (navigate), une fenêtre (window) ou appelle une fonction.",
    });
  });
}

export function frameContext(identity: FrameIdentity) {
  const { theme, snapshot } = useShell.getState();
  const reference = declaredReference(identity);
  const [module, page] = reference.split("/");
  return {
    reference,
    module,
    page,
    instance: identity.instance ?? null,
    accounts: identity.accounts ?? {},
    kind: identity.kind,
    surface: snapshot?.settingsPages.some((page) => page.reference === identity.reference) ? "settings" : "section",
    theme,
    accent: snapshot?.accent ?? null,
    selection: identity.host ? selectionOf(identity.host) : null,
    entry: entryOf(identity),
    params: paramsOf(identity),
    view:
      identity.kind !== "function" && identity.view
        ? { id: identity.view.id, label: identity.view.label, params: identity.view.params }
        : null,
  };
}

/**
 * Onglet demandé par `views.open` : la page du cadre (celle de son panneau), ou une autre page du module nommée par
 * `page` (depuis une copie, la copie de même suffixe si elle existe).
 */
function viewTarget(identity: FrameIdentity, page: unknown): string {
  const own = identity.view?.page ?? identity.host ?? identity.reference;
  if (page === undefined || page === null || page === "") return own;
  const name = String(page);
  if (name.includes("/") && name.split("/")[0] !== identity.module)
    throw new AlfredError({
      message: 'Un onglet ouvre une page de son propre module : views.open({ page: "ticket" }).',
    });
  const named = name.includes("/") ? name : `${identity.module}/${name}`;
  const suffix = copySuffix(identity);
  const sibling = suffix && !named.includes("@") ? `${named}@${suffix}` : named;
  const snapshot = useShell.getState().snapshot;
  const found = snapshot ? (findPage(snapshot, sibling) ?? findPage(snapshot, named)) : undefined;
  if (!found) throw new AlfredError({ message: `La page « ${named} » n’existe pas dans l’espace de travail.` });
  return found.page.reference;
}

/** Section où le cadre ouvre ses onglets : celle de l’onglet qu’il montre, sinon celle de sa page. */
function viewSection(identity: FrameIdentity): string {
  const section = identity.view?.section ?? sectionOfPage(identity.host ?? identity.reference, pageWindowReference());
  if (!section)
    throw new AlfredError({
      message: "Cette page n’est pas dans le menu (Réglages, capture) : elle n’ouvre pas d’onglet.",
    });
  return section;
}

type Params = Record<string, unknown>;

/** Dernier onglet fixe d’une section : celui qui s’affiche quand on ferme le premier onglet d’élément actif. */
function lastFixedTab(section: string): string | undefined {
  const snapshot = useShell.getState().snapshot;
  if (section.startsWith("fenêtre:")) return section.slice("fenêtre:".length);
  const pages = snapshot?.sections.find((candidate) => candidate.id === section)?.pages ?? [];
  return pages.filter((page) => !page.hidden).at(-1)?.reference;
}

/** Champs d’un appel de compte, communs à la requête, au téléchargement et au flux. */
const CLIENT_CALL = [
  "client",
  "instance",
  "method",
  "path",
  "query",
  "headers",
  "body",
  "form",
  "multipart",
  "file",
] as const;

/** Garde de `params` les seuls champs nommés, et seulement ceux qui sont présents. */
function pick(params: Params, names: readonly string[]): Params {
  const picked: Params = {};
  for (const name of names) if (Object.hasOwn(params, name)) picked[name] = params[name];
  return picked;
}

/** Appels que d’autres parties de la coquille fournissent (exécution des fonctions, agents). */
/** Abonnement d’une page à un état partagé (`useAlfredState`) : voir `sharedStates.ts`. */
export interface StateWatch {
  unsubscribe: () => void;
  refresh: () => Promise<unknown>;
}

export const frameServices: {
  callFunction?: (identity: FrameIdentity, reference: string, input: unknown) => Promise<unknown>;
  watchState?: (
    identity: FrameIdentity,
    request: { name: string; key?: string; instance?: string },
    listener: (state: unknown) => void,
  ) => StateWatch;
  startAgent?: (identity: FrameIdentity, options: Params) => Promise<unknown>;
  sendToAgent?: (identity: FrameIdentity, options: Params) => Promise<unknown>;
  oneShot?: (identity: FrameIdentity, request: Params) => Promise<unknown>;
  /** Lit une notification à voix haute, si l’utilisateur l’a permis (Réglages › Voix). */
  announce?: (text: string) => void;
} = {};

type PeerFrame = { kind: FrameIdentity["kind"]; deliver: (message: unknown) => void };
const peers = new Map<string, Set<PeerFrame>>();

/** Inscrit un cadre comme interlocuteur de sa page : la page et son panneau s’envoient des messages. */
export function registerPeer(identity: FrameIdentity, deliver: (message: unknown) => void): () => void {
  const key = identity.host ?? identity.reference;
  const frame: PeerFrame = { kind: identity.kind, deliver };
  const frames = peers.get(key) ?? new Set();
  frames.add(frame);
  peers.set(key, frames);
  return () => {
    frames.delete(frame);
  };
}

/** États suivis par chaque cadre (`useAlfredState`), par identifiant choisi par le cadre. */
const watches = new WeakMap<FrameIdentity, Map<string, StateWatch>>();
const MAX_WATCHES = 200;

/** Événement poussé de la coquille vers le cadre qui a fait la demande. */
export type FramePush = (name: string, payload: unknown) => void;

/** Un cadre qui disparaît (changement d’onglet, fermeture) ne laisse pas le micro ouvert derrière lui. */
export function releaseFrame(identity: FrameIdentity) {
  // Ses abonnements aux états partagés se ferment avec lui.
  for (const watch of watches.get(identity)?.values() ?? []) watch.unsubscribe();
  watches.delete(identity);
  if (identity.kind === "page" && !identity.capture) {
    removeTopBarSearch(identity.reference);
    setTopBarActions(identity.reference, []);
  }
  void handleFrameRequest(identity, "voice.cancelListening", {}).catch(() => undefined);
  // Les flux et WebSocket que ce cadre était seul à lire se ferment avec lui.
  if (identity.kind !== "function") void handleFrameRequest(identity, "channels.release", {}).catch(() => undefined);
  // Les objets Python que ce cadre a créés sont libérés avec lui.
  if (identity.kind !== "function") void handleFrameRequest(identity, "python.release", {}).catch(() => undefined);
}

const BADGE_TARGET = {
  unnamed: 'Une fonction règle le compteur d’une page nommée : badge.set(3, { page: "boite" }).',
  refused: "Compteur refusé",
};
const MENU_TARGET = {
  unnamed: 'Une fonction règle la zone du menu d’une page nommée : menu.setEntries([…], { page: "produits" }).',
  refused: "Menu refusé",
};

/**
 * Page dont un cadre règle le compteur : la sienne (un panneau, celle de sa page), ou une autre page de son module
 * nommée par `page` (« boite », ou « boite@instance »). Une fonction doit toujours nommer la page.
 */
function badgeTarget(identity: FrameIdentity, page: unknown, what = BADGE_TARGET): string {
  let reference: string;
  if (typeof page === "string" && page) {
    const named = `${identity.module}/${page}`;
    // Depuis une copie (`…@recette`), une page sœur sans suffixe nommé est la copie de même suffixe, si elle existe.
    const suffix = copySuffix(identity);
    const sibling = suffix && !page.includes("@") ? `${named}@${suffix}` : named;
    reference = isKnownPage(useShell.getState().snapshot, sibling) ? sibling : named;
  } else if (identity.kind === "function") {
    throw new AlfredError({ message: what.unnamed });
  } else {
    reference = identity.host ?? identity.reference;
  }
  if (!isKnownPage(useShell.getState().snapshot, reference))
    throw new AlfredError({
      message: `${what.refused} : la page « ${reference} » n’existe pas dans l’espace de travail.`,
    });
  return reference;
}

function badgeValue(value: unknown): number {
  const number = typeof value === "number" ? value : Number(value);
  if (!Number.isFinite(number)) throw new AlfredError({ message: "Le compteur attend un nombre." });
  return Math.trunc(number);
}

/** « La page « Titre » » de la page (ou de la page hôte d’un panneau), pour la boîte de révélation. */
function pageTitle(identity: FrameIdentity): string {
  const reference = declaredReference(identity);
  const snapshot = useShell.getState().snapshot;
  const pages = [
    ...(snapshot?.sections.flatMap((section) =>
      section.pages.flatMap((page) => [page, ...(page.panel ? [page.panel] : [])]),
    ) ?? []),
    ...(snapshot?.settingsPages ?? []),
  ];
  const title = pages.find((page) => page.reference === identity.reference || page.reference === reference)?.title;
  return `La page « ${title ?? reference} »`;
}

export async function handleFrameRequest(
  identity: FrameIdentity,
  method: string,
  params: Params,
  /** Pousse un événement vers ce cadre (états partagés) ; absent, ces demandes sont refusées. */
  push?: FramePush,
): Promise<unknown> {
  // Le backend reçoit la page déclarée (les accords valent pour toutes ses instances) et, à part, son instance.
  const subject = {
    kind: identity.kind,
    module: identity.module,
    reference: declaredReference(identity),
    ...(identity.instance ? { instance: identity.instance } : {}),
    ...(identity.accounts && Object.keys(identity.accounts).length > 0 ? { accounts: identity.accounts } : {}),
    ...(identity.examples ? { examples: true } : {}),
  };
  switch (method) {
    case "shell.context":
      return frameContext(identity);
    // État retenu de la page (`usePageState`) : par page affichée, instance comprise.
    case "shell.state.get":
      await loadDurablePageMemory();
      return pageMemoryOf(identity.reference);
    case "shell.state.set":
      rememberPageValue(identity.reference, params.key, params.value);
      return null;
    case "shell.notify": {
      const title = String(params.title ?? "");
      const description = params.description ? String(params.description) : undefined;
      const actions = notificationActions(identity, params.actions);
      notify({
        title,
        description,
        tone: (params.tone as "info" | "success" | "warning" | "error") ?? "info",
        source: identity.reference,
        ...(actions.length ? { actions } : {}),
        ...(params.persistent ? { persistent: true } : {}),
      });
      frameServices.announce?.(description ? `${title}. ${description}` : title);
      // Alfred en arrière-plan : la notification part aussi au système (Rust vérifie le focus des fenêtres).
      await notifySystem(title, description).catch(() => false);
      return null;
    }
    // Recherche de la barre du haut (`useTopBarSearch`) : une par page affichée, jamais pour un panneau.
    case "shell.search.declare":
      if (identity.kind !== "page")
        throw new AlfredError({
          message: "La recherche de la barre du haut est réservée à une page : un panneau de droite n’en a pas.",
        });
      if (identity.capture) return { query: topBarQueryOf(identity.reference) };
      return declareTopBarSearch(identity.reference, params);
    case "shell.search.set":
      if (identity.kind === "page" && !identity.capture) setTopBarQuery(identity.reference, params.query, "page");
      return null;
    // Résumé de la barre du haut (`useTopBarSummary`) : retiré de Socle (D-253). Le message d’une page plus ancienne
    // reste accepté et ignoré.
    case "shell.summary.set":
      return null;
    // Actions de la barre du haut (`useTopBarActions`) : leur description seule ; une page, jamais un panneau.
    case "shell.actions.set":
      if (identity.kind === "page" && !identity.capture) setTopBarActions(identity.reference, params.actions);
      return null;
    case "shell.search.remove":
      if (identity.kind === "page" && !identity.capture) removeTopBarSearch(identity.reference);
      return null;
    case "badge.update":
      return invoke("frame.badges.update", {
        subject,
        page: badgeTarget(identity, params.page),
        op: params.op === "increment" ? "increment" : "set",
        value: badgeValue(params.value),
      });
    // Zone du menu de la page (`menu.*`) : Rust vérifie chaque entrée et la garde pour l’espace.
    case "menu.update":
      return invoke("frame.menuZones.update", {
        ...pick(params, ["op", "title", "order", "visible", "entries", "id", "patch"]),
        subject,
        // Les entrées d’une section créée par le module (`{ section }`) sont la zone de cette section.
        page:
          params.section !== undefined && params.section !== null
            ? sectionZone(identity.module, String(params.section))
            : badgeTarget(identity, params.page, MENU_TARGET),
      });
    // Sections créées par le module (`menu.addSection`…) : Rust les écrit dans l’espace, avec un commit.
    case "menu.sections": {
      if (identity.capture) return params.op === "list" ? [] : null;
      const page =
        params.page !== undefined && params.page !== null
          ? String(params.page)
          : params.op === "add" && identity.kind !== "function"
            ? ownPageId(identity)
            : undefined;
      return invoke("frame.menuSections.update", {
        ...pick(params, ["op", "id", "title"]),
        ...(page ? { page } : {}),
        subject,
      });
    }
    // Onglets ouverts sur un élément (`views.*`, D-021) : une page ou son panneau, jamais une fonction.
    case "views.open": {
      if (identity.kind === "function" || identity.capture)
        throw new AlfredError({ message: "Seule une page affichée ouvre un onglet." });
      const page = viewTarget(identity, params.page);
      let view: OpenedView;
      try {
        view = cleanView(params, page);
      } catch (error) {
        throw new AlfredError({ message: error instanceof Error ? error.message : String(error) });
      }
      openView(viewSection(identity), view);
      return null;
    }
    case "views.close": {
      if (identity.kind === "function" || identity.capture) return false;
      const section = viewSection(identity);
      if (params.id === undefined || params.id === null) {
        // Sans identifiant : l’onglet que montre le cadre.
        if (!identity.view) return false;
        return closeView(section, viewKey(identity.view), lastFixedTab(section));
      }
      const id = String(params.id);
      const page = params.page === undefined || params.page === null ? null : viewTarget(identity, params.page);
      // L’onglet de cet élément ouvert par une page du module, dans cette section.
      const match = (useOpenViews.getState().views[section] ?? []).find(
        (view) => view.id === id && (page ? view.page === page : view.page.startsWith(`${identity.module}/`)),
      );
      return match ? closeView(section, viewKey(match), lastFixedTab(section)) : false;
    }
    case "menu.takeActions":
      if (identity.kind !== "page" || identity.capture) return [];
      return takePendingEntryActions(identity.reference);
    case "shell.navigate":
      useShell.getState().openPage(String(params.reference ?? ""));
      return null;
    case "shell.openWindow": {
      // Sans référence, la page s’ouvre elle-même dans sa fenêtre ; une page inconnue est refusée par Rust.
      // Une page inconnue est refusée par Rust ; « journal » désigne une page du module du cadre.
      const named = params.reference ? String(params.reference) : "";
      const reference = named
        ? named.includes("/")
          ? named
          : `${identity.module}/${named}`
        : (identity.host ?? identity.reference);
      await openPageWindow(reference, windowOptions(params));
      return null;
    }
    case "shell.setPanelVisible":
      useShell.getState().setPanelVisible(identity.host ?? identity.reference, Boolean(params.visible));
      return null;
    case "shell.publish": {
      const page = identity.host ?? identity.reference;
      selections.set(page, params.selection ?? null);
      for (const listener of selectionListeners) listener(page);
      return null;
    }
    case "shell.openExternal": {
      // Une sortie vers le réseau : l’utilisateur accorde chaque hôte à la page, une fois (Rust pose la question).
      const { url } = await invoke<{ url: string }>("frame.shell.openExternal", {
        subject,
        url: String(params.url ?? ""),
      });
      await openExternal(url);
      return null;
    }
    case "shell.send": {
      // De la page vers son panneau, ou du panneau vers sa page : jamais vers un cadre du même rôle.
      for (const frame of peers.get(identity.host ?? identity.reference) ?? [])
        if (frame.kind !== identity.kind) frame.deliver(params.message ?? null);
      return null;
    }
    case "functions.call": {
      if (!frameServices.callFunction) throw new AlfredError({ message: "L’exécution des fonctions n’est pas prête." });
      const name = String(params.function ?? "");
      const reference = name.includes("/") ? name : `${identity.module}/${name}`;
      // Une fonction d’un autre module demande l’accord de l’utilisateur, mémorisé ensuite.
      await invoke("frame.functions.authorize", { subject, function: reference });
      return frameServices.callFunction(identity, reference, params.input ?? {});
    }
    // État partagé (`useAlfredState`) : la page reçoit la valeur courante tout de suite, puis chaque changement.
    case "states.watch": {
      if (!frameServices.watchState || !push)
        throw new AlfredError({ message: "Les états partagés ne sont pas prêts." });
      const watch = String(params.watch ?? "");
      const name = String(params.name ?? "");
      if (!watch || !name) throw new AlfredError({ message: "Abonnement sans identifiant ou sans nom d’état." });
      const held = watches.get(identity) ?? new Map<string, StateWatch>();
      if (!held.has(watch) && held.size >= MAX_WATCHES)
        throw new AlfredError({ message: `Une page suit au plus ${MAX_WATCHES} états à la fois.` });
      held.get(watch)?.unsubscribe();
      watches.set(identity, held);
      const text = (value: unknown) =>
        typeof value === "string" || typeof value === "number" ? String(value) : undefined;
      held.set(
        watch,
        frameServices.watchState(identity, { name, key: text(params.key), instance: text(params.instance) }, (state) =>
          push("state", { watch, state }),
        ),
      );
      return null;
    }
    case "states.refresh": {
      const held = watches.get(identity)?.get(String(params.watch ?? ""));
      if (!held) return null;
      await held.refresh().catch(() => undefined);
      return null;
    }
    case "states.unwatch": {
      const held = watches.get(identity);
      const watch = String(params.watch ?? "");
      held?.get(watch)?.unsubscribe();
      held?.delete(watch);
      return null;
    }
    // Le cœur vérifie que l’état est celui du module ou d’une dépendance, et le compte du demandeur.
    case "states.get":
      return invoke("frame.states.get", { ...pick(params, ["name", "key", "instance"]), subject });
    case "states.publish":
      return invoke("frame.states.publish", { ...pick(params, ["name", "key", "instance", "value"]), subject });
    case "ai.oneShot":
      if (!frameServices.oneShot) throw new AlfredError({ message: "L’IA n’est pas prête." });
      return frameServices.oneShot(identity, params);
    case "ai.startAgent":
      if (!frameServices.startAgent) throw new AlfredError({ message: "Les agents ne sont pas prêts." });
      return frameServices.startAgent(identity, params);
    case "ai.sendToAgent":
      if (!frameServices.sendToAgent) throw new AlfredError({ message: "Les agents ne sont pas prêts." });
      return frameServices.sendToAgent(identity, params);
    case "ai.watch":
      return invoke("frame.agents.watch", {
        ...pick(params, ["conversationId", "event", "match", "timeoutMinutes", "label"]),
        subject,
      });
    case "ai.cancelWatch":
      return invoke("frame.agents.cancelWatch", { ...pick(params, ["id"]), subject });
    case "voice.speak":
      return invoke("frame.voice.speak", { text: String(params.text ?? ""), subject });
    case "voice.stopSpeaking":
      return invoke("frame.voice.speak.stop", { subject });
    case "voice.startListening":
      return invoke("frame.voice.listen.start", { subject });
    case "voice.stopListening":
      return invoke("frame.voice.listen.stop", { subject });
    case "voice.cancelListening":
      return invoke("frame.voice.listen.cancel", { subject });
    // Les arguments sont recopiés un par un : un champ du message (`subject` en particulier) ne doit jamais
    // pouvoir remplacer ce que la coquille a fixé.
    case "db.query":
    case "db.execute":
      return invoke(`frame.${method}`, { ...pick(params, ["sql", "params"]), subject });
    case "clients.request":
      return invoke("frame.clients.request", {
        ...pick(params, [...CLIENT_CALL, "responseType", "cache", "sealed"]),
        subject,
      });
    case "clients.download":
      return invoke("frame.clients.download", { ...pick(params, [...CLIENT_CALL, "name"]), subject });
    case "clients.stream":
      return invoke("frame.clients.stream", { ...pick(params, [...CLIENT_CALL, "format"]), subject });
    case "clients.socket":
      return invoke("frame.clients.socket", {
        ...pick(params, ["client", "instance", "path", "query", "headers"]),
        subject,
      });
    // Canaux ouverts par une fonction du connecteur : la page du même module les lit et les écrit.
    // `holder` : le cadre lui-même (copie de page comprise), pour fermer ses canaux quand il disparaît.
    case "channels.read":
      return invoke("frame.channels.read", {
        ...pick(params, ["channel", "after", "wait"]),
        holder: `${identity.kind}:${identity.reference}`,
        subject,
      });
    case "channels.release":
      return invoke("frame.channels.release", { holder: `${identity.kind}:${identity.reference}`, subject });
    case "channels.write":
      return invoke("frame.channels.write", { ...pick(params, ["channel", "text", "data"]), subject });
    case "channels.close":
      return invoke("frame.channels.close", { ...pick(params, ["channel"]), subject });
    // Noyau Python du module : objets créés et appelés par la page, libérés quand son cadre se ferme (`holder`).
    case "python.create":
      return invoke("frame.python.create", {
        ...pick(params, ["class", "args", "timeout"]),
        holder: `${identity.kind}:${identity.reference}`,
        subject,
      });
    case "python.call":
      return invoke("frame.python.call", {
        ...pick(params, ["handle", "method", "args", "timeout", "channel"]),
        subject,
      });
    case "python.run":
      return invoke("frame.python.run", { ...pick(params, ["function", "args", "timeout", "channel"]), subject });
    case "python.dispose":
      return invoke("frame.python.dispose", { ...pick(params, ["handle"]), subject });
    case "python.channel":
      return invoke("frame.python.channel", { subject });
    case "python.status":
      return invoke("frame.python.status", { subject });
    case "python.release":
      return invoke("frame.python.release", { holder: `${identity.kind}:${identity.reference}`, subject });
    case "files.save":
      return invoke("frame.files.save", { ...pick(params, ["name", "data", "text", "mime"]), subject });
    case "files.list":
      return invoke("frame.files.list", { ...pick(params, ["prefix", "limit"]), subject });
    case "files.get":
    case "files.read":
    case "files.readText":
    case "files.remove":
    case "files.open":
    case "files.dataUrl":
      return invoke(`frame.${method}`, { ...pick(params, ["id"]), subject });
    case "history.list":
      return invoke("frame.history.list", { ...pick(params, ["table", "key", "limit"]), subject });
    case "history.revert":
      return invoke("frame.history.revert", { ...pick(params, ["id"]), subject });
    case "events.publish":
      return invoke("frame.events.publish", { ...pick(params, ["event", "payload", "occurrence"]), subject });
    case "commands.run":
      return invoke("frame.commands.run", { ...pick(params, ["program", "args", "input", "timeout", "cwd"]), subject });
    case "semantic.search":
      return invoke("frame.semantic.search", { ...pick(params, ["index", "text", "limit"]), subject });
    case "semantic.status":
      return invoke("frame.semantic.status", { ...pick(params, ["index"]), subject });
    case "ai.decide":
      return invoke("frame.ai.decide", {
        ...pick(params, ["text", "question", "type", "choices", "questions", "preset"]),
        subject,
      });
    case "search.query":
      return invoke("frame.search.query", {
        ...pick(params, ["index", "text", "limit", "offset", "raw", "prefix"]),
        subject,
      });
    case "jobs.start":
      return invoke("frame.jobs.start", { ...pick(params, ["function", "input", "title"]), subject });
    case "jobs.list":
      return invoke("frame.jobs.list", { ...pick(params, ["status", "limit"]), subject });
    case "jobs.get":
    case "jobs.cancel":
    case "jobs.resume":
      return invoke(`frame.${method}`, { ...pick(params, ["id"]), subject });
    case "automations.trigger":
      return invoke("frame.automations.trigger", { ...pick(params, ["id", "event"]), subject });
    case "documents.pdf":
      return invoke("frame.documents.pdf", { ...pick(params, ["name", "title", "blocks"]), subject });
    case "documents.csv":
      return invoke("frame.documents.csv", { ...pick(params, ["name", "columns", "rows", "separator"]), subject });
    case "documents.xlsx":
      return invoke("frame.documents.xlsx", { ...pick(params, ["name", "sheets"]), subject });
    case "documents.extractText":
      return invoke("frame.documents.extractText", { ...pick(params, ["id"]), subject });
    case "files.pick": {
      // Le sélecteur est montré par la coquille : la page ne nomme jamais un chemin du disque.
      if (identity.kind === "function")
        throw new AlfredError({ message: "Une fonction ne peut pas ouvrir de fenêtre : faites-le depuis une page." });
      const extensions = Array.isArray(params.accept)
        ? params.accept.map((item) => String(item).replace(/^\./, "")).filter(Boolean)
        : undefined;
      const paths = await pickFiles("Choisir un fichier", { multiple: Boolean(params.multiple), extensions });
      if (paths.length === 0) return [];
      return invoke("frame.files.importPaths", { paths, subject });
    }
    case "files.export": {
      if (identity.kind === "function")
        throw new AlfredError({ message: "Une fonction ne peut pas ouvrir de fenêtre : faites-le depuis une page." });
      const info = await invoke<{ name: string }>("frame.files.get", { ...pick(params, ["id"]), subject });
      const path = await pickSaveFile("Enregistrer le fichier", info.name);
      if (!path) return false;
      await invoke("frame.files.exportTo", { ...pick(params, ["id"]), path, subject });
      return true;
    }
    case "clients.clearCache":
      return invoke("frame.clients.clearCache", { ...pick(params, ["client"]), subject });
    case "folders.pick": {
      // Le sélecteur est montré par la coquille : choisir le dossier, c’est l’accorder au module.
      if (identity.kind === "function")
        throw new AlfredError({ message: "Une fonction ne peut pas ouvrir de fenêtre : faites-le depuis une page." });
      const path = await pickFolder(typeof params.title === "string" ? params.title : "Choisir un dossier");
      if (!path) return null;
      return invoke("frame.folders.grantPicked", { path, ...pick(params, ["label"]), subject });
    }
    case "folders.list":
      return invoke("frame.folders.list", { subject });
    case "folders.get":
    case "folders.forget":
    case "folders.watch":
      return invoke(`frame.${method}`, { ...pick(params, ["folder"]), subject });
    case "folders.entries":
      return invoke("frame.folders.entries", { ...pick(params, ["folder", "path", "recursive", "glob"]), subject });
    case "folders.stat":
    case "folders.readText":
    case "folders.readFile":
    case "folders.mkdir":
    case "folders.remove":
      return invoke(`frame.${method}`, { ...pick(params, ["folder", "path"]), subject });
    case "folders.writeText":
      return invoke("frame.folders.writeText", { ...pick(params, ["folder", "path", "text"]), subject });
    case "folders.writeFile":
      return invoke("frame.folders.writeFile", { ...pick(params, ["folder", "path", "data"]), subject });
    case "folders.rename":
      return invoke("frame.folders.rename", { ...pick(params, ["folder", "path", "to"]), subject });
    case "folders.open":
      return invoke("frame.folders.open", { ...pick(params, ["folder", "path", "app"]), subject });
    case "git.repositories":
    case "git.status":
    case "git.branches":
    case "git.tags":
    case "git.log":
    case "git.compare":
    case "git.diff":
    case "git.show":
    case "git.fetch":
    case "git.pull":
    case "git.push":
    case "git.commit":
    case "git.switch":
    case "git.createTag":
    case "git.clone":
      return invoke(`frame.${method}`, {
        ...pick(params, [
          "folder",
          "repo",
          "ref",
          "file",
          "since",
          "limit",
          "base",
          "head",
          "from",
          "to",
          "staged",
          "remote",
          "rebase",
          "branch",
          "tag",
          "message",
          "paths",
          "create",
          "start",
          "name",
          "url",
          "path",
        ]),
        subject,
      });
    case "clients.instances":
      return invoke("frame.clients.instances", { ...pick(params, ["client"]), subject });
    case "clients.params":
      return invoke("frame.clients.params", { ...pick(params, ["client", "instance"]), subject });
    // Valeurs scellées : la page ne reçoit jamais la valeur. La coquille l’affiche dans sa propre boîte, ou fait
    // choisir où écrire le `.env` ; une fonction n’a ni l’une ni l’autre.
    case "secrets.reveal": {
      if (identity.kind === "function")
        throw new AlfredError({ message: "Une fonction n’affiche pas de secret : sa page appelle secrets.reveal." });
      const shown = await requestReveal({
        subject,
        ref: String(params.ref ?? ""),
        label: typeof params.label === "string" ? params.label : undefined,
        from: pageTitle(identity),
      });
      return { shown };
    }
    case "secrets.writeEnvFile": {
      if (identity.kind === "function")
        throw new AlfredError({ message: "Une fonction n’écrit pas de .env : sa page appelle secrets.writeEnvFile." });
      const name = typeof params.name === "string" && params.name ? params.name : ".env";
      const path = await pickSaveFile("Enregistrer les variables d’environnement", name);
      if (!path) return { saved: false };
      const result = await invoke<{ written: number }>("secrets.writeEnvFile", {
        subject,
        path,
        entries: params.entries,
      });
      return { saved: true, written: result.written };
    }
    default:
      throw new AlfredError({ message: `Appel inconnu : ${method}` });
  }
}
