/**
 * Harnais OpenCode : `opencode acp` (Agent Client Protocol). Repris de OneApp ; les demandes d’autorisation
 * remontent à l’utilisateur, sauf en autonomie totale où la première option d’accord est choisie.
 */
import { contentFiles } from "../lib/contentFiles";
import { spawnProcess } from "./process";
import { AgentProtocol, object, type RpcMessage } from "./rpc";
import type {
  ActivityAction,
  ActivityKind,
  HarnessEvent,
  HarnessModel,
  HarnessSession,
  InputFile,
  SessionOptions,
} from "./types";

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
    { type: "text", text },
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

/**
 * Configuration propre à la session, passée par l’environnement : elle déclare les outils d’Alfred sans toucher
 * aux fichiers de l’utilisateur. Le jeton y est un marqueur que Rust remplace au lancement.
 */
export function openCodeSessionConfig(toolsUrl: string | undefined, instructionsFile?: string) {
  const config: Record<string, unknown> = {};
  if (toolsUrl) {
    config.mcp = {
      servers: {
        alfred: {
          type: "remote",
          url: toolsUrl,
          oauth: false,
          codemode: false,
          disabled: false,
          headers: { Authorization: `Bearer ${TOKEN}` },
        },
      },
    };
    config.permissions = [{ action: "alfred_*", resource: "*", effect: "allow" }];
  }
  if (instructionsFile) config.instructions = [instructionsFile];
  return JSON.stringify(config);
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
      actions: [{ type: tool.title === "list" ? "listFiles" : "read", ...(path ? { path } : {}) }],
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
      : [...new Set([...(path ? [path] : []), ...tool.paths])].map((changed) => ({ type: "edit", path: changed }));
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
  return {
    kind: "tool",
    title: tool.title ? `Outil · ${tool.title}` : "Outil",
    detail: Object.keys(tool.input).length ? JSON.stringify(tool.input, null, 2) : undefined,
    content: serializedContent,
  };
}

export interface OpenCodeOptions extends Omit<SessionOptions, "provider"> {
  /** Session supprimée de l’historique d’OpenCode à la fermeture, pour les appels uniques. */
  ephemeral?: boolean;
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
      const choices = raw
        .filter((option) => typeof option.optionId === "string")
        .map((option) => ({
          id: String(option.optionId),
          label: String(option.name ?? option.kind),
          kind:
            option.kind === "allow_always"
              ? ("allowAlways" as const)
              : option.kind === "allow_once"
                ? ("allow" as const)
                : ("deny" as const),
        }));
      const allow =
        choices.find((choice) => choice.kind === "allow") ?? choices.find((choice) => choice.kind === "allowAlways");
      if (options.autonomy === "auto" && allow) {
        void rpc
          .write({ id: message.id, result: { outcome: { outcome: "selected", optionId: allow.id } } })
          .catch(() => undefined);
        return;
      }
      const id = `opencode-${String(message.id)}`;
      permissions.set(id, { rpcId: message.id, options: choices.map((choice) => choice.id) });
      const tool = object(params.toolCall);
      emit({
        type: "approval",
        request: {
          id,
          title: String(tool.title ?? "Autorisation demandée par OpenCode"),
          detail: tool.rawInput ? JSON.stringify(tool.rawInput, null, 2) : undefined,
          options: choices,
        },
      });
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

  const process = await spawnProcess("opencode", {
    cwd: options.cwd,
    ...(options.conversation ? { conversation: options.conversation } : {}),
    opencodeConfig: openCodeSessionConfig(
      options.conversation ? options.toolsUrl : undefined,
      options.instructionsFile,
    ),
  });
  const rpc = new AgentProtocol(process, onMessage, () => {
    if (closed) return;
    closed = true;
    updates.endTurn();
    emit({ type: "error", message: "OpenCode s’est arrêté. Envoyer un message relance la conversation." });
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
    if (options.model && modelOption) {
      const updated = await rpc.request("session/set_config_option", {
        sessionId,
        configId: modelOption.id,
        value: options.model,
      });
      const effort = configOptions(updated).find((option) => option.category === "thought_level");
      if (options.effort && effort && optionValues(effort.options).some(({ id }) => id === options.effort))
        await rpc.request("session/set_config_option", { sessionId, configId: effort.id, value: options.effort });
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
        models.push({ ...model, efforts: optionValues(effort?.options).map(({ id }) => id) });
      }
    }
    // La session ouverte pour lire le catalogue n’a pas sa place dans l’historique d’OpenCode.
    if (canDelete && typeof session.sessionId === "string")
      await rpc.request("session/delete", { sessionId: session.sessionId }).catch(() => undefined);
    return models;
  } finally {
    await rpc.close();
  }
}
