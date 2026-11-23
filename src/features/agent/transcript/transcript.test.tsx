import { act, fireEvent, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { render } from "../socle.test-helper";

const native = vi.hoisted(() => {
  window.matchMedia ??= ((query: string) => ({
    matches: false,
    media: query,
    addEventListener: () => undefined,
    removeEventListener: () => undefined,
  })) as unknown as typeof window.matchMedia;
  return { invoke: vi.fn() };
});
vi.mock("../../../lib/native", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../../lib/native")>()),
  invoke: native.invoke,
  onNativeEvent: vi.fn(() => () => undefined),
}));

import { Markdown } from "socle-ui/markdown";
import { Activities, activityStatusLabel } from "../Activities";
import { referencedLocalImages } from "../lib/chatImages";
import type { Conversation, ConversationRuntime, Turn } from "../model";
import { useAgents } from "../store";
import {
  CHAINED_TURN_GAP,
  ConversationQuestion,
  changedFilesOf,
  conversationModelLabel,
  elapsedWorkTime,
  finalMessage,
  isLongChatText,
  producedFiles,
  producedImages,
  QUOTE_EVENT,
  RECENT_TURNS,
  Transcript,
  turnDelivery,
  turnSequences,
} from "../Transcript";
import { agentQuestion, withoutAgentQuestion } from "./agentQuestions";
import { ErrorBoundary } from "./ErrorBoundary";
import { ReferencePills } from "./ReferencePills";

const idle: ConversationRuntime = { status: "idle", approvals: [], questions: [], queued: [] };

function turn(id: string, patch: Partial<Turn> = {}): Turn {
  return {
    id,
    user: { text: `Demande ${id}`, attachments: [], contexts: [] },
    items: [{ kind: "message", id: `${id}-m`, content: `Réponse ${id}` }],
    status: "done",
    startedAt: 1_000,
    endedAt: 5_000,
    ...patch,
  };
}

function conversation(turns: Turn[], patch: Partial<Conversation> = {}): Conversation {
  return {
    id: "c1",
    title: "Factures",
    provider: "claude",
    cwd: "/espace",
    autonomy: "ask",
    createdAt: Date.UTC(2026, 10, 16, 9, 30),
    updatedAt: 0,
    archived: false,
    unread: false,
    started: true,
    turns,
    ...patch,
  };
}

const question = (json: string, fence = "alfred-question") => `Je dois savoir.\n\n\`\`\`${fence}\n${json}\n\`\`\``;

beforeEach(() => {
  native.invoke.mockReset();
  native.invoke.mockResolvedValue(undefined);
});
afterEach(() => vi.restoreAllMocks());

describe("question de l’agent", () => {
  it("retire le bloc final du texte et lit la question tant que rien n’est en attente", () => {
    const content = question('{"question":"Quel format ?","options":["PDF","Word"," "]}');
    expect(withoutAgentQuestion(content)).toBe("Je dois savoir.");
    const last = turn("t1", { items: [{ kind: "message", id: "m", content }] });
    expect(agentQuestion(conversation([last]), idle)).toEqual({ question: "Quel format ?", options: ["PDF", "Word"] });
    expect(agentQuestion(conversation([last]), { ...idle, status: "responding" })).toBeUndefined();
    expect(
      agentQuestion(conversation([last]), {
        ...idle,
        queued: [{ id: "q", message: { text: "x", attachments: [], contexts: [] } }],
      }),
    ).toBeUndefined();
    expect(agentQuestion(conversation([{ ...last, status: "error" }]), idle)).toBeUndefined();
  });

  it("lit aussi le bloc de OneApp et laisse un bloc invalide dans le texte", () => {
    expect(withoutAgentQuestion(question('{"question":"Oui ?"}', "oneapp-question"))).toBe("Je dois savoir.");
    const invalid = question("{pas du json}");
    expect(withoutAgentQuestion(invalid)).toBe(invalid);
  });
});

