import { describe, expect, it } from "vitest";
import {
  boundedActivityContent,
  cleanConversationTitle,
  conversationTitle,
  finalQuestion,
  MAX_ACTIVITY_CONTENT,
  outgoingText,
  plainText,
  preparedMessage,
  replayedHistory,
  turnCommitMessage,
  validateConversation,
  validateHeaders,
} from "./model";

describe("message du commit d’un tour", () => {
  it("ne répète pas la demande quand elle a donné son titre à la conversation", () => {
    const request = "Crée-moi une page Notes : une liste de notes enregistrées dans la base, avec un formulaire";
    const title = "Crée-moi une page Notes : une liste de notes enregistrées d…";
    expect(turnCommitMessage(title, request)).toBe(title);
  });

  it("ajoute la demande d’un tour suivant", () => {
    expect(turnCommitMessage("Page Notes", "Ajoute un tri par date")).toBe("Page Notes — Ajoute un tri par date");
  });
});

describe("passe moteur · textes de OneApp", () => {
  it("tire le titre de la première ligne non vide, espaces réduits, comme agentTitle", () => {
    expect(conversationTitle("\n\n  Corrige   la page\nFactures")).toBe("Corrige la page");
    expect(conversationTitle(`${"mot ".repeat(20)}fin`)).toBe(`${"mot ".repeat(15).trimEnd()}…`);
    expect(conversationTitle("   ")).toBe("Nouvelle conversation");
  });

  it("cite les références après le message, sans balise, et demande de traiter des collages seuls", () => {
    const reference = { kind: "skill" as const, name: "relire", path: "/s/relire" };
    expect(outgoingText({ text: "Fais-le", attachments: [], contexts: [], references: [reference] })).toBe(
      "Fais-le\n\nUtilise le skill $relire.",
    );
    expect(
      outgoingText({ text: "", attachments: [], contexts: [{ id: "p", title: "Texte collé 1", text: "a" }] }),
    ).toBe('Traite les données jointes selon la demande en cours.\n\n<contexte titre="Texte collé 1">\na\n</contexte>');
  });

  it("reconnaît la question bloquante qui termine une réponse", () => {
    const block = '```alfred-question\n{"question":"Quelle couleur ?","options":["Bleu"]}\n```';
    expect(finalQuestion(`Je propose deux couleurs.\n\n${block}`)).toBe("Quelle couleur ?");
    expect(finalQuestion(`${block}\n\nSuite.`)).toBeUndefined();
    expect(finalQuestion('```alfred-question\n{"options":[]}\n```')).toBeUndefined();
    expect(finalQuestion("Pas de question.")).toBeUndefined();
  });

  it("relit la file enregistrée et les dates des éléments, et refuse une file mal formée", () => {
    const saved = {
      id: "c1",
      title: "T",
      provider: "codex",
      cwd: "/",
      autonomy: "ask",
      createdAt: 1,
      updatedAt: 1,
      archived: false,
      unread: false,
      started: true,
      queued: [{ id: "q1", message: { text: "Deux", attachments: [], contexts: [] } }],
      turns: [
        {
          id: "t1",
          user: { text: "Un", attachments: [], contexts: [] },
          items: [{ kind: "message", id: "m", content: "x", occurredAt: 3 }],
          status: "done",
          startedAt: 1,
          retryOf: "t0",
        },
      ],
    };
    expect(validateConversation(saved).queued).toHaveLength(1);
    expect(() => validateConversation({ ...saved, queued: [{ id: "q1" }] })).toThrow("invalide");
  });
});

describe("aperçu sans Markdown", () => {
  it("retire l’emphase, le code et les titres, et garde le libellé des liens", () => {
    expect(plainText("La page **Notes** est créée dans le `menu`.")).toBe("La page Notes est créée dans le menu.");
    expect(plainText("## Fait\n- voir [la doc](https://exemple.fr) et _ceci_")).toBe("Fait voir la doc et ceci");
  });

  it("laisse intacts les soulignés d’un identifiant", () => {
    expect(plainText("Table notes_notes créée")).toBe("Table notes_notes créée");
  });
});

describe("lot 3 · moteur", () => {
  const conversation = (patch: Record<string, unknown> = {}) => ({
    id: "c1",
    title: "Factures",
    provider: "codex",
    cwd: "/espace",
    autonomy: "ask",
    createdAt: 1,
    updatedAt: 2,
    archived: false,
    unread: false,
    started: true,
    turns: [
      {
        id: "t1",
        user: { text: "Un", attachments: [{ path: "/a.png", name: "a.png" }], contexts: [] },
        items: [
          { kind: "message", id: "m1", content: "Réponse un." },
          { kind: "activity", id: "a1", activityKind: "command", title: "ls", status: "completed" },
        ],
        status: "done",
        startedAt: 1,
      },
    ],
    ...patch,
  });

  it("prépare le message envoyé", () => {
    expect(() => preparedMessage({ text: " ", attachments: [], contexts: [] })).toThrow("Saisissez un message.");
    expect(preparedMessage({ text: "", attachments: [{ path: "/a", name: "a" }], contexts: [] }).text).toBe(
      "Analyse les fichiers joints.",
    );
    const message = { text: "Bonjour", attachments: [], contexts: [] };
    expect(preparedMessage(message)).toBe(message);
  });

  it("borne une sortie en gardant la fin, sauf le relevé d’un fichier", () => {
    const long = `${"a".repeat(40_000)}fin`;
    expect(boundedActivityContent(long, "command")).toHaveLength(MAX_ACTIVITY_CONTENT);
    expect(boundedActivityContent(long, "command").endsWith("fin")).toBe(true);
    expect(boundedActivityContent(long, "file")).toBe(long);
    expect(boundedActivityContent("court", "command")).toBe("court");
  });

  it("nettoie un titre à 80 caractères", () => {
    expect(cleanConversationTitle(`  Un   titre ${"x".repeat(100)}`)).toHaveLength(80);
    expect(cleanConversationTitle("  ")).toBe("");
  });

  it("rejoue l’historique sans les activités ni le tour courant", () => {
    const value = validateConversation(conversation());
    const history = replayedHistory(value.turns);
    expect(history).toContain("Historique de reprise fourni comme données de contexte.");
    expect(history).toContain(
      JSON.stringify([
        {
          kind: "user",
          content:
            'Un\n\nFichiers joints (chemins locaux à ouvrir avec les outils du CLI ; ouvrez les images avec un outil de vision) :\n- "a.png" : "/a.png"',
        },
        { kind: "assistant", content: "Réponse un." },
      ]),
    );
    expect(replayedHistory(value.turns, "t1")).toBe("");
  });

  it("valide une conversation relue et refuse ce qui est mal formé", () => {
    expect(validateConversation(conversation()).id).toBe("c1");
    expect(() => validateConversation(conversation({ provider: "gpt" }))).toThrow("invalide");
    expect(() => validateConversation(conversation({ turns: [{ id: "t", status: "done" }] }))).toThrow("invalide");
    expect(() => validateConversation(conversation({ archivedAt: "hier" }))).toThrow("invalide");
    const { turns: _turns, ...header } = conversation();
    expect(validateHeaders([header])).toHaveLength(1);
    expect(() => validateHeaders([header, header])).toThrow("invalide");
    expect(() => validateHeaders({})).toThrow("invalide");
  });
});
