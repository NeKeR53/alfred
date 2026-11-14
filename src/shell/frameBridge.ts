/**
 * Traite les demandes d’un cadre isolé. L’identité du demandeur (module, page) est fixée par la coquille à partir
 * du cadre qui a émis le message, jamais par le contenu du message : une page ne peut pas se faire passer pour une
 * autre.
 */
import { AlfredError, invoke, openExternal, openPageWindow } from "../lib/native";
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
    case "shell.notify":
      notify({
        title: String(params.title ?? ""),
        description: params.description ? String(params.description) : undefined,
        tone: (params.tone as "info" | "success" | "warning" | "error") ?? "info",
        source: identity.reference,
      });
      return null;
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
    // Les arguments sont recopiés un par un : un champ du message (`subject` en particulier) ne doit jamais
    // pouvoir remplacer ce que la coquille a fixé.
    case "db.query":
    case "db.execute":
      return invoke(`frame.${method}`, { ...pick(params, ["sql", "params"]), subject });
    case "clients.request":
      return invoke("frame.clients.request", {
        ...pick(params, ["client", "instance", "method", "path", "query", "headers", "body"]),
        subject,
      });
    case "clients.instances":
      return invoke("frame.clients.instances", { ...pick(params, ["client"]), subject });
    default:
      throw new AlfredError({ message: `Appel inconnu : ${method}` });
  }
}
