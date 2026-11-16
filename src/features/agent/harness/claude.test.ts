import { beforeEach, describe, expect, it, vi } from "vitest";
import { type ClaudeOptions, createClaudeSession } from "./claude";
import { type FakeProcess, fakeSpawn, recorder, type Spawned } from "./fakeProcess.test-helper";
import type { Autonomy, HarnessSession } from "./types";

vi.mock("./process", () => ({ spawnProcess: vi.fn(), probe: vi.fn() }));

/** Lignes que le CLI `claude -p --output-format stream-json --include-partial-messages` écrit sur sa sortie. */
const cli = {
  init: (sessionId = "8c1f0a52-3d1e-4c3a-9b7e-0d6f2a7e5b11") => ({
    type: "system",
    subtype: "init",
    session_id: sessionId,
    tools: ["Bash", "Read", "Edit"],
    model: "claude-opus",
  }),
  stream: (event: Record<string, unknown>) => ({ type: "stream_event", event }),
  messageStart: (id: string) => cli.stream({ type: "message_start", message: { id, role: "assistant", content: [] } }),
  blockStart: (index: number, block: Record<string, unknown>) =>
    cli.stream({ type: "content_block_start", index, content_block: block }),
  textDelta: (index: number, text: string) =>
    cli.stream({ type: "content_block_delta", index, delta: { type: "text_delta", text } }),
  thinkingDelta: (index: number, thinking: string) =>
    cli.stream({ type: "content_block_delta", index, delta: { type: "thinking_delta", thinking } }),
  blockStop: (index: number) => cli.stream({ type: "content_block_stop", index }),
  assistant: (id: string, content: Array<Record<string, unknown>>, extra: Record<string, unknown> = {}) => ({
    type: "assistant",
    message: { id, role: "assistant", model: "claude-opus", content },
    parent_tool_use_id: null,
    ...extra,
  }),
  toolResult: (toolUseId: string, content: unknown, isError = false) => ({
    type: "user",
    message: { role: "user", content: [{ type: "tool_result", tool_use_id: toolUseId, content, is_error: isError }] },
  }),
  canUseTool: (requestId: string, tool: string, input: Record<string, unknown>, suggestions?: unknown[]) => ({
    type: "control_request",
    request_id: requestId,
    request: {
      subtype: "can_use_tool",
      tool_name: tool,
      input,
      ...(suggestions ? { permission_suggestions: suggestions } : {}),
    },
  }),
  success: (result = "", extra: Record<string, unknown> = {}) => ({
    type: "result",
    subtype: "success",
    is_error: false,
    result,
    ...extra,
  }),
};

/** Messages écrits par Alfred sur l’entrée du CLI, par type. */
const writtenOf = (process: FakeProcess, type: string) => process.written.filter((message) => message.type === type);
const controlResponses = (process: FakeProcess) =>
  writtenOf(process, "control_response").map((message) => message.response as Record<string, unknown>);

let spawned: Spawned[];
beforeEach(() => {
  spawned = fakeSpawn();
});

async function open(options: Partial<ClaudeOptions> = {}) {
  const events = recorder();
  const session = await createClaudeSession({
    cwd: "/espace/projet",
    autonomy: "ask",
    onEvent: events.onEvent,
    ...options,
  });
  const launch = spawned.at(-1)!;
  return { session, events, process: launch.process, launch };
}

/** Un message envoyé, puis l’ouverture de session que le CLI annonce au premier message. */
async function sendFirst(session: HarnessSession, process: FakeProcess, text = "Ajoute une page Factures") {
  await session.send(text);
  process.send(cli.init());
}

