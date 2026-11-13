import { beforeEach, describe, expect, it, vi } from "vitest";
import { type FakeProcess, fakeSpawn, flush, recorder, type Spawned } from "./fakeProcess.test-helper";
import { createOpenCodeSession, listOpenCodeModels, type OpenCodeOptions } from "./opencode";

vi.mock("./process", () => ({ spawnProcess: vi.fn(), probe: vi.fn() }));

const SESSION = "ses_7f3a";

/** Option de configuration ACP « modèle », avec l’effort qu’il propose. */
const modelOption = {
  id: "model",
  category: "model",
  options: [
    { value: "anthropic/claude-sonnet", name: "Claude Sonnet" },
    { value: "openai/gpt-5", name: "GPT-5" },
  ],
};
/** Forme réelle d’OpenCode 2.1 : la valeur « default » s’ajoute aux efforts du modèle. */
const effortOption = {
  id: "effort",
  category: "thought_level",
  type: "select",
  currentValue: "default",
  options: [{ value: "low" }, { value: "high" }, { value: "default" }],
};

/** Faux `opencode acp` : poignée de main, nouvelle session, réglage du modèle ; les tours sont répondus par le test. */
function acpServer(process: FakeProcess) {
  process
    .respond("initialize", {
      result: { protocolVersion: 1, agentCapabilities: { sessionCapabilities: { delete: {} } } },
    })
    .respond("session/new", { result: { sessionId: SESSION, configOptions: [modelOption] } })
    .respond("session/resume", { result: { configOptions: [modelOption] } })
    .respond("session/set_config_option", { result: { configOptions: [modelOption, effortOption] } })
    .respond("session/delete", { result: {} })
    .respond("session/prompt", "later");
}

const update = (value: Record<string, unknown>, sessionId = SESSION) => ({
  jsonrpc: "2.0",
  method: "session/update",
  params: { sessionId, update: value },
});
const text = (value: string) => ({ type: "text", text: value });

let spawned: Spawned[];
beforeEach(() => {
  spawned = fakeSpawn(acpServer);
});

async function open(options: Partial<OpenCodeOptions> = {}) {
  const events = recorder();
  const session = await createOpenCodeSession({
    cwd: "/espace/projet",
    autonomy: "ask",
    onEvent: events.onEvent,
    ...options,
  });
  const launch = spawned.at(-1)!;
  return { session, events, process: launch.process, launch };
}

/** Envoie un message et attend que la requête `session/prompt` soit écrite ; renvoie de quoi y répondre. */
async function prompt(opened: Awaited<ReturnType<typeof open>>, message = "Ajoute une page Factures") {
  const sending = opened.session.send(message);
  await flush(1);
  const request = opened.process.call("session/prompt");
  return {
    request,
    finish: async (stopReason = "end_turn") => {
      opened.process.reply(request.id, { stopReason });
      await sending;
    },
    sending,
  };
}

