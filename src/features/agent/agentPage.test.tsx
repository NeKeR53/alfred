import { act, fireEvent, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Snapshot } from "../../lib/types";
import { useNotifications } from "../../shell/notifications";
import { useShell } from "../../shell/store";
import { AgentPage, ConversationTracking } from "./AgentPage";
import { compareConversations, type GitSummary } from "./ConversationList";
import type { AgentTask } from "./harness";
import type { Conversation, ConversationHeader } from "./model";
import { useAgentPreferences } from "./panel/ModelPicker";
import { AgentPageWithTracking, findConversationTitle, render } from "./socle.test-helper";
import { useAgents } from "./store";

const native = vi.hoisted(() => {
  window.matchMedia ??= ((query: string) => ({
    matches: false,
    media: query,
    addEventListener: () => undefined,
    removeEventListener: () => undefined,
  })) as unknown as typeof window.matchMedia;
  return { invoke: vi.fn() };
});
vi.mock("../../lib/native", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../lib/native")>()),
  invoke: native.invoke,
  onNativeEvent: vi.fn(() => () => undefined),
}));
vi.mock("./harness", async (original) => ({
  ...(await original<typeof import("./harness")>()),
  listModels: vi.fn(async () => []),
}));

function stored(id: string, title: string, at: number, patch: Partial<Conversation> = {}): Conversation {
  return {
    id,
    title,
    provider: "claude",
    cwd: "/espace",
    autonomy: "ask",
    createdAt: at,
    updatedAt: at,
    archived: false,
    unread: false,
    started: true,
    turns: [
      {
        id: `${id}-t1`,
        user: { text: `Bonjour ${title}`, attachments: [], contexts: [] },
        items: [],
        status: "done",
        startedAt: at,
        endedAt: at,
      },
    ],
    ...patch,
  };
}

const realLoad = useAgents.getState().load;
let database: Record<string, Conversation>;
let git: GitSummary | Error;
let settings: Record<string, unknown>;

beforeEach(() => {
  database = { c1: stored("c1", "Factures", 2_000) };
  git = { root: "/espace", files: [], additions: 0, deletions: 0, truncated: false };
  settings = {};
  native.invoke.mockReset();
  native.invoke.mockImplementation(async (command: string, args: Record<string, unknown> = {}) => {
    if (command === "conversations.list")
      return Object.values(database)
        .sort((a, b) => b.updatedAt - a.updatedAt)
        .map(({ turns: _turns, ...header }) => header);
    if (command === "conversations.get") return structuredClone(database[args.id as string] ?? null);
    if (command === "settings.get") return settings[args.key as string] ?? null;
    if (command === "agentWorkspace.gitSummary") {
      if (git instanceof Error) throw git;
      return git;
    }
    return null;
  });
  useNotifications.setState({ items: [], toasts: [] });
  useShell.setState({
    snapshot: { path: "/espace", name: "Espace", accent: null, sections: [], settingsPages: [] } as unknown as Snapshot,
    view: { kind: "agent" },
  });
  useAgents.setState({ loaded: {}, headers: [], runtime: {}, activeId: null, ready: false, load: realLoad });
  useAgentPreferences.setState({
    values: { shownModels: {}, titling: null, pageModel: null, textEditor: null },
    status: "idle",
  });
});

/**
 * Pastille Git de la saisie : une région `status` qui a du texte. Le relevé de Socle a aussi sa région d’annonce, vide
 * tant qu’aucune réponse ne se termine.
 */
const gitPill = () =>
  screen.queryAllByRole("status").find((status) => status.title || status.textContent?.includes("modifié"));
const findGitPill = () => waitFor(() => gitPill() ?? Promise.reject(new Error("Pas de pastille Git")));

