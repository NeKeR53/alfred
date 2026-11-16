import { beforeEach, describe, expect, it, vi } from "vitest";
import { type CodexOptions, codexPolicy, createCodexSession, listCodexModels } from "./codex";
import { type FakeProcess, fakeSpawn, flush, recorder, type Spawned } from "./fakeProcess.test-helper";
import type { Autonomy } from "./types";

vi.mock("./process", () => ({ spawnProcess: vi.fn(), probe: vi.fn() }));

/** Faux `codex app-server` : il répond à la poignée de main, ouvre un fil et accepte les tours. */
function codexServer(process: FakeProcess) {
  let turns = 0;
  process
    .respond("initialize", { result: { userAgent: "codex/0.50" } })
    .respond("thread/start", { result: { thread: { id: "thr_new" } } })
    .respond("thread/resume", (params) => ({ result: { thread: { id: params.threadId } } }))
    .respond("thread/name/set", { result: {} })
    .respond("turn/start", () => ({ result: { turn: { id: `turn_${++turns}`, status: "inProgress" } } }))
    .respond("turn/interrupt", { result: {} });
}

/** Notifications du serveur pendant un tour. */
const notify = (method: string, params: Record<string, unknown>) => ({ method, params });
const item = (method: "item/started" | "item/completed", value: Record<string, unknown>) =>
  notify(method, { threadId: "thr_new", turnId: "turn_1", item: value });
const turnCompleted = (turnId: string, status = "completed", error?: unknown) =>
  notify("turn/completed", { threadId: "thr_new", turn: { id: turnId, status, ...(error ? { error } : {}) } });

let spawned: Spawned[];
beforeEach(() => {
  spawned = fakeSpawn(codexServer);
});

async function open(options: Partial<CodexOptions> = {}) {
  const events = recorder();
  const session = await createCodexSession({
    cwd: "/espace/projet",
    autonomy: "ask",
    onEvent: events.onEvent,
    ...options,
  });
  const launch = spawned.at(-1)!;
  return { session, events, process: launch.process, launch };
}

describe("Codex · ouverture de la discussion", () => {
  it("se présente, ouvre un fil avec les outils d’Alfred et le nomme", async () => {
    const { process, events, launch, session } = await open({
      conversation: "conv-1",
      toolsUrl: "http://127.0.0.1:4100/mcp",
      instructions: "Réponds en français.",
      model: "gpt-5-codex",
      title: "Page Factures",
    });
    expect(launch.options).toEqual({ cwd: "/espace/projet", conversation: "conv-1" });
    expect(process.written.map((message) => message.method)).toEqual([
      "initialize",
      "initialized",
      "thread/start",
      "thread/name/set",
    ]);
    expect(process.call("initialize").params).toEqual({
      clientInfo: { name: "alfred", title: "Alfred", version: "0.1.0" },
      capabilities: null,
    });
    expect(process.call("thread/start").params).toEqual({
      cwd: "/espace/projet",
      approvalPolicy: "on-request",
      sandbox: "workspace-write",
      model: "gpt-5-codex",
      developerInstructions: "Réponds en français.",
      ephemeral: false,
      config: {
        "mcp_servers.alfred": {
          url: "http://127.0.0.1:4100/mcp",
          enabled: true,
          default_tools_approval_mode: "approve",
          bearer_token_env_var: "ALFRED_MCP_TOKEN",
        },
      },
    });
    expect(process.call("thread/name/set").params).toEqual({ threadId: "thr_new", name: "Page Factures" });
    expect(session.sessionId).toBe("thr_new");
    expect(events.view.sessionId).toBe("thr_new");
    expect(events.view.statuses).toEqual(["connecting", "ready"]);
  });

  it.each<[Autonomy, string, string]>([
    ["ask", "on-request", "workspace-write"],
    ["auto", "never", "danger-full-access"],
    ["strict", "untrusted", "read-only"],
  ])("en autonomie « %s », approbation %s et bac à sable %s", async (autonomy, approvalPolicy, sandbox) => {
    const { process } = await open({ autonomy });
    expect(process.call("thread/start").params).toMatchObject({ approvalPolicy, sandbox });
  });

  it("reprend un fil existant sans le renommer", async () => {
    const { process, session } = await open({ resumeSessionId: "thr_ancien", title: "Page Factures" });
    expect(process.call("thread/resume").params).toMatchObject({ threadId: "thr_ancien", excludeTurns: true });
    expect(process.calls("thread/start")).toEqual([]);
    expect(process.calls("thread/name/set")).toEqual([]);
    expect(session.sessionId).toBe("thr_ancien");
  });

  it("échoue clairement et arrête le processus quand le CLI refuse d’ouvrir le fil", async () => {
    spawned = fakeSpawn((process) => {
      codexServer(process);
      process.respond("thread/start", { error: { code: -32600, message: "model not supported" } });
    });
    await expect(open()).rejects.toThrow("(model not supported)");
    expect(spawned[0].process.killed).toBe(true);
  });

  it("exige un dossier de travail", async () => {
    await expect(open({ cwd: "  " })).rejects.toThrow("Le dossier de travail est requis");
  });
});

