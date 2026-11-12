import type { HarnessProcess } from "./process";

export type RpcMessage = {
  id?: number | string;
  method?: string;
  params?: Record<string, unknown>;
  result?: unknown;
  error?: unknown;
};
export const object = (value: unknown): Record<string, unknown> =>
  value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : {};

/** Motif court du CLI, sans jeton ni identifiant : clés, en-têtes Bearer, longues suites hexadécimales, courriels. */
export function redactedCliReason(message: string) {
  const redacted = message
    .replace(/Bearer\s+[\w.~+/=-]+/gi, "Bearer …")
    .replace(/\b(?:sk|pk|rk|ghp|gho|xox[abp])[-_][\w-]{8,}/gi, "…")
    .replace(/\b[a-f0-9]{24,}\b/gi, "…")
    .replace(/\b[\w.+-]+@[\w-]+\.[\w.-]+\b/g, "…")
    .replace(/\s+/g, " ")
    .trim();
  return redacted.length > 220 ? `${redacted.slice(0, 219)}…` : redacted;
}

/** Classifie les erreurs connues ; sinon le motif du CLI, expurgé, aide à corriger le modèle ou l’authentification. */
function cliRequestError(error: unknown): string {
  const message = object(error).message;
  if (typeof message === "string" && /\bAADSTS50078\b/.test(message)) {
    return "Votre authentification multifacteur a expiré (AADSTS50078). Reconnectez-vous au fournisseur dans le CLI, puis réessayez le message.";
  }
  const data = object(object(error).data);
  const detail = [message, data.message, data.error]
    .filter((item): item is string => typeof item === "string" && item.trim().length > 0)
    .map(redactedCliReason)
    .filter((item, index, list) => item && list.indexOf(item) === index)
    .join(" · ");
  return `Le CLI a refusé la requête${detail ? ` : ${detail}` : ""}. Vérifiez le modèle, les droits et l’authentification.`;
}

/** JSONL bidirectionnel ; les requêtes serveur et les réponses ont des espaces d’identifiants distincts. */
export class AgentProtocol {
  private buffer = "";
  private sequence = 0;
  private closed = false;
  private pending = new Map<
    number,
    { resolve: (value: unknown) => void; reject: (error: Error) => void; timer?: ReturnType<typeof setTimeout> }
  >();
  private stops: Array<() => void>;
  private process: HarnessProcess;
  private onMessage: (message: RpcMessage) => void;
  private onFailure: () => void;

  constructor(process: HarnessProcess, onMessage: (message: RpcMessage) => void, onFailure: () => void) {
    this.process = process;
    this.onMessage = onMessage;
    this.onFailure = onFailure;
    this.stops = [
      process.onStdout((chunk) => this.receive(chunk)),
      process.onClose(() => this.fail()),
      process.onError(() => this.fail()),
    ];
  }

  request(method: string, params: Record<string, unknown>, timeoutMs = 30_000): Promise<unknown> {
    if (this.closed) return Promise.reject(new Error("La connexion au CLI est fermée."));
    const id = ++this.sequence;
    return new Promise((resolve, reject) => {
      const timer = timeoutMs
        ? setTimeout(() => {
            this.pending.delete(id);
            reject(new Error(`Le CLI ne répond pas à ${method}.`));
          }, timeoutMs)
        : undefined;
      this.pending.set(id, { resolve, reject, timer });
      void this.write({ id, method, params }).catch(() => {
        clearTimeout(timer);
        this.pending.delete(id);
        reject(new Error("Impossible de communiquer avec le CLI."));
      });
    });
  }

  write(message: RpcMessage) {
    return this.process.write(`${JSON.stringify({ jsonrpc: "2.0", ...message })}\n`);
  }

  private receive(chunk: string) {
    this.buffer += chunk;
    if (this.buffer.length > 8_000_000) {
      this.fail();
      return;
    }
    const lines = this.buffer.split(/\r?\n/);
    this.buffer = lines.pop() ?? "";
    for (const line of lines) {
      let message: RpcMessage;
      try {
        message = JSON.parse(line) as RpcMessage;
      } catch {
        continue;
      }
      if (!message || typeof message !== "object") continue;
      if (message.method) {
        this.onMessage(message);
        continue;
      }
      if (typeof message.id !== "number") continue;
      const pending = this.pending.get(message.id);
      if (!pending) continue;
      clearTimeout(pending.timer);
      this.pending.delete(message.id);
      if (message.error) pending.reject(new Error(cliRequestError(message.error)));
      else pending.resolve(message.result);
    }
  }

  private fail() {
    if (this.closed) return;
    this.onFailure();
    void this.close();
  }

  async close() {
    if (this.closed) return;
    this.closed = true;
    for (const pending of this.pending.values()) {
      clearTimeout(pending.timer);
      pending.reject(new Error("La connexion au CLI est fermée."));
    }
    this.pending.clear();
    this.buffer = "";
    this.stops.forEach((stop) => {
      stop();
    });
    this.stops = [];
    await this.process.kill().catch(() => undefined);
  }
}