describe("présentation d’un tour", () => {
  it("donne la remise du message comme OneApp", () => {
    expect(turnDelivery(turn("t", { status: "running", items: [] })).status).toBe("pending");
    expect(turnDelivery(turn("t", { status: "running" })).status).toBe("sent");
    expect(turnDelivery(turn("t", { status: "error", items: [] })).status).toBe("error");
    expect(turnDelivery(turn("t", { status: "cancelled", items: [] })).status).toBe("cancelled");
  });

  it("garde sous le tour les images produites et les fichiers des outils", () => {
    const produced = turn("t", {
      items: [
        {
          kind: "activity",
          id: "a",
          activityKind: "tool",
          title: "Génération d’image",
          images: ["/tmp/a.png"],
          status: "completed",
        },
        {
          kind: "activity",
          id: "b",
          activityKind: "tool",
          title: "Lire",
          images: ["/tmp/lue.png"],
          files: ["/tmp/r.pdf"],
          status: "completed",
        },
      ],
    });
    expect(producedImages(produced)).toEqual(["/tmp/a.png"]);
    expect(producedFiles(produced)).toEqual(["/tmp/r.pdf"]);
  });

  it("découpe les tours en suites enchaînées et cumule leurs fichiers", () => {
    const sequences = turnSequences([
      turn("a", { startedAt: 0, endedAt: 10 }),
      turn("b", { startedAt: 10 + CHAINED_TURN_GAP, endedAt: 200_000 }),
      turn("c", { startedAt: 200_001 + CHAINED_TURN_GAP }),
    ]);
    expect(sequences.map((sequence) => sequence.map((item) => item.id))).toEqual([["a", "b"], ["c"]]);
    expect(
      changedFilesOf([
        turn("a", { changedFiles: ["x.md", "y.png"], changedLines: { "x.md": { added: 1, removed: 2 } } }),
        turn("b", { changedFiles: ["x.md", "y.png"], changedLines: { "x.md": { added: 3, removed: 0 } } }),
      ]),
    ).toEqual([
      { path: "x.md", added: 4, removed: 2 },
      { path: "y.png", added: null, removed: null },
    ]);
  });

  it("donne les lignes de chaque fichier modifié, ou rien quand elles sont inconnues", () => {
    expect(
      changedFilesOf(
        turn("t", { changedFiles: ["a.ts", "b.png"], changedLines: { "a.ts": { added: 3, removed: 1 } } }),
      ),
    ).toEqual([
      { path: "a.ts", added: 3, removed: 1 },
      { path: "b.png", added: null, removed: null },
    ]);
  });

  it("reconnaît un long message, le modèle et l’activité arrêtée", () => {
    expect(isLongChatText("a".repeat(2000))).toBe(true);
    expect(isLongChatText(Array(20).fill("l").join("\n"))).toBe(true);
    expect(isLongChatText("court\ntexte")).toBe(false);
    expect(conversationModelLabel({ model: "gpt-5", effort: "high" })).toBe("gpt-5 · Élevé");
    expect(conversationModelLabel({})).toBeUndefined();
    expect(activityStatusLabel("cancelled")).toBe("Arrêté");
    expect(activityStatusLabel("stopped")).toBe("Arrêté");
  });

  it("trouve les images citées hors des images insérées et des blocs de code, 8 au plus", () => {
    const text = [
      "Voir `captures/avant.png` et captures/apres.jpg.",
      "![insérée](captures/inseree.png)",
      "```\ncode/ignoree.png\n```",
      ...Array.from({ length: 10 }, (_, index) => `img/${index}.png`),
    ].join("\n");
    const images = referencedLocalImages(text);
    expect(images.slice(0, 2)).toEqual(["captures/avant.png", "captures/apres.jpg"]);
    expect(images).not.toContain("captures/inseree.png");
    expect(images).not.toContain("code/ignoree.png");
    expect(images).toHaveLength(8);
  });

  it("place les références en pastilles à leur position, comme OneApp", () => {
    render(
      <ReferencePills
        text=" puis  à relire"
        references={[
          { id: "r2", name: "src/page.tsx", path: "/e/src/page.tsx", kind: "file", offset: 6 },
          { id: "r1", name: "publier", path: "/c/publier.md", kind: "command", offset: 0 },
          { name: "ancienne", path: "/c/ancienne.md", kind: "command" },
        ]}
      />,
    );
    const pills = [...document.querySelectorAll(".agent-chat__reference-pill")].map((pill) => pill.textContent);
    expect(pills).toEqual(["publier", "page.tsx"]);
    expect(document.querySelector(".reference-text")?.textContent).toBe("publier puis page.tsx à relire");
  });
});

