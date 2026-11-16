/**
 * Faux backend d’Alfred, en mémoire et cohérent : il répond aux commandes de l’interface et émet ses événements
 * comme le vrai. Il se branche à l’endroit exact où l’application parle au backend hors de Tauri, le pont HTTP de
 * développement : `fetch` vers `/__dev/invoke` pour les commandes, `EventSource` sur `/__dev/events` pour les
 * événements. `src/lib/native.ts` est donc exercé tel quel, sans `vi.mock`.
 *
 * Il joue aussi un faux CLI Claude Code derrière `agents.spawn` : le harnais réel de l’interface (`claude.ts`) lit
 * ses lignes de flux JSON et lui écrit ses réponses.
 */
import type {
  Commit,
  Diagnostic,
  Layout,
  PlaceTarget,
  ResolvedFunction,
  ResolvedPage,
  ResolvedSection,
  Snapshot,
} from "../../src/lib/types";

type Json = Record<string, unknown>;
type Placement = { kind: "tab"; section: string } | { kind: "panel"; page: string } | { kind: "settings" };

export interface FakePage {
  id: string;
  title: string;
  icon?: string;
  placement: Placement;
  missing?: boolean;
  errors?: Diagnostic[];
}

export interface FakeModule {
  id: string;
  name: string;
  sections: Array<{ id: string; label: string; icon?: string; color?: string }>;
  pages: FakePage[];
  functions: Array<{ id: string; description: string; tool?: boolean }>;
}

interface SpaceState {
  path: string;
  name: string;
  modules: FakeModule[];
  layout: Layout;
}

export interface Call {
  command: string;
  args: Json;
}

const clone = <Value>(value: Value): Value => structuredClone(value);
const slug = (text: string) =>
  text
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "");

let current: FakeBackend | undefined;

/** Clé de cadre d’un module (32 chiffres hexadécimaux, comme celles de `pages::frame_key`). */
export function frameKeyOf(module: string): string {
  const hex = [...module].map((char) => char.charCodeAt(0).toString(16)).join("");
  return hex.padEnd(32, "0").slice(0, 32);
}

/** `EventSource` du pont : chaque instance reçoit les événements du faux backend en cours. */
class FakeEventSource {
  static instances: FakeEventSource[] = [];
  onmessage: ((message: { data: string }) => void) | null = null;
  readonly url: string;
  constructor(url: string) {
    this.url = url;
    FakeEventSource.instances.push(this);
  }
  close() {
    FakeEventSource.instances = FakeEventSource.instances.filter((source) => source !== this);
  }
}

export class FakeBackend {
  readonly calls: Call[] = [];
  /** Commandes que le faux ne connaît pas : un test les vérifie vides, pour que le faux reste honnête. */
  readonly unknown: string[] = [];
  readonly events: Array<{ name: string; payload: unknown }> = [];
  readonly settings = new Map<string, unknown>();
  /** Compteurs des pages (`badge.set`), comme `badges.rs` : une entrée par page, toujours supérieure à zéro. */
  badges: Record<string, number> = {};
  /** Voix : dictée réglée ou non, ce que rendra la prochaine dictée, ce qui a été lu. */
  voice = {
    configured: false,
    transcript: "",
    listening: false,
    spoken: [] as string[],
    readReplies: true,
    dictation: true,
    readNotifications: false,
  };
  readonly conversations = new Map<string, Json>();
  grants: Array<{ subject: string; resource: string; grantedAt: string }> = [];
  journal: Json[] = [];
  commits: Array<Commit & { before: SpaceState }> = [];
  vault: Json[] = [];
  clients: Json[] = [];
  webhooks: Json[] = [];
  schedules: Json[] = [];
  space: SpaceState | null = null;
  lastSpace: string | null = null;
  /** Fichiers que l’agent a modifiés depuis le dernier commit. */
  changed: string[] = [];
  readonly pending = new Map<string, (answer: { result?: unknown; error?: string }) => void>();
  readonly agent = new FakeClaude(this);
  /** Réponse aux appels de fonctions faits par l’interface (`functions.call`). */
  functionResult: (reference: string, input: unknown) => unknown = () => null;
  #sequence = 0;

