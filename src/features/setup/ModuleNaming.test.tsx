import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { expect, it, vi } from "vitest";

vi.hoisted(() => {
  // La coquille lit le thème du système dès son chargement, et jsdom n’a pas `matchMedia`.
  window.matchMedia ??= ((query: string) => ({
    matches: false,
    media: query,
    addEventListener: () => undefined,
    removeEventListener: () => undefined,
  })) as unknown as typeof window.matchMedia;
});

vi.mock("../../lib/native", () => ({
  invoke: vi.fn(async (_command: string, args: { layout: unknown }) => ({ ...current(), layout: args.layout })),
  onNativeEvent: vi.fn(() => () => undefined),
}));

import { invoke } from "../../lib/native";
import type { ModuleSummary, Snapshot } from "../../lib/types";
import { useShell } from "../../shell/store";
import { ModuleNaming } from "./ModuleNaming";

const current = () => useShell.getState().snapshot as Snapshot;

const suivi: ModuleSummary = {
  id: "suivi",
  name: "Suivi",
  version: "1.0.0",
  description: "",
  readOnly: false,
  origin: null,
  hidden: false,
  requires: [],
  requiredBy: [],
  pages: 2,
  functions: 0,
  clients: [{ id: "jira", label: "Jira" }],
  webhooks: [],
  schedules: [],
};

const page = (id: string, title: string, clients: string[]) => ({
  reference: `suivi/${id}`,
  module: "suivi",
  id,
  title,
  icon: null,
  description: "",
  hidden: false,
  readOnly: false,
  missing: false,
  errors: [],
  uses: { clients },
  panel: null,
});

it("fait nommer chaque entrée du menu et chaque onglet, et dit de quels services chacun a besoin", async () => {
  const user = userEvent.setup();
  useShell.setState({
    snapshot: {
      path: "/espace",
      name: "Démo",
      accent: null,
      sections: [
        {
          id: "suivi/principal",
          module: "suivi",
          label: "Suivi",
          icon: "list-checks",
          color: "blue",
          hidden: false,
          pages: [page("tickets", "Tickets", ["jira"]), page("notes", "Notes", [])],
        },
      ],
      settingsPages: [],
      modules: [suivi],
      functions: [],
      bindings: {},
      problems: [],
      layout: { sections: ["suivi/principal"] },
    } as unknown as Snapshot,
  });
  render(<ModuleNaming module={suivi} />);

  expect(screen.getByText("utilise Jira")).toBeInTheDocument();
  expect(screen.getByText("n’a besoin d’aucun service")).toBeInTheDocument();

  const name = screen.getByRole("textbox", { name: "Nom dans le menu" });
  await user.clear(name);
  await user.type(name, "Mes tickets{Enter}");
  await waitFor(() =>
    expect(invoke).toHaveBeenCalledWith(
      "space.updateLayout",
      expect.objectContaining({ message: expect.stringContaining("Mes tickets") }),
    ),
  );
  expect(useShell.getState().snapshot?.sections[0].label).toBe("Mes tickets");
});
