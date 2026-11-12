/**
 * Harnais Claude Code : `claude -p` en flux JSON dans les deux sens. Le processus reste ouvert d’un message à
 * l’autre ; les demandes d’autorisation arrivent comme requêtes de contrôle et repartent comme réponses.
 */
import { type HarnessProcess, spawnProcess } from "./process";
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

type Json = Record<string, unknown>;
type Activity = Extract<HarnessEvent, { type: "activity" }>;

const record = (value: unknown): Json =>
  value && typeof value === "object" && !Array.isArray(value) ? (value as Json) : {};
const text = (value: unknown) => (typeof value === "string" ? value : undefined);

/** Mode d’autorisation de Claude Code pour un niveau d’autonomie. */
export function claudePermissionMode(autonomy: Autonomy) {
  // `acceptEdits` : les écritures dans les dossiers de travail passent, le reste demande un accord.
  return autonomy === "auto" ? "bypassPermissions" : autonomy === "strict" ? "manual" : "acceptEdits";
}

const ALFRED_TOOL = /^mcp__alfred__(.+)$/;

/** Activité affichée pour un appel d’outil de Claude Code. */
export function claudeToolActivity(id: string, name: string, input: Json): Activity {
  const base = { type: "activity" as const, itemId: id, status: "running" as const };
  const path = text(input.file_path) ?? text(input.path) ?? text(input.notebook_path);
  const activity = (kind: ActivityKind, title: string, detail?: string, actions?: ActivityAction[]): Activity => ({
    ...base,
    kind,
    title,
    ...(detail ? { detail } : {}),
    ...(actions ? { actions } : {}),
  });
  switch (name) {
    case "Bash":
    case "PowerShell":
      return activity("command", "Commande", text(input.command), []);
    case "Read":
      return activity("command", "Lecture", path, [{ type: "read", ...(path ? { path } : {}) }]);
    case "Glob":
    case "LS":
      return activity("command", "Recherche", text(input.pattern) ?? path, [
        {
          type: "listFiles",
          ...(path ? { path } : {}),
          ...(text(input.pattern) ? { query: text(input.pattern) } : {}),
        },
      ]);
    case "Grep":
      return activity("command", "Recherche", [text(input.pattern), path].filter(Boolean).join(" · "), [
        { type: "search", ...(text(input.pattern) ? { query: text(input.pattern) } : {}), ...(path ? { path } : {}) },
      ]);
    case "Edit":
    case "MultiEdit":
    case "Write":
    case "NotebookEdit":
      return activity("file", "Modification de fichiers", path, path ? [{ type: "edit", path }] : []);
    case "WebSearch":
    case "WebFetch":
      return activity("search", "Recherche web", text(input.query) ?? text(input.url));
    case "Task":
    case "Agent":
      return activity("agent", "Agent · délégation", text(input.description) ?? text(input.prompt));
    default: {
      const alfred = ALFRED_TOOL.exec(name);
      const mcp = /^mcp__([^_]+(?:_[^_]+)*)__(.+)$/.exec(name);
      const title = alfred
        ? `Outil · Alfred / ${alfred[1]}`
        : mcp
          ? `Outil · ${mcp[1]} / ${mcp[2]}`
          : `Outil · ${name}`;
      return activity("tool", title, Object.keys(input).length ? JSON.stringify(input, null, 2) : undefined);
    }
  }
}

function resultText(content: unknown): string | undefined {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return undefined;
  const parts = content
    .map(record)
    .flatMap((block) => (block.type === "text" && text(block.text) ? [String(block.text)] : []));
  return parts.length ? parts.join("\n") : undefined;
}

function approvalFor(id: string, tool: string, input: Json, canRemember: boolean): ApprovalRequest {
  const path = text(input.file_path) ?? text(input.path);
  const title =
    tool === "Bash" || tool === "PowerShell"
      ? "Exécuter une commande"
      : path && ["Edit", "MultiEdit", "Write", "NotebookEdit"].includes(tool)
        ? "Modifier un fichier hors des dossiers de l’agent"
        : tool === "WebFetch" || tool === "WebSearch"
          ? "Accéder au web"
          : `Utiliser l’outil ${tool}`;
  return {
    id,
    title,
    detail:
      text(input.command) ??
      path ??
      text(input.url) ??
      (Object.keys(input).length ? JSON.stringify(input, null, 2) : undefined),
    options: [
      { id: "allow", label: "Autoriser", kind: "allow" },
      ...(canRemember ? [{ id: "allowAlways", label: "Toujours autoriser", kind: "allowAlways" as const }] : []),
      { id: "deny", label: "Refuser", kind: "deny" },
    ],
  };
}

