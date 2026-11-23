import { screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, expect, it, vi } from "vitest";

vi.mock("../../lib/native");
vi.hoisted(() => {
  window.matchMedia ??= ((query: string) => ({
    matches: false,
    media: query,
    addEventListener: () => undefined,
    removeEventListener: () => undefined,
  })) as unknown as typeof window.matchMedia;
});

import { invoke, pickSaveFile } from "../../lib/native";
import type { ModuleSummary } from "../../lib/types";
import { useShell } from "../../shell/store";
import { ModuleExportDialog } from "./ModuleDataDialog";
import { renderWithSocle as render } from "./sections.test-helper";

// jsdom n’implémente pas les modales natives.
HTMLDialogElement.prototype.showModal = function () {
  this.open = true;
};
HTMLDialogElement.prototype.close = function () {
  this.open = false;
  this.dispatchEvent(new Event("close"));
};

const module = (id: string, name: string) => ({ id, name }) as ModuleSummary;
let calls: Array<{ command: string; args: Record<string, unknown> }>;

beforeEach(() => {
  calls = [];
  useShell.setState({ info: { platform: "macos" } } as never);
  vi.mocked(invoke).mockImplementation(async (command, args = {}) => {
    calls.push({ command, args });
    return null;
  });
  vi.mocked(pickSaveFile).mockResolvedValue("/Users/test/atlassian.json");
});

it("exporte les données d’un module en une modale : quoi, où, format, puis « Exporté vers »", async () => {
  const user = userEvent.setup();
  const onClose = vi.fn();
  render(
    <ModuleExportDialog
      modules={[module("jira", "Jira"), module("atlassian", "Atlassian")]}
      initial="atlassian"
      onClose={onClose}
    />,
  );
  const dialog = screen.getByRole("dialog", { name: "Exporter les données" });
  expect(within(dialog).getByRole("button", { name: /Module/ })).toHaveTextContent("Atlassian");
  expect(within(dialog).getByText("Un fichier .json")).toBeInTheDocument();
  await user.click(within(dialog).getByRole("button", { name: "Exporter…" }));
  await waitFor(() =>
    expect(calls.at(-1)).toEqual({
      command: "backups.exportModule",
      args: { module: "atlassian", path: "/Users/test/atlassian.json" },
    }),
  );
  const done = await screen.findByRole("dialog", { name: "Données exportées" });
  expect(within(done).getByText("/Users/test/atlassian.json")).toBeInTheDocument();
  await user.click(within(done).getByRole("button", { name: "Afficher dans le Finder" }));
  expect(calls.at(-1)).toEqual({ command: "files.reveal", args: { path: "/Users/test/atlassian.json" } });
  await user.click(within(done).getByRole("button", { name: "Terminer" }));
  expect(onClose).toHaveBeenCalled();
});

it("en mode import, rend le module choisi pour faire choisir le fichier", async () => {
  const user = userEvent.setup();
  const onImport = vi.fn();
  render(<ModuleExportDialog modules={[module("jira", "Jira")]} onClose={() => undefined} onImport={onImport} />);
  const dialog = screen.getByRole("dialog", { name: "Importer des données" });
  await user.click(within(dialog).getByRole("button", { name: "Choisir le fichier…" }));
  expect(onImport).toHaveBeenCalledWith("jira");
  expect(calls).toEqual([]);
});
