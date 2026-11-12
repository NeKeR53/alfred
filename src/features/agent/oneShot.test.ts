import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Snapshot } from "../../lib/types";
import { useShell } from "../../shell/store";
import { type FakeProcess, fakeSpawn, type Spawned } from "./harness/fakeProcess.test-helper";
import { oneShot } from "./oneShot";
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
        summary: "Appel unique via Claude Code",
        detail: { provider: "claude", model: "sonnet", instruction: "Résume cette demande client" },
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
        summary: "Appel unique via Claude Code : La réponse du modèle ne respecte pas le schéma demandé.",
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

/** Défaut connu de `oneShot.ts`, laissé à corriger dans ce fichier (`it.fails` : échoue aujourd’hui). */
describe("appel unique · défaut connu", () => {
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