describe("Claude Code · lancement", () => {
  it.each<[Autonomy, string]>([
    ["ask", "acceptEdits"],
    ["auto", "bypassPermissions"],
    ["strict", "manual"],
  ])("l’autonomie « %s » lance le CLI en mode %s", async (autonomy, permissionMode) => {
    const { launch, events } = await open({ autonomy, conversation: "conv-1", spaceDir: "/espace" });
    expect(launch.provider).toBe("claude");
    expect(launch.options).toEqual({
      cwd: "/espace/projet",
      conversation: "conv-1",
      claude: { permissionMode, addDirs: ["/espace"] },
    });
    expect(events.view.statuses).toEqual(["connecting", "ready"]);
  });

  it("reprend la session, transmet modèle, effort et consignes, sans dossier en double", async () => {
    const { launch } = await open({
      spaceDir: "/espace/projet",
      model: "opus",
      effort: "high",
      instructions: "Réponds en français.",
      resumeSessionId: "8c1f0a52-3d1e-4c3a-9b7e-0d6f2a7e5b11",
    });
    expect(launch.options.claude).toEqual({
      model: "opus",
      effort: "high",
      appendSystemPrompt: "Réponds en français.",
      permissionMode: "acceptEdits",
      addDirs: [],
      resume: "8c1f0a52-3d1e-4c3a-9b7e-0d6f2a7e5b11",
    });
  });

  it("laisse le CLI choisir le modèle par défaut du compte", async () => {
    const { launch } = await open({ model: "default" });
    expect(launch.options.claude).not.toHaveProperty("model");
  });
});

