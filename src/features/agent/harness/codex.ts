/**
 * Harnais Codex : `codex app-server`, JSON-RPC ligne à ligne. Repris de OneApp, avec deux différences : les
 * demandes d’accord remontent à l’utilisateur au lieu d’être refusées, et le bac à sable suit le niveau d’autonomie
 * de la conversation.
 */
import { imageDataUrl } from "../lib/chatImages";
import { contentFiles } from "../lib/contentFiles";
import { isConversationDocument } from "../lib/conversationFileKinds";
import { type HarnessProcess, spawnProcess } from "./process";
import type {
  ActivityAction,
  ActivityStatus,
  ApprovalRequest,
  Autonomy,
  HarnessEvent,
  HarnessModel,
  HarnessSession,
  InputFile,
  SessionOptions,
  SessionStatus,
} from "./types";
import { isInputImage, messageText } from "./types";

type JsonValue = null | boolean | number | string | JsonValue[] | { [key: string]: JsonValue };

type JsonRpcMessage = {
  id?: number | string;
  method?: string;
  params?: Record<string, unknown>;
  result?: JsonValue;
  error?: { message?: string };
};

const CLIENT = { name: "alfred", title: "Alfred", version: "0.1.0" };

/**
 * Consigne de OneApp pour Codex : des lectures simples et séparées portent les métadonnées read, search et listFiles
 * (affichées « Lu », « Recherché »), et `apply_patch` celles des fichiers modifiés.
 */
export const CODEX_FILE_TOOLS =
  "Pour lire des fichiers, faites des appels de lecture simples et distincts (par exemple cat ou sed selon le shell disponible). Séparez les lectures des recherches, listes de dossiers, commandes Git et tests : ne les réunissez pas dans un même appel avec &&, ; ou un script. Cela permet à Codex de fournir les métadonnées read, search et listFiles à Alfred. Vous pouvez effectuer plusieurs appels de lecture indépendants en parallèle. Pour modifier des fichiers texte existants ou en créer, privilégiez l’outil natif apply_patch lorsqu’il est disponible. Réservez les commandes shell aux lectures, recherches, tests et opérations qui nécessitent réellement le shell. Évitez de réécrire un fichier texte avec cat, echo ou un script lorsque apply_patch convient : ses événements permettent à Alfred d’afficher précisément les fichiers modifiés.";

/**
 * Lignes ajoutées et retirées d’un changement de fichier. Pour une modification, `diff` est un diff unifié ; pour
 * une création ou une suppression, c’est le contenu entier du fichier, sans préfixe `+` ni `-`.
 */
function changeCounts(change: Record<string, unknown> | undefined): { added?: number; removed?: number } {
  const diff = textValue(change?.diff);
  if (diff === undefined) return {};
  const kind = textValue(recordValue(change?.kind)?.type) ?? textValue(change?.kind);
  const lines = diff.split("\n");
  if (lines.at(-1) === "") lines.pop();
  if (kind === "add") return { added: lines.length, removed: 0 };
  if (kind === "delete") return { added: 0, removed: lines.length };
  return {
    added: lines.filter((line) => line.startsWith("+") && !line.startsWith("+++ ")).length,
    removed: lines.filter((line) => line.startsWith("-") && !line.startsWith("--- ")).length,
  };
}

/**
 * Entrée d’un tour Codex. Les images partent en `localImage` ; Codex n’a pas d’entrée pour les autres fichiers,
 * qui sont cités par leur chemin pour qu’il les lise lui-même (sans quoi ils disparaissaient sans un mot).
 */
function codexInput(text: string, files: readonly InputFile[] = []) {
  const others = files.filter((file) => !isInputImage(file));
  const attached = others.length ? `\n\nFichiers joints :\n${others.map((file) => `- ${file.path}`).join("\n")}` : "";
  return [
    { type: "text", text: `${text}${attached}`, text_elements: [] },
    ...files.filter(isInputImage).map(({ path }) => ({ type: "localImage", path })),
  ];
}

/** Décode les fragments stdout, y compris lorsqu’une ligne JSONL est coupée. */
class JsonlParser {
  #buffer = "";

