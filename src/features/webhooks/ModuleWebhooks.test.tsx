import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, expect, it, vi } from "vitest";

vi.mock("../../lib/native");

import { invoke, onNativeEvent } from "../../lib/native";
import { useNotifications } from "../../shell/notifications";
import type { WebhookItem } from "./api";
import { MASK, ModuleWebhooks } from "./ModuleWebhooks";

// jsdom n’implémente pas les modales natives.
HTMLDialogElement.prototype.showModal = function () {
  this.open = true;
};
HTMLDialogElement.prototype.close = function () {
  this.open = false;
  this.dispatchEvent(new Event("close"));
};

const URL_PAIEMENT = "http://127.0.0.1:14731/hooks/ventes/paiement";
let hooks: WebhookItem[];
let secret: string;
let calls: Array<{ command: string; args: Record<string, unknown> }>;
const listeners = new Map<string, (payload: unknown) => void>();
let writeText: ReturnType<typeof vi.fn>;

beforeEach(() => {
  hooks = [];
  secret = "a".repeat(64);
  calls = [];
  listeners.clear();
  useNotifications.getState().clear();
  vi.mocked(onNativeEvent).mockImplementation((name, handler) => {
    listeners.set(name, handler);
    return () => listeners.delete(name);
  });
  vi.mocked(invoke).mockImplementation(async (command, args = {}) => {
    calls.push({ command, args });
    switch (command) {
      case "webhooks.list":
        return hooks.map((hook) => ({ ...hook }));
      case "webhooks.secret":
        return { secret };
      case "webhooks.rotate":
        secret = "b".repeat(64);
        return { secret };
      default:
        throw new Error(`Commande inattendue : ${command}`);
    }
  });
});

const notifications = () => useNotifications.getState().items.map((item) => item.title);

it("liste les webhooks, copie l’adresse, affiche le secret masqué et le régénère après confirmation", async () => {
  const user = userEvent.setup();
  // userEvent installe son propre presse-papiers : on l’observe après son installation.
  writeText = vi.spyOn(navigator.clipboard, "writeText").mockResolvedValue(undefined) as unknown as ReturnType<
    typeof vi.fn
  >;
  const { container } = render(<ModuleWebhooks module="ventes" />);

  // Sans webhook, la fiche du module n’en parle pas.
  await waitFor(() => expect(calls.some((call) => call.command === "webhooks.list")).toBe(true));
  expect(container).toBeEmptyDOMElement();

  // L’agent déclare deux webhooks : l’écran se relit sur space:changed.
  hooks = [
    {
      module: "ventes",
      id: "paiement",
      description: "Paiement reçu",
      function: "encaisser",
      url: URL_PAIEMENT,
      lastReceivedAt: null,
      functionExists: true,
    },
    {
      module: "crm",
      id: "contact",
      description: "Nouveau contact",
      function: "absente",
      url: "http://127.0.0.1:14731/hooks/crm/contact",
      lastReceivedAt: "2026-11-12T09:30:00Z",
      functionExists: false,
    },
  ];
  listeners.get("space:changed")?.(null);
  // Seuls ceux du module s’affichent, avec le rappel du tunnel.
  const table = await screen.findByRole("table", { name: "Webhooks du module" });
  expect(within(table).getByText("Paiement reçu")).toBeInTheDocument();
  expect(within(table).queryByText("Nouveau contact")).not.toBeInTheDocument();
  expect(within(table).getByText(URL_PAIEMENT)).toBeInTheDocument();
  expect(within(table).getByText("Jamais")).toBeInTheDocument();
  expect(screen.getByText(/tunnel de votre choix/)).toBeInTheDocument();

  // Copier l’adresse locale.
  await user.click(screen.getByRole("button", { name: "Copier l’adresse du webhook Paiement reçu" }));
  expect(writeText).toHaveBeenCalledWith(URL_PAIEMENT);
  await waitFor(() => expect(notifications()).toContain("Adresse copiée"));

  // Afficher le secret : masqué d’abord, révélé à la demande, copiable.
  await user.click(screen.getByRole("button", { name: "Afficher le secret du webhook Paiement reçu" }));
  expect(await screen.findByText(MASK)).toBeInTheDocument();
  expect(calls.find((call) => call.command === "webhooks.secret")?.args).toEqual({ hook: "ventes/paiement" });
  expect(document.body.textContent).not.toContain(secret);
  await user.click(screen.getByRole("button", { name: "Révéler le secret" }));
  expect(screen.getByText(secret)).toBeInTheDocument();
  expect(screen.queryByText(MASK)).not.toBeInTheDocument();
  await user.click(screen.getByRole("button", { name: "Copier le secret" }));
  expect(writeText).toHaveBeenLastCalledWith(secret);

  // Régénérer : annuler ne change rien, confirmer remplace le secret.
  await user.click(screen.getByRole("button", { name: "Régénérer" }));
  await user.click(within(screen.getByRole("alertdialog")).getByRole("button", { name: "Annuler" }));
  expect(calls.some((call) => call.command === "webhooks.rotate")).toBe(false);
  await user.click(screen.getByRole("button", { name: "Régénérer" }));
  await user.click(within(screen.getByRole("alertdialog")).getByRole("button", { name: "Régénérer" }));
  expect(await screen.findByText("b".repeat(64))).toBeInTheDocument();
  expect(calls.find((call) => call.command === "webhooks.rotate")?.args).toEqual({ hook: "ventes/paiement" });
  expect(notifications()).toContain("Secret régénéré");

  // Une réception arrive : journal:changed relit la liste.
  hooks = hooks.map((hook) => (hook.id === "paiement" ? { ...hook, lastReceivedAt: "2026-11-12T10:00:00Z" } : hook));
  listeners.get("journal:changed")?.(null);
  await waitFor(() => expect(within(table).queryByText("Jamais")).not.toBeInTheDocument());

  await user.click(screen.getByRole("button", { name: "Fermer" }));
  expect(screen.queryByText("b".repeat(64))).not.toBeInTheDocument();
});