describe("Codex · un tour", () => {
  it("démarre le tour avec le bac à sable de l’espace, suit commande et modification, puis termine", async () => {
    const { session, process, events } = await open({ spaceDir: "/espace", effort: "high" });
    await session.send(
      "Ajoute une page Factures",
      [
        { path: "/tmp/maquette.png", name: "maquette.png" },
        { path: "/tmp/tarifs.csv", name: "tarifs.csv" },
      ],
      "msg-1",
    );

    expect(process.call("turn/start").params).toEqual({
      threadId: "thr_new",
      input: [
        // Un fichier qui n’est pas une image est cité par son chemin, l’image part en `localImage`.
        { type: "text", text: "Ajoute une page Factures\n\nFichiers joints :\n- /tmp/tarifs.csv", text_elements: [] },
        { type: "localImage", path: "/tmp/maquette.png" },
      ],
      clientUserMessageId: "msg-1",
      cwd: "/espace/projet",
      approvalPolicy: "on-request",
      sandboxPolicy: { type: "workspaceWrite", writableRoots: ["/espace/projet", "/espace"], networkAccess: false },
      effort: "high",
    });
    expect(events.view.statuses.at(-1)).toBe("responding");

    process.send(
      item("item/started", { id: "rs_1", type: "reasoning", summary: [] }),
      notify("item/reasoning/summaryTextDelta", { itemId: "rs_1", delta: "Lire les règles" }),
      item("item/completed", { id: "rs_1", type: "reasoning", summary: ["Lire les règles"] }),
      item("item/started", {
        id: "cmd_1",
        type: "commandExecution",
        command: "cat AGENTS.md",
        commandActions: [{ type: "read", path: "AGENTS.md" }],
        status: "inProgress",
      }),
    );
    expect(events.view.activities.at(-1)).toMatchObject({
      itemId: "cmd_1",
      kind: "command",
      detail: "cat AGENTS.md",
      actions: [{ type: "read", path: "AGENTS.md" }],
      status: "running",
    });

    process.send(
      notify("item/commandExecution/outputDelta", { itemId: "cmd_1", delta: "# Règles\n" }),
      item("item/completed", {
        id: "cmd_1",
        type: "commandExecution",
        command: "cat AGENTS.md",
        aggregatedOutput: "# Règles\n",
        status: "completed",
      }),
      item("item/started", {
        id: "fc_1",
        type: "fileChange",
        status: "inProgress",
        changes: [{ path: "/espace/modules/factures/page.tsx", diff: "+++ b\n+ligne 1\n+ligne 2\n-ancienne" }],
      }),
      item("item/completed", {
        id: "fc_1",
        type: "fileChange",
        status: "completed",
        changes: [
          { path: "/espace/modules/factures/page.tsx", diff: "+++ b\n+ligne 1\n+ligne 2\n-ancienne" },
          // Une création porte le contenu entier, sans préfixe « + ».
          {
            path: "/espace/modules/factures/0001.sql",
            kind: { type: "add" },
            diff: "CREATE TABLE f (\n  id INTEGER\n);\n",
          },
        ],
      }),
      notify("item/agentMessage/delta", { itemId: "am_1", delta: "Page " }),
      notify("item/agentMessage/delta", { itemId: "am_1", delta: "créée." }),
      item("item/completed", { id: "am_1", type: "agentMessage", text: "Page créée." }),
      turnCompleted("turn_1"),
    );

    const view = events.view;
    expect(view.messages).toEqual(["Page créée."]);
    expect(view.activities).toEqual([
      expect.objectContaining({ itemId: "rs_1", kind: "analysis", status: "completed", content: "Lire les règles" }),
      expect.objectContaining({ itemId: "cmd_1", status: "completed", content: "# Règles\n" }),
      expect.objectContaining({
        itemId: "fc_1",
        kind: "file",
        detail: "/espace/modules/factures/page.tsx\n/espace/modules/factures/0001.sql",
        actions: [
          { type: "edit", path: "/espace/modules/factures/page.tsx", added: 2, removed: 1 },
          { type: "edit", path: "/espace/modules/factures/0001.sql", added: 3, removed: 0 },
        ],
        status: "completed",
      }),
    ]);
    expect(view.errors).toEqual([]);
    expect(view.statuses.at(-1)).toBe("idle");
    // Le tour fini, un nouveau message repart.
    await session.send("Merci");
    expect(process.calls("turn/start")).toHaveLength(2);
  });

  it("refuse un second message pendant la réponse", async () => {
    const { session } = await open();
    await session.send("Un");
    await expect(session.send("Deux")).rejects.toThrow("Codex prépare déjà une réponse.");
  });

  it("marque en échec une commande refusée ou en erreur", async () => {
    const { session, process, events } = await open();
    await session.send("Lance les tests");
    process.send(
      item("item/completed", { id: "cmd_2", type: "commandExecution", command: "pnpm test", status: "failed" }),
    );
    expect(events.view.activities).toEqual([expect.objectContaining({ itemId: "cmd_2", status: "failed" })]);
  });

  it("affiche l’erreur d’un tour en échec avec le motif du modèle", async () => {
    const { session, process, events } = await open();
    await session.send("Ajoute une page");
    process.send(
      notify("error", { error: { message: "Reconnecting… 1/5" }, willRetry: true, turnId: "turn_1" }),
      notify("error", { error: { message: "You've hit your usage limit." }, willRetry: false, turnId: "turn_1" }),
      turnCompleted("turn_1", "failed", { message: "You've hit your usage limit." }),
    );
    const view = events.view;
    expect(view.activities).toEqual([
      expect.objectContaining({ title: "Reconnexion au modèle", content: "Reconnecting… 1/5" }),
    ]);
    expect(view.errors).toEqual(["Codex n’a pas pu terminer sa réponse : You've hit your usage limit."]);
    expect(view.statuses.at(-1)).toBe("idle");
  });
});

