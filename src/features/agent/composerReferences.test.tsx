import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Snapshot } from "../../lib/types";
import { useShell } from "../../shell/store";
import { Composer } from "./Composer";
import { type ComposerReference, clearReferenceCatalogs } from "./lib/composerReferences";
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

const catalog: ComposerReference[] = [
  { kind: "command", name: "publier", path: "/projet/.claude/commands/publier.md", description: "Publie le module" },
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
  native.invoke.mockImplementation(async (command: string, args: Record<string, unknown> = {}) => {
    if (command === "composer.references") {
      if (args.kind === "file") return files.filter((item) => item.name.includes(String(args.query)));
      return catalog;
    }
    return null;
  });
  useShell.setState({
    snapshot: { path: "/projet", name: "Espace", accent: null, sections: [], settingsPages: [] } as unknown as Snapshot,
  });
  useAgents.setState({
    send: async (_id: string, message: UserMessage) => {
      sent.push(message);
    },
  });
});

/** Tape `value` d’un coup, curseur en fin de texte, comme le ferait la frappe. */
function type(input: HTMLTextAreaElement, value: string) {
  fireEvent.change(input, { target: { value, selectionStart: value.length, selectionEnd: value.length } });
}

describe("références de la saisie", () => {
  it("« / » propose les commandes et skills du harnais, « @ » les fichiers ; les références partent avec le message", async () => {
    render(<Composer conversation={conversation} responding={false} />);
    const input = screen.getByRole("textbox", { name: "Message à l’agent" }) as HTMLTextAreaElement;

    type(input, "/rel");
    const commands = await screen.findByRole("listbox", { name: "Commandes et skills" });
    await within(commands).findByRole("option", { name: /relire-page/ });
    expect(native.invoke).toHaveBeenCalledWith("composer.references", {
      cwd: "/projet",
      provider: "claude",
      kind: "command",
      query: "",
    });
    fireEvent.keyDown(input, { key: "Enter" });
    await waitFor(() => expect(input.value).toBe("/relire-page "));
    expect(screen.queryByRole("listbox")).toBeNull();

    type(input, "/relire-page puis vérifie @liste");
    const found = await screen.findByRole("listbox", { name: "Fichiers du dossier de travail" });
    const option = await within(found).findByRole("option", { name: /liste\.tsx/ });
    fireEvent.mouseDown(option);
    await waitFor(() => expect(input.value).toBe("/relire-page puis vérifie @modules/notes/pages/liste.tsx "));

    // Une mention effacée ne part pas : « /publier » choisi puis retiré du texte.
    type(input, `${input.value}/pub`);
    await within(await screen.findByRole("listbox")).findByRole("option", { name: /publier/ });
    fireEvent.keyDown(input, { key: "Tab" });
    await waitFor(() => expect(input.value.endsWith("/publier ")).toBe(true));
    type(input, input.value.replace("/publier ", ""));

    fireEvent.keyDown(input, { key: "Enter" });
    await waitFor(() => expect(sent).toHaveLength(1));
    expect(sent[0].text).toBe("/relire-page puis vérifie @modules/notes/pages/liste.tsx");
    expect(sent[0].references?.map((item) => item.name)).toEqual(["relire-page", "modules/notes/pages/liste.tsx"]);
    const outgoing = outgoingText(sent[0]);
    expect(outgoing).toContain('Utilise le skill « relire-page » ("/projet/.claude/skills/relire-page/SKILL.md").');
    expect(outgoing).toContain('"/projet/modules/notes/pages/liste.tsx"');
    expect(outgoing).not.toContain("publier");
  });

  it("Échap ferme la liste sans rien insérer", async () => {
    render(<Composer conversation={conversation} responding={false} />);
    const input = screen.getByRole("textbox", { name: "Message à l’agent" }) as HTMLTextAreaElement;
    type(input, "@notes");
    await screen.findByRole("listbox", { name: "Fichiers du dossier de travail" });
    fireEvent.keyDown(input, { key: "Escape" });
    expect(screen.queryByRole("listbox")).toBeNull();
    expect(input.value).toBe("@notes");
  });
});