  install() {
    current = this;
    FakeEventSource.instances = [];
    globalThis.EventSource = FakeEventSource as unknown as typeof EventSource;
    globalThis.fetch = (async (url: string | URL, init?: RequestInit) => {
      if (!String(url).endsWith("/__dev/invoke")) throw new Error(`Réseau interdit dans les tests : ${url}`);
      const { command, args } = JSON.parse(String(init?.body)) as { command: string; args: Json };
      const body = await this.invoke(command, args ?? {}).then(
        (ok) => ({ ok: ok ?? null }),
        (error: unknown) => ({ error: { message: error instanceof Error ? error.message : String(error) } }),
      );
      return { json: async () => body } as Response;
    }) as typeof fetch;
    return this;
  }

  // -------------------------------------------------------------------------------------------------------------
  // Espace
  // -------------------------------------------------------------------------------------------------------------

  /** Prépare un espace déjà ouvert au lancement précédent (`space.restore` le rouvre). */
  withSpace(path: string, name: string, modules: FakeModule[]) {
    this.space = { path, name, modules: clone(modules), layout: { sections: [] } };
    this.lastSpace = path;
    return this;
  }

  module(id: string): FakeModule {
    const found = this.space?.modules.find((module) => module.id === id);
    if (!found) throw new Error(`Module inconnu : ${id}`);
    return found;
  }

  snapshot(): Snapshot {
    const space = this.space;
    if (!space) throw new Error("Aucun espace n’est ouvert.");
    const override = (key: string) => space.layout.overrides?.[key];
    const resolve = (module: FakeModule, page: FakePage): ResolvedPage => {
      const reference = `${module.id}/${page.id}`;
      const changed = override(`page:${reference}`);
      return {
        reference,
        module: module.id,
        id: page.id,
        title: changed?.label ?? page.title,
        icon: changed?.icon ?? page.icon ?? null,
        description: "",
        hidden: changed?.hidden ?? false,
        readOnly: false,
        missing: page.missing ?? false,
        errors: page.errors ?? [],
        uses: {},
        panel: null,
      };
    };
    const sections: ResolvedSection[] = space.modules.flatMap((module) =>
      module.sections.map((section) => {
        const id = `${module.id}/${section.id}`;
        const changed = override(`section:${id}`);
        return {
          id,
          module: module.id,
          label: changed?.label ?? section.label,
          icon: changed?.icon ?? section.icon ?? null,
          color: changed?.color ?? section.color ?? null,
          hidden: changed?.hidden ?? false,
          pages: [],
        };
      }),
    );
    const settingsPages: ResolvedPage[] = [];
    const all = space.modules.flatMap((module) => module.pages.map((page) => ({ module, page })));
    for (const { module, page } of all) {
      const placement = page.placement;
      if (placement.kind === "tab") {
        const id = placement.section.includes("/") ? placement.section : `${module.id}/${placement.section}`;
        sections.find((section) => section.id === id)?.pages.push(resolve(module, page));
      } else if (placement.kind === "settings") settingsPages.push(resolve(module, page));
    }
    for (const { module, page } of all) {
      if (page.placement.kind !== "panel") continue;
      const host = page.placement.page;
      const target = sections.flatMap((section) => section.pages).find((candidate) => candidate.reference === host);
      if (target) target.panel = resolve(module, page);
    }
    const order = space.layout.sections;
    sections.sort((left, right) => {
      const rank = (id: string) => (order.includes(id) ? order.indexOf(id) : order.length);
      return rank(left.id) - rank(right.id);
    });
    const functions: ResolvedFunction[] = space.modules.flatMap((module) =>
      module.functions.map((fn) => ({
        reference: `${module.id}/${fn.id}`,
        module: module.id,
        id: fn.id,
        description: fn.description,
        input: { type: "object" },
        output: null,
        tool: fn.tool ?? false,
        missing: false,
        errors: [],
        uses: {},
        runtime: "ts",
      })),
    );
    return {
      path: space.path,
      name: space.name,
      accent: null,
      sections,
      settingsPages,
      modules: space.modules.map((module) => ({
        id: module.id,
        name: module.name,
        version: "0.1.0",
        description: "",
        readOnly: false,
        origin: null,
        hidden: false,
        requires: [],
        requiredBy: [],
        pages: module.pages.length,
        functions: module.functions.length,
        clients: [],
        webhooks: [],
        schedules: [],
      })),
      functions,
      bindings: {},
      problems: [],
      layout: clone(space.layout),
    };
  }