describe("Codex · demandes d’approbation", () => {
  async function pending() {
    const opened = await open();
    await opened.session.send("Nettoie le dossier");
    opened.process.send({
      id: 41,
      method: "item/commandExecution/requestApproval",
      params: {
        threadId: "thr_new",
        turnId: "turn_1",
        itemId: "cmd_9",
        command: "rm -rf dist",
        cwd: "/espace/projet",
        reason: "Hors du bac à sable",
      },
    });
    await flush();
    return opened;
  }

  it("remonte la commande sous forme de carte", async () => {
    const { events } = await pending();
    expect(events.view.approvals).toEqual([
      {
        id: "codex-41",
        title: "Exécuter une commande",
        detail: "rm -rf dist\ndans /espace/projet\nHors du bac à sable",
        options: [
          { id: "accept", label: "Autoriser", kind: "allow" },
          { id: "acceptForSession", label: "Autoriser pour cette conversation", kind: "allowAlways" },
          { id: "decline", label: "Refuser", kind: "deny" },
        ],
      },
    ]);
  });

  it.each(["accept", "acceptForSession", "decline"])("répond « %s » à la requête du CLI", async (decision) => {
    const { session, process } = await pending();
    await session.answer("codex-41", decision);
    expect(process.responseTo(41)).toEqual({ id: 41, result: { decision } });
    await expect(session.answer("codex-41", decision)).rejects.toThrow("n’est plus en attente");
  });

  it("remonte aussi une modification de fichiers hors des dossiers", async () => {
    const { session, process, events } = await open();
    await session.send("Modifie la config");
    process.send({
      id: 42,
      method: "item/fileChange/requestApproval",
      params: { itemId: "fc_9", reason: "Écriture hors de l’espace" },
    });
    await flush();
    expect(events.view.approvals).toEqual([
      expect.objectContaining({
        title: "Modifier des fichiers hors des dossiers de l’agent",
        detail: "Écriture hors de l’espace",
      }),
    ]);
  });

  it("ferme la carte à la fin du tour", async () => {
    const { process, events } = await pending();
    process.send(turnCompleted("turn_1"));
    expect(events.view.approvals).toEqual([]);
  });

  it("répond en erreur aux requêtes que le CLI envoie et qu’Alfred ne connaît pas", async () => {
    const { session, process } = await open();
    await session.send("Bonjour");
    process.send({ id: 43, method: "item/tool/requestUserInput", params: {} });
    await flush();
    expect(process.responseTo(43)).toEqual({
      id: 43,
      error: { code: -32601, message: "Cette interaction n’est pas prise en charge par Alfred." },
    });
  });
});