  push(chunk: string): JsonRpcMessage[] {
    this.#buffer += chunk;
    const lines = this.#buffer.split(/\r?\n/);
    this.#buffer = lines.pop() ?? "";
    return lines.flatMap((line) => {
      const trimmed = line.trim();
      if (!trimmed) return [];
      try {
        const parsed: unknown = JSON.parse(trimmed);
        return parsed && typeof parsed === "object" ? [parsed as JsonRpcMessage] : [];
      } catch {
        return [];
      }
    });
  }
}

/** WebView2, sous Windows, se présente comme « Windows NT ». */
const onWindows = () => typeof navigator !== "undefined" && /Windows/.test(navigator.userAgent);

/**
 * Politique d’approbation et bac à sable de Codex pour un niveau d’autonomie. Sous Windows, comme dans OneApp :
 * aucune demande d’accord et jamais le bac à sable « workspace-write », qui y prépare des droits sur les dossiers
 * avant chaque démarrage et rend Codex très lent à se lancer ; le mode strict reste en lecture seule.
 */
export function codexPolicy(autonomy: Autonomy, roots: string[], windows = onWindows()) {
  if (windows) {
    return autonomy === "strict"
      ? { approvalPolicy: "never", sandbox: "read-only", sandboxPolicy: { type: "readOnly" } }
      : { approvalPolicy: "never", sandbox: "danger-full-access", sandboxPolicy: { type: "dangerFullAccess" } };
  }
  if (autonomy === "auto") {
    return { approvalPolicy: "never", sandbox: "danger-full-access", sandboxPolicy: { type: "dangerFullAccess" } };
  }
  if (autonomy === "strict") {
    return { approvalPolicy: "untrusted", sandbox: "read-only", sandboxPolicy: { type: "readOnly" } };
  }
  return {
    approvalPolicy: "on-request",
    sandbox: "workspace-write",
    sandboxPolicy: { type: "workspaceWrite", writableRoots: roots, networkAccess: false },
  };
}

function messageFromResult(result: JsonValue | undefined, key: string): string | undefined {
  if (!result || typeof result !== "object" || Array.isArray(result)) return undefined;
  const value = result[key];
  return typeof value === "string" ? value : undefined;
}

function nestedId(result: JsonValue | undefined, key: string) {
  if (!result || typeof result !== "object" || Array.isArray(result)) return undefined;
  const nested = result[key];
  if (!nested || typeof nested !== "object" || Array.isArray(nested)) return undefined;
  const id = nested.id;
  return typeof id === "string" ? id : undefined;
}

function responseThreadId(result: JsonValue | undefined) {
  return nestedId(result, "thread") ?? messageFromResult(result, "threadId") ?? messageFromResult(result, "id");
}

function responseTurnId(result: JsonValue | undefined) {
  return nestedId(result, "turn") ?? messageFromResult(result, "turnId") ?? messageFromResult(result, "id");
}

function protocolError(method: string) {
  return `Codex CLI n’a pas pu ${method}. Fermez la conversation puis réessayez.`;
}

/** Motif ajouté à une phrase d’erreur, sans doubler le point final du message du modèle. */
export function withReason(sentence: string, reason: string | undefined) {
  const detail = reason?.trim().replace(/[.\s]+$/, "");
  return `${sentence}${detail ? ` : ${detail}` : ""}.`;
}

function turnFailed(params: Record<string, unknown> | undefined) {
  const turn = params?.turn;
  if (!turn || typeof turn !== "object" || Array.isArray(turn)) return false;
  const value = turn as Record<string, unknown>;
  return value.status === "failed" || Boolean(value.error);
}

function recordValue(value: unknown) {
  return value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : undefined;
}

function textValue(value: unknown) {
  return typeof value === "string" ? value : undefined;
}

function serialized(value: unknown) {
  if (value === undefined || value === null) return undefined;
  if (typeof value === "string") return value;
  try {
    return JSON.stringify(value, null, 2);
  } catch {
    return String(value);
  }
}

function activityStatus(item: Record<string, unknown>, completed: boolean): ActivityStatus {
  const status = textValue(item.status);
  if (status === "failed" || status === "declined" || status === "interrupted") return "failed";
  return completed || status === "completed" ? "completed" : "running";
}

