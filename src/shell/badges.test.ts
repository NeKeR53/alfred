import { beforeEach, describe, expect, it, vi } from "vitest";

const native = vi.hoisted(() => {
  window.matchMedia ??= ((query: string) => ({ matches: false, media: query })) as unknown as typeof window.matchMedia;
  return { invoke: vi.fn(), notifySystem: vi.fn() };
});
vi.mock("../lib/native", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../lib/native")>()),
  invoke: native.invoke,
  notifySystem: native.notifySystem,
}));

import type { ResolvedPage, Snapshot } from "../lib/types";
import { badgeText, sectionCount } from "./badges";
import { type FrameIdentity, handleFrameRequest } from "./frameBridge";
import { useNotifications } from "./notifications";
import { useShell } from "./store";

const page = (reference: string, hidden = false) => ({ reference, hidden }) as ResolvedPage;

beforeEach(() => {
  native.invoke.mockReset().mockResolvedValue({ count: 1 });
  native.notifySystem.mockReset().mockResolvedValue(false);
  useShell.setState({
    snapshot: {
      sections: [
        { id: "mail/courrier", pages: [page("mail/boite"), page("mail/envoyes")] },
        { id: "mail/compte@pro", pages: [page("mail/suivi@pro")] },
      ],
      settingsPages: [],
    } as unknown as Snapshot,
  });
});

describe("pastille d’une section", () => {
  it("additionne les pages visibles", () => {
    const pages = [page("mail/boite"), page("mail/envoyes"), page("mail/brouillons", true)];
    expect(sectionCount({ "mail/boite": 3, "mail/envoyes": 2, "mail/brouillons": 9 }, pages)).toBe(5);
    expect(sectionCount({}, pages)).toBe(0);
  });

  it("abrège au-delà de 99", () => {
    expect(badgeText(7)).toBe("7");
    expect(badgeText(120)).toBe("99+");
  });
});

describe("badge.update", () => {
  const boite: FrameIdentity = { kind: "page", module: "mail", reference: "mail/boite" };
  const subject = { kind: "page", module: "mail", reference: "mail/boite" };

  it("règle le compteur de la page elle-même", async () => {
    await handleFrameRequest(boite, "badge.update", { op: "set", value: 4 });
    expect(native.invoke).toHaveBeenCalledWith("frame.badges.update", {
      subject,
      page: "mail/boite",
      op: "set",
      value: 4,
    });
  });

  it("un panneau règle celui de sa page, une fonction nomme la page", async () => {
    await handleFrameRequest(
      { kind: "panel", module: "mail", reference: "mail/apercu", host: "mail/boite" },
      "badge.update",
      { op: "increment", value: 1 },
    );
    const relever: FrameIdentity = { kind: "function", module: "mail", reference: "mail/relever" };
    await handleFrameRequest(relever, "badge.update", { op: "increment", value: 2, page: "envoyes" });
    expect(native.invoke.mock.calls.map(([, args]) => (args as { page: string }).page)).toEqual([
      "mail/boite",
      "mail/envoyes",
    ]);
    await expect(handleFrameRequest(relever, "badge.update", { op: "set", value: 1 })).rejects.toThrow(/page nommée/);
  });

  it("garde l’instance de la page qui appelle et refuse une page inconnue", async () => {
    const suivi: FrameIdentity = { kind: "page", module: "mail", reference: "mail/suivi@pro", instance: "pro" };
    await handleFrameRequest(suivi, "badge.update", { op: "set", value: 1 });
    await handleFrameRequest(suivi, "badge.update", { op: "set", value: 1, page: "boite" });
    expect(native.invoke.mock.calls.map(([, args]) => (args as { page: string }).page)).toEqual([
      "mail/suivi@pro",
      "mail/boite",
    ]);
    await expect(handleFrameRequest(boite, "badge.update", { op: "set", value: 1, page: "inconnue" })).rejects.toThrow(
      /n’existe pas/,
    );
    await expect(handleFrameRequest(boite, "badge.update", { op: "set", value: "beaucoup" })).rejects.toThrow(/nombre/);
  });
});

describe("shell.notify", () => {
  it("garde la notification dans Alfred et la propose au système", async () => {
    useNotifications.getState().clear();
    await handleFrameRequest({ kind: "page", module: "mail", reference: "mail/boite" }, "shell.notify", {
      title: "3 nouveaux messages",
      description: "De Claire",
    });
    expect(useNotifications.getState().items[0]).toMatchObject({ title: "3 nouveaux messages", source: "mail/boite" });
    expect(native.notifySystem).toHaveBeenCalledWith("3 nouveaux messages", "De Claire");
  });
});