describe("Codex · annulation et arrêt", () => {
  it("interrompt le tour en cours et refuse les commandes en attente", async () => {
    const { session, process, events } = await open();
    await session.send("Lance le build");
    process.send({ id: 50, method: "item/commandExecution/requestApproval", params: { command: "pnpm build" } });
    await flush();
    await session.cancel();
    expect(process.responseTo(50)).toEqual({ id: 50, result: { decision: "cancel" } });
    expect(process.call("turn/interrupt").params).toEqual({ threadId: "thr_new", turnId: "turn_1" });
    expect(events.view.approvals).toEqual([]);
    // La confirmation du CLI ne termine pas le tour une seconde fois.
    process.send(turnCompleted("turn_1", "interrupted"));
    expect(events.view.statuses).toEqual(["connecting", "ready", "responding", "idle"]);
  });

  it("ne laisse pas la fin du tour interrompu terminer le tour suivant", async () => {
    const { session, process, events } = await open();
    await session.send("Lance le build");
    await session.cancel();
    await session.send("Plutôt les tests");
    expect(process.calls("turn/start")).toHaveLength(2);
    const before = events.events.length;

    // Les derniers éléments du premier tour et la confirmation de son interruption arrivent après le départ du second.
    process.send(
      item("item/completed", { id: "cmd_old", type: "commandExecution", command: "pnpm build", status: "interrupted" }),
      turnCompleted("turn_1", "interrupted"),
    );
    expect(events.events.slice(before)).toEqual([]);
    await expect(session.send("Encore autre chose")).rejects.toThrow("Codex prépare déjà une réponse.");

    process.send(turnCompleted("turn_2"));
    expect(events.view.statuses.at(-1)).toBe("idle");
  });

  it("signale l’arrêt inattendu du processus et rejette la requête en attente", async () => {
    spawned = fakeSpawn((process) => {
      codexServer(process);
      process.respond("turn/start", "later");
    });
    const { session, process, events } = await open();
    const sending = session.send("Bonjour");
    await flush();
    process.exit(1);
    await expect(sending).rejects.toThrow("Codex s’est arrêté.");
    expect(events.view.errors).toEqual(["Codex s’est arrêté. Envoyer un message relance la conversation."]);
    expect(events.view.statuses.at(-1)).toBe("closed");
    await expect(session.send("Encore")).rejects.toThrow("fermée");
  });

  it("ferme la discussion sans signaler d’erreur", async () => {
    const { session, process, events } = await open();
    await session.close();
    process.exit(0);
    expect(process.killed).toBe(true);
    expect(events.view.errors).toEqual([]);
    expect(events.view.statuses.at(-1)).toBe("closed");
  });
});