function activityFromItem(
  item: Record<string, unknown>,
  completed: boolean,
): Extract<HarnessEvent, { type: "activity" }> | undefined {
  const itemId = textValue(item.id);
  const itemType = textValue(item.type);
  if (!itemId || !itemType) return undefined;
  const status = activityStatus(item, completed);
  if (itemType === "reasoning") {
    const summary = Array.isArray(item.summary)
      ? item.summary.filter((value): value is string => typeof value === "string").join("\n")
      : undefined;
    return { type: "activity", itemId, kind: "analysis", title: "Analyse", content: summary, status };
  }
  if (itemType === "plan")
    return { type: "activity", itemId, kind: "analysis", title: "Plan", content: textValue(item.text), status };
  if (itemType === "commandExecution")
    return {
      type: "activity",
      itemId,
      kind: "command",
      title: "Commande",
      actions: Array.isArray(item.commandActions)
        ? item.commandActions.flatMap((raw): ActivityAction[] => {
            const action = recordValue(raw);
            if (!action || !["read", "search", "listFiles"].includes(String(action.type))) return [];
            return [
              {
                type: action.type as "read" | "search" | "listFiles",
                path: textValue(action.path),
                query: textValue(action.query),
              },
            ];
          })
        : [],
      detail: textValue(item.command),
      content: textValue(item.aggregatedOutput),
      status,
    };
  if (itemType === "fileChange") {
    const changes = Array.isArray(item.changes)
      ? item.changes.flatMap((change) => {
          const value = recordValue(change);
          const path = textValue(value?.path);
          return path ? [path] : [];
        })
      : [];
    return {
      type: "activity",
      itemId,
      kind: "file",
      title: "Modification de fichiers",
      actions: Array.isArray(item.changes)
        ? item.changes.flatMap((raw): ActivityAction[] => {
            const change = recordValue(raw);
            const path = textValue(change?.path);
            if (!path) return [];
            return [{ type: "edit", path, ...changeCounts(change) }];
          })
        : [],
      detail: changes.join("\n") || undefined,
      ...(changes.some(isConversationDocument) ? { files: changes.filter(isConversationDocument).slice(0, 8) } : {}),
      status,
    };
  }
  if (itemType === "mcpToolCall") {
    // Les fichiers renvoyés par un outil MCP (liens de ressource) s’affichent comme ceux d’OpenCode.
    const found = completed && !item.error ? contentFiles(item.result) : undefined;
    return {
      type: "activity",
      itemId,
      kind: "tool",
      title: `Outil · ${textValue(item.server) ?? "MCP"} / ${textValue(item.tool) ?? "appel"}`,
      detail: serialized(item.arguments),
      // Sans le base64 d’une image renvoyée (capture d’écran) : la sortie reste lisible et légère.
      content: completed ? serialized(item.error ?? found?.content ?? item.result) : undefined,
      ...(found?.files.length ? { files: found.files } : {}),
      status,
    };
  }
  if (itemType === "dynamicToolCall")
    return {
      type: "activity",
      itemId,
      kind: "tool",
      title: `Outil · ${textValue(item.namespace) ? `${textValue(item.namespace)} / ` : ""}${textValue(item.tool) ?? "appel"}`,
      detail: serialized(item.arguments),
      content: completed ? serialized(item.contentItems) : undefined,
      status,
    };
  if (itemType === "functionCallOutput")
    return {
      type: "activity",
      itemId,
      kind: "tool",
      title: `Outil · ${textValue(item.namespace) ? `${textValue(item.namespace)} / ` : ""}${textValue(item.name) ?? "appel"}`,
      content: serialized(item.output),
      status,
    };
  if (itemType === "collabAgentToolCall")
    return {
      type: "activity",
      itemId,
      kind: "agent",
      title: `Agent · ${textValue(item.tool) ?? "collaboration"}`,
      detail: textValue(item.prompt),
      content: completed ? serialized(item.agentsStates) : undefined,
      status,
    };
  if (itemType === "webSearch")
    return { type: "activity", itemId, kind: "search", title: "Recherche web", detail: textValue(item.query), status };
  if (itemType === "imageView") {
    const path = textValue(item.path);
    return {
      type: "activity",
      itemId,
      kind: "tool",
      title: "Lecture d’image",
      detail: path,
      ...(path ? { images: [path] } : {}),
      status,
    };
  }
  if (itemType === "imageGeneration") {
    const savedPath = textValue(item.savedPath);
    const result = textValue(item.result);
    const inline = result ? imageDataUrl(`data:image/png;base64,${result}`) : undefined;
    const image = savedPath ?? inline;
    const failure = recordValue(item.failure);
    return {
      type: "activity",
      itemId,
      kind: "tool",
      title: "Génération d’image",
      detail: textValue(item.revisedPrompt),
      ...(failure ? { content: textValue(failure.message) ?? serialized(failure) } : {}),
      ...(image ? { images: [image] } : {}),
      status: failure ? "failed" : status,
    };
  }
  return undefined;
}