describe("Claude Code · un tour de conversation", () => {
  it("envoie le message, diffuse la réponse puis ne la double pas à l’arrivée du message complet", async () => {
    const { session, process, events } = await open();
    await sendFirst(session, process, "  Ajoute une page Factures  ");

    expect(writtenOf(process, "user")).toEqual([
      {
        type: "user",
        message: { role: "user", content: [{ type: "text", text: "Ajoute une page Factures" }] },
        parent_tool_use_id: null,
      },
    ]);
    process.send(
      cli.messageStart("msg_01"),
      cli.blockStart(0, { type: "text", text: "" }),
      cli.textDelta(0, "Je crée "),
      cli.textDelta(0, "la page."),
      cli.blockStop(0),
      cli.assistant("msg_01", [{ type: "text", text: "Je crée la page." }]),
      cli.success("Je crée la page."),
    );

    const view = events.view;
    expect(view.sessionId).toBe("8c1f0a52-3d1e-4c3a-9b7e-0d6f2a7e5b11");
    expect(session.sessionId).toBe("8c1f0a52-3d1e-4c3a-9b7e-0d6f2a7e5b11");
    expect(view.messages).toEqual(["Je crée la page."]);
    expect(view.errors).toEqual([]);
    expect(view.statuses).toEqual(["connecting", "ready", "responding", "idle"]);
  });

  it("affiche un message arrivé sans diffusion (reprise, réponse courte)", async () => {
    const { session, process, events } = await open();
    await sendFirst(session, process);
    process.send(cli.assistant("msg_02", [{ type: "text", text: "C’est fait." }]), cli.success("C’est fait."));
    expect(events.view.messages).toEqual(["C’est fait."]);
  });

  it("cite les fichiers joints par leur chemin, images comprises", async () => {
    const { session, process } = await open();
    await session.send("Que montre cette capture ?", [
      { path: "/Users/moi/Bureau/capture.png", name: "capture.png", mimeType: "image/png" },
      { path: "/Users/moi/devis.pdf", name: "devis.pdf" },
    ]);
    const [message] = writtenOf(process, "user");
    expect(message.message).toEqual({
      role: "user",
      content: [
        {
          type: "text",
          text: "Que montre cette capture ?\n\nFichiers joints :\n- /Users/moi/Bureau/capture.png\n- /Users/moi/devis.pdf",
        },
      ],
    });
  });

  it("envoie la demande de OneApp quand le message n’a que des pièces jointes", async () => {
    const { session, process } = await open();
    await session.send("", [{ path: "/Users/moi/devis.pdf", name: "devis.pdf" }]);
    const [message] = writtenOf(process, "user");
    expect(message.message).toEqual({
      role: "user",
      content: [{ type: "text", text: "Analyse les fichiers joints.\n\nFichiers joints :\n- /Users/moi/devis.pdf" }],
    });
  });

  it("refuse un second message tant que la réponse n’est pas finie", async () => {
    const { session, process } = await open();
    await sendFirst(session, process);
    await expect(session.send("Et aussi…")).rejects.toThrow("prépare déjà une réponse");
    process.send(cli.success());
    await expect(session.send("Et aussi…")).resolves.toBeUndefined();
  });

  it("montre la réflexion pendant qu’elle s’écrit, puis la marque terminée", async () => {
    const { session, process, events } = await open();
    await sendFirst(session, process);
    process.send(
      cli.messageStart("msg_03"),
      cli.blockStart(0, { type: "thinking", thinking: "" }),
      cli.thinkingDelta(0, "Il faut d’abord lire "),
      cli.thinkingDelta(0, "AGENTS.md."),
    );
    expect(events.view.activities).toEqual([
      {
        itemId: "msg_03-0",
        kind: "analysis",
        title: "Analyse",
        status: "running",
        content: "Il faut d’abord lire AGENTS.md.",
      },
    ]);
    process.send(
      cli.blockStop(0),
      cli.blockStart(1, { type: "text", text: "" }),
      cli.textDelta(1, "Je lis les règles."),
      cli.blockStop(1),
      cli.assistant("msg_03", [
        { type: "thinking", thinking: "Il faut d’abord lire AGENTS.md." },
        { type: "text", text: "Je lis les règles." },
      ]),
      cli.success(),
    );
    const view = events.view;
    expect(view.activities).toEqual([
      expect.objectContaining({ itemId: "msg_03-0", status: "completed", content: "Il faut d’abord lire AGENTS.md." }),
    ]);
    expect(view.messages).toEqual(["Je lis les règles."]);
  });

  it("suit une commande Bash jusqu’à son résultat, et marque en échec celle qui échoue", async () => {
    const { session, process, events } = await open();
    await sendFirst(session, process);
    process.send(
      cli.messageStart("msg_04"),
      cli.blockStart(0, { type: "tool_use", id: "toolu_ls", name: "Bash", input: {} }),
      cli.blockStop(0),
      cli.assistant("msg_04", [
        { type: "tool_use", id: "toolu_ls", name: "Bash", input: { command: "ls modules", description: "Liste" } },
      ]),
    );
    expect(events.view.activities).toEqual([
      { itemId: "toolu_ls", kind: "command", title: "Commande", detail: "ls modules", actions: [], status: "running" },
    ]);

    process.send(
      cli.toolResult("toolu_ls", "factures\nclients"),
      cli.assistant("msg_05", [{ type: "tool_use", id: "toolu_test", name: "Bash", input: { command: "pnpm test" } }]),
      cli.toolResult("toolu_test", [{ type: "text", text: "1 test en échec" }], true),
      cli.assistant("msg_06", [{ type: "text", text: "Un test échoue." }]),
      cli.success(),
    );
    const view = events.view;
    expect(view.activities).toEqual([
      expect.objectContaining({ itemId: "toolu_ls", status: "completed", content: "factures\nclients" }),
      expect.objectContaining({ itemId: "toolu_test", status: "failed", content: "1 test en échec" }),
    ]);
    expect(view.messages).toEqual(["Un test échoue."]);
  });

  it("présente une modification de fichier avec son chemin", async () => {
    const { session, process, events } = await open();
    await sendFirst(session, process);
    process.send(
      cli.assistant("msg_07", [
        {
          type: "tool_use",
          id: "toolu_edit",
          name: "Edit",
          input: { file_path: "/espace/modules/factures/page.tsx", old_string: "a", new_string: "b" },
        },
      ]),
      cli.toolResult("toolu_edit", "The file has been updated."),
    );
    expect(events.view.activities).toEqual([
      expect.objectContaining({
        kind: "file",
        title: "Modification de fichiers",
        detail: "/espace/modules/factures/page.tsx",
        actions: [{ type: "edit", path: "/espace/modules/factures/page.tsx" }],
        status: "completed",
      }),
    ]);
  });
});

