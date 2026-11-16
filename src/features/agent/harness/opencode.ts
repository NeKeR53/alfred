/**
 * Harnais OpenCode : `opencode acp` (Agent Client Protocol). Repris de OneApp ; les demandes d’autorisation
 * remontent à l’utilisateur, sauf en autonomie totale où la première option d’accord est choisie.
 */
import { contentFiles } from "../lib/contentFiles";
import { checkOpenCodeConfig, probe, spawnProcess } from "./process";
import { AgentProtocol, object, type RpcMessage } from "./rpc";
import type {
  ActivityAction,
  ActivityKind,
  ApprovalRequest,
  Autonomy,
  HarnessEvent,
  HarnessModel,
  HarnessSession,
  InputFile,
  SessionOptions,
} from "./types";
import { messageText } from "./types";

const CLIENT = { name: "alfred", version: "0.1.0" };
const TOKEN = "__ALFRED_MCP_TOKEN__";

/** Adresse `file://` d’un chemin local, y compris un chemin Windows. */
export function localFileUri(path: string): string {
  const normalized = path.replace(/\\/g, "/");
  const absolute = /^[A-Za-z]:\//.test(normalized) ? `/${normalized}` : normalized;
  return `file://${absolute
    .split("/")
    .map(encodeURIComponent)
    .join("/")
    .replace(/^\/([A-Za-z])%3A/, "/$1:")}`;
}

/** Bloc ACP de chaque fichier joint : OpenCode le lit lui-même, image comprise. */
function acpPrompt(text: string, files: readonly InputFile[] = []) {
  return [
    { type: "text", text: messageText(text, files) },
    ...files.map(({ path, name, mimeType }) => ({
      type: "resource_link",
      uri: localFileUri(path),
      name,
      ...(mimeType ? { mimeType } : {}),
    })),
  ];
}

function configOptions(value: unknown) {
  const options = object(value).configOptions;
  return Array.isArray(options) ? options.map(object) : [];
}

function optionValues(value: unknown): Array<{ id: string; name: string }> {
  if (!Array.isArray(value)) return [];
  return value.flatMap((raw) => {
    const item = object(raw);
    if (Array.isArray(item.options)) return optionValues(item.options);
    return typeof item.value === "string" ? [{ id: item.value, name: String(item.name ?? item.value) }] : [];
  });
}

type PermissionRule = { action: string; resource: string; effect: "allow" | "ask" | "deny" };
const rule = (action: string, effect: PermissionRule["effect"]): PermissionRule => ({ action, resource: "*", effect });

/** Outils qui écrivent, lancent une commande ou sortent du dossier : refusés à un appel unique. */
const WRITING_TOOLS = ["edit", "write", "shell", "external_directory", "webfetch", "websearch", "subagent"];

/**
 * Règles d’autorisation d’OpenCode pour une autonomie. OpenCode applique la dernière règle qui correspond, après
 * celles de son agent, qui autorisent tout par défaut : sans règle, il écrit et lance des commandes sans demander.
 * Sans outils (appel unique), les outils d’écriture sont refusés : personne ne répondrait à une demande d’accord.
 * Jamais de refus global « * » : il couperait aussi l’accès au fournisseur du modèle (`provider.free-limit`).
 */
export function openCodePermissions(autonomy: Autonomy, tools: boolean, alfred: boolean): PermissionRule[] {
  if (!tools) return WRITING_TOOLS.map((action) => rule(action, "deny"));
  const rules =
    autonomy === "auto"
      ? []
      : autonomy === "strict"
        ? ["edit", "write", "shell", "external_directory"].map((action) => rule(action, "ask"))
        : [rule("external_directory", "ask")];
  return alfred ? [...rules, rule("alfred_*", "allow")] : rules;
}

/** Nom des actions d’Alfred dans les règles « permission » d’OpenCode 1 (un objet, et non une liste). */
const V1_ACTIONS: Record<string, string> = {
  edit: "edit",
  write: "edit",
  shell: "bash",
  external_directory: "external_directory",
  webfetch: "webfetch",
  websearch: "websearch",
  subagent: "task",
};

/**
 * OpenCode 1 et 2 n’ont pas le même contrat de configuration, comme le gère OneApp : une configuration écrite pour
 * la version 2 empêche OpenCode 1 (celui que npm installe, notamment sous Windows) de répondre. La version est lue
 * une fois par chargement ; illisible, la version 2 est supposée.
 */
