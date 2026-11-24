import { screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { invoke, onNativeEvent } from "../../lib/native";
import { renderSections } from "../modules/settingsHarness";
import { type PythonEnvStatus, usePythonEnvSection } from "./PythonEnv";

vi.mock("../../lib/native", () => ({
  invoke: vi.fn(),
  onNativeEvent: vi.fn(() => () => undefined),
}));

const mockedInvoke = vi.mocked(invoke);

function env(overrides: Partial<PythonEnvStatus>): PythonEnvStatus {
  return {
    module: "analyse",
    status: "pending",
    requirements: ["pandas>=2.2", "openpyxl"],
    version: null,
    message: null,
    log: null,
    installedAt: null,
    python: null,
    ...overrides,
  };
}

function backend(envs: PythonEnvStatus[], uv = true) {
  mockedInvoke.mockImplementation(async (command: string) => {
    if (command === "python.envs") return { uv, envs };
    if (command === "python.reinstall") return null;
    throw new Error(`commande inattendue : ${command}`);
  });
}

function show(module: string | undefined) {
  return renderSections(() => {
    const section = usePythonEnvSection(module);
    return section ? [section] : [];
  }, "Analyse");
}

describe("Environnement Python d’un module", () => {
  beforeEach(() => {
    mockedInvoke.mockReset();
  });

  it("montre un environnement prêt avec ses paquets et sa version de Python", async () => {
    backend([env({ status: "ready", python: "3.12.4", installedAt: "2026-11-24T10:00:00Z" })]);
    show("analyse");
    expect(await screen.findByText("Environnement Python")).toBeTruthy();
    expect(screen.getByText("Prêt")).toBeTruthy();
    expect(screen.getByText(/Python 3\.12\.4 · pandas>=2\.2, openpyxl/)).toBeTruthy();
  });

  it("n’affiche rien pour un module sans paquets Python", async () => {
    backend([env({ module: "autre" })]);
    show("analyse");
    await waitFor(() => expect(mockedInvoke).toHaveBeenCalledWith("python.envs"));
    expect(screen.queryByText("Environnement Python")).toBeNull();
  });

  it("montre l’échec avec la fin du journal et réinstalle", async () => {
    backend([
      env({
        status: "failed",
        message: "Installation des paquets Python impossible sans réseau.",
        log: "$ uv pip install pandas\nerror: Failed to fetch",
      }),
    ]);
    show("analyse");
    expect(await screen.findByText("Échec")).toBeTruthy();
    expect(screen.getByText(/impossible sans réseau/)).toBeTruthy();
    const log = screen.getByRole("region", { name: "Fin du journal d’installation" });
    expect(within(log).getByText(/Failed to fetch/)).toBeTruthy();

    await userEvent.click(screen.getByRole("button", { name: /Réinstaller/ }));
    await waitFor(() => expect(mockedInvoke).toHaveBeenCalledWith("python.reinstall", { module: "analyse" }));
  });

  it("dit que uv manque, sans proposer de réinstaller", async () => {
    backend([env({ status: "uv-missing", message: "Installer uv (`brew install uv`)." })], false);
    show("analyse");
    expect(await screen.findByText("uv absent")).toBeTruthy();
    expect(screen.getByText(/brew install uv/)).toBeTruthy();
    expect(screen.queryByRole("button", { name: /Réinstaller/ })).toBeNull();
  });

  it("suit l’installation par l’événement python:changed", async () => {
    let changed: ((payload: unknown) => void) | undefined;
    vi.mocked(onNativeEvent).mockImplementation((name: string, handler: (payload: unknown) => void) => {
      if (name === "python:changed") changed = handler;
      return () => undefined;
    });
    backend([env({ status: "installing" })]);
    show("analyse");
    expect(await screen.findByText("Installation en cours")).toBeTruthy();
    expect(screen.queryByRole("button", { name: /Réinstaller/ })).toBeNull();

    backend([env({ status: "ready", python: "3.13.1" })]);
    changed?.(null);
    expect(await screen.findByText("Prêt")).toBeTruthy();
  });
});
