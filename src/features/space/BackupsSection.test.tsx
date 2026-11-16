import { useConfirm } from "@alfred/ui";
import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, expect, it, vi } from "vitest";

vi.mock("../../lib/native");
vi.hoisted(() => {
  window.matchMedia ??= ((query: string) => ({
    matches: false,
    media: query,
    addEventListener: () => {},
    removeEventListener: () => {},
  })) as unknown as typeof window.matchMedia;
});

import { invoke, onNativeEvent } from "../../lib/native";
import type { Snapshot } from "../../lib/types";
import { useNotifications } from "../../shell/notifications";
import { type BackupInfo, BackupsSection, formatSize } from "./BackupsSection";

HTMLDialogElement.prototype.showModal = function () {
  this.open = true;
};
HTMLDialogElement.prototype.close = function () {
  this.open = false;
  this.dispatchEvent(new Event("close"));
};

const snapshot = {
  path: "/x",
  name: "Atelier",
  modules: [
    { id: "notes", name: "Carnet" },
    { id: "suivi", name: "Suivi" },
  ],
} as unknown as Snapshot;

let backups: BackupInfo[];
let calls: Array<{ command: string; args: Record<string, unknown> }>;

beforeEach(() => {
  calls = [];
  useNotifications.getState().clear();
  backups = [
    {
      id: "20261116-080000-quotidienne",
      createdAt: "2026-11-16T07:00:00Z",
      reason: "quotidienne",
      size: 2048,
      modules: [{ id: "notes", tables: 1, rows: 3, files: 0 }],
    },
  ];
  vi.mocked(onNativeEvent).mockImplementation(() => () => {});
  vi.mocked(invoke).mockImplementation(async (command, args = {}) => {
    calls.push({ command, args });
    switch (command) {
      case "backups.list":
        return backups;
      case "backups.settings":
        return { keep: 14 };
      case "backups.setSettings":
        return { keep: (args as { keep: number }).keep };
      case "backups.create": {
        const backup: BackupInfo = { ...backups[0], id: "b2", reason: "manuelle", createdAt: "2026-11-16T09:00:00Z" };
        backups = [backup, ...backups];
        return backup;
      }
      case "backups.restore":
        return backups[0];
      default:
        throw new Error(`Commande inattendue : ${command}`);
    }
  });
});

function Harness() {
  const { confirm, confirmDialog } = useConfirm();
  return (
    <>
      <BackupsSection snapshot={snapshot} confirm={confirm} />
      {confirmDialog}
    </>
  );
}

it("liste les sauvegardes, en fait une et restaure un seul module après confirmation", async () => {
  const user = userEvent.setup();
  render(<Harness />);
  const table = await screen.findByRole("table", { name: "Sauvegardes de l’espace" });
  expect(within(table).getByText("Quotidienne")).toBeInTheDocument();
  expect(within(table).getByText("2 Ko")).toBeInTheDocument();

  await user.selectOptions(screen.getByLabelText("Copies quotidiennes gardées"), "30");
  await waitFor(() => expect(calls.some((call) => call.command === "backups.setSettings")).toBe(true));
  expect(calls.find((call) => call.command === "backups.setSettings")?.args).toEqual({ keep: 30 });

  await user.click(screen.getByRole("button", { name: "Sauvegarder maintenant" }));
  await waitFor(() => expect(within(table).getByText("Manuelle")).toBeInTheDocument());
  expect(useNotifications.getState().items.map((item) => item.title)).toContain("Sauvegarde faite");

  const [, older] = within(table).getAllByRole("button", { name: /Actions de la sauvegarde/ });
  await user.click(older);
  await user.click(screen.getByRole("menuitem", { name: "Seulement « Carnet »" }));
  const dialog = await screen.findByRole("alertdialog");
  expect(within(dialog).getByText(/les données du module « Carnet »/)).toBeInTheDocument();
  await user.click(within(dialog).getByRole("button", { name: "Restaurer" }));
  await waitFor(() =>
    expect(calls.find((call) => call.command === "backups.restore")?.args).toEqual({
      id: "20261116-080000-quotidienne",
      module: "notes",
    }),
  );
});

it("écrit les tailles en unités françaises", () => {
  expect(formatSize(512)).toBe("512 o");
  expect(formatSize(1536)).toBe("1,5 Ko");
  expect(formatSize(30 * 1024 * 1024)).toBe("30 Mo");
});
