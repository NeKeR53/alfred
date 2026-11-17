import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Snapshot } from "../../lib/types";
import { useShell } from "../../shell/store";
import { type FakeProcess, fakeSpawn, type Spawned } from "./harness/fakeProcess.test-helper";
import { useHarnesses } from "./harness/installed";
import { complete, oneShot } from "./oneShot";
import { useAgentPreferences } from "./panel/ModelPicker";
import { useAgents } from "./store";

const native = vi.hoisted(() => {
  // jsdom n’a pas `matchMedia`, que le magasin de la coque lit à sa création.
  window.matchMedia ??= ((query: string) => ({ matches: false, media: query })) as unknown as typeof window.matchMedia;
  return { invoke: vi.fn(), onNativeEvent: vi.fn() };
});
vi.mock("../../lib/native", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../lib/native")>()),
  invoke: native.invoke,
  onNativeEvent: native.onNativeEvent,
}));
vi.mock("./harness/process", () => ({ spawnProcess: vi.fn(), probe: vi.fn() }));

const schema = {
  type: "object",
  required: ["titre", "priorite"],
  additionalProperties: false,
  properties: { titre: { type: "string" }, priorite: { enum: ["basse", "haute"] } },
};
const request = { instruction: "Résume cette demande client", context: { texte: "Le portail est cassé" }, schema };

/** Réponse du faux Claude Code à un appel unique : résultat structuré, ou texte seul. */
type Answer = { structured: unknown } | { text: string } | { error: string };

/** Faux `claude -p` en appel unique : à chaque message reçu, il rend la réponse suivante de la liste. */
function claudeAnswering(answers: Answer[]) {
  let index = 0;
  return (process: FakeProcess) =>
    process.onWrite((message) => {
      if (message.type !== "user") return;
      const answer = answers[index++];
      queueMicrotask(() => {
        process.send({ type: "system", subtype: "init", session_id: `ses-${index}` });
        if ("error" in answer) {
          process.send(
            {
              type: "assistant",
              message: { id: "a", model: "<synthetic>", content: [{ type: "text", text: answer.error }] },
              error: "authentication_failed",
            },
            { type: "result", subtype: "success", is_error: true, result: answer.error },
          );
          return;
        }
        const text = "text" in answer ? answer.text : JSON.stringify(answer.structured);
        process.send(
          { type: "assistant", message: { id: `msg-${index}`, content: [{ type: "text", text }] } },
          {
            type: "result",
            subtype: "success",
            is_error: false,
            result: text,
            ...("structured" in answer ? { structured_output: answer.structured } : {}),
          },
        );
      });
    });
}

/** Texte du message envoyé au CLI lors du lancement `index`. */
const sentText = (launch: Spawned) => {
  const message = launch.process.written.find((line) => line.type === "user") as {
    message: { content: Array<{ text: string }> };
  };
  return message.message.content[0].text;
};
const journal = () =>
  native.invoke.mock.calls.filter(([command]) => command === "journal.record").map(([, args]) => args);

beforeEach(() => {
  native.invoke.mockResolvedValue(null);
  native.onNativeEvent.mockReturnValue(() => undefined);
  useShell.setState({
    snapshot: { path: "/espace", name: "Espace", accent: null, sections: [], settingsPages: [] } as unknown as Snapshot,
  });
  useAgents.setState({
    ready: true,
    defaults: { provider: "claude", autonomy: "ask", models: { claude: { model: "sonnet", effort: "low" } } },
  });
  // Réglages → Agent, « Dans les pages » : « Comme l’agent » par défaut.
  setPageModel(null);
  useHarnesses.setState({ probes: {} });
});

const setPageModel = (
  pageModel: { provider: "claude" | "codex" | "opencode"; model?: string; effort?: string } | null,
) =>
  useAgentPreferences.setState({
    values: { shownModels: {}, titling: null, pageModel, textEditor: null },
    status: "ready",
  });