  /** Ce que fait `place_page` côté backend : un nouveau module pour une entrée du menu, sinon le module visé. */
  placePage(title: string, target: PlaceTarget, icon?: string): string {
    const space = this.space;
    if (!space) throw new Error("Aucun espace n’est ouvert.");
    const page: FakePage = { id: slug(title), title, icon, placement: { kind: "settings" }, missing: true };
    let module: FakeModule;
    if (target.kind === "menu") {
      module = { id: slug(target.label), name: target.label, sections: [], pages: [], functions: [] };
      module.sections.push({ id: "principal", label: target.label, icon: target.icon, color: target.color });
      space.modules.push(module);
      page.placement = { kind: "tab", section: "principal" };
    } else if (target.kind === "tab") {
      module = this.module(target.section.split("/")[0] ?? "");
      page.placement = { kind: "tab", section: target.section };
    } else if (target.kind === "panel") {
      module = this.module(target.page.split("/")[0] ?? "");
      page.placement = { kind: "panel", page: target.page };
    } else {
      module = { id: slug(title), name: title, sections: [], pages: [], functions: [] };
      space.modules.push(module);
    }
    module.pages.push(page);
    this.changed.push(`modules/${module.id}/module.json`);
    return `${module.id}/${page.id}`;
  }

  /** L’agent écrit le fichier d’une page : elle n’est plus « en cours de création ». */
  writePage(reference: string, errors: Diagnostic[] = []) {
    const [module, id] = reference.split("/");
    const page = this.module(module ?? "").pages.find((candidate) => candidate.id === id);
    if (!page) throw new Error(`Page inconnue : ${reference}`);
    page.missing = false;
    page.errors = errors;
    this.changed.push(`modules/${module}/pages/${id}.tsx`);
  }

  // -------------------------------------------------------------------------------------------------------------
  // Événements et demandes à l’interface
  // -------------------------------------------------------------------------------------------------------------

  emit(name: string, payload: unknown = null) {
    this.events.push({ name, payload });
    const data = JSON.stringify({ name, payload });
    queueMicrotask(() => {
      for (const source of FakeEventSource.instances) source.onmessage?.({ data });
    });
  }

  /** Comme `ask_ui` : une demande diffusée à l’interface, qui y répond par `ui.resolve`. */
  ask(name: string, payload: Json): Promise<{ result?: unknown; error?: string }> {
    const requestId = `demande-${++this.#sequence}`;
    return new Promise((resolve) => {
      this.pending.set(requestId, (answer) => {
        this.emit("ui:resolved", { requestId });
        resolve(answer);
      });
      this.emit(name, { ...payload, requestId });
    });
  }

  /** Demande d’accord d’accès, mémorisée comme le fait `permissions::ensure`. */
  async ensureGrant(subject: { kind: string; module: string; reference: string }, resource: string, label: string) {
    const key = `${subject.kind === "function" ? "function" : "page"}:${subject.reference}`;
    if (this.grants.some((grant) => grant.subject === key && grant.resource === resource)) return;
    const answer = await this.ask("permission:ask", { subject, resource, label });
    if ((answer.result as { granted?: boolean } | undefined)?.granted !== true)
      throw new Error(`Accès refusé : ${subject.reference} n’a pas le droit d’utiliser ${label}.`);
    this.grants.push({ subject: key, resource, grantedAt: "2026-11-13T09:00:00Z" });
  }