describe("relevé", () => {
  beforeEach(() => {
    useAgents.setState({
      retry: vi.fn(async () => undefined),
      send: vi.fn(async () => undefined),
      answerApproval: vi.fn(async () => undefined),
    });
  });

  it("s’ouvre sur les derniers tours puis montre les précédents", async () => {
    const turns = Array.from({ length: RECENT_TURNS + 4 }, (_, index) => turn(`t${index}`));
    render(<Transcript conversation={conversation(turns)} runtime={idle} />);
    await waitFor(() => expect(screen.getByText("Demande t0")).toBeInTheDocument(), { timeout: 5000 });
    expect(screen.getByText(`Demande t${RECENT_TURNS + 3}`)).toBeInTheDocument();
  });

  it("montre l’en-tête avec le modèle, la remise, un long message en carte et les pastilles", () => {
    const long = "x".repeat(2500);
    render(
      <Transcript
        conversation={conversation(
          [
            turn("t1", { user: { text: long, attachments: [], contexts: [] } }),
            turn("t2", {
              user: {
                text: " maintenant",
                attachments: [],
                contexts: [],
                references: [{ id: "r1", name: "publier", path: "/c/publier.md", kind: "command", offset: 0 }],
              },
            }),
          ],
          { model: "gpt-5", origin: { reference: "notes/page", title: "Notes" } },
        )}
        runtime={idle}
        header
      />,
    );
    const header = screen.getByText(/^Depuis Notes · /);
    expect(header).toHaveAttribute("title", "gpt-5");
    expect(screen.getByRole("button", { name: /^Voir Texte · 2.500 caractères$/ })).toBeInTheDocument();
    expect(screen.getByText("publier")).toHaveClass("agent-chat__reference-pill");
    expect(screen.getAllByText("Envoyé")).toHaveLength(2);
  });

  it("ne redessine pas la bulle d’un message relancé, comme OneApp", () => {
    render(
      <Transcript
        conversation={conversation([turn("t1", { status: "error" }), turn("t2", { retryOf: "t1" })])}
        runtime={idle}
      />,
    );
    expect(screen.getAllByText("Demande t1")).toHaveLength(1);
    expect(screen.queryByText("Demande t2")).not.toBeInTheDocument();
  });

  it("n’affiche l’arrêt qu’en bas de la conversation, comme OneApp", () => {
    const { unmount } = render(
      <Transcript conversation={conversation([turn("t1", { status: "cancelled" }), turn("t2")])} runtime={idle} />,
    );
    expect(screen.queryByText("Exécution arrêtée · Travail non terminé")).not.toBeInTheDocument();
    unmount();
    render(<Transcript conversation={conversation([turn("t1", { status: "cancelled" })])} runtime={idle} />);
    expect(screen.getByText("Exécution arrêtée · Travail non terminé")).toBeInTheDocument();
  });

  it("propose « Réessayer le message » sous l’erreur du dernier tour", () => {
    render(
      <Transcript
        conversation={conversation([turn("t1", { status: "error", error: "Session perdue" })])}
        runtime={idle}
      />,
    );
    fireEvent.click(screen.getByRole("button", { name: "Réessayer le message" }));
    expect(useAgents.getState().retry).toHaveBeenCalledWith("c1");
  });

  it("relance un message et repart d’ici depuis le message ou la réponse", () => {
    const resend = vi.fn(async () => undefined);
    const fork = vi.fn(async () => undefined);
    useAgents.setState({ resend, fork } as never);
    render(<Transcript conversation={conversation([turn("t1")])} runtime={idle} />);
    fireEvent.click(screen.getByRole("button", { name: "Relancer le message" }));
    expect(resend).toHaveBeenCalledWith("c1", "t1");
    const [fromUser, fromReply] = screen.getAllByRole("button", { name: "Repartir d’ici" });
    fireEvent.click(fromUser);
    expect(fork).toHaveBeenLastCalledWith("c1", "t1", "user");
    fireEvent.click(fromReply);
    expect(fork).toHaveBeenLastCalledWith("c1", "t1", "reply");
    useAgents.setState({ resend: undefined, fork: undefined } as never);
  });

  it("cite le passage sélectionné de la réponse, sinon toute la réponse", () => {
    const quoted = vi.fn();
    const listener = (event: Event) => quoted((event as CustomEvent).detail);
    window.addEventListener(QUOTE_EVENT, listener);
    render(<Transcript conversation={conversation([turn("t1")])} runtime={idle} />);
    const cite = screen.getByRole("button", { name: "Citer dans la réponse" });
    fireEvent.click(cite);
    expect(quoted).toHaveBeenLastCalledWith({ conversationId: "c1", text: "Réponse t1" });
    const answer = screen.getByText("Réponse t1");
    const range = document.createRange();
    range.setStart(answer.firstChild as Text, 0);
    range.setEnd(answer.firstChild as Text, 7);
    window.getSelection()?.removeAllRanges();
    window.getSelection()?.addRange(range);
    fireEvent.pointerDown(cite);
    fireEvent.click(cite);
    expect(quoted).toHaveBeenLastCalledWith({ conversationId: "c1", text: "Réponse" });
    window.removeEventListener(QUOTE_EVENT, listener);
  });

  it("pose la question au-dessus de la saisie, répond au chiffre et se replie", () => {
    const content = question('{"question":"Quel format ?","options":["PDF","Word"]}');
    render(
      <Transcript
        conversation={conversation([turn("t1", { items: [{ kind: "message", id: "m", content }] })])}
        runtime={idle}
      />,
    );
    expect(screen.queryByText(/alfred-question/)).not.toBeInTheDocument();
    const card = screen.getByRole("region", { name: "Question de l’agent" });
    expect(within(card).getByText("Quel format ?")).toBeVisible();
    fireEvent.keyDown(within(card).getByRole("button", { name: "Word" }), { key: "2" });
    expect(useAgents.getState().send).toHaveBeenCalledWith("c1", { text: "Word", attachments: [], contexts: [] });
    fireEvent.click(within(card).getByRole("button", { name: "Replier la question" }));
    expect(screen.getByRole("button", { name: /Question de l’agent en attente/ })).toBeInTheDocument();
  });

  it("présente l’autorisation dans la même carte, options numérotées", () => {
    render(
      <Transcript
        conversation={conversation([turn("t1", { status: "running", endedAt: undefined, items: [] })])}
        runtime={{
          ...idle,
          status: "responding",
          approvals: [
            {
              id: "a1",
              title: "Exécuter une commande",
              detail: "ls",
              options: [
                { id: "allow", label: "Autoriser", kind: "allow" },
                { id: "deny", label: "Refuser", kind: "deny" },
              ],
            },
          ],
        }}
      />,
    );
    const card = screen.getByRole("region", { name: "Autorisation demandée" });
    fireEvent.keyDown(card, { key: "1" });
    expect(useAgents.getState().answerApproval).toHaveBeenCalledWith("c1", "a1", "allow");
    expect(screen.getByText("Autorisation requise")).toBeInTheDocument();
  });

  it("montre les images citées et les fichiers cités avec leurs actions", async () => {
    native.invoke.mockImplementation(async (command: string) =>
      command === "files.readImage" ? { dataUrl: "data:image/png;base64,iVBORw0KGgo=" } : undefined,
    );
    render(
      <Transcript
        conversation={conversation([
          turn("t1", { items: [{ kind: "message", id: "m", content: "Fait : sortie/graphe.png et `rapport.pdf`." }] }),
        ])}
        runtime={idle}
      />,
    );
    const images = screen.getByRole("region", { name: "Images citées" });
    expect(await within(images).findByRole("button", { name: "Agrandir l’image : graphe.png" })).toBeInTheDocument();
    expect(native.invoke).toHaveBeenCalledWith("files.readImage", { path: "sortie/graphe.png", base: "/espace" });
    const files = screen.getByRole("region", { name: "Fichiers cités" });
    fireEvent.click(within(files).getByRole("button", { name: "Ouvrir rapport.pdf" }));
    await waitFor(() =>
      expect(native.invoke).toHaveBeenCalledWith("files.open", { path: "rapport.pdf", base: "/espace" }),
    );
    expect(within(files).getByRole("button", { name: "Enregistrer… une copie de rapport.pdf" })).toBeInTheDocument();
    expect(within(files).getByText("Aperçu")).toBeInTheDocument();
  });

  it("donne l’état d’une image jointe et permet de réessayer", async () => {
    native.invoke.mockRejectedValueOnce(new Error("absente"));
    native.invoke.mockResolvedValue({ dataUrl: "data:image/png;base64,iVBORw0KGgo=" });
    render(
      <Transcript
        conversation={conversation([
          turn("t1", {
            user: { text: "Regarde", attachments: [{ path: "/tmp/photo.png", name: "photo.png" }], contexts: [] },
          }),
        ])}
        runtime={idle}
      />,
    );
    const retry = await screen.findByRole("button", { name: "Image indisponible · Réessayer : photo.png" });
    fireEvent.click(retry);
    expect(await screen.findByRole("button", { name: "Agrandir l’image : photo.png" })).toBeInTheDocument();
  });

  it("détaille le bilan des modifications par fichier", () => {
    render(
      <Transcript
        conversation={conversation([
          turn("t1", {
            commit: "abc",
            changedFiles: ["src/a.ts", "img/b.png", "c.md", "d.md"],
            changedLines: { "src/a.ts": { added: 3, removed: 1 } },
          }),
        ])}
        runtime={idle}
      />,
    );
    const summary = screen.getByRole("region", { name: "Bilan des modifications" });
    expect(within(summary).getByText("4 fichiers de l’espace de travail modifiés")).toBeInTheDocument();
    expect(within(summary).getAllByText("—")).toHaveLength(2);
    expect(within(summary).getByRole("button", { name: "src/a.ts" })).toBeInTheDocument();
    fireEvent.click(within(summary).getByRole("button", { name: "Afficher 1 fichier de plus" }));
    expect(within(summary).getByRole("button", { name: "d.md" })).toBeInTheDocument();
  });

  it("deux tours enchaînés : un seul bilan, à la fin, qui regroupe leurs fichiers et les annule ensemble", async () => {
    const undoTurns = vi.fn(async () => undefined);
    useAgents.setState({ undoTurns } as never);
    render(
      <Transcript
        conversation={conversation([
          turn("t1", {
            startedAt: 1_000,
            endedAt: 5_000,
            commit: "c1",
            changedFiles: ["a.md", "b.md"],
            changedLines: { "a.md": { added: 2, removed: 1 }, "b.md": { added: 1, removed: 0 } },
          }),
          // Parti de la file dès la fin du précédent.
          turn("t2", {
            startedAt: 5_010,
            endedAt: 9_000,
            commit: "c2",
            changedFiles: ["a.md", "c.md"],
            changedLines: { "a.md": { added: 3, removed: 0 }, "c.md": { added: 4, removed: 4 } },
          }),
        ])}
        runtime={idle}
      />,
    );
    const summaries = screen.getAllByRole("region", { name: "Bilan des modifications" });
    expect(summaries).toHaveLength(1);
    const [summary] = summaries;
    // Sous la réponse du second tour, pas entre les deux messages.
    expect(
      screen.getByText("Réponse t2").compareDocumentPosition(summary) & Node.DOCUMENT_POSITION_FOLLOWING,
    ).toBeTruthy();
    expect(within(summary).getByText("3 fichiers de l’espace de travail modifiés")).toBeInTheDocument();
    expect(within(summary).getByText("+10")).toBeInTheDocument();
    expect(within(summary).getByText("−5")).toBeInTheDocument();
    fireEvent.click(within(summary).getByRole("button", { name: "Annuler cette modification" }));
    expect(await screen.findByText(/revient à son état d’avant ces messages/)).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Annuler la modification" }));
    await waitFor(() => expect(undoTurns).toHaveBeenCalledWith("c1", ["t1", "t2"]));
  });

  it("pas de bilan tant que l’agent répond ou qu’un message attend, même pour le tour déjà fini de la suite", () => {
    const first = turn("t1", { startedAt: 1_000, endedAt: 5_000, commit: "c1", changedFiles: ["a.md"] });
    const view = render(
      <Transcript
        conversation={conversation([
          first,
          turn("t2", { startedAt: 5_010, endedAt: undefined, status: "running", items: [] }),
        ])}
        runtime={{ ...idle, status: "responding" }}
      />,
    );
    expect(screen.queryByRole("region", { name: "Bilan des modifications" })).toBeNull();
    // Le second tour est fini, mais un troisième message attend dans la file.
    view.rerender(
      <Transcript
        conversation={conversation([first, turn("t2", { startedAt: 5_010, endedAt: 9_000 })])}
        runtime={{ ...idle, queued: [{ id: "q", message: { text: "Puis", attachments: [], contexts: [] } }] }}
      />,
    );
    expect(screen.queryByRole("region", { name: "Bilan des modifications" })).toBeNull();
    expect(screen.queryByText("Exécution arrêtée · Travail non terminé")).toBeNull();
  });

  it("une conversation rouverte montre un bilan à la fin de chaque suite", () => {
    render(
      <Transcript
        conversation={conversation([
          turn("t1", { startedAt: 1_000, endedAt: 5_000, commit: "c1", changedFiles: ["a.md"] }),
          turn("t2", { startedAt: 6_000, endedAt: 9_000 }),
          // Une heure plus tard : une autre suite.
          turn("t3", { startedAt: 3_609_000, endedAt: 3_620_000, commit: "c3", changedFiles: ["b.md", "c.md"] }),
          turn("t4", { startedAt: 3_621_000, endedAt: 3_630_000, commit: "c4", changedFiles: ["c.md"] }),
        ])}
        runtime={idle}
      />,
    );
    const summaries = screen.getAllByRole("region", { name: "Bilan des modifications" });
    expect(summaries.map((summary) => within(summary).getByRole("strong").textContent)).toEqual([
      "1 fichier de l’espace de travail modifié",
      "2 fichiers de l’espace de travail modifiés",
    ]);
    const follows = (text: string, node: Element) =>
      Boolean(screen.getByText(text).compareDocumentPosition(node) & Node.DOCUMENT_POSITION_FOLLOWING);
    expect(follows("Réponse t2", summaries[0]) && !follows("Demande t3", summaries[0])).toBe(true);
    expect(follows("Réponse t4", summaries[1])).toBe(true);
  });
});

