import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";

const settings = vi.hoisted(() => new Map<string, unknown>());
vi.mock("../lib/native", () => ({
  invoke: vi.fn(async (command: string, args: { key: string; value?: unknown }) => {
    if (command === "settings.get") return settings.get(args.key) ?? null;
    if (command === "settings.set") settings.set(args.key, args.value);
    return null;
  }),
}));

import { nextPanelWidth, ResizablePanel } from "./ResizablePanel";

beforeEach(() => settings.clear());

const panel = () => screen.getByRole("complementary", { name: "Historique" });

describe("ResizablePanel", () => {
  it("passe d’une largeur à l’autre par Agrandir, puis revient à la plus étroite", async () => {
    const user = userEvent.setup();
    render(
      <ResizablePanel storageKey="shell.panelWidth" label="Historique" title="Historique" onClose={() => undefined}>
        contenu
      </ResizablePanel>,
    );
    expect(panel().dataset.size).toBe("compact");
    await user.click(screen.getByRole("button", { name: "Agrandir le panneau" }));
    expect(panel().dataset.size).toBe("form");
    await user.click(screen.getByRole("button", { name: "Agrandir le panneau" }));
    expect(panel().dataset.size).toBe("wide");
    expect(settings.get("shell.panelWidth")).toBe("wide");
    await user.click(screen.getByRole("button", { name: "Réduire le panneau" }));
    expect(panel().dataset.size).toBe("compact");
    // Plus de séparateur de largeur : les trois tailles le remplacent, comme dans OneApp.
    expect(screen.queryByRole("separator")).toBeNull();
    expect(screen.getByRole("button", { name: "Fermer le panneau" })).toBeTruthy();
  });

  it("reprend la largeur retenue, et ignore l’ancienne largeur en pixels", async () => {
    settings.set("shell.panelWidth", "form");
    const first = render(
      <ResizablePanel storageKey="shell.panelWidth" label="Historique" title="Historique" onClose={() => undefined}>
        contenu
      </ResizablePanel>,
    );
    await waitFor(() => expect(panel().dataset.size).toBe("form"));
    first.unmount();
    settings.set("shell.panelWidth", 520);
    render(
      <ResizablePanel storageKey="shell.panelWidth" label="Historique" title="Historique" onClose={() => undefined}>
        contenu
      </ResizablePanel>,
    );
    await Promise.resolve();
    expect(panel().dataset.size).toBe("compact");
  });

  it("enchaîne sections, formulaire et large", () => {
    expect([nextPanelWidth("compact"), nextPanelWidth("form"), nextPanelWidth("wide")]).toEqual([
      "form",
      "wide",
      "compact",
    ]);
  });
});