export interface CodexOptions extends Omit<SessionOptions, "provider"> {
  /** Discussion absente de l’historique Codex, pour les appels uniques. */
  ephemeral?: boolean;
  /** Sans outil ni écriture : appel unique. */
  readOnly?: boolean;
  /** Schéma JSON qui contraint le dernier message du tour. */
  outputSchema?: unknown;
}

class CodexSession implements HarnessSession {
  readonly #process: HarnessProcess;
  readonly #options: CodexOptions;
  readonly #emit: (event: HarnessEvent) => void;
  readonly #parser = new JsonlParser();
  readonly #pending = new Map<
    number,
    { resolve: (result: JsonValue | undefined) => void; reject: (error: Error) => void }
  >();
  /** Demandes d’accord en attente : identifiant affiché → identifiant de la requête du CLI. */
  readonly #approvals = new Map<string, number | string>();
  #lastError: string | undefined;
  #requestId = 0;
  #threadId?: string;
  #turnId?: string;
  /** Tours interrompus par Alfred : leur fin, confirmée plus tard par le CLI, ne concerne plus le tour suivant. */
  readonly #interrupted = new Set<string>();
  /** Fin de la sortie d’erreur du CLI : sa dernière ligne dit pourquoi il s’est arrêté. */
  #stderr = "";
  #closed = false;

  constructor(process: HarnessProcess, options: CodexOptions) {
    this.#process = process;
    this.#options = options;
    this.#emit = options.onEvent;
    process.onStdout((chunk) => this.handleOutput(chunk));
    process.onStderr((chunk) => {
      this.#stderr = (this.#stderr + chunk).slice(-2000);
    });
    process.onClose(() => this.handleClosed());
  }

  get sessionId() {
    return this.#threadId;
  }

