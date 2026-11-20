import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Snapshot } from "../../lib/types";
import { useShell } from "../../shell/store";
import { answerTurn, type FakeSession, fakeAgents } from "./harness/fakeNative.test-helper";
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

const schema = {
  type: "object",
  required: ["titre", "priorite"],
  additionalProperties: false,
  properties: { titre: { type: "string" }, priorite: { enum: ["basse", "haute"] } },
};
const request = { instruction: "Résume cette demande client", context: { texte: "Le portail est cassé" }, schema };

/** Réponse du faux agent à un appel unique : résultat structuré, ou texte seul, ou erreur du CLI. */
type Answer = { structured: unknown } | { text: string } | { error: string };

/** Faux agent en appel unique : à chaque message reçu, il rend la réponse suivante de la liste. */
function fakeSpawn(answers: Answer[]): FakeSession[] {
  let index = 0;
  return fakeAgents(native, (session) => {
    const answer = answers[index++];
    if ("error" in answer) {
      session.emit(
        { type: "error", message: `Claude Code n’a pas pu terminer sa réponse : ${answer.error}.` },
        { type: "status", status: "idle" },
      );
      return;
    }
    if ("text" in answer) answerTurn(session, answer.text);
    else answerTurn(session, JSON.stringify(answer.structured), answer.structured);
  });
}

/** Texte du message envoyé à l’agent. */
const sentText = (launch: FakeSession) => launch.sent[0];
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
    const spawned = fakeSpawn([{ structured: { titre: "Portail cassé", priorite: "haute" } }]);
    await expect(oneShot(request, "clients/demandes")).resolves.toEqual({ titre: "Portail cassé", priorite: "haute" });

    expect(spawned).toHaveLength(1);
    expect(spawned[0].args).toMatchObject({
      provider: "claude",
      cwd: "/espace",
      model: "sonnet",
      effort: "low",
      oneShot: true,
      outputSchema: schema,
    });
    expect(spawned[0].args).not.toHaveProperty("conversation");
    const text = sentText(spawned[0]);
    expect(text).toContain("Consigne :\nRésume cette demande client");
    expect(text).toContain('"texte": "Le portail est cassé"');
    expect(text).toContain(JSON.stringify(schema));
    expect(spawned[0].closed).toBe(true);
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
    fakeSpawn([{ text: 'Voici :\n```json\n{"titre":"Portail","priorite":"basse"}\n```' }]);
    await expect(oneShot(request, "clients/demandes")).resolves.toEqual({ titre: "Portail", priorite: "basse" });
  });

  it("relance une fois avec les écarts, puis rend la réponse corrigée", async () => {
    const spawned = fakeSpawn([
      { structured: { titre: "Portail", priorite: "urgente" } },
      { structured: { titre: "Portail", priorite: "haute" } },
    ]);
    await expect(oneShot(request, "clients/demandes")).resolves.toEqual({ titre: "Portail", priorite: "haute" });

    expect(spawned).toHaveLength(2);
    expect(sentText(spawned[0])).not.toContain("invalide");
    expect(sentText(spawned[1])).toContain(
      'Ta réponse précédente était invalide :\n$.priorite : valeur hors de la liste autorisée ("basse", "haute").\nCorrige-la.',
    );
    expect(spawned.every(({ closed }) => closed)).toBe(true);
    expect(journal()).toEqual([expect.objectContaining({ ok: true })]);
  });

  it("échoue avec le détail des écarts après deux réponses invalides, et l’inscrit au journal", async () => {
    const spawned = fakeSpawn([{ structured: { titre: 3, priorite: "haute" } }, { structured: { titre: "Portail" } }]);
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
    const spawned = fakeSpawn([{ error: "Not logged in · Please run /login" }]);
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
    const spawned = fakeSpawn([answer]);
    await expect(oneShot(request, "clients/demandes")).resolves.toEqual(answer.structured);
    expect(spawned[0].args).toMatchObject({ model: "haiku", effort: "high" });
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
    const spawned = fakeSpawn([answer]);
    await oneShot(request, "clients/demandes");
    expect(spawned[0].args).toMatchObject({ model: "sonnet", effort: "low" });
  });

  it("lit le réglage enregistré avant le premier appel", async () => {
    useAgentPreferences.setState({ status: "idle" });
    native.invoke.mockImplementation(async (command: string, args: { key?: string }) =>
      command === "settings.get" && args?.key === "agents.pageModel" ? { provider: "claude", model: "haiku" } : null,
    );
    const spawned = fakeSpawn([answer]);
    await oneShot(request, "clients/demandes");
    expect(spawned[0].args).toMatchObject({ model: "haiku" });
  });

  it("retombe sur le modèle de l’agent quand celui des pages ne répond pas, et le note au journal", async () => {
    setPageModel({ provider: "claude", model: "haiku" });
    const spawned = fakeSpawn([{ error: "Overloaded" }, answer]);
    await expect(oneShot(request, "clients/demandes")).resolves.toEqual(answer.structured);
    expect(spawned).toHaveLength(2);
    expect(spawned[0].args).toMatchObject({ model: "haiku" });
    expect(spawned[1].args).toMatchObject({ model: "sonnet", effort: "low" });
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
    const spawned = fakeSpawn([{ structured: { titre: 3, priorite: "haute" } }, { structured: { titre: "Portail" } }]);
    await expect(oneShot(request, "clients/demandes")).rejects.toThrow("ne respecte pas le schéma");
    expect(spawned).toHaveLength(2);
    expect(spawned.every((launch) => launch.args.model === "haiku")).toBe(true);
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
    const spawned = fakeSpawn([answer]);
    await oneShot(request, "clients/demandes");
    expect(spawned[0].args).toMatchObject({ provider: "claude", model: "sonnet" });
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
    const spawned = fakeSpawn([
      { text: "Bien sûr, voici le résumé." },
      { structured: { titre: "Portail", priorite: "haute" } },
    ]);
    await expect(oneShot(request, "clients/demandes")).resolves.toEqual({ titre: "Portail", priorite: "haute" });
    expect(spawned).toHaveLength(2);
  });
});

describe("appel texte (nommage des conversations)", () => {
  it("rend le texte de la réponse du modèle choisi, sans schéma", async () => {
    const spawned = fakeSpawn([{ text: "Page des factures clients" }]);
    await expect(complete("Donne un titre", { provider: "claude", model: "haiku" })).resolves.toBe(
      "Page des factures clients",
    );
    expect(spawned[0].args).toEqual({
      provider: "claude",
      cwd: "/espace",
      model: "haiku",
      autonomy: "strict",
      oneShot: true,
    });
    expect(sentText(spawned[0])).toBe("Donne un titre");
    expect(spawned[0].closed).toBe(true);
  });
});