let openCodeMajor: Promise<number> | undefined;
export function openCodeVersion(): Promise<number> {
  openCodeMajor ??= Promise.resolve()
    .then(() => probe("opencode"))
    .then((result) => Number(/(\d+)\.\d+/.exec(result?.version ?? "")?.[1] ?? 2))
    .catch(() => 2);
  return openCodeMajor;
}

/**
 * Configuration propre à la session, passée par l’environnement : elle déclare les outils d’Alfred et les règles
 * d’autorisation sans toucher aux fichiers de l’utilisateur. Le jeton y est un marqueur que Rust remplace au
 * lancement.
 */
export function openCodeSessionConfig(
  toolsUrl: string | undefined,
  instructionsFile?: string,
  autonomy: Autonomy = "ask",
  tools = true,
  version = 2,
) {
  const config: Record<string, unknown> = {};
  const permissions = openCodePermissions(autonomy, tools, Boolean(toolsUrl));
  const alfred = {
    type: "remote",
    url: toolsUrl,
    oauth: false,
    headers: { Authorization: `Bearer ${TOKEN}` },
  };
  if (version < 2) {
    if (permissions.length)
      config.permission = Object.fromEntries(
        permissions.map(({ action, effect }) => [V1_ACTIONS[action] ?? action, effect]),
      );
    if (toolsUrl) config.mcp = { alfred: { ...alfred, enabled: true } };
  } else {
    if (permissions.length) config.permissions = permissions;
    if (toolsUrl) config.mcp = { servers: { alfred: { ...alfred, codemode: false, disabled: false } } };
  }
  if (instructionsFile) config.instructions = [instructionsFile];
  return JSON.stringify(config);
}

/**
 * Vérifie, comme OneApp avant chaque lancement, que la configuration de l’utilisateur se lit : sans quoi une
 * configuration refusée n’apparaît qu’à l’arrêt d’OpenCode. OpenCode 2 en liste les sources, OpenCode 1 la fusionne.
 */
export async function verifyOpenCodeConfig(cwd: string): Promise<void> {
  const inspected = await checkOpenCodeConfig(cwd);
  if (inspected.code !== 0) {
    const detail = inspected.stderr.trim().split("\n").at(-1)?.trim();
    throw new Error(
      `Impossible de vérifier la configuration OpenCode avant le lancement${detail ? ` : ${detail}` : ""}.`,
    );
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(inspected.stdout);
  } catch {
    throw new Error("La configuration OpenCode ne peut pas être vérifiée.");
  }
  const documents = Array.isArray(parsed) ? parsed.map(object).filter((source) => source.type === "document") : [];
  if (
    !parsed ||
    typeof parsed !== "object" ||
    documents.some((source) => !source.info || typeof source.info !== "object")
  )
    throw new Error("La configuration OpenCode ne peut pas être vérifiée.");
}

async function initialize(rpc: AgentProtocol, cwd: string, resumeSessionId?: string) {
  const initialized = object(
    await rpc.request("initialize", { protocolVersion: 1, clientCapabilities: {}, clientInfo: CLIENT }),
  );
  const capabilities = object(initialized.agentCapabilities);
  // Reprise : OpenCode garde l’historique de la session, Alfred ne le renvoie pas.
  const session = object(
    await rpc.request(resumeSessionId ? "session/resume" : "session/new", {
      ...(resumeSessionId ? { sessionId: resumeSessionId } : {}),
      cwd,
      mcpServers: [],
    }),
  );
  if (resumeSessionId) session.sessionId = resumeSessionId;
  return { session, canDelete: "delete" in object(capabilities.sessionCapabilities) };
}

/**
 * Convertit les mises à jour ACP d’OpenCode en événements d’Alfred, en direct comme à la relecture d’une session.
 * `nextTurn` sépare les messages d’un tour à l’autre ; `endTurn` termine la réflexion et le plan restés ouverts.
 */