describe("Claude Code · demandes d’accord", () => {
  const suggestions = [
    { type: "addRules", rules: [{ toolName: "Bash", ruleContent: "rm -rf dist" }], behavior: "allow" },
  ];

  async function pendingCommand() {
    const opened = await open();
    await sendFirst(opened.session, opened.process);
    opened.process.send(
      cli.assistant("msg_10", [{ type: "tool_use", id: "toolu_rm", name: "Bash", input: { command: "rm -rf dist" } }]),
      cli.canUseTool("req-1", "Bash", { command: "rm -rf dist" }, suggestions),
    );
    return opened;
  }

  it("remonte la demande sous forme de carte", async () => {
    const { events } = await pendingCommand();
    expect(events.view.approvals).toEqual([
      {
        id: "claude-req-1",
        title: "Exécuter une commande",
        detail: "rm -rf dist",
        options: [
          { id: "allow", label: "Autoriser", kind: "allow" },
          { id: "allowAlways", label: "Toujours autoriser", kind: "allowAlways" },
          { id: "deny", label: "Refuser", kind: "deny" },
        ],
      },
    ]);
  });

  it("accorde la commande avec l’entrée d’origine", async () => {
    const { session, process } = await pendingCommand();
    await session.answer("claude-req-1", "allow");
    expect(controlResponses(process)).toEqual([
      {
        subtype: "success",
        request_id: "req-1",
        response: { behavior: "allow", updatedInput: { command: "rm -rf dist" } },
      },
    ]);
    await expect(session.answer("claude-req-1", "allow")).rejects.toThrow("n’est plus en attente");
  });

  it("« toujours autoriser » renvoie les règles proposées par le CLI", async () => {
    const { session, process } = await pendingCommand();
    await session.answer("claude-req-1", "allowAlways");
    expect(controlResponses(process)[0].response).toEqual({
      behavior: "allow",
      updatedInput: { command: "rm -rf dist" },
      updatedPermissions: suggestions,
    });
  });

  it("refuse la commande avec un message pour l’agent", async () => {
    const { session, process } = await pendingCommand();
    await session.answer("claude-req-1", "deny");
    expect(controlResponses(process)[0]).toEqual({
      subtype: "success",
      request_id: "req-1",
      response: { behavior: "deny", message: "Refusé par l’utilisateur." },
    });
  });

  it("ne propose pas « toujours autoriser » quand le CLI n’a pas de règle à retenir", async () => {
    const { session, process, events } = await open();
    await sendFirst(session, process);
    process.send(cli.canUseTool("req-2", "Write", { file_path: "/etc/hosts", content: "…" }));
    expect(events.view.approvals).toEqual([
      expect.objectContaining({
        title: "Modifier un fichier hors des dossiers de l’agent",
        detail: "/etc/hosts",
        options: [expect.objectContaining({ id: "allow" }), expect.objectContaining({ id: "deny" })],
      }),
    ]);
  });

  it("accorde sans question les outils d’Alfred", async () => {
    const { session, process, events } = await open();
    await sendFirst(session, process);
    process.send(cli.canUseTool("req-3", "mcp__alfred__place_page", { reference: "factures/liste" }));
    expect(events.view.approvals).toEqual([]);
    expect(controlResponses(process)).toEqual([
      {
        subtype: "success",
        request_id: "req-3",
        response: { behavior: "allow", updatedInput: { reference: "factures/liste" } },
      },
    ]);
  });

  it("refuse AskUserQuestion en demandant de poser la question dans la réponse", async () => {
    const { session, process, events } = await open();
    await sendFirst(session, process);
    process.send(cli.canUseTool("req-4", "AskUserQuestion", { questions: [{ question: "Quel nom ?" }] }));
    expect(events.view.approvals).toEqual([]);
    expect(controlResponses(process)[0].response).toEqual({
      behavior: "deny",
      message: expect.stringContaining("Pose ta question directement dans ta réponse"),
    });
  });

  it("ferme la carte quand le tour se termine sans réponse", async () => {
    const { process, events } = await pendingCommand();
    process.send(cli.success());
    expect(events.view.approvals).toEqual([]);
  });

  it("répond en erreur aux requêtes de contrôle qu’Alfred ne connaît pas", async () => {
    const { session, process } = await open();
    await sendFirst(session, process);
    process.send({ type: "control_request", request_id: "req-5", request: { subtype: "hook_callback" } });
    expect(controlResponses(process)).toEqual([
      { subtype: "error", request_id: "req-5", error: "Requête non prise en charge par Alfred." },
    ]);
  });
});

