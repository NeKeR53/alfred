/**
 * La saisie d’une conversation, reprise de OneApp : brouillons gardés par conversation et relus au redémarrage,
 * saisie verrouillée tant que rien n’est prêt, message rendu à la saisie si l’envoi échoue, un seul envoi pour
 * plusieurs Entrée, collages longs en cartes, limites des pièces jointes et file avec ses pastilles.
 */
import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Snapshot } from "../../lib/types";
import { useShell } from "../../shell/store";
import { Composer, isLongChatText, mergeIntoDraft } from "./Composer";
import {
  blankDraft,
  DRAFTS_KEY,
  flushComposerDrafts,
  parseDraft,
  resetComposerDrafts,
  serializeDraft,
  setComposerDraft,
  useComposerDrafts,
} from "./drafts";
import { ATTACHMENT_LIMIT_MESSAGE, checkAttachmentLimits, saveBlobs } from "./files";
import { clearReferenceCatalogs } from "./lib/composerReferences";
import type { Conversation, QueuedMessage, UserMessage } from "./model";
import { queuedPreview } from "./QueueList";
import { useAgents } from "./store";

const native = vi.hoisted(() => {
  window.matchMedia ??= ((query: string) => ({
    matches: false,
    media: query,
    addEventListener: () => undefined,
    removeEventListener: () => undefined,
  })) as unknown as typeof window.matchMedia;
  return { invoke: vi.fn(), settings: new Map<string, unknown>() };
});
vi.mock("../../lib/native", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../lib/native")>()),
  invoke: native.invoke,
  onNativeEvent: vi.fn(() => () => undefined),
}));

function conversation(id: string, patch: Partial<Conversation> = {}): Conversation {
  return {
    id,
    title: "Nouvelle conversation",
    provider: "claude",
    cwd: "/projet",
    autonomy: "ask",
    createdAt: 0,
    updatedAt: 0,
    archived: false,
    unread: false,
    started: true,
    turns: [],
    ...patch,
  };
}

let sent: UserMessage[];

beforeEach(() => {
  sent = [];
  clearReferenceCatalogs();
  resetComposerDrafts();
  native.settings.clear();
  native.invoke.mockReset();
  native.invoke.mockImplementation(async (command: string, args: Record<string, unknown> = {}) => {
    if (command === "settings.get") return native.settings.get(String(args.key)) ?? null;
    if (command === "settings.set") {
      native.settings.set(String(args.key), structuredClone(args.value));
      return null;
    }
    if (command === "files.saveExchange") return { path: `/echange/${String(args.name)}`, name: String(args.name) };
    return null;
  });
  useShell.setState({
    snapshot: { path: "/projet", name: "Espace", accent: null, sections: [], settingsPages: [] } as unknown as Snapshot,
  });
  useAgents.setState({
    ready: true,
    loaded: {},
    runtime: {},
    send: async (_id: string, message: UserMessage) => {
      sent.push(message);
    },
  });
});

afterEach(() => {
  vi.useRealTimers();
});

async function editor() {
  const input = screen.getByRole("textbox", { name: "Message à l’agent" });
  await waitFor(() => expect(input).toHaveAttribute("contenteditable", "true"));
  return input;
}

function paste(target: HTMLElement, text: string) {
  fireEvent.paste(target, {
    clipboardData: { getData: () => text, items: [], files: [] },
  });
}