function acpUpdateMapper(emit: (event: HarnessEvent) => void) {
  let chunkId = 0;
  let imageCount = 0;
  const tools = new Map<string, AcpTool>();
  /** Réflexions et plan affichés en cours : ACP n’en annonce pas la fin, elle se déduit de la suite du tour. */
  const open = new Map<string, string>();
  const settle = (only?: string) => {
    for (const [itemId, title] of open)
      if (!only || itemId === only) {
        emit({ type: "activity", itemId, kind: "analysis", title, status: "completed" });
        open.delete(itemId);
      }
  };
  return {
    nextTurn() {
      chunkId++;
    },
    endTurn() {
      settle();
    },
    map(update: Record<string, unknown>) {
      const kind = update.sessionUpdate;
      // La réflexion s’arrête dès que l’agent passe à autre chose.
      if (kind !== "agent_thought_chunk") settle(`analysis-${chunkId}`);
      if (kind === "agent_message_chunk") {
        const { images, files } = contentFiles(update.content);
        // Une image ou un fichier envoyé dans la réponse s’affiche avec ceux du tour.
        if (images.length || files.length)
          emit({
            type: "activity",
            itemId: `image-${chunkId}-${++imageCount}`,
            kind: "tool",
            title: images.length ? "Image de l’agent" : "Fichier de l’agent",
            ...(images.length ? { images } : {}),
            ...(files.length ? { files } : {}),
            status: "completed",
          });
        else
          emit({ type: "message", itemId: `message-${chunkId}`, content: String(object(update.content).text ?? "") });
      }
      if (kind === "agent_thought_chunk") {
        const itemId = `analysis-${chunkId}`;
        if (!open.has(itemId)) {
          open.set(itemId, "Analyse");
          emit({ type: "activity", itemId, kind: "analysis", title: "Analyse", status: "running" });
        }
        emit({ type: "activityDelta", itemId, content: String(object(update.content).text ?? "") });
      }
      if (kind === "tool_call" || kind === "tool_call_update") {
        chunkId++;
        const itemId = String(update.toolCallId);
        const tool = tools.get(itemId) ?? { input: {}, paths: [] };
        if (typeof update.kind === "string") tool.kind = update.kind;
        if (typeof update.title === "string") tool.title = update.title;
        if (update.rawInput && typeof update.rawInput === "object")
          tool.input = { ...tool.input, ...object(update.rawInput) };
        if (Array.isArray(update.locations))
          for (const location of update.locations.map(object))
            if (typeof location.path === "string" && !tool.paths.includes(location.path))
              tool.paths.push(location.path);
        tools.set(itemId, tool);
        const { images, files, content } = contentFiles(update.content, update.locations);
        emit({
          type: "activity",
          itemId,
          ...acpActivity(tool, content),
          ...(images.length ? { images } : {}),
          ...(files.length ? { files } : {}),
          status: update.status === "completed" ? "completed" : update.status === "failed" ? "failed" : "running",
        });
      }
      if (kind === "plan") {
        open.set("plan", "Plan");
        emit({
          type: "activity",
          itemId: "plan",
          kind: "analysis",
          title: "Plan",
          content: JSON.stringify(update.entries, null, 2),
          status: "running",
        });
      }
    },
  };
}

/** Champs d’entrée ACP utiles à l’affichage, quel que soit l’outil OpenCode. */
function inputText(input: Record<string, unknown>, ...keys: string[]) {
  for (const key of keys) if (typeof input[key] === "string" && input[key]) return String(input[key]);
  return undefined;
}

function changedLines(oldText: string, newText: string) {
  const counts = new Map<string, number>();
  for (const line of oldText ? oldText.split("\n") : []) counts.set(line, (counts.get(line) ?? 0) + 1);
  let added = 0;
  for (const line of newText ? newText.split("\n") : []) {
    const count = counts.get(line) ?? 0;
    if (count) counts.set(line, count - 1);
    else added++;
  }
  return { added, removed: [...counts.values()].reduce((total, count) => total + count, 0) };
}

type AcpTool = { kind?: string; title?: string; input: Record<string, unknown>; paths: string[] };

/**
 * Activité typée d’un appel d’outil ACP, au même niveau que Codex : commande, lecture et recherche (actions
 * read/search/listFiles), modification de fichiers (lignes ajoutées et retirées), recherche web et analyse.
 */
