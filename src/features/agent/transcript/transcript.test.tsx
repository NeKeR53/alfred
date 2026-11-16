import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { installDialogPolyfill } from "../../../ui/dialog.test-helper";

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

import { Markdown } from "@alfred/ui";
import { Activities, activityStatusLabel } from "../Activities";
import { referencedLocalImages } from "../lib/chatImages";
import type { Conversation, ConversationRuntime, Turn } from "../model";
import { useAgents } from "../store";
import {
  changedFilesOf,
  conversationModelLabel,
  isLongChatText,
  producedFiles,
  producedImages,
  QUOTE_EVENT,
  RECENT_TURNS,
  Transcript,
  turnDelivery,
} from "../Transcript";
import { agentQuestion, withoutAgentQuestion } from "./agentQuestions";
import { ErrorBoundary } from "./ErrorBoundary";
import { referenceMentions } from "./ReferencePills";

installDialogPolyfill();

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

  it("place les références en pastilles sur leurs mentions", () => {
    const references = [
      { name: "publier", path: "/c/publier.md", kind: "command" as const },
      { name: "src/page.tsx", path: "/e/src/page.tsx", kind: "file" as const },
    ];
    expect(
      referenceMentions("/publier puis @src/page.tsx, pas x/publier", references).map(({ start, end }) => [start, end]),
    ).toEqual([
      [0, 8],
      [14, 27],
    ]);
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
    await waitFor(() => expect(screen.getByText("Demande t0")).toBeInTheDocument());
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
                text: "/publier maintenant",
                attachments: [],
                contexts: [],
                references: [{ name: "publier", path: "/c/publier.md", kind: "command" }],
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

  it("n’affiche Relancer et Repartir d’ici que si le moteur les fournit", () => {
    const { unmount } = render(<Transcript conversation={conversation([turn("t1")])} runtime={idle} />);
    expect(screen.queryByRole("button", { name: "Relancer le message" })).not.toBeInTheDocument();
    unmount();
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
        conversation={conversation([turn("t1", { status: "running", items: [] })])}
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
    expect(screen.getByText("Accord requis")).toBeInTheDocument();
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
    expect(within(files).getByRole("button", { name: "Enregistrer une copie de rapport.pdf" })).toBeInTheDocument();
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
    expect(within(summary).getByText("4 fichiers de l’espace modifiés")).toBeInTheDocument();
    expect(within(summary).getAllByText("—")).toHaveLength(2);
    expect(within(summary).getByRole("button", { name: "src/a.ts" })).toBeInTheDocument();
    fireEvent.click(within(summary).getByRole("button", { name: "Afficher 1 fichier de plus" }));
    expect(within(summary).getByRole("button", { name: "d.md" })).toBeInTheDocument();
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