describe("brouillons", () => {
  it("chaque conversation garde son brouillon, enregistré et relu au redémarrage", async () => {
    const user = userEvent.setup();
    const { rerender, unmount } = render(<Composer conversation={conversation("a")} responding={false} />);
    await user.click(await editor());
    await user.keyboard("Brouillon de A");

    rerender(<Composer conversation={conversation("b")} responding={false} />);
    const input = await editor();
    expect(input).toHaveTextContent("");
    await user.click(input);
    await user.keyboard("Autre");

    rerender(<Composer conversation={conversation("a")} responding={false} />);
    await waitFor(() =>
      expect(screen.getByRole("textbox", { name: "Message à l’agent" })).toHaveTextContent("Brouillon de A"),
    );

    await act(() => flushComposerDrafts());
    const stored = native.settings.get(DRAFTS_KEY) as Record<string, { text: string }>;
    expect(stored.a.text).toBe("Brouillon de A");
    expect(stored.b.text).toBe("Autre");

    // Redémarrage : plus rien en mémoire, le brouillon revient des réglages.
    unmount();
    resetComposerDrafts();
    render(<Composer conversation={conversation("b")} responding={false} />);
    await waitFor(() => expect(screen.getByRole("textbox", { name: "Message à l’agent" })).toHaveTextContent("Autre"));
  });

  it("un brouillon illisible verrouille la saisie, avec « Réessayer » et « Supprimer le brouillon »", async () => {
    native.settings.set(DRAFTS_KEY, { a: { version: 9 }, b: serializeDraft({ ...blankDraft, text: "Gardé" }) });
    const user = userEvent.setup();
    render(<Composer conversation={conversation("a")} responding={false} />);
    expect(await screen.findByText("Le brouillon enregistré de cette conversation est illisible.")).toBeVisible();
    const input = screen.getByRole("textbox", { name: "Message à l’agent" });
    expect(input).toHaveAttribute("aria-disabled", "true");
    expect(input).toHaveAttribute("contenteditable", "false");

    await user.click(screen.getByRole("button", { name: "Supprimer le brouillon" }));
    await waitFor(() => expect(input).toHaveAttribute("contenteditable", "true"));
    expect(screen.queryByText(/illisible/)).toBeNull();
    // L’autre brouillon n’a pas été touché.
    expect(native.settings.get(DRAFTS_KEY)).toEqual({ b: serializeDraft({ ...blankDraft, text: "Gardé" }) });
  });

  it("des brouillons non chargés verrouillent la saisie jusqu’à un nouvel essai réussi", async () => {
    let failing = true;
    const base = native.invoke.getMockImplementation();
    native.invoke.mockImplementation(async (command: string, args: Record<string, unknown> = {}) => {
      if (command === "settings.get" && failing) throw new Error("Base indisponible");
      return base?.(command, args);
    });
    const user = userEvent.setup();
    render(<Composer conversation={conversation("a")} responding={false} />);
    expect(
      await screen.findByText("Les brouillons n’ont pas pu être chargés. Réessayez avant de saisir un message."),
    ).toBeVisible();
    expect(screen.getByRole("textbox", { name: "Message à l’agent" })).toHaveAttribute("aria-disabled", "true");
    failing = false;
    await user.click(screen.getByRole("button", { name: "Réessayer" }));
    await editor();
    expect(screen.queryByText(/n’ont pas pu être chargés/)).toBeNull();
  });

  it("la saisie reste verrouillée tant que les conversations ne sont pas prêtes", async () => {
    useAgents.setState({ ready: false });
    render(<Composer conversation={conversation("a")} responding={false} />);
    await act(() => useComposerDrafts.getState().load());
    expect(screen.getByRole("textbox", { name: "Message à l’agent" })).toHaveAttribute("aria-disabled", "true");
    expect(screen.getByRole("button", { name: "Envoyer" })).toBeDisabled();
    act(() => useAgents.setState({ ready: true }));
    await editor();
  });

  it("un brouillon déposé avant le chargement (capture) s’y ajoute", async () => {
    native.settings.set(DRAFTS_KEY, { a: serializeDraft({ ...blankDraft, text: "Déjà là" }) });
    setComposerDraft("a", { contexts: [{ id: "x", title: "Élément à corriger", text: "contexte" }] });
    render(<Composer conversation={conversation("a")} responding={false} />);
    await waitFor(() =>
      expect(screen.getByRole("textbox", { name: "Message à l’agent" })).toHaveTextContent("Déjà là"),
    );
    expect(screen.getByRole("button", { name: "Retirer Élément à corriger" })).toBeInTheDocument();
  });

  it("la forme enregistrée se relit à l’identique, sans les vignettes", () => {
    const draft = {
      text: "Salut",
      references: [{ id: "r", offset: 0, kind: "file" as const, name: "a.ts", path: "/p/a.ts" }],
      attachments: [{ path: "/p/i.png", name: "i.png", mimeType: "image/png", preview: "data:image/webp;base64,AA" }],
      pastes: [{ id: "p", title: "Texte collé 1", text: "long" }],
    };
    const parsed = parseDraft(structuredClone(serializeDraft(draft)));
    expect(parsed.attachments[0]).toEqual({ path: "/p/i.png", name: "i.png", mimeType: "image/png" });
    expect(parsed.text).toBe("Salut");
    expect(() => parseDraft({ ...serializeDraft(draft), references: [{ name: "x" }] })).toThrow();
  });
});

