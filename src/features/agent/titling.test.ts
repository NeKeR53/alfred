import { describe, expect, it, vi } from "vitest";
import { cleanTitle, needsAutoTitle, type TitlingStore, titlePrompt, watchConversationTitles } from "./titling";

describe("titre à déterminer", () => {
  it("vise les titres génériques, tronqués ou en double", () => {
    expect(needsAutoTitle("Nouvelle conversation", [])).toBe(true);
    expect(needsAutoTitle("  agent ", [])).toBe(true);
    expect(needsAutoTitle("Crée une page de suivi des factures avec…", [])).toBe(true);
    expect(needsAutoTitle("Factures", ["factures"])).toBe(true);
    expect(needsAutoTitle("Factures", ["Clients"])).toBe(false);
  });

  it("demande 3 à 7 mots d’après le premier message", () => {
    const prompt = titlePrompt(`  ${"a".repeat(5000)}`);
    expect(prompt).toContain("de 3 à 7 mots");
    expect(prompt.endsWith(`Demande :\n${"a".repeat(4000)}`)).toBe(true);
  });

  it("nettoie la réponse du modèle", () => {
    expect(cleanTitle("```\nTitre : « Page des factures ».\n```")).toBe("Page des factures");
    expect(cleanTitle("")).toBe("");
    expect(cleanTitle("x".repeat(80))).toBe(`${"x".repeat(59)}…`);
  });
});

describe("nommage automatique", () => {
  function store(conversations: Array<{ id: string; firstMessage?: string; wanted: boolean }>) {
    const listeners = new Set<() => void>();
    const titles = new Map<string, string>();
    const engine: TitlingStore = {
      candidates: () => conversations.filter((item) => item.wanted),
      stillWanted: (id) => conversations.find((item) => item.id === id)?.wanted ?? false,
      setTitle: async (id, title) => {
        titles.set(id, title);
      },
      model: () => ({ provider: "claude", model: "haiku" }),
      subscribe: (listener) => {
        listeners.add(listener);
        return () => listeners.delete(listener);
      },
    };
    return {
      engine,
      titles,
      changed: () => {
        for (const listener of listeners) listener();
      },
      conversations,
    };
  }

  it("nomme une conversation une seule fois, avec le modèle de nommage", async () => {
    const { engine, titles, changed } = store([{ id: "c1", firstMessage: "Fais une page factures", wanted: true }]);
    const complete = vi.fn(async () => "Page des factures");
    watchConversationTitles(engine, complete);
    changed();
    await vi.waitFor(() => expect(titles.get("c1")).toBe("Page des factures"));
    expect(complete).toHaveBeenCalledTimes(1);
    expect(complete).toHaveBeenCalledWith(
      expect.stringContaining("Fais une page factures"),
      {
        provider: "claude",
        model: "haiku",
      },
      60_000,
    );
  });

  it("attend le premier message, ne réessaie pas après un échec et garde un renommage manuel", async () => {
    const { engine, titles, changed, conversations } = store([
      { id: "vide", wanted: true },
      { id: "echec", firstMessage: "Un", wanted: true },
      { id: "renommee", firstMessage: "Deux", wanted: true },
    ]);
    let release: (title: string) => void = () => undefined;
    const complete = vi.fn((prompt: string) => {
      if (prompt.includes("Un")) return Promise.reject(new Error("hors délai"));
      return new Promise<string>((resolve) => {
        release = resolve;
      });
    });
    watchConversationTitles(engine, complete);
    expect(complete).toHaveBeenCalledTimes(2);
    conversations[2].wanted = false;
    release("Titre du modèle");
    changed();
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(titles.size).toBe(0);
    expect(complete).toHaveBeenCalledTimes(2);
  });
});