describe("OpenCode · ouverture", () => {
  it("déclare les outils d’Alfred avec un marqueur de jeton, jamais un vrai jeton", async () => {
    const { launch } = await open({
      conversation: "conv-1",
      toolsUrl: "http://127.0.0.1:4100/mcp",
      instructionsFile: "/espace/.alfred/consignes.md",
    });
    expect(launch.provider).toBe("opencode");
    expect(launch.options.conversation).toBe("conv-1");
    const config = JSON.parse(launch.options.opencodeConfig!);
    expect(config.mcp.servers.alfred).toMatchObject({
      type: "remote",
      url: "http://127.0.0.1:4100/mcp",
      headers: { Authorization: "Bearer __ALFRED_MCP_TOKEN__" },
    });
    // Forme réelle d’OpenCode 2.1 : la dernière règle qui correspond l’emporte sur celles de l’agent.
    expect(config.permissions).toEqual([
      { action: "external_directory", resource: "*", effect: "ask" },
      { action: "alfred_*", resource: "*", effect: "allow" },
    ]);
    expect(config.instructions).toEqual(["/espace/.alfred/consignes.md"]);
    // Seul le marqueur figure dans la configuration : Rust le remplace au lancement.
    expect([...launch.options.opencodeConfig!.matchAll(/Bearer ([^"]*)/g)].map((match) => match[1])).toEqual([
      "__ALFRED_MCP_TOKEN__",
    ]);
  });

  it("règle les autorisations selon l’autonomie, sans jamais tout refuser", async () => {
    const config = async (options: Partial<OpenCodeOptions>) =>
      JSON.parse((await open(options)).launch.options.opencodeConfig!).permissions;
    expect(await config({ autonomy: "auto" })).toBeUndefined();
    expect(await config({ autonomy: "strict" })).toEqual(
      ["edit", "write", "shell", "external_directory"].map((action) => ({ action, resource: "*", effect: "ask" })),
    );
    const denied = await config({ withoutTools: true });
    expect(denied).toContainEqual({ action: "write", resource: "*", effect: "deny" });
    expect(denied).toContainEqual({ action: "shell", resource: "*", effect: "deny" });
    // Un refus global coupe aussi l’accès au modèle : OpenCode répond alors « Free usage limit reached ».
    expect(denied).not.toContainEqual(expect.objectContaining({ action: "*" }));
  });

  it("n’ajoute pas les outils d’Alfred hors d’une conversation", async () => {
    const { launch } = await open({ toolsUrl: "http://127.0.0.1:4100/mcp" });
    expect(JSON.parse(launch.options.opencodeConfig!)).toEqual({
      permissions: [{ action: "external_directory", resource: "*", effect: "ask" }],
    });
  });

  it("se présente, crée la session puis règle le modèle et l’effort", async () => {
    const { process, session, events } = await open({ model: "openai/gpt-5", effort: "high" });
    expect(process.written.map((message) => message.method)).toEqual([
      "initialize",
      "session/new",
      "session/set_config_option",
      "session/set_config_option",
    ]);
    expect(process.call("initialize").params).toEqual({
      protocolVersion: 1,
      clientCapabilities: {},
      clientInfo: { name: "alfred", version: "0.1.0" },
    });
    expect(process.call("session/new").params).toEqual({ cwd: "/espace/projet", mcpServers: [] });
    expect(process.calls("session/set_config_option").map((call) => call.params)).toEqual([
      { sessionId: SESSION, configId: "model", value: "openai/gpt-5" },
      { sessionId: SESSION, configId: "effort", value: "high" },
    ]);
    expect(session.sessionId).toBe(SESSION);
    expect(events.view.sessionId).toBe(SESSION);
    expect(events.view.statuses).toEqual(["connecting", "ready"]);
  });

  it("ignore un effort que le modèle ne propose pas", async () => {
    const { process } = await open({ model: "openai/gpt-5", effort: "max" });
    expect(process.calls("session/set_config_option")).toHaveLength(1);
  });

  it("reprend une session existante", async () => {
    const { process, session } = await open({ resumeSessionId: "ses_ancienne" });
    expect(process.call("session/resume").params).toEqual({
      sessionId: "ses_ancienne",
      cwd: "/espace/projet",
      mcpServers: [],
    });
    expect(session.sessionId).toBe("ses_ancienne");
  });

  it("échoue et arrête le processus quand le CLI refuse la session", async () => {
    spawned = fakeSpawn((process) => {
      acpServer(process);
      process.respond("session/new", { error: { code: -32000, message: "Authentication required" } });
    });
    await expect(open()).rejects.toThrow("Le CLI a refusé la requête : Authentication required.");
    expect(spawned[0].process.killed).toBe(true);
  });
});

describe("OpenCode · un tour", () => {
  it("transmet le message et ses fichiers, puis affiche réponse, réflexion et outils", async () => {
    const opened = await open();
    const { process, events, session } = opened;
    const sending = session.send("Que contient ce devis ?", [
      { path: "/Users/moi/Mes devis/devis 1.pdf", name: "devis 1.pdf", mimeType: "application/pdf" },
    ]);
    await flush(1);
    const request = process.call("session/prompt");
    expect(request.params).toEqual({
      sessionId: SESSION,
      prompt: [
        text("Que contient ce devis ?"),
        {
          type: "resource_link",
          uri: "file:///Users/moi/Mes%20devis/devis%201.pdf",
          name: "devis 1.pdf",
          mimeType: "application/pdf",
        },
      ],
    });
    expect(events.view.statuses.at(-1)).toBe("responding");

    process.send(
      update({ sessionUpdate: "agent_thought_chunk", content: text("Je lis le fichier ") }),
      update({ sessionUpdate: "agent_thought_chunk", content: text("puis je résume.") }),
      update({
        sessionUpdate: "tool_call",
        toolCallId: "call_1",
        title: "bash",
        kind: "execute",
        status: "pending",
        rawInput: { command: "pdftotext devis.pdf -" },
      }),
    );
    expect(events.view.activities).toEqual([
      expect.objectContaining({ kind: "analysis", content: "Je lis le fichier puis je résume." }),
      expect.objectContaining({
        itemId: "call_1",
        kind: "command",
        title: "Commande",
        detail: "pdftotext devis.pdf -",
        status: "running",
      }),
    ]);

    process.send(
      update({
        sessionUpdate: "tool_call_update",
        toolCallId: "call_1",
        status: "completed",
        content: [{ type: "content", content: text("Total : 1 200 €") }],
      }),
      update({ sessionUpdate: "agent_message_chunk", content: text("Le devis s’élève ") }),
      update({ sessionUpdate: "agent_message_chunk", content: text("à 1 200 €.") }),
      // Une mise à jour d’une autre session ne concerne pas cette conversation.
      update({ sessionUpdate: "agent_message_chunk", content: text("Bruit") }, "ses_autre"),
    );
    process.reply(request.id, { stopReason: "end_turn" });
    await sending;

    const view = events.view;
    expect(view.messages).toEqual(["Le devis s’élève à 1 200 €."]);
    expect(view.activities).toEqual([
      expect.objectContaining({ kind: "analysis", status: "completed" }),
      expect.objectContaining({ itemId: "call_1", status: "completed", content: "Total : 1 200 €" }),
    ]);
    expect(view.errors).toEqual([]);
    expect(view.statuses.at(-1)).toBe("idle");
  });

  it("compte les lignes d’une modification de fichier", async () => {
    const opened = await open();
    const turn = await prompt(opened);
    opened.process.send(
      update({
        sessionUpdate: "tool_call",
        toolCallId: "call_2",
        title: "edit",
        kind: "edit",
        status: "completed",
        rawInput: { filePath: "/espace/modules/factures/page.tsx" },
        content: [{ type: "diff", path: "/espace/modules/factures/page.tsx", oldText: "a\nb", newText: "a\nc\nd" }],
      }),
    );
    await turn.finish();
    expect(opened.events.view.activities).toEqual([
      expect.objectContaining({
        kind: "file",
        detail: "/espace/modules/factures/page.tsx",
        actions: [{ type: "edit", path: "/espace/modules/factures/page.tsx", added: 2, removed: 1 }],
        status: "completed",
      }),
    ]);
  });

  it("présente le script du mode code et un outil d’Alfred (formes réelles d’OpenCode 2.1)", async () => {
    const opened = await open();
    const turn = await prompt(opened);
    opened.process.send(
      update({
        sessionUpdate: "tool_call",
        toolCallId: "call_c",
        name: "execute",
        title: "execute",
        kind: "other",
        status: "pending",
        locations: [],
        rawInput: {},
      }),
      update({
        sessionUpdate: "tool_call_update",
        toolCallId: "call_c",
        status: "completed",
        kind: "other",
        title: "execute",
        locations: [],
        rawInput: { code: "return await tools.opencode.list_mcp_resources({});" },
        content: [{ type: "content", content: text("{}") }],
      }),
      update({
        sessionUpdate: "tool_call",
        toolCallId: "call_m",
        name: "alfred_check",
        title: "alfred_check",
        kind: "other",
        status: "completed",
        locations: [],
        rawInput: {},
        content: [{ type: "content", content: text("ok") }],
      }),
    );
    await turn.finish();
    expect(opened.events.view.activities).toEqual([
      expect.objectContaining({
        kind: "command",
        title: "Script d’outils",
        detail: "return await tools.opencode.list_mcp_resources({});",
      }),
      expect.objectContaining({ kind: "tool", title: "Outil · alfred_check", content: "ok" }),
    ]);
  });

  it("compte les lignes d’un fichier créé par l’outil write, qui ne renvoie pas de diff", async () => {
    const opened = await open();
    const turn = await prompt(opened);
    opened.process.send(
      update({
        sessionUpdate: "tool_call_update",
        toolCallId: "call_w",
        status: "completed",
        kind: "edit",
        title: "write",
        locations: [{ path: "/espace/note.txt" }],
        rawInput: { path: "/espace/note.txt", content: "un\ndeux\n" },
        content: [{ type: "content", content: text("Created file successfully: note.txt") }],
      }),
    );
    await turn.finish();
    expect(opened.events.view.activities).toEqual([
      expect.objectContaining({
        kind: "file",
        actions: [{ type: "edit", path: "/espace/note.txt", added: 2, removed: 0 }],
      }),
    ]);
  });

  it("ne laisse pas le plan affiché en cours après le tour", async () => {
    const opened = await open();
    const turn = await prompt(opened);
    opened.process.send(
      update({ sessionUpdate: "plan", entries: [{ content: "Créer la page", status: "in_progress" }] }),
    );
    expect(opened.events.view.activities).toEqual([expect.objectContaining({ title: "Plan", status: "running" })]);
    await turn.finish();
    expect(opened.events.view.activities).toEqual([
      expect.objectContaining({
        title: "Plan",
        status: "completed",
        content: expect.stringContaining("Créer la page"),
      }),
    ]);
  });

  it("sépare les messages d’un tour à l’autre", async () => {
    const opened = await open();
    let turn = await prompt(opened, "Un");
    opened.process.send(update({ sessionUpdate: "agent_message_chunk", content: text("Réponse un.") }));
    await turn.finish();
    opened.process.written.length = 0;
    turn = await prompt(opened, "Deux");
    opened.process.send(update({ sessionUpdate: "agent_message_chunk", content: text("Réponse deux.") }));
    await turn.finish();
    expect(opened.events.view.messages).toEqual(["Réponse un.", "Réponse deux."]);
  });

  it("affiche le refus du modèle comme une erreur", async () => {
    const opened = await open();
    const turn = await prompt(opened);
    await turn.finish("refusal");
    expect(opened.events.view.errors).toEqual(["OpenCode a refusé la demande."]);
    expect(opened.events.view.statuses.at(-1)).toBe("idle");
  });

  it("affiche l’erreur du CLI quand le tour échoue", async () => {
    const opened = await open();
    const turn = await prompt(opened);
    opened.process.send({ jsonrpc: "2.0", id: turn.request.id, error: { code: -32603, message: "Model not found" } });
    await turn.sending;
    expect(opened.events.view.errors).toEqual([expect.stringContaining("Model not found")]);
  });
});

describe("OpenCode · autorisations", () => {
  const permission = (id: number) => ({
    jsonrpc: "2.0",
    id,
    method: "session/request_permission",
    params: {
      sessionId: SESSION,
      toolCall: {
        toolCallId: "call_3",
        name: "shell",
        title: "rm -rf dist",
        kind: "execute",
        status: "pending",
        locations: [{ path: "/espace/projet" }],
        rawInput: { command: "rm -rf dist", cwd: "/espace/projet" },
      },
      options: [
        { optionId: "once", kind: "allow_once", name: "Allow once" },
        { optionId: "always", kind: "allow_always", name: "Always allow" },
        { optionId: "reject", kind: "reject_once", name: "Reject" },
      ],
    },
  });

  it("en autonomie « ask », présente une carte et transmet le choix", async () => {
    const opened = await open({ autonomy: "ask" });
    const turn = await prompt(opened);
    opened.process.send(permission(90));
    expect(opened.events.view.approvals).toEqual([
      {
        id: "opencode-90",
        title: "Exécuter une commande",
        detail: "rm -rf dist",
        options: [
          { id: "once", label: "Autoriser", kind: "allow" },
          { id: "always", label: "Toujours autoriser", kind: "allowAlways" },
          { id: "reject", label: "Refuser", kind: "deny" },
        ],
      },
    ]);
    await opened.session.answer("opencode-90", "always");
    expect(opened.process.responseTo(90)).toEqual({
      jsonrpc: "2.0",
      id: 90,
      result: { outcome: { outcome: "selected", optionId: "always" } },
    });
    await expect(opened.session.answer("opencode-90", "always")).rejects.toThrow("n’est plus en attente");
    await turn.finish();
  });

  it("en autonomie « auto », accorde une fois sans question", async () => {
    const opened = await open({ autonomy: "auto" });
    await prompt(opened);
    opened.process.send(permission(91));
    await flush(1);
    expect(opened.events.view.approvals).toEqual([]);
    expect(opened.process.responseTo(91)).toMatchObject({
      result: { outcome: { outcome: "selected", optionId: "once" } },
    });
  });

  it("ferme la carte restée sans réponse à la fin du tour", async () => {
    const opened = await open();
    const turn = await prompt(opened);
    opened.process.send(permission(92));
    await turn.finish();
    expect(opened.events.view.approvals).toEqual([]);
  });

  it("répond en erreur aux méthodes client non prises en charge", async () => {
    const opened = await open();
    opened.process.send({ jsonrpc: "2.0", id: 93, method: "fs/read_text_file", params: { path: "/etc/hosts" } });
    await flush(1);
    expect(opened.process.responseTo(93)).toMatchObject({ error: { code: -32601 } });
  });
});

describe("OpenCode · annulation et fermeture", () => {
  it("annule le tour, retire les cartes et ne montre pas d’erreur", async () => {
    const opened = await open();
    const turn = await prompt(opened);
    opened.process.send({
      jsonrpc: "2.0",
      id: 94,
      method: "session/request_permission",
      params: { sessionId: SESSION, toolCall: { title: "bash" }, options: [{ optionId: "once", kind: "allow_once" }] },
    });
    await opened.session.cancel();
    expect(opened.process.responseTo(94)).toMatchObject({ result: { outcome: { outcome: "cancelled" } } });
    expect(opened.process.call("session/cancel")).toMatchObject({ params: { sessionId: SESSION } });
    expect(opened.process.call("session/cancel")).not.toHaveProperty("id");
    expect(opened.events.view.approvals).toEqual([]);
    await turn.finish("cancelled");
    expect(opened.events.view.errors).toEqual([]);
    expect(opened.events.view.statuses.at(-1)).toBe("idle");
  });

  it("supprime une session éphémère à la fermeture, puis arrête le processus", async () => {
    const opened = await open({ ephemeral: true });
    await opened.session.close();
    expect(opened.process.call("session/delete").params).toEqual({ sessionId: SESSION });
    expect(opened.process.killed).toBe(true);
    expect(opened.events.view.statuses.at(-1)).toBe("closed");
    expect(opened.events.view.errors).toEqual([]);
  });

  it("garde une session ordinaire dans l’historique d’OpenCode", async () => {
    const opened = await open();
    await opened.session.close();
    expect(opened.process.calls("session/delete")).toEqual([]);
    expect(opened.process.killed).toBe(true);
  });

  it("signale l’arrêt inattendu du processus pendant un tour", async () => {
    const opened = await open();
    const turn = await prompt(opened);
    opened.process.exit(1);
    await turn.sending;
    const view = opened.events.view;
    expect(view.errors).toEqual(["OpenCode s’est arrêté. Envoyer un message relance la conversation."]);
    expect(view.statuses.at(-1)).toBe("closed");
    await expect(opened.session.send("Encore")).rejects.toThrow("fermée");
  });
});

describe("OpenCode · catalogue", () => {
  it("lit les modèles et leurs efforts, puis supprime la session de lecture", async () => {
    await expect(listOpenCodeModels("/espace")).resolves.toEqual([
      { id: "anthropic/claude-sonnet", name: "Claude Sonnet", efforts: ["low", "high"] },
      { id: "openai/gpt-5", name: "GPT-5", efforts: ["low", "high"] },
    ]);
    const { process } = spawned[0];
    expect(process.call("session/delete").params).toEqual({ sessionId: SESSION });
    expect(process.killed).toBe(true);
  });
});
