import { describe, expect, it } from "vitest";
import {
  conversationLabel,
  conversationTree,
  delegatesActive,
  delegatesSummary,
  familyState,
  nodeSigns,
} from "./conversationTree";
import type { ConversationHeader } from "./model";
import type { ConversationState } from "./summary";

const header = (id: string, createdAt: number, extra: Partial<ConversationHeader> = {}) =>
  ({
    id,
    title: id,
    provider: "claude",
    createdAt,
    updatedAt: createdAt,
    archived: false,
    started: true,
    unread: false,
    ...extra,
  }) as ConversationHeader;

const delegate = (id: string, parent: string, createdAt: number) =>
  header(id, createdAt, { title: `${id} · délégué`, parent, taskKey: id });

const tree = (headers: ConversationHeader[], states: Record<string, ConversationState> = {}, known = headers) =>
  conversationTree(
    headers.filter((item) => item.started && !item.archived),
    (item) => states[item.id] ?? "idle",
    known,
  );

describe("arbre des conversations", () => {
  it("range chaque délégué sous sa coordinatrice, dans l’ordre où elle les a lancés", () => {
    const nodes = tree([
      header("ventes-q3", 10, { coordinator: true }),
      delegate("documentation", "ventes-q3", 13),
      delegate("ventes", "ventes-q3", 11),
      header("seule", 20),
      delegate("demandes", "ventes-q3", 12),
    ]);
    expect(nodes.map((node) => node.header.id)).toEqual(["ventes-q3", "seule"]);
    expect(nodes[0].delegates.map((node) => node.label)).toEqual(["ventes", "demandes", "documentation"]);
    expect(nodes[0].delegateOf).toBeUndefined();
    expect(nodes[1].delegates).toEqual([]);
  });

  it("sous sa coordinatrice, un délégué perd « · délégué » ; renommé, il garde son titre", () => {
    expect(conversationLabel({ title: "ventes · délégué", parent: "c" })).toBe("ventes");
    expect(conversationLabel({ title: "Synthèse des ventes", parent: "c" })).toBe("Synthèse des ventes");
    // Une conversation ordinaire garde son titre, même s’il finit par ces mots.
    expect(conversationLabel({ title: "Un agent · délégué" })).toBe("Un agent · délégué");
  });

  it("coordinatrice archivée ou absente : le délégué reste en haut et dit de qui il est le délégué", () => {
    const coordinator = header("ventes-q3", 10, { title: "Ventes Q3", coordinator: true, archived: true });
    const headers = [coordinator, delegate("ventes", "ventes-q3", 11), delegate("orphelin", "disparue", 12)];
    const nodes = tree(headers);
    expect(nodes.map((node) => [node.label, node.delegateOf])).toEqual([
      ["ventes", "Délégué de Ventes Q3"],
      ["orphelin", "Délégué"],
    ]);
  });

  it("jamais de troisième niveau : le délégué d’un délégué reste en haut", () => {
    const nodes = tree([header("c", 1, { coordinator: true }), delegate("d", "c", 2), delegate("e", "d", 3)]);
    expect(nodes.map((node) => node.header.id)).toEqual(["c", "e"]);
    expect(nodes[0].delegates.map((node) => node.header.id)).toEqual(["d"]);
    expect(nodes[1].delegateOf).toBe("Délégué de d · délégué");
  });

  it("plus de trois délégués : tous sous la coordinatrice, comptés dans le résumé", () => {
    const delegates = ["a", "b", "c", "d", "e"].map((id, index) => delegate(id, "coord", index + 2));
    const [node] = tree([header("coord", 1, { coordinator: true }), ...delegates], {
      a: "working",
      b: "working",
      c: "attention",
      d: "error",
      e: "done",
    });
    expect(node.delegates).toHaveLength(5);
    // Les non-lus ne sont pas cités : socle-ui les ajoute à la ligne résumé.
    expect(delegatesSummary(node)).toBe("5 délégués · 1 réponse attendue · 2 au travail · 1 en échec");
  });

  it("le résumé dit le nombre seul quand aucun délégué ne demande rien", () => {
    const [node] = tree([header("c", 1), delegate("a", "c", 2)], { a: "done" });
    expect(delegatesSummary(node)).toBe("1 délégué");
    const [alone] = tree([header("seule", 1)]);
    expect(delegatesSummary(alone)).toBeUndefined();
  });

  it("la coordinatrice montre un délégué au travail ou qui attend une réponse, et reste dépliée", () => {
    const headers = [header("c", 1, { coordinator: true }), delegate("a", "c", 2), delegate("b", "c", 3)];
    const at = (states: Record<string, ConversationState>) => tree(headers, states)[0];

    const working = at({ c: "done", a: "working", b: "done" });
    expect(familyState(working)).toBe("working");
    expect(nodeSigns(working)).toEqual({ activity: true, warning: false, unread: true });
    expect(delegatesActive(working)).toBe(true);

    const asking = at({ c: "idle", a: "working", b: "attention" });
    expect(familyState(asking)).toBe("attention");
    expect(nodeSigns(asking)).toEqual({ activity: true, warning: true, unread: false });
    expect(delegatesActive(asking)).toBe(true);

    // Tout est fini : la coordinatrice garde son propre état et se replie.
    const finished = at({ c: "done", a: "done", b: "error" });
    expect(familyState(finished)).toBe("done");
    expect(nodeSigns(finished)).toEqual({ activity: false, warning: false, unread: true });
    expect(delegatesActive(finished)).toBe(false);

    // Son propre échec passe avant le travail de ses délégués.
    expect(familyState(at({ c: "error", a: "working" }))).toBe("error");
  });

  it("une conversation sans délégué garde ses signes d’avant", () => {
    const signs = (state: ConversationState) => nodeSigns(tree([header("x", 1)], { x: state })[0]);
    expect(signs("working")).toEqual({ activity: true, warning: false, unread: false });
    expect(signs("waiting")).toEqual({ activity: true, warning: false, unread: false });
    expect(signs("attention")).toEqual({ activity: false, warning: true, unread: false });
    expect(signs("error")).toEqual({ activity: false, warning: true, unread: false });
    expect(signs("done")).toEqual({ activity: false, warning: false, unread: true });
    expect(signs("idle")).toEqual({ activity: false, warning: false, unread: false });
  });
});