describe("appel unique", () => {
  it("rend la réponse conforme du premier coup et l’inscrit au journal", async () => {
    const spawned = fakeSpawn(claudeAnswering([{ structured: { titre: "Portail cassé", priorite: "haute" } }]));
    await expect(oneShot(request, "clients/demandes")).resolves.toEqual({ titre: "Portail cassé", priorite: "haute" });

    expect(spawned).toHaveLength(1);
    expect(spawned[0].options).toEqual({
      cwd: "/espace",
      claude: { model: "sonnet", effort: "low", oneShot: true, jsonSchema: schema },
    });
    const text = sentText(spawned[0]);
    expect(text).toContain("Consigne :\nRésume cette demande client");
    expect(text).toContain('"texte": "Le portail est cassé"');
    expect(text).toContain(JSON.stringify(schema));
    expect(spawned[0].process.killed).toBe(true);
    expect(journal()).toEqual([
      expect.objectContaining({
        kind: "ai",
        subject: "clients/demandes",
        ok: true,
        summary: "Appel unique via Claude Code · sonnet",
        detail: { provider: "claude", model: "sonnet", effort: "low", instruction: "Résume cette demande client" },
      }),
    ]);
  });

  it("lit le JSON du texte quand le CLI ne rend pas de résultat structuré", async () => {
    fakeSpawn(claudeAnswering([{ text: 'Voici :\n```json\n{"titre":"Portail","priorite":"basse"}\n```' }]));
    await expect(oneShot(request, "clients/demandes")).resolves.toEqual({ titre: "Portail", priorite: "basse" });
  });

  it("relance une fois avec les écarts, puis rend la réponse corrigée", async () => {
    const spawned = fakeSpawn(
      claudeAnswering([
        { structured: { titre: "Portail", priorite: "urgente" } },
        { structured: { titre: "Portail", priorite: "haute" } },
      ]),
    );
    await expect(oneShot(request, "clients/demandes")).resolves.toEqual({ titre: "Portail", priorite: "haute" });

    expect(spawned).toHaveLength(2);
    expect(sentText(spawned[0])).not.toContain("invalide");
    expect(sentText(spawned[1])).toContain(
      'Ta réponse précédente était invalide :\n$.priorite : valeur hors de la liste autorisée ("basse", "haute").\nCorrige-la.',
    );
    expect(spawned.every(({ process }) => process.killed)).toBe(true);
    expect(journal()).toEqual([expect.objectContaining({ ok: true })]);
  });

  it("échoue avec le détail des écarts après deux réponses invalides, et l’inscrit au journal", async () => {
    const spawned = fakeSpawn(
      claudeAnswering([{ structured: { titre: 3, priorite: "haute" } }, { structured: { titre: "Portail" } }]),
    );
    const failure = await oneShot(request, "clients/demandes").catch((error: unknown) => error);

    expect(spawned).toHaveLength(2);
    expect(sentText(spawned[1])).toContain("$.titre : type attendu string, reçu integer.");
    expect(failure).toMatchObject({
      message: "La réponse du modèle ne respecte pas le schéma demandé.",
      detail: ["$.priorite : champ requis absent."],
    });
    expect(journal()).toEqual([
      expect.objectContaining({
        ok: false,
        summary: "Appel unique via Claude Code · sonnet : La réponse du modèle ne respecte pas le schéma demandé.",
      }),
    ]);
  });

  it("rend l’erreur du CLI non connecté sans relance", async () => {
    const spawned = fakeSpawn(claudeAnswering([{ error: "Not logged in · Please run /login" }]));
    await expect(oneShot(request, "clients/demandes")).rejects.toThrow(
      "Claude Code n’a pas pu terminer sa réponse : Not logged in · Please run /login.",
    );
    expect(spawned).toHaveLength(1);
    expect(journal()).toEqual([expect.objectContaining({ ok: false })]);
  });

  it("refuse un appel sans consigne ou sans schéma", async () => {
    await expect(oneShot({ ...request, instruction: " " }, "x")).rejects.toThrow("demande une consigne");
    await expect(oneShot({ ...request, schema: undefined as never }, "x")).rejects.toThrow("demande le schéma");
  });
});