export interface ClaudeOptions extends Omit<SessionOptions, "provider"> {
  /** Appel unique : aucun outil, réponse contrainte par `outputSchema`. */
  oneShot?: boolean;
  outputSchema?: unknown;
  /** Reçoit le résultat structuré d’un appel unique. */
  onStructuredResult?: (value: unknown) => void;
}

class ClaudeSession implements HarnessSession {
  readonly #process: HarnessProcess;
  readonly #options: ClaudeOptions;
  readonly #emit: (event: HarnessEvent) => void;
  #buffer = "";
  #sessionId?: string;
  #closed = false;
  #responding = false;
  #sequence = 0;
  /** Message en cours de diffusion et type de chacun de ses blocs. */
  #streamMessage?: string;
  readonly #streamed = new Set<string>();
  readonly #blocks = new Map<number, "text" | "thinking" | "other">();
  readonly #activities = new Map<string, Activity>();
  /** Réflexions ouvertes, terminées à leur `content_block_stop`. */
  readonly #thinking = new Set<string>();
  readonly #approvals = new Map<string, { requestId: string; input: Json; suggestions: unknown }>();
  #stderr = "";
  /** Motif d’un message d’erreur synthétique du CLI (non connecté, quota) : il s’affiche comme erreur du tour. */
  #cliError?: string;

  constructor(process: HarnessProcess, options: ClaudeOptions) {
    this.#process = process;
    this.#options = options;
    this.#emit = options.onEvent;
    process.onStdout((chunk) => this.receive(chunk));
    process.onStderr((chunk) => {
      this.#stderr = (this.#stderr + chunk).slice(-2000);
    });
    process.onClose(() => this.handleClosed());
  }

  get sessionId() {
    return this.#sessionId;
  }