describe("activités", () => {
  it("rend cliquables les fichiers lus ou modifiés et les titres « Read {chemin} »", () => {
    const open = vi.fn();
    render(
      <Activities
        onOpenFile={open}
        activities={[
          {
            kind: "activity",
            id: "a",
            activityKind: "file",
            title: "Fichiers",
            actions: [{ type: "edit", path: "src/page.tsx", added: 2, removed: 1 }],
            status: "completed",
          },
          { kind: "activity", id: "b", activityKind: "tool", title: "Read notes/plan.md", status: "completed" },
          { kind: "activity", id: "c", activityKind: "command", title: "ls", status: "cancelled" as never },
        ]}
      />,
    );
    // La suite d’activités est repliée derrière son résumé.
    fireEvent.click(screen.getByRole("button", { name: /^3 activités|^3 outils/ }));
    fireEvent.click(screen.getByRole("button", { name: "page.tsx" }));
    expect(open).toHaveBeenCalledWith("src/page.tsx");
    fireEvent.click(screen.getByRole("button", { name: "notes/plan.md" }));
    expect(open).toHaveBeenCalledWith("notes/plan.md");
    expect(screen.getByText("Arrêté")).toBeInTheDocument();
  });
});

describe("Markdown", () => {
  it("copie un bloc de code et laisse un schéma au rendu propre", async () => {
    const writeText = vi.fn(async () => undefined);
    Object.assign(navigator, { clipboard: { writeText } });
    render(
      <Markdown renderCode={(language, text) => (language === "mermaid" ? <p>Schéma : {text.trim()}</p> : undefined)}>
        {"```ts\nconst a = 1;\n```\n\n```mermaid\ngraph TD\n```"}
      </Markdown>,
    );
    await act(async () => fireEvent.click(screen.getByRole("button", { name: "Copier le bloc" })));
    expect(writeText).toHaveBeenCalledWith("const a = 1;");
    expect(screen.getByText("Schéma : graph TD")).toBeInTheDocument();
  });
});