describe("envoi", () => {
  it("la saisie se vide à l’envoi et revient si l’envoi échoue", async () => {
    useAgents.setState({
      send: async () => {
        throw new Error("La file contient déjà 50 messages.");
      },
    });
    const user = userEvent.setup();
    render(<Composer conversation={conversation("a")} responding={false} />);
    const input = await editor();
    await user.click(input);
    await user.keyboard("Ne pas perdre ceci{Enter}");
    await waitFor(() => expect(input).toHaveTextContent("Ne pas perdre ceci"));
    expect(useComposerDrafts.getState().read("a").text).toBe("Ne pas perdre ceci");
  });

  it("plusieurs Entrée avant le rendu suivant n’envoient qu’un message", async () => {
    const user = userEvent.setup();
    render(<Composer conversation={conversation("a")} responding={false} />);
    const input = await editor();
    await user.click(input);
    await user.keyboard("Une fois");
    act(() => {
      fireEvent.keyDown(input, { key: "Enter" });
      fireEvent.keyDown(input, { key: "Enter" });
      fireEvent.keyDown(input, { key: "Enter" });
    });
    await waitFor(() => expect(sent).toHaveLength(1));
    expect(sent[0].text).toBe("Une fois");
  });

  it("l’envoi attend la préparation des pièces jointes : bouton désactivé et en chargement", async () => {
    let release: (value: unknown) => void = () => undefined;
    const base = native.invoke.getMockImplementation();
    native.invoke.mockImplementation(async (command: string, args: Record<string, unknown> = {}) => {
      if (command === "files.saveExchange") {
        await new Promise((resolve) => {
          release = resolve;
        });
      }
      return base?.(command, args);
    });
    const user = userEvent.setup();
    render(<Composer conversation={conversation("a")} responding={false} />);
    const input = await editor();
    await user.click(input);
    await user.keyboard("Avec l’image");
    const image = new File(["png"], "capture.png", { type: "image/png" });
    fireEvent.paste(input, {
      clipboardData: {
        getData: () => "",
        items: [{ kind: "file", type: "image/png", getAsFile: () => image }],
        files: [image],
      },
    });
    const button = screen.getByRole("button", { name: "Envoyer" });
    await waitFor(() => expect(button).toHaveAttribute("aria-busy", "true"));
    expect(button).toBeDisabled();
    fireEvent.keyDown(input, { key: "Enter" });
    expect(sent).toHaveLength(0);

    await act(async () => release(undefined));
    await waitFor(() => expect(button).not.toBeDisabled());
    expect(screen.getByRole("button", { name: "Retirer capture.png" })).toBeInTheDocument();
    await user.click(button);
    await waitFor(() => expect(sent).toHaveLength(1));
    expect(sent[0].attachments).toEqual([{ path: "/echange/capture.png", name: "capture.png", mimeType: "image/png" }]);
  });

  it("un collage d’au moins 2 000 caractères ou 20 lignes devient une carte « Texte collé N », supprimable", async () => {
    expect(isLongChatText("a".repeat(1999))).toBe(false);
    expect(isLongChatText("a".repeat(2000))).toBe(true);
    expect(isLongChatText(Array.from({ length: 19 }, () => "l").join("\n"))).toBe(false);
    expect(isLongChatText(Array.from({ length: 20 }, () => "l").join("\n"))).toBe(true);

    const user = userEvent.setup();
    render(<Composer conversation={conversation("a")} responding={false} />);
    const input = await editor();
    await user.click(input);
    paste(input, Array.from({ length: 25 }, (_, index) => `ligne ${index}`).join("\n"));
    expect(await screen.findByRole("button", { name: /^Voir Texte collé 1 · / })).toBeVisible();
    expect(input).toHaveTextContent("");
    paste(input, "b".repeat(2500));
    await user.click(await screen.findByRole("button", { name: "Retirer Texte collé 2" }));
    expect(screen.queryByRole("button", { name: /Texte collé 2/ })).toBeNull();
    await user.click(screen.getByRole("button", { name: "Envoyer" }));
    await waitFor(() => expect(sent).toHaveLength(1));
    expect(sent[0].contexts[0].title).toBe("Texte collé 1");
    expect(sent[0].contexts[0].text).toContain("ligne 24");
  });

  it("pendant une réponse, l’indication propose de mettre en file", async () => {
    render(<Composer conversation={conversation("a", { turns: [] })} responding />);
    expect(await editor()).toHaveAttribute("aria-placeholder", "Ajouter un message à la file…");
  });

  it("un message déjà commencé garde sa place quand un autre revient dans la saisie", () => {
    const merged = mergeIntoDraft(
      {
        text: "Revenu",
        attachments: [],
        contexts: [],
        references: [{ id: "r1", offset: 0, kind: "skill", name: "relire", path: "/s" }],
      },
      { ...blankDraft, text: "Tapé", references: [{ id: "r2", offset: 4, kind: "file", name: "a", path: "/a" }] },
    );
    expect(merged.text).toBe("Revenu\n\nTapé");
    expect(merged.references.map((item) => [item.id, item.offset])).toEqual([
      ["r1", 0],
      ["r2", 12],
    ]);
  });
});