describe("Codex · catalogue et appel unique", () => {
  it("lit le catalogue de modèles page par page puis arrête le processus", async () => {
    spawned = fakeSpawn((process) =>
      process.respond("initialize", { result: {} }).respond("model/list", (params) =>
        params.cursor === "page-2"
          ? { result: { data: [{ model: "gpt-5-mini", supportedReasoningEfforts: [] }] } }
          : {
              result: {
                data: [
                  {
                    model: "gpt-5-codex",
                    displayName: "GPT-5 Codex",
                    supportedReasoningEfforts: [{ reasoningEffort: "low" }, { reasoningEffort: "high" }],
                  },
                  { displayName: "sans identifiant" },
                ],
                nextCursor: "page-2",
              },
            },
      ),
    );
    await expect(listCodexModels("/espace")).resolves.toEqual([
      { id: "gpt-5-codex", name: "GPT-5 Codex", efforts: ["low", "high"] },
      { id: "gpt-5-mini", name: "gpt-5-mini", efforts: [] },
    ]);
    const { process, options } = spawned[0];
    expect(options).toEqual({ cwd: "/espace" });
    expect(process.calls("model/list").map((call) => call.params)).toEqual([
      { limit: 100 },
      { limit: 100, cursor: "page-2" },
    ]);
    expect(process.killed).toBe(true);
  });

  it("appel unique : fil éphémère en lecture seule, sans outil, réponse contrainte par le schéma", async () => {
    const schema = { type: "object", properties: { titre: { type: "string" } } };
    const { session, process, launch, events } = await open({
      readOnly: true,
      ephemeral: true,
      outputSchema: schema,
      conversation: "conv-1",
      toolsUrl: "http://127.0.0.1:4100/mcp",
      autonomy: "auto",
    });
    expect(launch.options).toEqual({ cwd: "/espace/projet" });
    const start = process.call("thread/start").params;
    expect(start).toMatchObject({ approvalPolicy: "never", sandbox: "read-only", ephemeral: true });
    expect(start.config).toMatchObject({
      "features.shell_tool": false,
      web_search: "disabled",
      project_doc_max_bytes: 0,
    });
    expect(start.config).not.toHaveProperty("mcp_servers.alfred");

    await session.send("Donne un titre");
    expect(process.call("turn/start").params).toMatchObject({
      sandboxPolicy: { type: "readOnly" },
      approvalPolicy: "never",
      outputSchema: schema,
    });
    process.send({ id: 60, method: "item/commandExecution/requestApproval", params: { command: "ls" } });
    await flush();
    expect(process.responseTo(60)).toEqual({ id: 60, result: { decision: "decline" } });
    expect(events.view.approvals).toEqual([]);

    process.send(
      item("item/completed", { id: "am_1", type: "agentMessage", text: '{"titre":"Factures"}' }),
      turnCompleted("turn_1"),
    );
    expect(events.view.messages).toEqual(['{"titre":"Factures"}']);
  });
});

describe("Codex · Windows", () => {
  it("n’utilise jamais le bac à sable workspace-write, comme OneApp", () => {
    for (const autonomy of ["ask", "auto"] as const)
      expect(codexPolicy(autonomy, ["C:\\espace"], true)).toEqual({
        approvalPolicy: "never",
        sandbox: "danger-full-access",
        sandboxPolicy: { type: "dangerFullAccess" },
      });
    expect(codexPolicy("strict", ["C:\\espace"], true)).toMatchObject({
      approvalPolicy: "never",
      sandbox: "read-only",
    });
    expect(codexPolicy("ask", ["/espace"], false)).toMatchObject({ sandbox: "workspace-write" });
  });
});