  commandsCalled(): string[] {
    return this.calls.map((call) => call.command);
  }

  lastCall(command: string): Json | undefined {
    return this.calls.filter((call) => call.command === command).at(-1)?.args;
  }

  // -------------------------------------------------------------------------------------------------------------
  // Commandes
  // -------------------------------------------------------------------------------------------------------------

  async invoke(command: string, args: Json): Promise<unknown> {
    this.calls.push({ command, args: clone(args) });
    const handler = this.handlers[command];
    if (!handler) {
      this.unknown.push(command);
      throw new Error(`Commande inconnue : ${command}`);
    }
    return handler(args);
  }

  private commit(message: string): string | null {
    if (!this.space || this.changed.length === 0) return null;
    const id = `c${String(this.commits.length + 1).padStart(7, "0")}`;
    this.commits.push({
      id,
      message,
      date: "2026-11-13T10:00:00+01:00",
      files: [...new Set(this.changed)],
      before: this.#beforeChanges ?? clone(this.space),
    });
    this.changed = [];
    this.#beforeChanges = clone(this.space);
    return id;
  }

  /** État de l’espace au dernier commit : ce qu’une annulation du commit suivant rétablit. */
  #beforeChanges: SpaceState | undefined;

  private readonly handlers: Record<string, (args: Json) => unknown> = {
    // Dossier de travail d’une conversation : dépôt propre, ouvertures sans effet.
    "agentWorkspace.gitSummary": (args) => ({
      root: String(args.path),
      files: [],
      additions: 0,
      deletions: 0,
      truncated: false,
    }),
    "agentWorkspace.openEditor": () => null,
    "agentWorkspace.openExplorer": () => null,
    "badges.list": () => (this.space ? { ...this.badges } : {}),
    "frame.badges.update": (args) => {
      const page = String(args.page);
      const current = this.badges[page] ?? 0;
      const count = Math.max(0, args.op === "increment" ? current + Number(args.value) : Number(args.value));
      if (count === 0) delete this.badges[page];
      else this.badges[page] = count;
      this.emit("badges:changed", { ...this.badges });
      return { count };
    },
    "app.info": () => ({
      version: "0.1.0",
      serverPort: 14731,
      pageBase: "alfred-page://localhost",
      platform: "macos",
      home: "/Users/lea",
    }),
    "voice.status": () => ({
      configured: this.voice.configured,
      listenError: this.voice.configured ? null : "Réglages vocaux invalides : aucun modèle Whisper n’est indiqué.",
      speakError: null,
      listening: this.voice.listening,
      readReplies: this.voice.readReplies,
      dictation: this.voice.dictation,
      readNotifications: this.voice.readNotifications,
      enabled: true,
      qwenInstalled: false,
    }),
    "voice.listen.start": () => {
      if (!this.voice.dictation) throw new Error("La dictée est bloquée (Réglages, onglet Voix).");
      if (!this.voice.configured) throw new Error("Réglages vocaux invalides : aucun modèle Whisper n’est indiqué.");
      this.voice.listening = true;
      return null;
    },
    "voice.listen.stop": () => {
      if (!this.voice.listening) throw new Error("Aucune écoute n’est en cours.");
      this.voice.listening = false;
      this.emit("voice:event", { type: "final", text: this.voice.transcript });
      return { text: this.voice.transcript };
    },
    "voice.listen.cancel": () => {
      this.voice.listening = false;
      return null;
    },
    "voice.speak": (args) => {
      this.voice.spoken.push(String(args.text));
      return { interrupted: false };
    },
    "voice.speak.stop": () => null,
    "voice.enabled.set": (args) => this.handlers["voice.status"]?.(args),
    "voice.preferences.set": (args) => {
      if (typeof args.dictation === "boolean") this.voice.dictation = args.dictation;
      if (typeof args.readNotifications === "boolean") this.voice.readNotifications = args.readNotifications;
      if (!this.voice.dictation) this.voice.listening = false;
      return this.handlers["voice.status"]?.({});
    },
    "frame.voice.listen.start": () => this.handlers["voice.listen.start"]?.({}),
    "frame.voice.listen.stop": () => this.handlers["voice.listen.stop"]?.({}),
    "frame.voice.listen.cancel": () => this.handlers["voice.listen.cancel"]?.({}),
    "frame.voice.speak": (args) => this.handlers["voice.speak"]?.(args),
    "frame.voice.speak.stop": () => null,
    "settings.get": (args) => this.settings.get(String(args.key)) ?? null,
    "settings.set": (args) => {
      this.settings.set(String(args.key), args.value);
      return null;
    },
    "space.restore": () => (this.space && this.lastSpace ? this.#open() : null),
    "space.open": (args) => {
      const path = String(args.path);
      if (this.space?.path !== path) {
        const name = String(args.name ?? path.split("/").at(-1) ?? "Espace");
        this.space = { path, name, modules: [], layout: { sections: [] } };
      }
      this.lastSpace = path;
      return this.#open();
    },
    "space.close": () => {
      this.lastSpace = null;
      return null;
    },
    "space.snapshot": () => this.snapshot(),
    "space.updateLayout": (args) => {
      const space = this.space;
      if (!space) throw new Error("Aucun espace n’est ouvert.");
      if (args.layout) space.layout = clone(args.layout as Layout);
      if (typeof args.name === "string") space.name = args.name;
      this.changed.push("alfred.json");
      this.commit(String(args.message ?? "Réorganisation de la navigation"));
      this.emit("space:changed");
      return this.snapshot();
    },
    "space.commit": (args) => ({ commit: this.commit(String(args.message)) }),
    "space.history": (args) =>
      [...this.commits]
        .reverse()
        .slice(0, Number(args.limit ?? 50))
        .map(({ before: _before, ...commit }) => commit),
    "space.undo": (args) => {
      const target = this.commits.find((commit) => commit.id === args.commit);
      if (!target || !this.space) throw new Error("Commit inconnu.");
      this.space = clone(target.before);
      this.changed.push(...target.files);
      const id = this.commit(`Revert "${target.message}"`);
      this.emit("space:changed");
      return { commit: id };
    },
    "space.deletePage": (args) => {
      const [module, id] = String(args.reference).split("/");
      const owner = this.module(module ?? "");
      owner.pages = owner.pages.filter((page) => page.id !== id);
      this.changed.push(`modules/${module}/pages/${id}.tsx`);
      this.commit(`Suppression de la page ${args.reference}`);
      this.emit("space:changed");
      return null;
    },
    "db.applyMigrations": () => [],
    "pages.frameKey": (args) => ({ key: frameKeyOf(String(args.module)) }),
    "conversations.list": () =>
      [...this.conversations.values()].map(({ turns: _turns, ...header }) => header).reverse(),
    "conversations.get": (args) => this.conversations.get(String(args.id)) ?? null,
    "conversations.save": (args) => {
      const conversation = args.conversation as Json;
      this.conversations.set(String(conversation.id), clone(conversation));
      return null;
    },
    "conversations.delete": (args) => {
      this.conversations.delete(String(args.id));
      return null;
    },
    "agents.probe": () => ({ installed: true, version: "2.1.0", loggedIn: true }),
    "agents.spawn": (args) => this.agent.spawn(args),
    "agents.write": (args) => {
      this.agent.receive(String(args.session), String(args.data));
      return null;
    },
    "agents.kill": (args) => {
      this.agent.kill(String(args.session));
      return null;
    },
    // Les questions sont diffusées à la seule interface du test : aucune n’attend une fenêtre ouverte après coup.
    "ui.waiting": () => [],
    "ui.claim": (args) => this.pending.has(String(args.requestId)),
    "ui.resolve": (args) => {
      const settle = this.pending.get(String(args.requestId));
      if (!settle) throw new Error("Cette demande n’attend plus de réponse.");
      this.pending.delete(String(args.requestId));
      settle(typeof args.error === "string" ? { error: args.error } : { result: args.result });
      return null;
    },
    "grants.list": () => clone(this.grants),
    "grants.revoke": (args) => {
      this.grants = this.grants.filter(
        (grant) => !(grant.subject === args.subject && grant.resource === args.resource),
      );
      return null;
    },
    "journal.list": (args) =>
      this.journal.filter((line) => !args.kind || line.kind === args.kind).slice(0, Number(args.limit ?? 200)),
    "journal.record": (args) => {
      this.journal.unshift({
        id: this.journal.length + 1,
        at: "2026-11-13T10:00:00+01:00",
        kind: args.kind,
        subject: args.subject,
        status: args.ok ? "ok" : "error",
        durationMs: args.durationMs ?? null,
        summary: args.summary,
        detail: args.detail ?? null,
      });
      this.emit("journal:changed");
      return null;
    },
    "vault.list": () => clone(this.vault),
    "clients.list": () => ({
      clients: clone(this.clients),
      needs: [],
      redirectUri: "http://127.0.0.1:14731/oauth/callback",
    }),
    // Les modules du faux espace n’ont besoin d’aucun service : ils sont prêts d’office.
    "modules.setup": () => ({
      modules: (this.space?.modules ?? []).map((module) => ({
        module: module.id,
        name: module.name,
        description: "",
        welcome: "",
        installed: false,
        ready: true,
        steps: [],
      })),
    }),
    "webhooks.list": () => clone(this.webhooks),
    "schedules.list": () => clone(this.schedules),
    "marketplace.list": () => [],
    "marketplace.updates": () => [],
    "marketplace.publications": () => [],
    "functions.call": (args) => this.functionResult(String(args.function), args.input),
    // Requêtes des cadres : la coquille y joint l’identité du cadre, jamais celle que le message prétend.
    "frame.db.query": (args) => [{ demandeur: (args.subject as Json).reference, sql: args.sql }],
    "frame.db.execute": () => ({ changes: 1, lastInsertId: 1 }),
    "frame.functions.authorize": async (args) => {
      const subject = args.subject as { kind: string; module: string; reference: string };
      const reference = String(args.function);
      if (reference.split("/")[0] === subject.module) return null;
      await this.ensureGrant(subject, `function:${reference}`, `la fonction ${reference}`);
      return null;
    },
    "frame.clients.request": async (args) => {
      const subject = args.subject as { kind: string; module: string; reference: string };
      await this.ensureGrant(subject, `client:${args.client}`, `le client ${args.client}`);
      return { status: 200, ok: true, headers: {}, body: { chemin: args.path } };
    },
  };

  #open() {
    const snapshot = this.snapshot();
    this.#beforeChanges ??= clone(this.space as SpaceState);
    return snapshot;
  }
}

