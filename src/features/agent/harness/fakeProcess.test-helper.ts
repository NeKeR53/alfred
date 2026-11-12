/**
 * Faux processus de harnais pour les tests : il enregistre ce que l’adaptateur écrit et laisse le test injecter des
 * lignes de sortie, comme le ferait le CLI. Chaque fichier de test doit d’abord remplacer `./process` :
 *
 *   vi.mock("./process", () => ({ spawnProcess: vi.fn(), probe: vi.fn() }));
 */
import { vi } from "vitest";
import { type HarnessProcess, type SpawnOptions, spawnProcess } from "./process";
import type { ApprovalRequest, HarnessEvent, Provider } from "./types";

type Json = Record<string, unknown>;
type Handler<Value> = (value: Value) => void;
/** Réponse d’un faux CLI à une requête JSON-RPC : un résultat, une erreur, ou rien (le test répondra plus tard). */
export type Reply = { result: unknown } | { error: { code?: number; message: string } } | "later";

export class FakeProcess implements HarnessProcess {
  /** Messages JSON écrits par l’adaptateur, dans l’ordre. */
  readonly written: Json[] = [];
  killed = false;
  readonly #stdout = new Set<Handler<string>>();
  readonly #stderr = new Set<Handler<string>>();
  readonly #close = new Set<Handler<number | null>>();
  readonly #responders = new Map<string, (params: Json) => Reply>();
  readonly #onWrite: Array<(message: Json) => void> = [];

  async write(data: string) {
    for (const line of data.split("\n")) {
      if (!line.trim()) continue;
      const message = JSON.parse(line) as Json;
      this.written.push(message);
      for (const handler of this.#onWrite) handler(message);
      const method = typeof message.method === "string" ? message.method : undefined;
      const responder = method ? this.#responders.get(method) : undefined;
      if (responder && message.id !== undefined) {
        const reply = responder((message.params ?? {}) as Json);
        if (reply !== "later") queueMicrotask(() => this.send({ id: message.id, ...reply }));
      }
    }
  }

  async kill() {
    this.killed = true;
  }

  onStdout(handler: Handler<string>) {
    return this.#subscribe(this.#stdout, handler);
  }
  onStderr(handler: Handler<string>) {
    return this.#subscribe(this.#stderr, handler);
  }
  onClose(handler: Handler<number | null>) {
    return this.#subscribe(this.#close, handler);
  }
  onError() {
    return () => undefined;
  }

  #subscribe<Value>(set: Set<Handler<Value>>, handler: Handler<Value>) {
    set.add(handler);
    return () => {
      set.delete(handler);
    };
  }

  /** Une ligne de sortie du CLI. */
  send(...messages: Array<Json | string>) {
    for (const message of messages) {
      const line = typeof message === "string" ? message : JSON.stringify(message);
      for (const handler of [...this.#stdout]) handler(`${line}\n`);
    }
  }

  /** Un fragment brut de la sortie, tel que le système le découpe (sans fin de ligne ajoutée). */
  chunk(text: string) {
    for (const handler of [...this.#stdout]) handler(text);
  }

  stderr(chunk: string) {
    for (const handler of [...this.#stderr]) handler(chunk);
  }

  /** Le processus s’arrête de lui-même. */
  exit(code: number | null = 1) {
    for (const handler of [...this.#close]) handler(code);
  }

  /** Réponse automatique du faux CLI à une méthode JSON-RPC. */
  respond(method: string, reply: Reply | ((params: Json) => Reply)) {
    this.#responders.set(method, typeof reply === "function" ? reply : () => reply);
    return this;
  }

  /** Réagit à chaque message écrit par l’adaptateur (scénario scripté). */
  onWrite(handler: (message: Json) => void) {
    this.#onWrite.push(handler);
    return this;
  }

  /** Répond à une requête restée en attente. */
  reply(id: unknown, result: unknown) {
    this.send({ jsonrpc: "2.0", id, result });
  }

  /** Requêtes ou notifications JSON-RPC écrites pour une méthode. */
  calls(method: string) {
    return this.written.filter((message) => message.method === method);
  }

  call(method: string) {
    const found = this.calls(method).at(-1);
    if (!found) throw new Error(`Aucun appel à ${method} : ${this.written.map((m) => m.method ?? m.type).join(", ")}`);
    return found as Json & { id: number; params: Json };
  }

  /** Réponses écrites à une requête du CLI (accord, refus). */
  responseTo(id: unknown) {
    return this.written.find((message) => message.id === id && message.method === undefined);
  }
}

export interface Spawned {
  provider: Provider;
  options: SpawnOptions;
  process: FakeProcess;
}

/**
 * Remplace `spawnProcess` : chaque lancement crée un faux processus, préparé par `setup` avant que l’adaptateur
 * ne s’y abonne. La liste rendue garde tous les lancements.
 */
export function fakeSpawn(setup: (process: FakeProcess, provider: Provider) => void = () => undefined) {
  const spawned: Spawned[] = [];
  vi.mocked(spawnProcess).mockImplementation(async (provider, options) => {
    const process = new FakeProcess();
    setup(process, provider);
    spawned.push({ provider, options, process });
    return process;
  });
  return spawned;
}

/** Laisse passer les micro-tâches et les minuteries immédiates en attente. */
export async function flush(rounds = 5) {
  for (let round = 0; round < rounds; round++) await new Promise((resolve) => setTimeout(resolve, 0));
}

type ActivityEvent = Extract<HarnessEvent, { type: "activity" }>;
export type VisibleActivity = Omit<ActivityEvent, "type">;

/** Ce que l’utilisateur voit d’une suite d’événements : messages, activités, cartes d’accord, erreurs, état. */
export interface Visible {
  messages: string[];
  activities: VisibleActivity[];
  approvals: ApprovalRequest[];
  errors: string[];
  statuses: string[];
  sessionId?: string;
}

export function visible(events: readonly HarnessEvent[]): Visible {
  const messages = new Map<string, string>();
  const activities = new Map<string, VisibleActivity>();
  const approvals = new Map<string, ApprovalRequest>();
  const view: Visible = { messages: [], activities: [], approvals: [], errors: [], statuses: [] };
  for (const event of events) {
    switch (event.type) {
      case "message":
        messages.set(event.itemId, event.replace ? event.content : (messages.get(event.itemId) ?? "") + event.content);
        break;
      case "activity": {
        const { type: _type, ...activity } = event;
        const previous = activities.get(event.itemId);
        activities.set(event.itemId, {
          ...activity,
          content: activity.content ?? previous?.content,
          detail: activity.detail ?? previous?.detail,
        });
        break;
      }
      case "activityDelta": {
        const previous = activities.get(event.itemId) ?? {
          itemId: event.itemId,
          kind: "analysis",
          title: "Analyse",
          status: "running",
        };
        activities.set(event.itemId, { ...previous, content: (previous.content ?? "") + event.content });
        break;
      }
      case "approval":
        approvals.set(event.request.id, event.request);
        break;
      case "approvalClosed":
        approvals.delete(event.id);
        break;
      case "error":
        view.errors.push(event.message);
        break;
      case "status":
        view.statuses.push(event.status);
        break;
      case "session":
        view.sessionId = event.sessionId;
        break;
    }
  }
  view.messages = [...messages.values()];
  view.activities = [...activities.values()];
  view.approvals = [...approvals.values()];
  return view;
}

/** Collecteur d’événements à passer en `onEvent`. */
export function recorder() {
  const events: HarnessEvent[] = [];
  return {
    events,
    onEvent: (event: HarnessEvent) => {
      events.push(event);
    },
    get view() {
      return visible(events);
    },
  };
}