describe("appel unique · modèle des pages", () => {
  const answer = { structured: { titre: "Portail", priorite: "haute" } };

  it("prend le harnais, le modèle et l’effort réglés pour les pages", async () => {
    setPageModel({ provider: "claude", model: "haiku", effort: "high" });
    const spawned = fakeSpawn(claudeAnswering([answer]));
    await expect(oneShot(request, "clients/demandes")).resolves.toEqual(answer.structured);
    expect(spawned[0].options).toMatchObject({ claude: { model: "haiku", effort: "high" } });
    expect(journal()).toEqual([
      expect.objectContaining({
        ok: true,
        summary: "Appel unique via Claude Code · haiku",
        detail: expect.objectContaining({ provider: "claude", model: "haiku", effort: "high" }),
      }),
    ]);
  });

  it("prend le modèle réglé pour ce harnais quand les pages n’en choisissent pas", async () => {
    setPageModel({ provider: "claude" });
    const spawned = fakeSpawn(claudeAnswering([answer]));
    await oneShot(request, "clients/demandes");
    expect(spawned[0].options).toMatchObject({ claude: { model: "sonnet", effort: "low" } });
  });

  it("lit le réglage enregistré avant le premier appel", async () => {
    useAgentPreferences.setState({ status: "idle" });
    native.invoke.mockImplementation(async (command: string, args: { key?: string }) =>
      command === "settings.get" && args?.key === "agents.pageModel" ? { provider: "claude", model: "haiku" } : null,
    );
    const spawned = fakeSpawn(claudeAnswering([answer]));
    await oneShot(request, "clients/demandes");
    expect(spawned[0].options).toMatchObject({ claude: { model: "haiku" } });
  });

  it("retombe sur le modèle de l’agent quand celui des pages ne répond pas, et le note au journal", async () => {
    setPageModel({ provider: "claude", model: "haiku" });
    const spawned = fakeSpawn(claudeAnswering([{ error: "Overloaded" }, answer]));
    await expect(oneShot(request, "clients/demandes")).resolves.toEqual(answer.structured);
    expect(spawned).toHaveLength(2);
    expect(spawned[0].options).toMatchObject({ claude: { model: "haiku" } });
    expect(spawned[1].options).toMatchObject({ claude: { model: "sonnet", effort: "low" } });
    const [entry] = journal() as Array<{ ok: boolean; summary: string; detail: Record<string, unknown> }>;
    expect(entry.ok).toBe(true);
    expect(entry.summary).toMatch(
      /^Appel unique via Claude Code · sonnet \(Claude Code · haiku, réglé pour les pages, n’a pas répondu \(.*Overloaded.*\) : Claude Code · sonnet, celui de l’agent, a pris le relais\)$/,
    );
    expect(entry.detail).toMatchObject({
      provider: "claude",
      model: "sonnet",
      fallback: expect.stringContaining("n’a pas répondu"),
    });
  });

  it("ne change pas de modèle pour une réponse hors schéma", async () => {
    setPageModel({ provider: "claude", model: "haiku" });
    const spawned = fakeSpawn(
      claudeAnswering([{ structured: { titre: 3, priorite: "haute" } }, { structured: { titre: "Portail" } }]),
    );
    await expect(oneShot(request, "clients/demandes")).rejects.toThrow("ne respecte pas le schéma");
    expect(spawned).toHaveLength(2);
    expect(spawned.every((launch) => (launch.options as { claude: { model: string } }).claude.model === "haiku")).toBe(
      true,
    );
  });

  it("retombe sur le harnais de l’agent quand celui des pages n’est plus installé", async () => {
    useHarnesses.setState({
      probes: {
        claude: { status: "ready", value: { installed: true } },
        codex: { status: "ready", value: { installed: true } },
        opencode: { status: "ready", value: { installed: false } },
      },
    });
    setPageModel({ provider: "opencode", model: "kimi" });
    const spawned = fakeSpawn(claudeAnswering([answer]));
    await oneShot(request, "clients/demandes");
    expect(spawned[0].options).toMatchObject({ claude: { model: "sonnet" } });
    expect(journal()).toEqual([
      expect.objectContaining({
        summary:
          "Appel unique via Claude Code · sonnet (OpenCode, réglé pour les pages, n’est plus installé : Claude Code, celui de l’agent, le remplace)",
      }),
    ]);
  });
});

/** Régression corrigée dans `oneShot.ts` : une réponse sans JSON lisible est relancée. */
describe("appel unique · réponse sans JSON", () => {
  it("relance aussi une réponse sans JSON lisible", async () => {
    const spawned = fakeSpawn(
      claudeAnswering([
        { text: "Bien sûr, voici le résumé." },
        { structured: { titre: "Portail", priorite: "haute" } },
      ]),
    );
    await expect(oneShot(request, "clients/demandes")).resolves.toEqual({ titre: "Portail", priorite: "haute" });
    expect(spawned).toHaveLength(2);
  });
});

describe("appel texte (nommage des conversations)", () => {
  it("rend le texte de la réponse du modèle choisi, sans schéma", async () => {
    const spawned = fakeSpawn(claudeAnswering([{ text: "Page des factures clients" }]));
    await expect(complete("Donne un titre", { provider: "claude", model: "haiku" })).resolves.toBe(
      "Page des factures clients",
    );
    expect(spawned[0].options).toEqual({ cwd: "/espace", claude: { model: "haiku", oneShot: true } });
    expect(sentText(spawned[0])).toBe("Donne un titre");
    expect(spawned[0].process.killed).toBe(true);
  });
});