describe("page Agent", () => {
  it("F2 met le titre de la conversation ouverte en édition", async () => {
    render(<AgentPageWithTracking />);
    await findConversationTitle("Factures");
    fireEvent.keyDown(window, { key: "F2" });
    expect(await screen.findByRole("textbox", { name: "Nom de la conversation" })).toHaveValue("Factures");
  });

  it("ouvre le dossier de travail dans l’explorateur, et dans l’éditeur une fois choisi", async () => {
    render(<AgentPageWithTracking />);
    await findConversationTitle("Factures");
    const editor = screen.getByRole("button", { name: "Ouvrir le dossier dans l’éditeur" });
    // Sans éditeur dans les réglages, le bouton reste visible mais grisé.
    expect(editor).toBeDisabled();
    fireEvent.click(screen.getByRole("button", { name: "Ouvrir le dossier dans l’explorateur" }));
    await waitFor(() => expect(native.invoke).toHaveBeenCalledWith("agentWorkspace.openExplorer", { path: "/espace" }));

    act(() =>
      useAgentPreferences.setState({
        values: { shownModels: {}, titling: null, pageModel: null, textEditor: { command: 'code "{{directory}}"' } },
      }),
    );
    await waitFor(() => expect(editor).toBeEnabled());
    fireEvent.click(editor);
    await waitFor(() =>
      expect(native.invoke).toHaveBeenCalledWith("agentWorkspace.openEditor", {
        command: 'code "{{directory}}"',
        path: "/espace",
      }),
    );
  });

  it("montre l’état Git du dossier de travail sous la saisie et dans la carte « Modifications »", async () => {
    git = {
      root: "/espace",
      files: [
        { path: "a.txt", state: "modifié" },
        { path: "b.txt", state: "nouveau" },
      ],
      additions: 1200,
      deletions: 3,
      truncated: false,
    };
    render(<AgentPageWithTracking />);
    await findConversationTitle("Factures");
    const pill = await findGitPill();
    expect(pill).toHaveTextContent("2 fichiers modifiés");
    // DiffStat : compteurs visibles, et la phrase lue par le lecteur d’écran.
    expect(pill).toHaveTextContent("+1200−3");
    expect(pill).toHaveTextContent("1200 lignes ajoutées, 3 retirées");
    const card = within(screen.getByLabelText("Suivi des conversations")).getByRole("region", {
      name: "Modifications",
    });
    // Lignes de propriété : le dossier lu, puis ce qui n’est pas encore enregistré (DiffStat).
    expect(card).toHaveTextContent("Dossier de travail/espace");
    expect(card).toHaveTextContent("Non enregistrées+1200−3");
    expect(native.invoke).toHaveBeenCalledWith("agentWorkspace.gitSummary", { path: "/espace" });
  });

  it("fenêtre principale : le panneau de détail garde les modifications, sans la liste des conversations", async () => {
    render(
      <>
        <AgentPage />
        <aside aria-label="Détail">
          <ConversationTracking withList={false} />
        </aside>
      </>,
    );
    await findConversationTitle("Factures");
    const panel = screen.getByLabelText("Détail");
    expect(within(panel).getByText("Détails de la conversation")).toBeInTheDocument();
    expect(await within(panel).findByRole("region", { name: "Modifications" })).toBeInTheDocument();
    expect(within(panel).queryByRole("region", { name: "Conversations" })).toBeNull();
  });

  it("montre le plan de l’agent en tête du panneau de détail, avec l’état de chaque étape, mis à jour en direct", async () => {
    database.c1 = stored("c1", "Factures", 2_000, {
      plan: [
        { text: "Lire le guide", status: "completed" },
        { text: "Créer la page", status: "inProgress" },
        { text: "Vérifier la page", status: "pending" },
      ],
    });
    render(
      <>
        <AgentPage />
        <aside aria-label="Détail">
          <ConversationTracking withList={false} />
        </aside>
      </>,
    );
    await findConversationTitle("Factures");
    const panel = screen.getByLabelText("Détail");
    const section = await within(panel).findByRole("region", { name: "Plan" });
    const regions = within(panel).getAllByRole("region");
    expect(regions[0]).toBe(section);
    expect(section).toHaveTextContent("1 sur 3");
    const steps = within(section).getAllByRole("row");
    // L’icône porte seule l’état, nommé pour les lecteurs d’écran ; aucun texte d’état à droite.
    expect(steps.map((row) => [row.textContent, within(row).getByRole("img").getAttribute("aria-label")])).toEqual([
      ["Lire le guide", "Faite"],
      ["Créer la page", "En cours"],
      ["Vérifier la page", "À faire"],
    ]);

    act(() =>
      useAgents.setState((state) => ({
        loaded: {
          ...state.loaded,
          c1: {
            ...state.loaded.c1!,
            plan: [
              { text: "Lire le guide", status: "completed" },
              { text: "Créer la page", status: "completed" },
              { text: "Vérifier la page", status: "completed" },
            ],
          },
        },
      })),
    );
    await waitFor(() => expect(section).toHaveTextContent("3 sur 3"));
    expect(within(section).queryByRole("img", { name: "En cours" })).toBeNull();
  });

  it("montre les tâches de fond de la conversation, leur durée, un arrêt par tâche et le compte des finies", async () => {
    const now = Date.now();
    const task = (taskId: string, patch: Partial<AgentTask>): AgentTask => ({
      taskId,
      kind: "command",
      title: taskId,
      background: true,
      status: "running",
      startedAt: now - 61_000,
      stoppable: true,
      ...patch,
    });
    const tasks = Object.fromEntries(
      [
        task("npm run dev", {}),
        task("Relire le module", { kind: "agent", background: false, startedAt: now - 2_000 }),
        // Une commande courte qui bloque la réponse n’est pas une tâche.
        task("ls", { background: false, startedAt: now - 1_000 }),
        task("cargo build", { background: false, startedAt: now - 40_000, status: "failed", endedAt: now - 1_000 }),
        task("echo", { status: "completed", endedAt: now - 500, stoppable: false }),
        task("codex", { stoppable: false, title: "sleep 60" }),
      ].map((item) => [item.taskId, item]),
    );
    const stopTask = vi.fn(async () => undefined);
    useAgents.setState({ stopTask });
    render(
      <>
        <AgentPage />
        <aside aria-label="Détail">
          <ConversationTracking withList={false} />
        </aside>
      </>,
    );
    await findConversationTitle("Factures");
    act(() =>
      useAgents.setState((state) => ({
        runtime: {
          ...state.runtime,
          c1: { ...(state.runtime.c1 ?? { status: "idle", approvals: [], questions: [], queued: [] }), tasks },
        },
      })),
    );
    const section = await within(screen.getByLabelText("Détail")).findByRole("region", {
      name: "Tâches en arrière-plan",
    });
    expect(section).toHaveTextContent("3 en cours");
    const rows = within(within(section).getByRole("list")).getAllByRole("listitem");
    expect(rows.map((row) => row.textContent?.replace(/\d+ s$/, ""))).toEqual([
      "npm run dev1 min ",
      "sleep 601 min ",
      "Relire le module",
    ]);
    // Sans arrêt possible (Codex), pas de bouton.
    expect(within(section).queryByRole("button", { name: "Arrêter sleep 60" })).toBeNull();
    fireEvent.click(within(section).getByRole("button", { name: "Arrêter npm run dev" }));
    expect(stopTask).toHaveBeenCalledWith("c1", "npm run dev");
    expect(section).toHaveTextContent("2 terminées");
    expect(within(section).getByText("1 en échec")).toBeInTheDocument();
  });

  it("sans plan, le panneau de détail n’a pas de section Plan", async () => {
    render(
      <aside aria-label="Détail">
        <AgentPage />
        <ConversationTracking withList={false} />
      </aside>,
    );
    await findConversationTitle("Factures");
    expect(
      await within(screen.getByLabelText("Détail")).findByRole("region", { name: "Modifications" }),
    ).toBeInTheDocument();
    expect(screen.queryByRole("region", { name: "Plan" })).toBeNull();
  });

  it("une conversation rouverte montre le bilan à la fin de chaque suite de messages, jamais entre deux", async () => {
    const at = 1_000_000;
    const done = (id: string, startedAt: number, endedAt: number, files?: string[]) => ({
      id,
      user: { text: `Demande ${id}`, attachments: [], contexts: [] },
      items: [{ kind: "message" as const, id: `${id}-m`, content: `Réponse ${id}` }],
      status: "done" as const,
      startedAt,
      endedAt,
      ...(files ? { commit: `commit-${id}`, changedFiles: files } : {}),
    });
    database = {
      c1: stored("c1", "Factures", at, {
        turns: [
          done("t1", at, at + 4_000, ["a.md"]),
          // Envoyé pendant la réponse : parti de la file aussitôt après.
          done("t2", at + 4_010, at + 9_000, ["b.md"]),
          // Le lendemain : une autre suite.
          done("t3", at + 86_400_000, at + 86_410_000, ["c.md"]),
        ],
      }),
    };
    render(<AgentPageWithTracking />);
    await screen.findByText("Réponse t3");
    const summaries = screen.getAllByRole("region", { name: "Bilan des modifications" });
    expect(summaries.map((summary) => within(summary).getByRole("heading").textContent)).toEqual([
      "2 fichiers de l’espace de travail modifiés",
      "1 fichier de l’espace de travail modifié",
    ]);
    // Le premier bilan suit la réponse du deuxième message, pas celle du premier.
    expect(screen.getByText("Réponse t2").compareDocumentPosition(summaries[0])).toBe(Node.DOCUMENT_POSITION_FOLLOWING);
  });

  it("pendant une réponse, ni bilan ni pastille Git ne marquent une fin", async () => {
    git = {
      root: "/espace",
      files: [{ path: "a.txt", state: "modifié" }],
      additions: 1,
      deletions: 0,
      truncated: false,
    };
    database = {
      c1: stored("c1", "Factures", 2_000, {
        turns: [
          {
            id: "t1",
            user: { text: "Ajoute", attachments: [], contexts: [] },
            items: [{ kind: "message", id: "m1", content: "Fait." }],
            status: "done",
            startedAt: 2_000,
            endedAt: 3_000,
            commit: "c-1",
            changedFiles: ["a.txt"],
          },
        ],
      }),
    };
    render(<AgentPageWithTracking />);
    expect(await screen.findByRole("region", { name: "Bilan des modifications" })).toBeInTheDocument();
    expect(await screen.findByText("1 fichier modifié")).toBeInTheDocument();
    // Un deuxième message part juste après : l’agent répond.
    act(() =>
      useAgents.setState((state) => {
        const current = state.loaded.c1;
        return {
          loaded: {
            ...state.loaded,
            c1: {
              ...current,
              turns: [
                ...current.turns,
                {
                  id: "t2",
                  user: { text: "Et ceci", attachments: [], contexts: [] },
                  items: [],
                  status: "running",
                  startedAt: 3_500,
                },
              ],
            },
          },
          runtime: { ...state.runtime, c1: { status: "responding", approvals: [], questions: [], queued: [] } },
        };
      }),
    );
    await waitFor(() => expect(screen.queryByRole("region", { name: "Bilan des modifications" })).toBeNull());
    expect(screen.queryByText("1 fichier modifié")).toBeNull();
  });

  it("signale un dépôt illisible, sans pastille", async () => {
    git = new Error("Ce dossier n’est pas un dépôt Git.");
    render(<AgentPageWithTracking />);
    expect(await screen.findByText("1 dépôt indisponible.")).toBeInTheDocument();
    expect(gitPill()).toBeUndefined();
  });

  it("comme OneApp : pas de suppression dans la barre, origine et date au-dessus du relevé, pastille Git sur la ligne du modèle", async () => {
    database = {
      c1: stored("c1", "Factures", 2_000, { origin: { reference: "compta/factures", title: "Factures du mois" } }),
    };
    git = {
      root: "/espace",
      files: [{ path: "a.txt", state: "modifié" }],
      additions: 1,
      deletions: 0,
      truncated: false,
    };
    render(<AgentPageWithTracking />);
    await findConversationTitle("Factures");
    expect(screen.queryByRole("button", { name: "Supprimer la conversation" })).toBeNull();
    expect(
      within(screen.getByRole("region", { name: "Conversation de Factures" })).getByText(/^Depuis Factures du mois · /),
    ).toBeInTheDocument();
    const pill = await findGitPill();
    expect(pill.closest('[role="group"][aria-label="Réglages de la conversation"]')).not.toBeNull();
  });

  it("le suivi liste toutes les conversations comme OneApp : état ou heure, archiver au survol", async () => {
    const today = new Date();
    today.setHours(14, 2, 0, 0);
    const at = today.getTime();
    database = {
      c1: stored("c1", "Ancienne", at - 5_000, { updatedAt: Date.UTC(2026, 0, 5, 12), lastStatus: "done" }),
      c2: stored("c2", "Récente", at - 1_000, { updatedAt: at, unread: true, lastStatus: "error" }),
      c3: stored("c3", "Lue", at - 3_000, { updatedAt: at, lastStatus: "cancelled" }),
      c4: stored("c4", "Plus récente", at, { unread: true, lastStatus: "done" }),
    };
    render(<AgentPageWithTracking />);
    const panel = await screen.findByLabelText("Suivi des conversations");
    // Une seule carte, résumée par ce qui demande l’utilisateur ; plus de cartes par état.
    const list = await within(panel).findByRole("region", { name: "Conversations" });
    expect(within(panel).queryByRole("region", { name: "À traiter" })).toBeNull();
    expect(within(panel).queryByRole("region", { name: "Terminées" })).toBeNull();
    await waitFor(() => expect(list).toHaveTextContent("1 à traiter"));
    // La plus récemment créée d’abord, quel que soit son état, dans l’arbre des conversations (TreeView).
    const tree = within(list).getByRole("treegrid", { name: "Conversations" });
    const rows = within(tree).getAllByRole("row");
    expect(rows.map((row) => row.getAttribute("aria-label"))).toEqual(["Plus récente", "Récente", "Lue", "Ancienne"]);
    // L’état à droite de la ligne ; en veille, l’heure de la dernière activité.
    expect(within(tree).getByRole("row", { name: "Récente" })).toHaveTextContent("En échec");
    expect(within(tree).getByRole("row", { name: "Plus récente" })).toHaveTextContent("À consulter");
    const read = within(tree).getByRole("row", { name: "Lue" });
    expect(read).toHaveTextContent("14:02");
    expect(read).not.toHaveTextContent("En échec");
    // Un autre jour : le jour et le mois.
    expect(within(tree).getByRole("row", { name: "Ancienne" })).toHaveTextContent("5 janv.");
    // Chaque conversation s’archive depuis sa ligne, pas seulement les terminées.
    for (const title of ["Plus récente", "Récente", "Lue", "Ancienne"])
      expect(within(tree).getByRole("button", { name: `Archiver ${title}`, hidden: true })).toBeInTheDocument();
  });

  it("le suivi range les délégués sous leur coordinatrice, dépliée tant que l’un d’eux travaille", async () => {
    const delegate = (id: string, key: string, at: number, patch: Partial<Conversation> = {}) =>
      stored(id, `${key} · délégué`, at, { parent: "vq3", taskKey: key, ...patch });
    database = {
      vq3: stored("vq3", "Ventes Q3", 1_000, { coordinator: true }),
      d1: delegate("d1", "ventes", 1_100),
      d2: delegate("d2", "demandes", 1_200, { unread: true, lastStatus: "done" }),
      d3: delegate("d3", "documentation", 1_300),
      // La plus récente : la page l’ouvre d’elle-même.
      demo: stored("demo", "Préparer la démo", 5_000),
    };
    render(<AgentPageWithTracking />);
    await findConversationTitle("Préparer la démo");
    const panel = await screen.findByLabelText("Suivi des conversations");
    const tree = await within(panel).findByRole("treegrid", { name: "Conversations" });
    // Tant qu’aucun délégué ne travaille, la coordinatrice est repliée : ses délégués n’ont pas de ligne.
    const coordinator = within(tree).getByRole("row", { name: "Ventes Q3" });
    expect(coordinator).toHaveAttribute("aria-expanded", "false");
    expect(within(tree).queryByRole("row", { name: "ventes" })).toBeNull();

    // Un délégué se met au travail : elle se déplie, ses délégués dessous, dans l’ordre où elle les a lancés.
    act(() =>
      useAgents.setState({ runtime: { d1: { status: "responding", approvals: [], questions: [], queued: [] } } }),
    );
    await waitFor(() =>
      expect(within(tree).getByRole("row", { name: "Ventes Q3" })).toHaveAttribute("aria-expanded", "true"),
    );
    const rows = within(tree).getAllByRole("row");
    expect(rows.map((row) => [row.getAttribute("aria-label"), row.getAttribute("aria-level")])).toEqual([
      ["Préparer la démo", "1"],
      ["Ventes Q3", "1"],
      ["ventes", "2"],
      ["demandes", "2"],
      ["documentation", "2"],
    ]);
    // La coordinatrice montre le délégué au travail ; chaque délégué garde son état.
    expect(within(tree).getByRole("row", { name: "Ventes Q3" })).toHaveTextContent("Au travail");
    expect(within(tree).getByRole("row", { name: "ventes" })).toHaveTextContent("Au travail");
    expect(within(tree).getByRole("row", { name: "demandes" })).toHaveTextContent("À consulter");

    // Un clic ouvre le délégué.
    await userEvent.setup().click(within(tree).getByRole("row", { name: "demandes" }));
    await findConversationTitle("demandes · délégué");

    // Coordinatrice archivée : ses délégués remontent en haut et disent de qui ils sont les délégués.
    act(() =>
      useAgents.setState((state) => ({
        headers: state.headers.map((header) => (header.id === "vq3" ? { ...header, archived: true } : header)),
      })),
    );
    await waitFor(() =>
      expect(within(tree).getByRole("row", { name: "ventes · délégué de Ventes Q3" })).toHaveAttribute(
        "aria-level",
        "1",
      ),
    );
    expect(within(tree).queryByRole("row", { name: "Ventes Q3" })).toBeNull();
  });

  it("le suivi résume les conversations au travail quand rien n’attend l’utilisateur", async () => {
    render(<AgentPageWithTracking />);
    const panel = await screen.findByLabelText("Suivi des conversations");
    const list = await within(panel).findByRole("region", { name: "Conversations" });
    act(() =>
      useAgents.setState({ runtime: { c1: { status: "responding", approvals: [], questions: [], queued: [] } } }),
    );
    await waitFor(() => expect(list).toHaveTextContent("1 au travail"));
    const row = within(list).getByRole("row", { name: "Factures" });
    expect(row).toHaveTextContent("Au travail");
  });

  it("archiver notifie aussitôt, avec « Annuler »", async () => {
    render(<AgentPageWithTracking />);
    await findConversationTitle("Factures");
    fireEvent.click(screen.getAllByRole("button", { name: "Archiver Factures" })[0]);
    const item = useNotifications.getState().items[0];
    expect(item?.title).toBe("Conversation archivée");
    expect(item?.action?.label).toBe("Annuler");
  });

  it("affiche le bandeau d’échec de chargement avec « Réessayer » quand le magasin l’expose", async () => {
    const load = vi.fn(async () => undefined);
    render(<AgentPageWithTracking />);
    await findConversationTitle("Factures");
    act(() => useAgents.setState({ loadError: "Base illisible.", load } as never));
    expect(await screen.findByText("L’historique des agents n’a pas pu être chargé.")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Réessayer" }));
    expect(load).toHaveBeenCalled();
    act(() => useAgents.setState({ loadError: undefined } as never));
  });

  it("affiche l’échec d’enregistrement près de la saisie avec « Réessayer la sauvegarde »", async () => {
    const retrySave = vi.fn(async () => undefined);
    render(<AgentPageWithTracking />);
    await findConversationTitle("Factures");
    act(() =>
      useAgents.setState({
        saveError: "Les conversations n’ont pas pu être enregistrées : disque plein",
        retrySave,
      } as never),
    );
    expect(await screen.findByText(/n’ont pas pu être enregistrées : disque plein/)).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Réessayer la sauvegarde" }));
    expect(retrySave).toHaveBeenCalled();
    act(() => useAgents.setState({ saveError: undefined, retrySave: undefined } as never));
  });
});

describe("tri du suivi", () => {
  const header = (id: string, createdAt: number, updatedAt: number): ConversationHeader => {
    const { turns: _turns, ...rest } = stored(id, id, createdAt, { updatedAt });
    return rest;
  };

  it("classe chaque carte par création, la plus récente d’abord, comme la liste des agents de OneApp", () => {
    const old = header("ancienne", 1, 50);
    const recent = header("récente", 10, 20);
    // La plus récemment créée d’abord, même si l’autre vient d’écrire : une ligne ne saute pas à chaque message.
    expect(compareConversations(old, recent)).toBeGreaterThan(0);
    expect(compareConversations(recent, old)).toBeLessThan(0);
  });
});
