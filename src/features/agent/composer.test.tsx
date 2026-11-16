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
import { Composer, clipboardImages, isLongChatText, mergeIntoDraft, numberPastes } from "./Composer";
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
  const input = screen.getByRole("textbox", { name: /^Message à / });
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
      expect(screen.getByRole("textbox", { name: /^Message à / })).toHaveTextContent("Brouillon de A"),
    );

    await act(() => flushComposerDrafts());
    const stored = native.settings.get(DRAFTS_KEY) as Record<string, { text: string }>;
    expect(stored.a.text).toBe("Brouillon de A");
    expect(stored.b.text).toBe("Autre");

    // Redémarrage : plus rien en mémoire, le brouillon revient des réglages.
    unmount();
    resetComposerDrafts();
    render(<Composer conversation={conversation("b")} responding={false} />);
    await waitFor(() => expect(screen.getByRole("textbox", { name: /^Message à / })).toHaveTextContent("Autre"));
  });

  it("un brouillon illisible verrouille la saisie, avec « Réessayer » et « Supprimer le brouillon »", async () => {
    native.settings.set(DRAFTS_KEY, { a: { version: 9 }, b: serializeDraft({ ...blankDraft, text: "Gardé" }) });
    const user = userEvent.setup();
    render(<Composer conversation={conversation("a")} responding={false} />);
    expect(await screen.findByText("Le brouillon enregistré de cette conversation est illisible.")).toBeVisible();
    const input = screen.getByRole("textbox", { name: /^Message à / });
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
    expect(screen.getByRole("textbox", { name: /^Message à / })).toHaveAttribute("aria-disabled", "true");
    failing = false;
    await user.click(screen.getByRole("button", { name: "Réessayer" }));
    await editor();
    expect(screen.queryByText(/n’ont pas pu être chargés/)).toBeNull();
  });

  it("la saisie reste verrouillée tant que les conversations ne sont pas prêtes", async () => {
    useAgents.setState({ ready: false });
    render(<Composer conversation={conversation("a")} responding={false} />);
    await act(() => useComposerDrafts.getState().load());
    expect(screen.getByRole("textbox", { name: /^Message à / })).toHaveAttribute("aria-disabled", "true");
    expect(screen.getByRole("button", { name: "Envoyer" })).toBeDisabled();
    act(() => useAgents.setState({ ready: true }));
    await editor();
  });

  it("un brouillon déposé avant le chargement (capture) s’y ajoute", async () => {
    native.settings.set(DRAFTS_KEY, { a: serializeDraft({ ...blankDraft, text: "Déjà là" }) });
    setComposerDraft("a", { contexts: [{ id: "x", title: "Élément à corriger", text: "contexte" }] });
    render(<Composer conversation={conversation("a")} responding={false} />);
    await waitFor(() => expect(screen.getByRole("textbox", { name: /^Message à / })).toHaveTextContent("Déjà là"));
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
      "Analyse les fichiers joints.",
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

  it("comme dans OneApp : la file est en tête du cadre de la saisie, avec le même bouton d’envoi rond", async () => {
    useAgents.setState({
      runtime: {
        a: {
          status: "responding",
          approvals: [],
          questions: [],
          queued: [item("q1", { text: "Faire le point" })],
        },
      },
    });
    render(<Composer conversation={conversation("a")} responding />);
    const queue = screen.getByRole("region", { name: /en file/ });
    expect(queue.closest("form")).toHaveClass("agent-composer__box");
    expect(queue).toHaveClass("agent-queue");
    const sendNow = within(queue).getByRole("button", { name: "Envoyer le message 1 maintenant" });
    expect(sendNow).toHaveClass("agent-send-button", "agent-send-button--up-right");
    const send = screen.getByRole("button", { name: "Envoyer maintenant" });
    expect(send).toHaveClass("agent-send-button");
    expect(sendNow.querySelector("svg")?.outerHTML).toBe(send.querySelector("svg")?.outerHTML);
  });

  it("modifier reprend le texte et les pastilles à la place de la saisie ; pas pour un message avec pièces jointes", async () => {
    const unqueue = vi.fn((id: string, queuedId: string) => {
      const runtime = useAgents.getState().runtime[id];
      const found = runtime.queued.find((entry) => entry.id === queuedId);
      useAgents.setState({
        runtime: { [id]: { ...runtime, queued: runtime.queued.filter((entry) => entry.id !== queuedId) } },
      });
      return found?.message;
    });
    useAgents.setState({
      unqueue,
      runtime: {
        a: {
          status: "responding",
          approvals: [],
          questions: [],
          queued: [
            item("q1", { text: "Corriger ceci" }),
            item("q2", { text: "Avec fichier", attachments: [{ path: "/a", name: "a" }] }),
          ],
        },
      },
    } as never);
    await useComposerDrafts.getState().load();
    useComposerDrafts.getState().patch("a", { text: "Déjà tapé" });
    render(<Composer conversation={conversation("a")} responding />);
    expect(screen.getByRole("button", { name: "Modifier le message 2" })).toBeDisabled();
    fireEvent.click(screen.getByRole("button", { name: "Modifier le message 1" }));
    expect(unqueue).toHaveBeenCalledWith("a", "q1");
    await waitFor(() => expect(useComposerDrafts.getState().read("a").text).toBe("Corriger ceci"));
  });

  it("pendant une réponse : « Arrêter l’agent », le rappel des raccourcis sur la ligne du modèle, modèle modifiable", async () => {
    render(<Composer conversation={conversation("a")} responding status={<span>3 fichiers modifiés</span>} />);
    expect(screen.getByRole("button", { name: "Arrêter l’agent" })).toBeInTheDocument();
    const hint = screen.getByText(/pour envoyer, .* pour mettre en file/);
    const options = hint.closest(".agent-composer__options");
    expect(options).not.toBeNull();
    expect(options).toHaveTextContent("3 fichiers modifiés");
    await waitFor(() => expect(screen.getByRole("button", { name: /^Modèle de l’agent/ })).toBeEnabled());
    expect(screen.getByRole("textbox", { name: "Message à Nouvelle conversation" })).toBeInTheDocument();
  });
});

describe("collages et presse-papiers", () => {
  it("retirer un collage renumérote les suivants, comme les cartes de OneApp", () => {
    expect(
      numberPastes([
        { id: "b", title: "Texte collé 2", text: "deux" },
        { id: "c", title: "Citation", text: "autre" },
        { id: "d", title: "Texte collé 3", text: "trois" },
      ]).map((paste) => paste.title),
    ).toEqual(["Texte collé 1", "Citation", "Texte collé 2"]);
  });

  it("seules les images du presse-papiers deviennent des pièces jointes", () => {
    const image = new File(["i"], "capture.png", { type: "image/png" });
    const text = new File(["t"], "notes.txt", { type: "text/plain" });
    expect(clipboardImages({ items: [] as unknown as DataTransferItemList, files: [image, text] as never })).toEqual([
      image,
    ]);
  });
});