  private roots() {
    return [...new Set([this.#options.cwd, ...(this.#options.spaceDir ? [this.#options.spaceDir] : [])])];
  }

  private policy() {
    return this.#options.readOnly
      ? { approvalPolicy: "never", sandbox: "read-only", sandboxPolicy: { type: "readOnly" } }
      : codexPolicy(this.#options.autonomy, this.roots());
  }

  async handshake() {
    await this.request("initialize", { clientInfo: CLIENT, capabilities: null });
    await this.notify("initialized", {});
  }

  async listModels(): Promise<HarnessModel[]> {
    const models: HarnessModel[] = [];
    let cursor: string | undefined;
    const seen = new Set<string>();
    do {
      const page = recordValue(await this.request("model/list", { limit: 100, ...(cursor ? { cursor } : {}) }));
      for (const raw of Array.isArray(page?.data) ? page.data : []) {
        const item = recordValue(raw);
        const id = textValue(item?.model);
        if (!item || !id) continue;
        models.push({
          id,
          name: textValue(item.displayName) ?? id,
          efforts: Array.isArray(item.supportedReasoningEfforts)
            ? item.supportedReasoningEfforts.flatMap((entry) => {
                const effort = textValue(recordValue(entry)?.reasoningEffort);
                return effort ? [effort] : [];
              })
            : [],
        });
      }
      cursor = textValue(page?.nextCursor);
      if (cursor && seen.has(cursor)) break;
      if (cursor) seen.add(cursor);
    } while (cursor && models.length < 1000);
    return models;
  }

  async initialize() {
    this.status("connecting");
    await this.handshake();
    const config: Record<string, unknown> = {};
    if (this.#options.readOnly) {
      // Appel unique : aucun outil, aucune consigne de projet.
      Object.assign(config, {
        "features.shell_tool": false,
        "features.unified_exec": false,
        "features.apply_patch_freeform": false,
        "features.apps": false,
        "features.plugins": false,
        "features.multi_agent": false,
        "tools.view_image": false,
        web_search: "disabled",
        "features.hooks": false,
        "features.memories": false,
        project_doc_max_bytes: 0,
      });
    } else if (this.#options.conversation && this.#options.toolsUrl) {
      // Les outils d’Alfred : le jeton est fourni au CLI par Rust, dans son environnement.
      config["mcp_servers.alfred"] = {
        url: this.#options.toolsUrl,
        enabled: true,
        default_tools_approval_mode: "approve",
        bearer_token_env_var: "ALFRED_MCP_TOKEN",
      };
    }
    const { approvalPolicy, sandbox } = this.policy();
    const resume = this.#options.resumeSessionId;
    // La consigne des outils de fichiers (`CODEX_FILE_TOOLS`) est placée par le moteur, avant l’historique rejoué.
    const instructions = this.#options.instructions?.trim();
    const common = {
      cwd: this.#options.cwd,
      approvalPolicy,
      sandbox,
      ...(this.#options.model ? { model: this.#options.model } : {}),
      ...(Object.keys(config).length ? { config } : {}),
      ...(instructions ? { developerInstructions: instructions } : {}),
    };
    // Reprise : Codex garde l’historique du fil, Alfred ne le renvoie pas.
    const thread = resume
      ? await this.request("thread/resume", { ...common, threadId: resume, excludeTurns: true })
      : await this.request("thread/start", { ...common, ephemeral: this.#options.ephemeral === true });
    this.#threadId = responseThreadId(thread);
    if (!this.#threadId) throw new Error(protocolError(resume ? "reprendre la discussion" : "préparer la discussion"));
    this.#emit({ type: "session", sessionId: this.#threadId });
    if (!resume && this.#options.title?.trim()) {
      await this.request("thread/name/set", { threadId: this.#threadId, name: this.#options.title.trim() }).catch(
        () => undefined,
      );
    }
    this.status("ready");
  }

  async send(message: string, files?: readonly InputFile[], clientId?: string) {
    const text = messageText(message, files);
    if (!text) return;
    if (this.#closed || !this.#threadId) throw new Error("La discussion Codex est fermée.");
    if (this.#turnId) throw new Error("Codex prépare déjà une réponse.");
    this.status("responding");
    const { approvalPolicy, sandboxPolicy } = this.policy();
    try {
      const turn = await this.request("turn/start", {
        threadId: this.#threadId,
        input: codexInput(text, files),
        ...(clientId ? { clientUserMessageId: clientId } : {}),
        cwd: this.#options.cwd,
        approvalPolicy,
        sandboxPolicy,
        ...(this.#options.model ? { model: this.#options.model } : {}),
        ...(this.#options.effort ? { effort: this.#options.effort } : {}),
        ...(this.#options.outputSchema ? { outputSchema: this.#options.outputSchema } : {}),
      });
      this.#turnId = responseTurnId(turn);
      if (!this.#turnId) throw new Error(protocolError("démarrer la réponse"));
    } catch (cause) {
      // Comme OneApp : l’échec remonte à l’appelant, qui termine le tour en erreur ; aucune fin de tour n’est
      // annoncée, sans quoi le tour passait pour terminé avant que l’erreur n’arrive.
      this.#turnId = undefined;
      throw cause;
    }
  }

  async steer(message: string, files?: readonly InputFile[], clientId?: string) {
    const text = messageText(message, files);
    if (!text) return;
    if (this.#closed || !this.#threadId || !this.#turnId)
      throw new Error("Codex ne prépare plus de réponse à orienter.");
    await this.request("turn/steer", {
      threadId: this.#threadId,
      expectedTurnId: this.#turnId,
      input: codexInput(text, files),
      ...(clientId ? { clientUserMessageId: clientId } : {}),
    });
  }

  async answer(approvalId: string, optionId: string) {
    const rpcId = this.#approvals.get(approvalId);
    if (rpcId === undefined) throw new Error("Cette demande d’accord n’est plus en attente.");
    this.#approvals.delete(approvalId);
    await this.#process.write(`${JSON.stringify({ id: rpcId, result: { decision: optionId } })}\n`);
  }

  async cancel() {
    this.closeApprovals("cancel");
    if (this.#closed || !this.#threadId || !this.#turnId) return;
    const turnId = this.#turnId;
    this.#interrupted.add(turnId);
    try {
      await this.request("turn/interrupt", { threadId: this.#threadId, turnId });
    } finally {
      this.#turnId = undefined;
      this.status("idle");
    }
  }

  async close() {
    if (this.#closed) return;
    this.#closed = true;
    this.rejectPending(new Error("La discussion Codex est fermée."));
    await this.#process.kill().catch(() => undefined);
    this.status("closed");
  }

  private closeApprovals(decision?: string) {
    for (const [id, rpcId] of this.#approvals) {
      if (decision)
        void this.#process.write(`${JSON.stringify({ id: rpcId, result: { decision } })}\n`).catch(() => undefined);
      this.#emit({ type: "approvalClosed", id });
    }
    this.#approvals.clear();
  }

  private async request(method: string, params: Record<string, unknown>) {
    if (this.#closed) throw new Error("La discussion Codex est fermée.");
    const id = ++this.#requestId;
    const response = new Promise<JsonValue | undefined>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.#pending.delete(id);
        reject(new Error(protocolError("obtenir une réponse du processus")));
      }, 30_000);
      this.#pending.set(id, {
        resolve: (value) => {
          clearTimeout(timer);
          resolve(value);
        },
        reject: (error) => {
          clearTimeout(timer);
          reject(error);
        },
      });
    });
    try {
      await this.#process.write(`${JSON.stringify({ method, id, params })}\n`);
    } catch {
      this.#pending.get(id)?.reject(new Error(protocolError("communiquer avec le processus")));
      this.#pending.delete(id);
    }
    return response;
  }

  private notify(method: string, params: Record<string, unknown>) {
    return this.#process.write(`${JSON.stringify({ method, params })}\n`).catch(() => {
      throw new Error(protocolError("communiquer avec le processus"));
    });
  }

  private handleOutput(chunk: string) {
    // Une erreur en traitant un message ne doit pas perdre les suivants du même fragment, dont la fin du tour.
    for (const message of this.#parser.push(chunk)) {
      try {
        this.handleMessage(message);
      } catch (cause) {
        console.error(cause);
      }
    }
  }

  private handleMessage(message: JsonRpcMessage) {
    if (message.method && message.id !== undefined) {
      void this.respondToServer(message);
      return;
    }
    if (typeof message.id === "number") {
      const pending = this.#pending.get(message.id);
      if (!pending) return;
      this.#pending.delete(message.id);
      if (message.error) {
        const detail = textValue(message.error.message);
        pending.reject(new Error(`${protocolError("traiter la requête")}${detail ? ` (${detail})` : ""}`));
      } else pending.resolve(message.result);
      return;
    }
    // Les derniers éléments d’un tour interrompu arriveraient dans le tour suivant.
    const turnId = textValue(message.params?.turnId);
    if (turnId && this.#interrupted.has(turnId)) return;
    if (message.method === "error") {
      const error = recordValue(message.params?.error);
      const detail = textValue(error?.message) ?? "Erreur du modèle.";
      if (message.params?.willRetry === true)
        this.#emit({
          type: "activity",
          itemId: `reconnect-${this.#turnId ?? "turn"}`,
          kind: "analysis",
          title: "Reconnexion au modèle",
          content: detail,
          status: "running",
        });
      else this.#lastError = detail;
    }
    if (message.method === "item/agentMessage/delta" && typeof message.params?.delta === "string") {
      const itemId = typeof message.params.itemId === "string" ? message.params.itemId : "agent-message";
      this.#emit({ type: "message", itemId, content: message.params.delta });
    }
    const item =
      message.method === "item/started" || message.method === "item/completed"
        ? recordValue(message.params?.item)
        : undefined;
    if (item) {
      const event = activityFromItem(item, message.method === "item/completed");
      if (event) this.#emit(event);
      const text = textValue(item.text);
      if (message.method === "item/completed" && item.type === "agentMessage" && text && textValue(item.id))
        this.#emit({ type: "message", itemId: String(item.id), content: text, replace: true });
    }
    if (
      (message.method === "item/commandExecution/outputDelta" ||
        message.method === "item/reasoning/summaryTextDelta" ||
        message.method === "item/plan/delta") &&
      typeof message.params?.delta === "string" &&
      typeof message.params.itemId === "string"
    ) {
      this.#emit({ type: "activityDelta", itemId: message.params.itemId, content: message.params.delta });
    }
    if (
      message.method === "item/mcpToolCall/progress" &&
      typeof message.params?.message === "string" &&
      typeof message.params.itemId === "string"
    ) {
      this.#emit({ type: "activityDelta", itemId: message.params.itemId, content: `${message.params.message}\n` });
    }
    if (message.method === "turn/completed") {
      const completed = textValue(recordValue(message.params?.turn)?.id);
      if (completed && this.#interrupted.delete(completed)) return;
      this.#turnId = undefined;
      this.closeApprovals();
      if (turnFailed(message.params)) {
        this.#emit({
          type: "error",
          message: `${withReason("Codex n’a pas pu terminer sa réponse", this.#lastError)} Réessayez ou ouvrez une nouvelle discussion.`,
        });
      }
      this.#lastError = undefined;
      this.status("idle");
    }
  }

  /** Requête du CLI vers Alfred : une demande d’accord devient une carte ; le reste n’est pas pris en charge. */
  private async respondToServer(message: JsonRpcMessage) {
    const params = message.params ?? {};
    const command = message.method === "item/commandExecution/requestApproval";
    if (command || message.method === "item/fileChange/requestApproval") {
      if (this.#options.readOnly) {
        await this.#process.write(`${JSON.stringify({ id: message.id, result: { decision: "decline" } })}\n`);
        return;
      }
      const id = `codex-${String(message.id)}`;
      this.#approvals.set(id, message.id as number | string);
      const reason = textValue(params.reason);
      const request: ApprovalRequest = {
        id,
        title: command ? "Exécuter une commande" : "Modifier des fichiers hors des dossiers de l’agent",
        detail: [textValue(params.command), textValue(params.cwd) ? `dans ${String(params.cwd)}` : undefined, reason]
          .filter(Boolean)
          .join("\n"),
        options: [
          { id: "accept", label: "Autoriser", kind: "allow" },
          { id: "acceptForSession", label: "Autoriser pour cette conversation", kind: "allowAlways" },
          { id: "decline", label: "Refuser", kind: "deny" },
        ],
      };
      this.#emit({ type: "approval", request });
      return;
    }
    await this.#process
      .write(
        `${JSON.stringify({ id: message.id, error: { code: -32601, message: "Cette interaction n’est pas prise en charge par Alfred." } })}\n`,
      )
      .catch(() => undefined);
    // Comme dans OneApp : sans quoi le CLI attend une réponse que personne ne voit venir.
    this.#emit({
      type: "error",
      message: "Le CLI demande une interaction non prise en charge. Reprenez la tâche dans le CLI.",
    });
  }

  private handleClosed() {
    if (this.#closed) return;
    this.#closed = true;
    this.rejectPending(new Error("Codex s’est arrêté."));
    this.closeApprovals();
    const detail = this.#stderr.trim().split("\n").at(-1)?.trim();
    this.#emit({
      type: "error",
      message: `Codex s’est arrêté${detail ? ` : ${detail}` : ""}. Envoyer un message relance la conversation.`,
    });
    this.status("closed");
  }

  private rejectPending(error: Error) {
    for (const { reject } of this.#pending.values()) reject(error);
    this.#pending.clear();
  }

  private status(status: SessionStatus) {
    this.#emit({ type: "status", status });
  }
}

async function open(options: CodexOptions) {
  if (!options.cwd.trim()) throw new Error("Le dossier de travail est requis pour démarrer Codex.");
  const process = await spawnProcess("codex", {
    cwd: options.cwd,
    ...(options.conversation && !options.readOnly ? { conversation: options.conversation } : {}),
  });
  return new CodexSession(process, options);
}

export async function createCodexSession(options: CodexOptions): Promise<HarnessSession> {
  const session = await open(options);
  try {
    await session.initialize();
    return session;
  } catch (cause) {
    await session.close();
    throw cause;
  }
}

const silent = { autonomy: "strict" as const, onEvent: () => undefined };

/** Catalogue des modèles du CLI installé. */
export async function listCodexModels(cwd: string): Promise<HarnessModel[]> {
  const reader = await open({ cwd, ...silent });
  try {
    await reader.handshake();
    return await reader.listModels();
  } finally {
    await reader.close();
  }
}
