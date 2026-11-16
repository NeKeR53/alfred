/**
 * Traite les demandes d’un cadre isolé. L’identité du demandeur (module, page) est fixée par la coquille à partir
 * du cadre qui a émis le message, jamais par le contenu du message : une page ne peut pas se faire passer pour une
 * autre.
 */
import {
  AlfredError,
  invoke,
  notifySystem,
  openExternal,
  openPageWindow,
  pickFiles,
  pickSaveFile,
} from "../lib/native";
import { isKnownPage } from "./badges";
import { notify } from "./notifications";
import { useShell } from "./store";

export interface FrameIdentity {
  kind: "page" | "panel" | "function";
  module: string;
  /** `module/page` ou `module/fonction`. */
  reference: string;
  /** Pour un panneau : la page hôte. */
  host?: string;
  /** Instance du client que montre la page (section par instance) ; `reference` porte alors `@instance`. */
  instance?: string;
}

/** Référence déclarée de la page, sans l’instance qu’elle montre. */
export function declaredReference(identity: FrameIdentity): string {
  return identity.instance ? identity.reference.replace(new RegExp(`@${identity.instance}$`), "") : identity.reference;
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

export function frameContext(identity: FrameIdentity) {
  const { theme, snapshot } = useShell.getState();
  const reference = declaredReference(identity);
  const [module, page] = reference.split("/");
  return {
    reference,
    module,
    page,
    instance: identity.instance ?? null,
    kind: identity.kind,
    surface: snapshot?.settingsPages.some((page) => page.reference === identity.reference) ? "settings" : "section",
    theme,
    accent: snapshot?.accent ?? null,
    selection: identity.host ? selectionOf(identity.host) : null,
  };
}

type Params = Record<string, unknown>;

/** Garde de `params` les seuls champs nommés, et seulement ceux qui sont présents. */
function pick(params: Params, names: readonly string[]): Params {
  const picked: Params = {};
  for (const name of names) if (Object.hasOwn(params, name)) picked[name] = params[name];
  return picked;
}

/** Appels que d’autres parties de la coquille fournissent (exécution des fonctions, agents). */
export const frameServices: {
  callFunction?: (identity: FrameIdentity, reference: string, input: unknown) => Promise<unknown>;
  startAgent?: (identity: FrameIdentity, options: Params) => Promise<unknown>;
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

/** Un cadre qui disparaît (changement d’onglet, fermeture) ne laisse pas le micro ouvert derrière lui. */
export function releaseFrame(identity: FrameIdentity) {
  void handleFrameRequest(identity, "voice.cancelListening", {}).catch(() => undefined);
}

/**
 * Page dont un cadre règle le compteur : la sienne (un panneau, celle de sa page), ou une autre page de son module
 * nommée par `page` (« boite », ou « boite@instance »). Une fonction doit toujours nommer la page.
 */
function badgeTarget(identity: FrameIdentity, page: unknown): string {
  let reference: string;
  if (typeof page === "string" && page) {
    const named = `${identity.module}/${page}`;
    // Depuis une section par instance, une page sœur sans instance nommée est celle de la même instance.
    const sibling = identity.instance && !page.includes("@") ? `${named}@${identity.instance}` : named;
    reference = isKnownPage(useShell.getState().snapshot, sibling) ? sibling : named;
  } else if (identity.kind === "function") {
    throw new AlfredError({
      message: 'Une fonction règle le compteur d’une page nommée : badge.set(3, { page: "boite" }).',
    });
  } else {
    reference = identity.host ?? identity.reference;
  }
  if (!isKnownPage(useShell.getState().snapshot, reference))
    throw new AlfredError({ message: `Compteur refusé : la page « ${reference} » n’existe pas dans l’espace.` });
  return reference;
}

function badgeValue(value: unknown): number {
  const number = typeof value === "number" ? value : Number(value);
  if (!Number.isFinite(number)) throw new AlfredError({ message: "Le compteur attend un nombre." });
  return Math.trunc(number);
}

export async function handleFrameRequest(identity: FrameIdentity, method: string, params: Params): Promise<unknown> {
  // Le backend reçoit la page déclarée (les accords valent pour toutes ses instances) et, à part, son instance.
  const subject = {
    kind: identity.kind,
    module: identity.module,
    reference: declaredReference(identity),
    ...(identity.instance ? { instance: identity.instance } : {}),
  };
  switch (method) {
    case "shell.context":
      return frameContext(identity);
    case "shell.notify": {
      const title = String(params.title ?? "");
      const description = params.description ? String(params.description) : undefined;
      notify({
        title,
        description,
        tone: (params.tone as "info" | "success" | "warning" | "error") ?? "info",
        source: identity.reference,
      });
      frameServices.announce?.(description ? `${title}. ${description}` : title);
      // Alfred en arrière-plan : la notification part aussi au système (Rust vérifie le focus des fenêtres).
      await notifySystem(title, description).catch(() => false);
      return null;
    }
    case "badge.update":
      return invoke("frame.badges.update", {
        subject,
        page: badgeTarget(identity, params.page),
        op: params.op === "increment" ? "increment" : "set",
        value: badgeValue(params.value),
      });
    case "shell.navigate":
      useShell.getState().openPage(String(params.reference ?? ""));
      return null;
    case "shell.openWindow": {
      // Sans référence, la page s’ouvre elle-même dans sa fenêtre ; une page inconnue est refusée par Rust.
      const reference = params.reference ? String(params.reference) : (identity.host ?? identity.reference);
      await openPageWindow(reference);
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
    case "ai.oneShot":
      if (!frameServices.oneShot) throw new AlfredError({ message: "L’IA n’est pas prête." });
      return frameServices.oneShot(identity, params);
    case "ai.startAgent":
      if (!frameServices.startAgent) throw new AlfredError({ message: "Les agents ne sont pas prêts." });
      return frameServices.startAgent(identity, params);
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
        ...pick(params, ["client", "instance", "method", "path", "query", "headers", "body", "cache"]),
        subject,
      });
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
    case "events.publish":
      return invoke("frame.events.publish", { ...pick(params, ["event", "payload"]), subject });
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
    case "clients.instances":
      return invoke("frame.clients.instances", { ...pick(params, ["client"]), subject });
    default:
      throw new AlfredError({ message: `Appel inconnu : ${method}` });
  }
}
