import { fireEvent, screen, waitFor, within } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
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

import { captureGroups, pageCaptures } from "../lib/pageCaptures";
import type { Conversation, ConversationRuntime, Turn, TurnItem } from "../model";
import { Transcript } from "../Transcript";

const idle: ConversationRuntime = { status: "idle", approvals: [], questions: [], queued: [] };

/** Sortie de `page_screenshot` telle que Claude Code et OpenCode la transmettent : le texte des détails. */
function details(capture: string, patch: Record<string, unknown> = {}) {
  return JSON.stringify(
    { page: "taches/liste", title: "Tâches", width: 1280, height: 800, capture, note: "Image rendue…", ...patch },
    null,
    2,
  );
}

function screenshot(id: string, capture: string, patch: Partial<Extract<TurnItem, { kind: "activity" }>> = {}) {
  return {
    kind: "activity" as const,
    id,
    activityKind: "tool" as const,
    title: "Outil · Alfred / page_screenshot",
    detail: '{\n  "page": "taches/liste"\n}',
    content: details(capture),
    status: "completed" as const,
    ...patch,
  };
}

function conversation(turns: Turn[]): Conversation {
  return {
    id: "c1",
    title: "Tâches",
    provider: "claude",
    cwd: "/espace",
    autonomy: "ask",
    createdAt: 0,
    updatedAt: 0,
    archived: false,
    unread: false,
    started: true,
    turns,
  };
}

function turn(items: TurnItem[], patch: Partial<Turn> = {}): Turn {
  return {
    id: "t1",
    user: { text: "Fais la page", attachments: [], contexts: [] },
    items: [...items, { kind: "message", id: "fin", content: "La page est prête." }],
    status: "done",
    startedAt: 1_000,
    endedAt: 5_000,
    ...patch,
  };
}

beforeEach(() => {
  native.invoke.mockReset();
  native.invoke.mockImplementation(async (command: string, args: { path: string }) =>
    command === "files.readImage" ? { dataUrl: `data:image/png;base64,${btoa(args.path)}` } : undefined,
  );
});

/** Vignette lue : jsdom ne charge pas les images, l’événement `load` les rend prêtes à s’agrandir. */
async function loadedThumbnail(within_: HTMLElement, alt: string) {
  const image = await within(within_).findByRole("img", { name: alt });
  fireEvent.load(image);
  return within(within_).findByRole("button", { name: `Agrandir ${alt}` });
}

