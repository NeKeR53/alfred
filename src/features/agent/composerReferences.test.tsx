import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Snapshot } from "../../lib/types";
import { useShell } from "../../shell/store";
import { Composer } from "./Composer";
import { resetComposerDrafts } from "./drafts";
import { fakeSpawn } from "./harness/fakeProcess.test-helper";
import {
  type ComposerReference,
  type ComposerReferenceMention,
  clearReferenceCatalogs,
  loadComposerReferences,
  referenceInstructions,
  referenceQuery,
  replaceComposerRange,
  trimComposerReferences,
} from "./lib/composerReferences";
import { type Conversation, outgoingText, type UserMessage } from "./model";
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
vi.mock("./harness/process", () => ({ spawnProcess: vi.fn(), probe: vi.fn() }));

const commands: ComposerReference[] = [
  { kind: "command", name: "publier", path: "/projet/.claude/commands/publier.md", description: "Publie le module" },
];
const skills: ComposerReference[] = [
  { kind: "skill", name: "relire-page", path: "/projet/.claude/skills/relire-page/SKILL.md" },
];
const files: ComposerReference[] = [
  { kind: "file", name: "modules/notes/pages/liste.tsx", path: "/projet/modules/notes/pages/liste.tsx" },
  { kind: "file", name: "modules/notes/", path: "/projet/modules/notes" },
];

const conversation: Conversation = {
  id: "c1",
  title: "Nouvelle conversation",
  provider: "claude",
  cwd: "/projet",
  autonomy: "ask",
  createdAt: 0,
  updatedAt: 0,
  archived: false,
  unread: false,
  started: false,
  turns: [],
};

let sent: UserMessage[];

beforeEach(() => {
  sent = [];
  clearReferenceCatalogs();
  resetComposerDrafts();
  native.invoke.mockReset();
  native.invoke.mockImplementation(async (command: string, args: Record<string, unknown> = {}) => {
    if (command === "composer.references") {
      if (args.kind === "file") return files.filter((item) => item.name.includes(String(args.query)));
      return args.kind === "skill" ? skills : commands;
    }
    return null;
  });
  useShell.setState({
    snapshot: { path: "/projet", name: "Espace", accent: null, sections: [], settingsPages: [] } as unknown as Snapshot,
  });
  useAgents.setState({
    ready: true,
    send: async (_id: string, message: UserMessage) => {
      sent.push(message);
    },
  });
});

async function editor() {
  const input = screen.getByRole("textbox", { name: "Message à l’agent" });
  await waitFor(() => expect(input).toHaveAttribute("contenteditable", "true"));
  return input;
}

describe("références de la saisie", () => {
  it("« / » propose commandes et skills, « @ » les fichiers ; chaque choix devient une pastille qui part avec le message", async () => {
    const user = userEvent.setup();
    render(<Composer conversation={conversation} responding={false} />);
    const input = await editor();

    await user.click(input);
    await user.keyboard("/rel");
    const listed = await screen.findByRole("listbox", { name: "Commandes et skills" });
    await within(listed).findByRole("option", { name: /relire-page/ });
    expect(native.invoke).toHaveBeenCalledWith("composer.references", {
      cwd: "/projet",
      provider: "claude",
      kind: "command",
      query: "",
    });
    expect(native.invoke).toHaveBeenCalledWith("composer.references", {
      cwd: "/projet",
      provider: "claude",
      kind: "skill",
      query: "",
    });
    await user.keyboard("{Enter}");
    // La mention tapée laisse place à une pastille non éditable, avec son « × ».
    const pill = await within(input).findByText("relire-page");
    expect(pill.closest(".reference-pill")).toHaveAttribute("contenteditable", "false");
    expect(within(input).getByRole("button", { name: "Retirer relire-page" })).toBeInTheDocument();
    expect(screen.queryByRole("listbox")).toBeNull();

    await user.keyboard(" puis vérifie @liste");
    const found = await screen.findByRole("listbox", { name: "Fichiers du dossier de travail" });
    fireEvent.mouseDown(await within(found).findByRole("option", { name: /liste\.tsx/ }));
    await within(input).findByText("liste.tsx");

    // Une pastille retirée par son « × » ne part pas.
    await user.keyboard(" /pub");
    await within(await screen.findByRole("listbox")).findByRole("option", { name: /publier/ });
    await user.keyboard("{Tab}");
    await within(input).findByText("publier");
    await user.click(within(input).getByRole("button", { name: "Retirer publier" }));
    await waitFor(() => expect(within(input).queryByText("publier")).toBeNull());

    await user.click(screen.getByRole("button", { name: "Envoyer" }));
    await waitFor(() => expect(sent).toHaveLength(1));
    expect(sent[0].text).toBe("puis vérifie");
    const references = sent[0].references as ComposerReferenceMention[];
    expect(references.map((item) => [item.name, item.offset])).toEqual([
      ["relire-page", 0],
      ["modules/notes/pages/liste.tsx", 12],
    ]);
    const outgoing = outgoingText(sent[0]);
    expect(outgoing).toContain("Utilise le skill $relire-page.");
    expect(outgoing).toContain('Fichier ou dossier référencé : @"/projet/modules/notes/pages/liste.tsx"');
    expect(outgoing).not.toContain("publier");
  });

  it("« $ » ne propose que les skills", async () => {
    const user = userEvent.setup();
    render(<Composer conversation={conversation} responding={false} />);
    const input = await editor();
    await user.click(input);
    await user.keyboard("$re");
    const listed = await screen.findByRole("listbox", { name: "Skills" });
    await within(listed).findByRole("option", { name: /relire-page/ });
    expect(within(listed).queryByRole("option", { name: /publier/ })).toBeNull();
  });

  it("Échap ferme la liste sans rien insérer", async () => {
    const user = userEvent.setup();
    render(<Composer conversation={conversation} responding={false} />);
    const input = await editor();
    await user.click(input);
    await user.keyboard("@notes");
    await screen.findByRole("listbox", { name: "Fichiers du dossier de travail" });
    await user.keyboard("{Escape}");
    expect(screen.queryByRole("listbox")).toBeNull();
    expect(input).toHaveTextContent("@notes");
  });

  it("le menu « + » insère le déclencheur au curseur, précédé d’une espace, et ouvre les suggestions", async () => {
    const user = userEvent.setup();
    render(<Composer conversation={conversation} responding={false} />);
    const input = await editor();
    await user.click(input);
    await user.keyboard("Regarde");
    await user.click(screen.getByRole("button", { name: "Ajouter au message" }));
    expect(screen.getByRole("menuitem", { name: "Joindre des fichiers…" })).toBeInTheDocument();
    expect(screen.getByRole("menuitem", { name: "Skill ou commande · /" })).toBeInTheDocument();
    await user.click(screen.getByRole("menuitem", { name: "Fichier du dossier · @" }));
    await waitFor(() => expect(input).toHaveTextContent("Regarde @"));
    await screen.findByRole("listbox", { name: "Fichiers du dossier de travail" });
  });
});