describe("parité avec OneApp", () => {
  beforeEach(() => {
    useAgents.setState({
      retry: vi.fn(async () => undefined),
      send: vi.fn(async () => undefined),
      answerApproval: vi.fn(async () => undefined),
    });
  });

  const activity = (id: string, patch: Record<string, unknown> = {}) =>
    ({ kind: "activity", id, activityKind: "tool", title: `Outil ${id}`, status: "completed", ...patch }) as never;

  it("lit la commande dans le titre et montre son détail, quel que soit le genre de l’activité", () => {
    render(
      <Activities
        activities={[
          activity("a", { activityKind: "command", title: "Commande", detail: "git status --short" }),
          activity("b", { activityKind: "command", title: "Commande", detail: '{"command":"ls -la"}' }),
          activity("c", { activityKind: "search", title: "Recherche web", detail: "météo Lyon" }),
          activity("d", {
            activityKind: "file",
            title: "Fichiers",
            actions: [{ type: "edit", path: "a.ts", added: 2, removed: 1 }],
          }),
        ]}
      />,
    );
    fireEvent.click(screen.getByText("4 outils exécutés"));
    expect(screen.getByText("Exécuté git status --short")).toBeInTheDocument();
    expect(screen.getByText("Exécuté ls -la")).toBeInTheDocument();
    // Le détail d’une recherche web s’ouvre comme celui d’un outil.
    fireEvent.click(screen.getByText("Recherche web"));
    expect(screen.getByRole("textbox", { name: "Détail de Recherche web" })).toHaveValue("météo Lyon");
    // Les lignes d’une modification restent du texte, sans couleur.
    expect(screen.getByText(/Modifié/)).toHaveTextContent("Modifié a.ts +2 −1");
    expect(document.querySelector(".agent-chat__tool-list .agent-chat__change-added")).toBeNull();
  });

  it("résume un tour sans outil par « 0 outils appelés » et mesure le temps écoulé à la seconde", () => {
    render(<Transcript conversation={conversation([turn("t1")])} runtime={idle} />);
    expect(screen.getByText("A travaillé pendant 4 s · 0 outils appelés")).toBeInTheDocument();
    expect(elapsedWorkTime(0, 3_723_900)).toBe("1 h 2 min 3 s");
    expect(elapsedWorkTime(0, 59_900)).toBe("59 s");
  });

  it("garde visible la dernière réponse d’un tour terminé, même suivie d’activités", () => {
    const done = turn("t1", {
      items: [
        { kind: "message", id: "m1", content: "Je regarde." },
        activity("a1"),
        { kind: "message", id: "m2", content: "C’est corrigé." },
        activity("a2"),
      ],
    });
    expect(finalMessage(done)?.id).toBe("m2");
    render(<Transcript conversation={conversation([done])} runtime={idle} />);
    const final = screen.getByText("C’est corrigé.");
    expect(final.closest("details")).toBeNull();
    // Le reste du tour, activités d’avant et d’après réunies, se replie derrière le résumé.
    expect(screen.getByRole("button", { name: "A travaillé pendant 4 s · 2 outils appelés" })).toHaveAttribute(
      "aria-expanded",
      "false",
    );
  });

  it("montre tout le travail d’un tour arrêté ou en erreur, sans le replier ni le résumer", () => {
    render(
      <Transcript
        conversation={conversation([
          turn("t1", {
            status: "error",
            error: "Session perdue",
            items: [
              activity("a1", { title: "Image de l’agent", images: ["data:image/png;base64,iVBORw0KGgo="] }),
              { kind: "message", id: "m", content: "Presque fini." },
            ],
          }),
        ])}
        runtime={idle}
      />,
    );
    expect(screen.queryByText(/A travaillé pendant/)).not.toBeInTheDocument();
    expect(screen.getByText("Presque fini.").closest("details")).toBeNull();
    expect(screen.queryByRole("region", { name: "Images du tour" })).not.toBeInTheDocument();
    expect(screen.getByText("Session perdue")).toBeInTheDocument();
  });

  it("nomme la conversation comme OneApp et suit le bas à chaque changement, puis à l’ouverture d’une autre", () => {
    const running = turn("t1", { status: "running", items: [activity("a1", { status: "running" })] });
    const { rerender } = render(
      <Transcript conversation={conversation([running])} runtime={{ ...idle, status: "responding" }} />,
    );
    const scroller = screen.getByRole("region", { name: "Conversation de Factures" });
    Object.defineProperty(scroller, "scrollHeight", { configurable: true, value: 1000 });
    Object.defineProperty(scroller, "clientHeight", { configurable: true, value: 100 });
    // Une activité qui change sans s’ajouter fait suivre le relevé resté en bas.
    rerender(
      <Transcript
        conversation={conversation([{ ...running, items: [activity("a1", { status: "running", content: "sortie" })] }])}
        runtime={{ ...idle, status: "responding" }}
      />,
    );
    expect(scroller.scrollTop).toBe(1000);
    // Remonté, l’utilisateur n’est pas ramené en bas…
    scroller.scrollTop = 0;
    fireEvent.scroll(scroller);
    rerender(<Transcript conversation={conversation([turn("t1")])} runtime={idle} />);
    expect(scroller.scrollTop).toBe(0);
    // … jusqu’à l’ouverture d’une autre conversation, qui part du bas.
    rerender(<Transcript conversation={conversation([turn("t1")], { id: "c2" })} runtime={idle} />);
    expect(scroller.scrollTop).toBe(1000);
  });

  it("laisse la page poser la question dans son pied, au-dessus de la saisie", () => {
    const content = question('{"question":"Quel format ?","options":["PDF"]}');
    const value = conversation([turn("t1", { items: [{ kind: "message", id: "m", content }] })]);
    const onOther = vi.fn();
    render(
      <>
        <Transcript conversation={value} runtime={idle} dockQuestion={false} />
        <ConversationQuestion conversation={value} runtime={idle} onOther={onOther} />
      </>,
    );
    expect(document.querySelector(".agent-chat__question-dock")).toBeNull();
    const card = screen.getByRole("region", { name: "Question de l’agent" });
    fireEvent.click(within(card).getByRole("button", { name: "Autre réponse…" }));
    expect(onOther).toHaveBeenCalledOnce();
  });

  it("rend le Markdown d’un agent comme OneApp : intertitres, fichiers, liens web seuls, sans HTML", async () => {
    native.invoke.mockResolvedValue(undefined);
    render(
      <Transcript
        conversation={conversation([
          turn("t1", {
            items: [
              {
                kind: "message",
                id: "m",
                content:
                  "# Bilan\n\nVoir [le plan](notes/plan.md), [le site](https://exemple.fr) et [ceci](javascript:alert(1)).\n\n<b>gras</b>\n\n| a | b |\n| - | - |\n| 1 | 2 |",
              },
            ],
          }),
        ])}
        runtime={idle}
      />,
    );
    expect(screen.getByRole("heading", { level: 3, name: "Bilan" })).toBeInTheDocument();
    const file = screen.getByRole("link", { name: "le plan" });
    fireEvent.click(file);
    await waitFor(() =>
      expect(native.invoke).toHaveBeenCalledWith("files.open", { path: "notes/plan.md", base: "/espace" }),
    );
    expect(screen.getByRole("link", { name: /^le site/ })).toHaveAttribute("target", "_blank");
    expect(screen.queryByRole("link", { name: "ceci" })).not.toBeInTheDocument();
    expect(screen.getByText(/et ceci\./)).toBeInTheDocument();
    expect(screen.queryByText(/<b>/)).not.toBeInTheDocument();
    expect(screen.getByRole("region", { name: "Tableau" })).toHaveAttribute("tabindex", "0");
  });
});

function Boom(): never {
  throw new Error("rendu");
}

describe("limite d’erreur", () => {
  it("garde l’erreur de rendu dans la conversation et se réinitialise", () => {
    vi.spyOn(console, "error").mockImplementation(() => undefined);
    const { rerender } = render(
      <ErrorBoundary resetKey="a">
        <Boom />
      </ErrorBoundary>,
    );
    expect(screen.getByText("Cette vue ne peut pas être affichée.")).toBeInTheDocument();
    rerender(
      <ErrorBoundary resetKey="b">
        <p>Conversation</p>
      </ErrorBoundary>,
    );
    expect(screen.getByText("Conversation")).toBeInTheDocument();
  });
});

describe("en-tête d’une reprise", () => {
  it("indique la conversation d’origine", () => {
    render(
      <Transcript
        conversation={{ ...conversation([turn("t1")]), forkedFrom: { id: "c0", title: "Factures" } } as Conversation}
        runtime={idle}
        header
      />,
    );
    expect(screen.getByText(/^Depuis Factures · /)).toBeInTheDocument();
  });
});