describe("captures prises par l’agent", () => {
  it("lit la capture dans la sortie de chaque harnais", () => {
    const claude = screenshot("a", "/echanges/c1/captures/a.png");
    const opencode = screenshot("b", "/echanges/c1/captures/b.png", { title: "Outil · alfred_page_screenshot" });
    // Codex : le résultat MCP sérialisé, l’image remplacée par un repère, les détails en texte imbriqué.
    const codex = screenshot("c", "", {
      title: "Outil · alfred / page_screenshot",
      content: JSON.stringify(
        {
          content: [
            "[image affichée ci-dessous]",
            { type: "text", text: details("/echanges/c1/captures/c.png", { fullPage: true, title: "Notes" }) },
          ],
          isError: false,
        },
        null,
        2,
      ),
    });
    const failed = screenshot("d", "/echanges/c1/captures/d.png", { status: "failed" });
    const other = screenshot("e", "/echanges/c1/captures/e.png", { title: "Outil · Alfred / page_snapshot" });
    expect(pageCaptures({ items: [claude, opencode, codex, failed, other] })).toEqual([
      { id: "a", image: "/echanges/c1/captures/a.png", page: "taches/liste", title: "Tâches", fullPage: false },
      { id: "b", image: "/echanges/c1/captures/b.png", page: "taches/liste", title: "Tâches", fullPage: false },
      { id: "c", image: "/echanges/c1/captures/c.png", page: "taches/liste", title: "Notes", fullPage: true },
    ]);
  });

  it("montre la capture en vignette sous le travail replié, et l’agrandit d’un clic", async () => {
    render(
      <Transcript
        conversation={conversation([
          turn([
            screenshot("a", "/echanges/c1/captures/a.png", {
              content: details("/echanges/c1/captures/a.png", { fullPage: true }),
            }),
          ]),
        ])}
        runtime={idle}
      />,
    );
    expect(screen.getByRole("button", { name: /A travaillé pendant/ })).toHaveAttribute("aria-expanded", "false");
    // ImageGallery : un groupe « Captures de l’agent », une liste par page.
    const row = screen.getByRole("group", { name: "Captures de l’agent" });
    expect(within(row).getByRole("list", { name: "Tâches" })).toBeInTheDocument();
    expect(within(row).getByText("Tâches · page entière")).toBeInTheDocument();
    await waitFor(() =>
      expect(native.invoke).toHaveBeenCalledWith("files.readImage", {
        path: "/echanges/c1/captures/a.png",
        base: "/espace",
      }),
    );
    const thumbnail = await loadedThumbnail(row, "Tâches · page entière");
    fireEvent.click(thumbnail);
    const viewer = await screen.findByRole("dialog", { name: "Tâches · page entière" });
    expect(within(viewer).getByRole("img", { name: "Tâches · page entière" })).toHaveAttribute(
      "src",
      `data:image/png;base64,${btoa("/echanges/c1/captures/a.png")}`,
    );
    expect(within(viewer).queryByRole("button", { name: "Image suivante" })).not.toBeInTheDocument();
    fireEvent.click(within(viewer).getByRole("button", { name: "Fermer" }));
    await waitFor(() => expect(screen.queryByRole("dialog")).not.toBeInTheDocument());
  });

  it("montre aussi la capture pendant que l’agent travaille", async () => {
    render(
      <Transcript
        conversation={conversation([
          {
            ...turn([screenshot("a", "/echanges/c1/captures/a.png")], { status: "running", endedAt: undefined }),
          },
        ])}
        runtime={{ ...idle, status: "responding" }}
      />,
    );
    const row = screen.getByRole("group", { name: "Captures de l’agent" });
    expect(await loadedThumbnail(row, "Tâches")).toBeInTheDocument();
  });

  it("ne garde que les trois dernières captures d’une page, les autres derrière « + N »", async () => {
    const shots = Array.from({ length: 10 }, (_, index) => screenshot(`s${index}`, `/captures/${index}.png`));
    const notes = screenshot("n", "/captures/notes.png", {
      content: details("/captures/notes.png", { page: "notes", title: "Notes" }),
    });
    const groups = captureGroups(pageCaptures({ items: [...shots.slice(0, 5), notes, ...shots.slice(5)] }));
    // La page capturée en dernier ferme la rangée.
    expect(groups.map((group) => [group.page, group.shown.map((capture) => capture.id), group.hidden.length])).toEqual([
      ["notes", ["n"], 0],
      ["taches/liste", ["s7", "s8", "s9"], 7],
    ]);

    render(<Transcript conversation={conversation([turn([...shots, notes])])} runtime={idle} />);
    const row = screen.getByRole("group", { name: "Captures de l’agent" });
    // Trois vignettes pour la page aux dix captures, une pour l’autre ; les plus anciennes derrière « + 7 ».
    await waitFor(() => expect(row.querySelectorAll("img")).toHaveLength(4));
    const more = within(row).getByRole("button", { name: "Voir 7 autres images de Tâches" });
    expect(more).toHaveTextContent("+ 7");
    fireEvent.click(more);
    // La vue agrandie parcourt toutes les captures de la page ; une capture cachée est lue quand on l’atteint.
    const viewer = await screen.findByRole("dialog", { name: "Tâches" });
    // Elle s’ouvre sur la plus récente des captures cachées.
    expect(within(viewer).getByText("7 / 10")).toBeInTheDocument();
    expect(await within(viewer).findByRole("img")).toHaveAttribute(
      "src",
      `data:image/png;base64,${btoa("/captures/6.png")}`,
    );
    fireEvent.click(within(viewer).getByRole("button", { name: "Image précédente" }));
    expect(within(viewer).getByText("6 / 10")).toBeInTheDocument();
    expect(await within(viewer).findByRole("img")).toHaveAttribute(
      "src",
      `data:image/png;base64,${btoa("/captures/5.png")}`,
    );
    fireEvent.keyDown(viewer, { key: "ArrowRight" });
    fireEvent.keyDown(viewer, { key: "ArrowRight" });
    expect(within(viewer).getByText("8 / 10")).toBeInTheDocument();
  });

  it("n’affiche rien pour une capture sans fichier", () => {
    render(<Transcript conversation={conversation([turn([screenshot("a", "")])])} runtime={idle} />);
    expect(screen.queryByRole("group", { name: "Captures de l’agent" })).not.toBeInTheDocument();
  });
});