describe("pièces jointes", () => {
  it("16 fichiers au plus, de 20 Mo chacun", async () => {
    expect(() => checkAttachmentLimits(Array.from({ length: 17 }, () => ({ size: 1 })))).toThrow(
      ATTACHMENT_LIMIT_MESSAGE,
    );
    expect(() => checkAttachmentLimits([{ size: 21 * 1024 * 1024 }])).toThrow(
      "Joignez au plus 16 fichiers de 20 Mo chacun.",
    );
    expect(() => checkAttachmentLimits(Array.from({ length: 16 }, () => ({ size: 20 * 1024 * 1024 })))).not.toThrow();
    const big = new File(["x"], "gros.bin");
    Object.defineProperty(big, "size", { value: 21 * 1024 * 1024 });
    await expect(saveBlobs("a", [big])).rejects.toThrow(ATTACHMENT_LIMIT_MESSAGE);
    expect(native.invoke).not.toHaveBeenCalledWith("files.saveExchange", expect.anything());
  });
});

describe("file d’attente", () => {
  const item = (id: string, message: Partial<UserMessage>): QueuedMessage => ({
    id,
    message: { text: "", attachments: [], contexts: [], ...message },
  });

  it("aperçu : pastilles des références, « Texte collé » pour un collage seul", async () => {
    useAgents.setState({
      runtime: {
        a: {
          status: "responding",
          approvals: [],
          questions: [],
          queued: [
            item("q1", {
              text: "Vérifie la page",
              references: [{ id: "r", offset: 0, kind: "skill", name: "relire", path: "/s" }],
            }),
            item("q2", { contexts: [{ id: "p", title: "Texte collé 1", text: "long" }] }),
          ],
        },
      },
    });
    render(<Composer conversation={conversation("a")} responding />);
    const queue = screen.getByRole("region", { name: "2 messages en file, envoyés à la fin de l’étape en cours" });
    const rows = within(queue).getAllByRole("listitem");
    expect(within(rows[0]).getByText("relire")).toHaveClass("reference-pill");
    expect(rows[0]).toHaveTextContent("relireVérifie la page");
    expect(rows[1]).toHaveTextContent("Texte collé");
    expect(within(queue).getByRole("button", { name: "Envoyer le message 2 maintenant" })).toBeInTheDocument();
    // Sans action de réordonnancement dans le store, pas de poignée.
    expect(within(queue).queryByRole("button", { name: /Déplacer le message/ })).toBeNull();
    expect(queuedPreview(item("q3", { attachments: [{ path: "/a", name: "a" }] }).message)).toBe(
      "1 pièce(s) jointe(s)",
    );
  });

  it("la poignée réordonne la file au clavier quand le store sait le faire", async () => {
    // Le store remet sa file dans l’ordre demandé, comme le fera `reorderQueued` du moteur des conversations.
    const reorderQueued = vi.fn(async (id: string, ids: string[]) => {
      const runtime = useAgents.getState().runtime[id];
      useAgents.setState({
        runtime: {
          [id]: {
            ...runtime,
            queued: ids.flatMap((queuedId) => runtime.queued.filter((entry) => entry.id === queuedId)),
          },
        },
      });
    });
    useAgents.setState({
      reorderQueued,
      runtime: {
        a: {
          status: "responding",
          approvals: [],
          questions: [],
          queued: [item("q1", { text: "Premier" }), item("q2", { text: "Second" })],
        },
      },
    } as never);
    render(<Composer conversation={conversation("a")} responding />);
    const handle = await screen.findByRole("button", { name: "Déplacer le message 1" });
    fireEvent.keyDown(handle, { key: "ArrowDown" });
    await waitFor(() => expect(reorderQueued).toHaveBeenCalledWith("a", ["q2", "q1"]));
    const rows = within(screen.getByRole("region", { name: /en file/ })).getAllByRole("listitem");
    expect(rows[0]).toHaveTextContent("Second");
    useAgents.setState({ reorderQueued: undefined } as never);
  });
});