  async send(message: string, files: readonly InputFile[] = []) {
    const body = message.trim();
    if (!body) return;
    if (this.#closed) throw new Error("La conversation Claude Code est fermée.");
    if (this.#responding) throw new Error("Claude Code prépare déjà une réponse.");
    this.#responding = true;
    this.#emit({ type: "status", status: "responding" });
    // Les fichiers joints sont cités par leur chemin : Claude Code les lit lui-même, images comprises.
    const attached = files.length ? `\n\nFichiers joints :\n${files.map((file) => `- ${file.path}`).join("\n")}` : "";
    try {
      await this.write({
        type: "user",
        message: { role: "user", content: [{ type: "text", text: `${body}${attached}` }] },
        parent_tool_use_id: null,
      });
    } catch (cause) {
      this.#responding = false;
      this.#emit({ type: "status", status: "idle" });
      throw cause;
    }
  }

  async answer(approvalId: string, optionId: string) {
    const approval = this.#approvals.get(approvalId);
    if (!approval) throw new Error("Cette demande d’accord n’est plus en attente.");
    this.#approvals.delete(approvalId);
    const response =
      optionId === "deny"
        ? { behavior: "deny", message: "Refusé par l’utilisateur." }
        : {
            behavior: "allow",
            updatedInput: approval.input,
            ...(optionId === "allowAlways" && approval.suggestions ? { updatedPermissions: approval.suggestions } : {}),
          };
    await this.respond(approval.requestId, response);
  }

  async cancel() {
    for (const [id, approval] of this.#approvals) {
      void this.respond(approval.requestId, { behavior: "deny", message: "Tour interrompu." }).catch(() => undefined);
      this.#emit({ type: "approvalClosed", id });
    }
    this.#approvals.clear();
    if (this.#closed || !this.#responding) return;
    await this.write({
      type: "control_request",
      request_id: `alfred-${++this.#sequence}`,
      request: { subtype: "interrupt" },
    });
  }

  async close() {
    if (this.#closed) return;
    this.#closed = true;
    await this.#process.kill().catch(() => undefined);
    this.#emit({ type: "status", status: "closed" });
  }

  private write(message: Json) {
    return this.#process.write(`${JSON.stringify(message)}\n`);
  }

  private respond(requestId: string, response: Json) {
    return this.write({ type: "control_response", response: { subtype: "success", request_id: requestId, response } });
  }

  private receive(chunk: string) {
    this.#buffer += chunk;
    const lines = this.#buffer.split(/\r?\n/);
    this.#buffer = lines.pop() ?? "";
    for (const line of lines) {
      if (!line.trim()) continue;
      try {
        this.handle(record(JSON.parse(line)));
      } catch (cause) {
        // Une ligne illisible ou un message inattendu ne doit pas perdre la suite, dont la fin du tour.
        console.error(cause);
      }
    }
  }

  private handle(message: Json) {
    switch (message.type) {
      case "system": {
        const sessionId = text(message.session_id);
        if (message.subtype === "init" && sessionId && sessionId !== this.#sessionId) {
          this.#sessionId = sessionId;
          this.#emit({ type: "session", sessionId });
        }
        return;
      }
      case "stream_event":
        this.handleStream(record(message.event));
        return;
      case "assistant":
        this.handleAssistant(record(message.message), message.error);
        return;
      case "user":
        this.handleToolResults(record(message.message).content);
        return;
      case "control_request":
        this.handleControl(text(message.request_id) ?? "", record(message.request));
        return;
      case "result": {
        this.#responding = false;
        const cliError = this.#cliError;
        this.#cliError = undefined;
        for (const id of this.#approvals.keys()) this.#emit({ type: "approvalClosed", id });
        this.#approvals.clear();
        this.settleActivities();
        if (message.structured_output !== undefined) this.#options.onStructuredResult?.(message.structured_output);
        if (message.is_error === true || (text(message.subtype) ?? "success") !== "success") {
          const reason =
            text(message.result) ||
            (Array.isArray(message.errors) ? message.errors.map(String).join(" · ") : undefined) ||
            cliError;
          // Une interruption demandée n’est pas une erreur à afficher.
          if (message.subtype !== "error_during_execution" || reason)
            this.#emit({
              type: "error",
              message: `Claude Code n’a pas pu terminer sa réponse${reason ? ` : ${reason.trim().replace(/[.\s]+$/, "")}` : ""}.`,
            });
        }
        this.#emit({ type: "status", status: "idle" });
        return;
      }
      default:
        return;
    }
  }

  private handleStream(event: Json) {
    if (event.type === "message_start") {
      this.#streamMessage = text(record(event.message).id);
      this.#blocks.clear();
      return;
    }
    const messageId = this.#streamMessage;
    const index = typeof event.index === "number" ? event.index : 0;
    if (!messageId) return;
    if (event.type === "content_block_start") {
      const kind = record(event.content_block).type;
      this.#blocks.set(index, kind === "text" ? "text" : kind === "thinking" ? "thinking" : "other");
      if (kind === "thinking") this.#thinking.add(`${messageId}-${index}`);
      if (kind === "thinking")
        this.#emit({
          type: "activity",
          itemId: `${messageId}-${index}`,
          kind: "analysis",
          title: "Analyse",
          status: "running",
        });
      return;
    }
    if (event.type === "content_block_delta") {
      const delta = record(event.delta);
      const itemId = `${messageId}-${index}`;
      if (delta.type === "text_delta" && text(delta.text)) {
        this.#streamed.add(messageId);
        this.#emit({ type: "message", itemId, content: String(delta.text) });
      } else if (delta.type === "thinking_delta" && text(delta.thinking)) {
        this.#emit({ type: "activityDelta", itemId, content: String(delta.thinking) });
      }
      return;
    }
    if (event.type === "content_block_stop" && this.#blocks.get(index) === "thinking") {
      this.#thinking.delete(`${messageId}-${index}`);
      this.#emit({
        type: "activity",
        itemId: `${messageId}-${index}`,
        kind: "analysis",
        title: "Analyse",
        status: "completed",
      });
    }
  }

  /**
   * Fin de tour (résultat, interruption, arrêt) : une réflexion ou un outil resté sans suite ne doit pas rester
   * affiché en cours. Un outil sans résultat a été interrompu.
   */
  private settleActivities() {
    for (const itemId of this.#thinking)
      this.#emit({ type: "activity", itemId, kind: "analysis", title: "Analyse", status: "completed" });
    this.#thinking.clear();
    for (const activity of this.#activities.values()) this.#emit({ ...activity, status: "failed" });
    this.#activities.clear();
  }

  private handleAssistant(message: Json, error: unknown) {
    const messageId = text(message.id) ?? `message-${++this.#sequence}`;
    const blocks = Array.isArray(message.content) ? message.content.map(record) : [];
    // Sans compte connecté ou sur un refus de l’API, le CLI fabrique un message assistant qui porte l’erreur : ce
    // n’est pas une réponse de l’agent, le résultat en erreur qui suit l’affiche.
    if ((error !== undefined && error !== null) || message.model === "<synthetic>") {
      const reason = blocks.flatMap((block) => (block.type === "text" && text(block.text) ? [String(block.text)] : []));
      if (reason.length) this.#cliError = reason.join("\n");
      return;
    }
    blocks.forEach((block, index) => {
      if (block.type === "tool_use" && text(block.id)) {
        const activity = claudeToolActivity(String(block.id), text(block.name) ?? "outil", record(block.input));
        this.#activities.set(activity.itemId, activity);
        this.#emit(activity);
      } else if (block.type === "text" && text(block.text) && !this.#streamed.has(messageId)) {
        // Message arrivé sans diffusion (erreur du CLI, reprise) : son texte complet.
        this.#emit({
          type: "message",
          itemId: `${messageId}-text-${index}`,
          content: String(block.text),
          replace: true,
        });
      }
    });
  }

  private handleToolResults(content: unknown) {
    for (const block of Array.isArray(content) ? content.map(record) : []) {
      const id = text(block.tool_use_id);
      const activity = id ? this.#activities.get(id) : undefined;
      if (block.type !== "tool_result" || !id || !activity) continue;
      this.#activities.delete(id);
      const output = resultText(block.content);
      this.#emit({
        ...activity,
        ...(output ? { content: output } : {}),
        status: block.is_error === true ? "failed" : "completed",
      });
    }
  }

  private handleControl(requestId: string, request: Json) {
    if (request.subtype !== "can_use_tool") {
      void this.write({
        type: "control_response",
        response: { subtype: "error", request_id: requestId, error: "Requête non prise en charge par Alfred." },
      }).catch(() => undefined);
      return;
    }
    const tool = text(request.tool_name) ?? "outil";
    const input = record(request.input);
    // Les outils d’Alfred sont les siens : pas de question pour s’en servir.
    if (ALFRED_TOOL.test(tool)) {
      void this.respond(requestId, { behavior: "allow", updatedInput: input }).catch(() => undefined);
      return;
    }
    if (tool === "AskUserQuestion") {
      void this.respond(requestId, {
        behavior: "deny",
        message: "Pose ta question directement dans ta réponse : l’utilisateur te répondra dans la conversation.",
      }).catch(() => undefined);
      return;
    }
    if (this.#options.oneShot) {
      void this.respond(requestId, { behavior: "deny", message: "Aucun outil n’est disponible pour cet appel." }).catch(
        () => undefined,
      );
      return;
    }
    const id = `claude-${requestId}`;
    const suggestions =
      Array.isArray(request.permission_suggestions) && request.permission_suggestions.length
        ? request.permission_suggestions
        : undefined;
    this.#approvals.set(id, { requestId, input, suggestions });
    this.#emit({ type: "approval", request: approvalFor(id, tool, input, suggestions !== undefined) });
  }

  private handleClosed() {
    if (this.#closed) return;
    this.#closed = true;
    for (const id of this.#approvals.keys()) this.#emit({ type: "approvalClosed", id });
    this.#approvals.clear();
    this.settleActivities();
    const detail = this.#stderr.trim().split("\n").at(-1);
    this.#emit({
      type: "error",
      message: `Claude Code s’est arrêté${detail ? ` : ${detail}` : ""}. Envoyer un message relance la conversation.`,
    });
    this.#emit({ type: "status", status: "closed" });
  }
}