describe("Claude Code · erreurs et interruptions", () => {
  it("affiche comme une erreur la réponse du CLI non connecté, sans la présenter comme une réponse", async () => {
    const { session, process, events } = await open();
    await sendFirst(session, process);
    // Ce que le CLI renvoie sans compte connecté : un message assistant synthétique, puis un résultat en erreur.
    process.send(
      cli.assistant(
        "3f9e2a10-5b8c-4d2e-a1f0-7c6b5d4e3f21",
        [{ type: "text", text: "Not logged in · Please run /login" }],
        { error: "authentication_failed" },
      ),
      {
        type: "result",
        subtype: "success",
        is_error: true,
        result: "Not logged in · Please run /login",
        session_id: "8c1f0a52-3d1e-4c3a-9b7e-0d6f2a7e5b11",
      },
    );
    const view = events.view;
    expect(view.errors).toEqual(["Claude Code n’a pas pu terminer sa réponse : Not logged in · Please run /login."]);
    expect(view.messages).toEqual([]);
    expect(view.statuses.at(-1)).toBe("idle");
  });

  it("reconnaît aussi le message synthétique à son modèle et en reprend le motif quand le résultat n’en a pas", async () => {
    const { session, process, events } = await open();
    await sendFirst(session, process);
    process.send(
      {
        type: "assistant",
        message: {
          id: "a1",
          model: "<synthetic>",
          role: "assistant",
          content: [{ type: "text", text: "Invalid API key · Please run /login" }],
        },
      },
      { type: "result", subtype: "success", is_error: true, result: "" },
    );
    expect(events.view.messages).toEqual([]);
    expect(events.view.errors).toEqual([
      "Claude Code n’a pas pu terminer sa réponse : Invalid API key · Please run /login.",
    ]);
  });

  it("explique un tour arrêté par une limite du CLI", async () => {
    const { session, process, events } = await open();
    await sendFirst(session, process);
    process.send({ type: "result", subtype: "error_max_turns", is_error: true, errors: ["Nombre de tours atteint."] });
    expect(events.view.errors).toEqual(["Claude Code n’a pas pu terminer sa réponse : Nombre de tours atteint."]);
  });

  it("interrompt la réponse, ferme les cartes et ne montre pas d’erreur", async () => {
    const { session, process, events } = await open();
    await sendFirst(session, process);
    process.send(cli.canUseTool("req-6", "Bash", { command: "pnpm build" }));
    await session.cancel();

    const interrupts = writtenOf(process, "control_request");
    expect(interrupts).toEqual([
      { type: "control_request", request_id: expect.stringMatching(/^alfred-/), request: { subtype: "interrupt" } },
    ]);
    expect(controlResponses(process)[0]).toEqual({
      subtype: "success",
      request_id: "req-6",
      response: { behavior: "deny", message: "Tour interrompu." },
    });
    expect(events.view.approvals).toEqual([]);

    // Le CLI confirme l’interruption puis clôt le tour sans motif.
    process.send(
      {
        type: "control_response",
        response: { subtype: "success", request_id: interrupts[0].request_id },
      },
      { type: "result", subtype: "error_during_execution", is_error: true },
    );
    expect(events.view.errors).toEqual([]);
    expect(events.view.statuses.at(-1)).toBe("idle");
  });

  it("après une interruption, ni la réflexion ni l’outil coupés ne restent affichés en cours", async () => {
    const { session, process, events } = await open();
    await sendFirst(session, process);
    process.send(
      cli.messageStart("msg_30"),
      cli.blockStart(0, { type: "thinking", thinking: "" }),
      cli.thinkingDelta(0, "Je compile d’abord."),
      cli.blockStop(0),
      cli.assistant("msg_30", [
        { type: "tool_use", id: "toolu_build", name: "Bash", input: { command: "pnpm build" } },
      ]),
      cli.messageStart("msg_31"),
      cli.blockStart(0, { type: "thinking", thinking: "" }),
      cli.thinkingDelta(0, "Puis je…"),
    );
    await session.cancel();
    process.send({ type: "result", subtype: "error_during_execution", is_error: true });
    expect(events.view.activities.map(({ itemId, status }) => ({ itemId, status }))).toEqual([
      { itemId: "msg_30-0", status: "completed" },
      // Un outil resté sans résultat est « Arrêté », comme dans OneApp, et non en échec.
      { itemId: "toolu_build", status: "cancelled" },
      { itemId: "msg_31-0", status: "completed" },
    ]);
  });

  it("n’envoie pas d’interruption quand rien n’est en cours", async () => {
    const { session, process } = await open();
    await session.cancel();
    expect(process.written).toEqual([]);
  });

  it("signale un arrêt inattendu du processus avec la dernière ligne d’erreur", async () => {
    const { session, process, events } = await open();
    await sendFirst(session, process);
    process.send(cli.canUseTool("req-7", "Bash", { command: "make" }));
    process.stderr("Démarrage…\nError: ECONNRESET\n");
    process.exit(1);

    const view = events.view;
    expect(view.approvals).toEqual([]);
    expect(view.errors).toEqual([
      "Claude Code s’est arrêté : Error: ECONNRESET. Envoyer un message relance la conversation.",
    ]);
    expect(view.statuses.at(-1)).toBe("closed");
    await expect(session.send("Encore")).rejects.toThrow("fermée");
  });

  it("ne signale pas d’arrêt quand Alfred ferme lui-même la session", async () => {
    const { session, process, events } = await open();
    await session.close();
    process.exit(0);
    expect(process.killed).toBe(true);
    expect(events.view.errors).toEqual([]);
    expect(events.view.statuses.at(-1)).toBe("closed");
  });

  it("garde la fin du tour malgré une ligne illisible", async () => {
    const { session, process, events } = await open();
    await sendFirst(session, process);
    const error = vi.spyOn(console, "error").mockImplementation(() => undefined);
    process.send("{pas du json", cli.success());
    expect(events.view.statuses.at(-1)).toBe("idle");
    expect(error).toHaveBeenCalled();
  });

  it("reçoit une ligne coupée en deux fragments", async () => {
    const { session, process, events } = await open();
    await sendFirst(session, process);
    const line = JSON.stringify(cli.assistant("msg_x", [{ type: "text", text: "Bonjour" }]));
    process.chunk(line.slice(0, 20));
    expect(events.view.messages).toEqual([]);
    process.chunk(`${line.slice(20)}\n`);
    expect(events.view.messages).toEqual(["Bonjour"]);
  });
});

