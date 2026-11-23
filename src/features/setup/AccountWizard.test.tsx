import { fireEvent, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => {
  window.matchMedia ??= ((query: string) => ({ matches: false, media: query })) as unknown as typeof window.matchMedia;
  return {
    saveInstance: vi.fn(),
    testClient: vi.fn(),
    probeAddress: vi.fn(),
    saveVaultEntry: vi.fn(),
    listVault: vi.fn(),
  };
});
vi.mock("../clients/api", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../clients/api")>()),
  saveInstance: mocks.saveInstance,
  testClient: mocks.testClient,
  probeAddress: mocks.probeAddress,
}));
vi.mock("../vault/api", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../vault/api")>()),
  saveVaultEntry: mocks.saveVaultEntry,
  listVault: mocks.listVault,
}));

import type { ClientItem } from "../clients/api";
import type { ClientsController } from "../clients/useClients";
import { renderWithSocle } from "../modules/settingsHarness";
import { AccountWizard } from "./AccountWizard";

const portainer = {
  id: "portainer",
  label: "Portainer",
  baseUrl: "",
  simple: false,
  methods: [
    {
      id: "motdepasse",
      label: "Identifiant et mot de passe",
      type: "session",
      login: { path: "/api/auth", token: "jwt" },
      params: [{ id: "endpoint", label: "Endpoint", example: "3", help: "Numéro de l’environnement." }],
    },
  ],
  instances: [],
  status: "noInstance",
  hasSecret: false,
  connected: null,
  usedBy: [],
  problem: null,
  validation: null,
} as unknown as ClientItem;

const services = {
  overview: { clients: [portainer], needs: [], redirectUri: null },
  load: vi.fn(),
} as unknown as ClientsController;

beforeEach(() => {
  mocks.saveInstance.mockReset().mockResolvedValue(portainer);
  mocks.testClient.mockReset().mockResolvedValue({ ok: true, status: 200, durationMs: 3, message: "ok" });
  mocks.probeAddress.mockReset().mockResolvedValue({ ok: true, status: 200, reason: null, message: "" });
  mocks.saveVaultEntry.mockReset().mockResolvedValue({ id: "portainer-prod", hasSecret: true });
  mocks.listVault.mockReset().mockResolvedValue([]);
});

describe("assistant de compte", () => {
  it("demande l’identifiant, le mot de passe et les paramètres d’un compte à session", async () => {
    const connected = vi.fn();
    renderWithSocle(
      <AccountWizard
        plan={{ key: "docker/portainer", module: "docker", need: "portainer", label: "Portainer" }}
        modules={[]}
        services={services}
        client={portainer}
        onSaved={vi.fn()}
        onConnected={connected}
      />,
    );
    fireEvent.change(screen.getByLabelText(/Adresse/), { target: { value: "https://portainer.acme.example" } });
    fireEvent.change(screen.getByLabelText("Identifiant"), { target: { value: "alice" } });
    fireEvent.change(screen.getByLabelText("Mot de passe"), { target: { value: "m0t-de-p4ss3" } });
    expect(screen.getByText(/Numéro de l’environnement\. Par exemple 3\./)).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Connecter" }));
    await screen.findByText("Saisissez « Endpoint ».");
    expect(mocks.saveInstance).not.toHaveBeenCalled();

    fireEvent.change(screen.getByLabelText("Endpoint"), { target: { value: " 3 " } });
    fireEvent.click(screen.getByRole("button", { name: "Connecter" }));
    await waitFor(() => expect(connected).toHaveBeenCalled());
    expect(mocks.saveVaultEntry).toHaveBeenCalledWith(
      expect.objectContaining({ kind: "basic", meta: { username: "alice" }, secrets: { password: "m0t-de-p4ss3" } }),
    );
    const [, instance] = mocks.saveInstance.mock.calls[0] as [string, Record<string, unknown>];
    expect(instance).toMatchObject({
      method: "motdepasse",
      url: "https://portainer.acme.example",
      secret: "portainer-prod",
      params: { endpoint: "3" },
    });
    // Le mot de passe va au coffre, jamais dans le compte enregistré avec le service.
    expect(JSON.stringify(instance)).not.toContain("m0t-de-p4ss3");
  });
});