function acpActivity(
  tool: AcpTool,
  content: unknown,
): {
  kind: ActivityKind;
  title: string;
  detail?: string;
  actions?: ActivityAction[];
  content?: string;
} {
  const path = inputText(tool.input, "filePath", "file_path", "path") ?? tool.paths[0];
  const blocks = Array.isArray(content) ? content.map(object) : [];
  const text = blocks
    .map((block) => object(block.content))
    .filter((block) => block.type === "text" && typeof block.text === "string")
    .map((block) => String(block.text))
    .join("\n");
  const serializedContent = text || (content === undefined ? undefined : JSON.stringify(content, null, 2));
  if (tool.kind === "execute")
    return {
      kind: "command",
      title: "Commande",
      detail: inputText(tool.input, "command", "cmd") ?? tool.title,
      actions: [],
      content: serializedContent,
    };
  if (tool.kind === "read")
    return {
      kind: "command",
      title: "Lecture",
      detail: path ?? tool.title,
      // L’outil `read` d’OpenCode lit aussi un dossier : sa sortie commence alors par « Read directory ».
      actions: [
        {
          type: tool.title === "list" || /^Read directory\b/.test(text) ? "listFiles" : "read",
          ...(path ? { path } : {}),
        },
      ],
      content: serializedContent,
    };
  if (tool.kind === "search") {
    const query = inputText(tool.input, "pattern", "query");
    const searchPath = inputText(tool.input, "path");
    return {
      kind: "command",
      title: "Recherche",
      detail: [query, searchPath].filter(Boolean).join(" · ") || tool.title,
      actions: [
        {
          type: tool.title === "glob" ? "listFiles" : "search",
          ...(query ? { query } : {}),
          ...(searchPath ? { path: searchPath } : {}),
        },
      ],
      content: serializedContent,
    };
  }
  if (tool.kind === "edit" || tool.kind === "delete" || tool.kind === "move") {
    const diffs = blocks.filter((block) => block.type === "diff" && typeof block.path === "string");
    const actions: ActivityAction[] = diffs.length
      ? diffs.map((diff) => ({
          type: "edit",
          path: String(diff.path),
          ...changedLines(typeof diff.oldText === "string" ? diff.oldText : "", String(diff.newText ?? "")),
        }))
      : [...new Set([...(path ? [path] : []), ...tool.paths])].map((changed) => ({
          type: "edit",
          path: changed,
          // L’outil `write` ne renvoie pas de diff : son contenu complet est dans l’entrée.
          ...(typeof tool.input.content === "string" && changed === path
            ? changedLines("", String(tool.input.content).replace(/\n$/, ""))
            : {}),
        }));
    return {
      kind: "file",
      title: "Modification de fichiers",
      detail: actions.map(({ path: changed }) => changed).join("\n") || undefined,
      actions,
    };
  }
  if (tool.kind === "fetch")
    return {
      kind: "search",
      title: "Recherche web",
      detail: inputText(tool.input, "url", "query") ?? tool.title,
      content: serializedContent,
    };
  if (tool.kind === "think") return { kind: "analysis", title: "Analyse", content: serializedContent };
  // Mode code d’OpenCode : l’outil `execute` lance un script qui appelle d’autres outils.
  if (tool.title === "execute" && typeof tool.input.code === "string")
    return {
      kind: "command",
      title: "Script d’outils",
      detail: String(tool.input.code),
      actions: [],
      content: serializedContent,
    };
  return {
    kind: "tool",
    title: tool.title ? `Outil · ${tool.title}` : "Outil",
    detail: Object.keys(tool.input).length ? JSON.stringify(tool.input, null, 2) : undefined,
    content: serializedContent,
  };
}

const OPTION_LABEL = { allow: "Autoriser", allowAlways: "Toujours autoriser", deny: "Refuser" } as const;

/** Carte d’accord d’une demande ACP : titre et détail en français, d’après l’outil plutôt que son libellé brut. */
function approvalFor(id: string, toolCall: Record<string, unknown>, rawOptions: Record<string, unknown>[]) {
  const input = object(toolCall.rawInput);
  const name = typeof toolCall.name === "string" ? toolCall.name : undefined;
  const locations = Array.isArray(toolCall.locations) ? toolCall.locations.map(object) : [];
  const path = inputText(input, "filePath", "file_path", "path") ?? locations.map((l) => l.path).find(Boolean);
  const command = inputText(input, "command", "cmd");
  const title =
    toolCall.kind === "execute" || command
      ? "Exécuter une commande"
      : toolCall.kind === "edit" || toolCall.kind === "delete" || toolCall.kind === "move"
        ? "Modifier un fichier"
        : toolCall.kind === "fetch"
          ? "Accéder au web"
          : name
            ? `Utiliser l’outil ${name}`
            : String(toolCall.title ?? "Autorisation demandée par OpenCode");
  const options = rawOptions
    .filter((option) => typeof option.optionId === "string")
    .map((option) => {
      const kind =
        option.kind === "allow_always"
          ? ("allowAlways" as const)
          : option.kind === "allow_once"
            ? ("allow" as const)
            : ("deny" as const);
      return { id: String(option.optionId), label: OPTION_LABEL[kind], kind };
    });
  const request: ApprovalRequest = {
    id,
    title,
    detail:
      command ??
      (typeof path === "string" ? path : undefined) ??
      (Object.keys(input).length ? JSON.stringify(input, null, 2) : undefined),
    options,
  };
  return request;
}