export async function createClaudeSession(options: ClaudeOptions): Promise<HarnessSession> {
  options.onEvent({ type: "status", status: "connecting" });
  const addDirs = options.spaceDir && options.spaceDir !== options.cwd ? [options.spaceDir] : [];
  const process = await spawnProcess("claude", {
    cwd: options.cwd,
    ...(options.conversation && !options.oneShot ? { conversation: options.conversation } : {}),
    claude: {
      ...(options.model && options.model !== "default" ? { model: options.model } : {}),
      ...(options.effort ? { effort: options.effort } : {}),
      ...(options.instructions ? { appendSystemPrompt: options.instructions } : {}),
      ...(options.oneShot
        ? { oneShot: true, ...(options.outputSchema ? { jsonSchema: options.outputSchema } : {}) }
        : {
            permissionMode: claudePermissionMode(options.autonomy),
            addDirs,
            ...(options.resumeSessionId ? { resume: options.resumeSessionId } : {}),
          }),
    },
  });
  const session = new ClaudeSession(process, options);
  // Le CLI n’annonce sa session qu’au premier message : il est prêt dès qu’il est lancé.
  options.onEvent({ type: "status", status: "ready" });
  return session;
}

/** Claude Code n’expose pas de catalogue : ce sont les alias que le CLI accepte, plus le modèle par défaut du compte. */
export function listClaudeModels(): HarnessModel[] {
  const efforts = ["low", "medium", "high", "xhigh", "max"];
  return [
    { id: "default", name: "Modèle par défaut du compte", efforts },
    { id: "fable", name: "Fable", efforts },
    { id: "opus", name: "Opus", efforts },
    { id: "sonnet", name: "Sonnet", efforts },
    { id: "haiku", name: "Haiku", efforts },
  ];
}