// ---------------------------------------------------------------------------------------------------------------
// Faux Claude Code
// ---------------------------------------------------------------------------------------------------------------

/**
 * Un CLI Claude Code joué par script : à chaque message de l’utilisateur, il regarde l’espace, demande l’accord pour
 * une commande, place une page (carte de placement posée par l’outil `place_page`), l’écrit et conclut.
 */
export class FakeClaude {
  readonly #backend: FakeBackend;
  readonly spawned: Json[] = [];
  readonly written: Json[] = [];
  readonly #controlWaiters = new Map<string, (response: Json) => void>();
  #conversation = "";
  #session = "";
  killed = false;
  /** Résultat de la commande soumise à l’accord, et réponse que l’utilisateur a donnée. */
  approvalAnswer: string | undefined;

  constructor(backend: FakeBackend) {
    this.#backend = backend;
  }

  spawn(args: Json) {
    this.spawned.push(clone(args));
    this.#conversation = String(args.conversation ?? "");
    this.#session = `session-${this.spawned.length}`;
    return { session: this.#session };
  }

  kill(session: string) {
    if (session !== this.#session) return;
    this.killed = true;
    this.#backend.emit("agent:output", { session, kind: "closed", code: 0 });
  }

  #out(message: Json) {
    this.#backend.emit("agent:output", { session: this.#session, kind: "stdout", line: JSON.stringify(message) });
  }

  receive(session: string, data: string) {
    for (const line of data.split("\n").filter((text) => text.trim())) {
      const message = JSON.parse(line) as Json;
      this.written.push(message);
      if (message.type === "user") void this.#turn(session, message);
      if (message.type === "control_response") {
        const response = message.response as Json;
        this.#controlWaiters.get(String(response.request_id))?.(response.response as Json);
      }
    }
  }

  async #turn(_session: string, _message: Json) {
    const backend = this.#backend;
    this.#out({ type: "system", subtype: "init", session_id: "claude-session-1" });
    this.#out({
      type: "assistant",
      message: {
        id: "m1",
        content: [
          { type: "text", text: "Je regarde ce que contient l’espace." },
          { type: "tool_use", id: "outil-1", name: "mcp__alfred__space_overview", input: {} },
        ],
      },
    });
    this.#out({ type: "user", message: { content: [{ type: "tool_result", tool_use_id: "outil-1", content: "{}" }] } });

    // Une commande hors de ce qui est permis : la carte d’accord attend l’utilisateur.
    const decided = new Promise<Json>((resolve) => this.#controlWaiters.set("controle-1", resolve));
    this.#out({
      type: "control_request",
      request_id: "controle-1",
      request: { subtype: "can_use_tool", tool_name: "Bash", input: { command: "ls modules" } },
    });
    const decision = await decided;
    this.approvalAnswer = String(decision.behavior);
    this.#out({
      type: "assistant",
      message: {
        id: "m2",
        content: [{ type: "tool_use", id: "outil-2", name: "Bash", input: { command: "ls modules" } }],
      },
    });
    this.#out({
      type: "user",
      message: { content: [{ type: "tool_result", tool_use_id: "outil-2", content: "suivi", is_error: false }] },
    });

    // `place_page` sans emplacement : la carte de placement, puis l’écriture de la page.
    this.#out({
      type: "assistant",
      message: {
        id: "m3",
        content: [{ type: "tool_use", id: "outil-3", name: "mcp__alfred__place_page", input: { title: "Recettes" } }],
      },
    });
    const answer = await backend.ask("agent:question", {
      conversation: this.#conversation,
      kind: "placement",
      payload: { title: "Recettes", description: "Les recettes de la famille.", icon: "chef-hat" },
    });
    let placed = "aucune page";
    if (answer.result) {
      const chosen = answer.result as { title: string; icon?: string; target: PlaceTarget };
      placed = backend.placePage(chosen.title || "Recettes", chosen.target, chosen.icon);
      backend.writePage(placed);
      backend.emit("space:changed");
    }
    this.#out({
      type: "user",
      message: { content: [{ type: "tool_result", tool_use_id: "outil-3", content: answer.error ?? placed }] },
    });
    this.#out({
      type: "assistant",
      message: { id: "m4", content: [{ type: "text", text: `La page **${placed}** est prête.` }] },
    });
    this.#out({ type: "result", subtype: "success", is_error: false, result: "fini" });
  }
}

/** Le faux backend en cours (installé par `install`). */
export function backend(): FakeBackend {
  if (!current) throw new Error("Aucun faux backend installé.");
  return current;
}