export interface OpenCodeOptions extends Omit<SessionOptions, "provider"> {
  /** Session supprimée de l’historique d’OpenCode à la fermeture, pour les appels uniques. */
  ephemeral?: boolean;
  /** Appel unique : tout outil est refusé, faute de quelqu’un pour répondre à une demande d’accord. */
  withoutTools?: boolean;
  /** Fichier qui porte les consignes d’Alfred : OpenCode lit des chemins, pas du texte. */
  instructionsFile?: string;
}

export async function createOpenCodeSession(options: OpenCodeOptions): Promise<HarnessSession> {
  const emit = options.onEvent;
  let sessionId = "";
  let closed = false;
  let running = false;
  const updates = acpUpdateMapper(emit);
  const permissions = new Map<string, { rpcId: number | string; options: string[] }>();

  const onMessage = (message: RpcMessage) => {
    const params = message.params ?? {};
    if (message.method === "session/request_permission" && message.id !== undefined) {
      const raw = Array.isArray(params.options) ? params.options.map(object) : [];
      const id = `opencode-${String(message.id)}`;
      const request = approvalFor(id, object(params.toolCall), raw);
      const choices = request.options;
      const allow =
        choices.find((choice) => choice.kind === "allow") ?? choices.find((choice) => choice.kind === "allowAlways");
      if (options.autonomy === "auto" && allow) {
        void rpc
          .write({ id: message.id, result: { outcome: { outcome: "selected", optionId: allow.id } } })
          .catch(() => undefined);
        return;
      }
      permissions.set(id, { rpcId: message.id, options: choices.map((choice) => choice.id) });
      emit({ type: "approval", request });
      return;
    }
    if (message.id !== undefined && message.method) {
      void rpc
        .write({ id: message.id, error: { code: -32601, message: "Méthode client non prise en charge." } })
        .catch(() => undefined);
      return;
    }
    if (message.method !== "session/update" || params.sessionId !== sessionId) return;
    updates.map(object(params.update));
  };

  await verifyOpenCodeConfig(options.cwd);
  const process = await spawnProcess("opencode", {
    cwd: options.cwd,
    ...(options.conversation ? { conversation: options.conversation } : {}),
    opencodeConfig: openCodeSessionConfig(
      options.conversation ? options.toolsUrl : undefined,
      options.instructionsFile,
      options.autonomy,
      !options.withoutTools,
      await openCodeVersion(),
    ),
    // Comme OneApp, les consignes passent par un fichier d’instructions : OpenCode lit des chemins, pas du texte.
    ...(options.instructions?.trim() ? { opencodeInstructions: options.instructions } : {}),
  });
  // Fin de la sortie d’erreur du CLI : sa dernière ligne dit pourquoi il s’est arrêté.
  let stderr = "";
  process.onStderr((chunk) => {
    stderr = (stderr + chunk).slice(-2000);
  });
  const rpc = new AgentProtocol(process, onMessage, () => {
    if (closed) return;
    closed = true;
    updates.endTurn();
    const detail = stderr.trim().split("\n").at(-1)?.trim();
    emit({
      type: "error",
      message: `OpenCode s’est arrêté${detail ? ` : ${detail}` : ""}. Envoyer un message relance la conversation.`,
    });
    emit({ type: "status", status: "closed" });
  });
  let canDelete = false;
  try {
    emit({ type: "status", status: "connecting" });
    const opened = await initialize(rpc, options.cwd, options.resumeSessionId);
    canDelete = opened.canDelete;
    if (typeof opened.session.sessionId !== "string") throw new Error("OpenCode n’a pas créé de session.");
    sessionId = opened.session.sessionId;
    emit({ type: "session", sessionId });
    const modelOption = configOptions(opened.session).find((option) => option.category === "model");
    if (options.model) {
      // Comme OneApp : un modèle choisi qu’OpenCode ne permet pas de régler est un échec, pas un repli silencieux.
      if (!modelOption) throw new Error("Mettez OpenCode à jour pour sélectionner le modèle via ACP.");
      const updated = await rpc.request("session/set_config_option", {
        sessionId,
        configId: modelOption.id,
        value: options.model,
      });
      if (options.effort) {
        const effort = configOptions(updated).find((option) => option.category === "thought_level");
        if (!effort || !optionValues(effort.options).some(({ id }) => id === options.effort))
          throw new Error("Ce niveau de raisonnement n’est plus disponible pour le modèle OpenCode.");
        await rpc.request("session/set_config_option", { sessionId, configId: effort.id, value: options.effort });
      }
    }
    emit({ type: "status", status: "ready" });
  } catch (cause) {
    closed = true;
    await rpc.close();
    throw cause;
  }

  const closeApprovals = () => {
    for (const id of permissions.keys()) emit({ type: "approvalClosed", id });
    permissions.clear();
  };

  return {
    sessionId,
    async send(text, files) {
      if (closed || running) throw new Error("La session est fermée ou prépare déjà une réponse.");
      running = true;
      updates.nextTurn();
      emit({ type: "status", status: "responding" });
      try {
        const result = object(await rpc.request("session/prompt", { sessionId, prompt: acpPrompt(text, files) }, 0));
        if (result.stopReason === "refusal") throw new Error("OpenCode a refusé la demande.");
      } catch (cause) {
        if (!closed)
          emit({
            type: "error",
            message: cause instanceof Error ? cause.message : "OpenCode n’a pas terminé la réponse.",
          });
      } finally {
        running = false;
        updates.endTurn();
        closeApprovals();
        if (!closed) emit({ type: "status", status: "idle" });
      }
    },
    async answer(id, optionId) {
      const permission = permissions.get(id);
      if (!permission?.options.includes(optionId)) throw new Error("Cette demande d’accord n’est plus en attente.");
      permissions.delete(id);
      await rpc.write({ id: permission.rpcId, result: { outcome: { outcome: "selected", optionId } } });
    },
    async cancel() {
      for (const permission of permissions.values())
        await rpc.write({ id: permission.rpcId, result: { outcome: { outcome: "cancelled" } } });
      closeApprovals();
      await rpc.write({ method: "session/cancel", params: { sessionId } });
    },
    async close() {
      if (closed) return;
      closed = true;
      if (options.ephemeral && canDelete)
        await rpc.request("session/delete", { sessionId }, 5_000).catch(() => undefined);
      await rpc.close();
      emit({ type: "status", status: "closed" });
    },
  };
}