describe("Claude Code · appel unique", () => {
  const schema = { type: "object", required: ["titre"], properties: { titre: { type: "string" } } };

  it("lance le CLI sans outil ni conversation, et rend le résultat structuré", async () => {
    let structured: unknown;
    const { session, process, launch, events } = await open({
      oneShot: true,
      outputSchema: schema,
      conversation: "conv-1",
      autonomy: "strict",
      onStructuredResult: (value) => {
        structured = value;
      },
    });
    expect(launch.options).toEqual({ cwd: "/espace/projet", claude: { oneShot: true, jsonSchema: schema } });

    await sendFirst(session, process, "Donne un titre");
    process.send(cli.canUseTool("req-8", "Bash", { command: "ls" }));
    expect(events.view.approvals).toEqual([]);
    expect(controlResponses(process)[0].response).toEqual({
      behavior: "deny",
      message: "Aucun outil n’est disponible pour cet appel.",
    });

    process.send(
      cli.assistant("msg_20", [{ type: "text", text: '{"titre":"Factures"}' }]),
      cli.success('{"titre":"Factures"}', { structured_output: { titre: "Factures" } }),
    );
    expect(structured).toEqual({ titre: "Factures" });
    expect(events.view.statuses.at(-1)).toBe("idle");
  });
});