describe("positions et consignes des références", () => {
  it("`$` déclenche les skills, en début de mot seulement", () => {
    expect(referenceQuery("lance $rel", 10)).toEqual({ kind: "skill", query: "rel", start: 6, end: 10 });
    expect(referenceQuery("prix 5$", 7)).toBeUndefined();
    expect(referenceQuery("@src", 4)?.kind).toBe("file");
    expect(referenceQuery("/pub", 4)?.kind).toBe("command");
  });

  it("les pastilles suivent les modifications du texte", () => {
    const mention = (offset: number): ComposerReferenceMention => ({
      id: String(offset),
      offset,
      kind: "file",
      name: "a",
      path: "/a",
    });
    const shifted = replaceComposerRange([mention(2), mention(5), mention(9)], 4, 7, 1);
    expect(shifted.map((item) => item.offset)).toEqual([2, 5, 7]);
    expect(
      trimComposerReferences("  bonjour  ", [mention(0), mention(9), mention(11)]).map((item) => item.offset),
    ).toEqual([0, 7, 7]);
  });

  it("consignes de OneApp : l’agent reçoit le chemin, l’interface n’affiche que le nom", () => {
    expect(
      referenceInstructions([
        { kind: "file", name: "src/a.ts", path: "/p/src/a.ts" },
        { kind: "skill", name: "relire", path: "/p/SKILL.md" },
        { kind: "command", name: "publier", path: "/p/publier.md" },
      ]),
    ).toBe(
      [
        'Fichier ou dossier référencé : @"/p/src/a.ts"',
        "Utilise le skill $relire.",
        'Applique la commande /publier définie dans "/p/publier.md".',
      ].join("\n"),
    );
  });

  it("Codex : les skills viennent de `skills/list`, désactivés écartés, et le catalogue est gardé 30 s", async () => {
    const spawned = fakeSpawn((process) => {
      process.respond("initialize", { result: {} });
      process.respond("skills/list", {
        result: {
          data: [
            {
              cwd: "/projet",
              skills: [
                { name: "relire", path: "/s/relire/SKILL.md", description: "Relit", enabled: true },
                { name: "ancien", path: "/s/ancien/SKILL.md", enabled: false },
              ],
            },
          ],
        },
      });
    });
    const found = await loadComposerReferences("/projet", "codex", "skill", "");
    expect(found).toEqual([{ kind: "skill", name: "relire", path: "/s/relire/SKILL.md", description: "Relit" }]);
    expect(spawned).toHaveLength(1);
    expect(spawned[0].provider).toBe("codex");
    expect(spawned[0].process.written.map((message) => message.method)).toEqual([
      "initialize",
      "initialized",
      "skills/list",
    ]);
    expect(spawned[0].process.written[2].params).toEqual({ cwds: ["/projet"], forceReload: true });
    expect(spawned[0].process.killed).toBe(true);
    // `/` réunit les commandes lues par Alfred et les skills de Codex, sans relancer le CLI.
    await act(async () => {
      const all = await loadComposerReferences("/projet", "codex", "command", "");
      expect(all.map((item) => item.name)).toEqual(["publier", "relire"]);
    });
    expect(spawned).toHaveLength(1);
    expect(native.invoke).not.toHaveBeenCalledWith("composer.references", expect.objectContaining({ kind: "skill" }));
  });
});