/** Catalogue des modèles du CLI installé, sans appel au modèle. */
export async function listOpenCodeModels(cwd: string): Promise<HarnessModel[]> {
  const rpc = new AgentProtocol(
    await spawnProcess("opencode", { cwd }),
    () => undefined,
    () => undefined,
  );
  try {
    const { session, canDelete } = await initialize(rpc, cwd);
    const modelOption = configOptions(session).find((option) => option.category === "model");
    const models: HarnessModel[] = [];
    if (modelOption) {
      for (const model of optionValues(modelOption.options)) {
        const updated = await rpc.request("session/set_config_option", {
          sessionId: session.sessionId,
          configId: modelOption.id,
          value: model.id,
        });
        const effort = configOptions(updated).find((option) => option.category === "thought_level");
        // « default » d’OpenCode est l’effort par défaut du modèle, qu’Alfred propose déjà.
        const efforts = optionValues(effort?.options).map(({ id }) => id);
        models.push({ ...model, efforts: efforts.filter((id) => id !== "default") });
      }
    }
    if (!models.length)
      throw new Error("Cette version d’OpenCode ne fournit pas de catalogue ACP. Mettez le CLI à jour.");
    // La session ouverte pour lire le catalogue n’a pas sa place dans l’historique d’OpenCode.
    if (canDelete && typeof session.sessionId === "string")
      await rpc.request("session/delete", { sessionId: session.sessionId }).catch(() => undefined);
    return models;
  } finally {
    await rpc.close();
  }
}
