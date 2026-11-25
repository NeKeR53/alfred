import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../lib/native");
vi.hoisted(() => {
  window.matchMedia ??= ((query: string) => ({
    matches: false,
    media: query,
    addEventListener: () => {},
    removeEventListener: () => {},
  })) as unknown as typeof window.matchMedia;
});

import { invoke } from "../lib/native";
import type { ResolvedFunction, Snapshot } from "../lib/types";
import { callFunction } from "./functionHost";
import { useShell } from "./store";

const script: ResolvedFunction = {
  reference: "outils/saluer",
  module: "outils",
  id: "saluer",
  description: "",
  input: null,
  output: null,
  tool: true,
  missing: false,
  errors: [],
  uses: {},
  runtime: "bash",
};

beforeEach(() => {
  vi.mocked(invoke).mockReset();
  useShell.setState({ snapshot: { functions: [script] } as unknown as Snapshot });
});

it("confie un script à Alfred, sans cadre, avec son appelant", async () => {
  vi.mocked(invoke).mockResolvedValue({ message: "Bonjour Zoé" });
  await expect(callFunction("outils/saluer", { nom: "Zoé" }, "outils/accueil")).resolves.toEqual({
    message: "Bonjour Zoé",
  });
  expect(vi.mocked(invoke)).toHaveBeenCalledTimes(1);
  expect(vi.mocked(invoke)).toHaveBeenCalledWith("functions.call", {
    function: "outils/saluer",
    input: { nom: "Zoé" },
    caller: "outils/accueil",
  });
  expect(document.querySelector("iframe")).toBeNull();
});

it("refuse un script pas encore écrit sans rien lancer", async () => {
  useShell.setState({ snapshot: { functions: [{ ...script, missing: true }] } as unknown as Snapshot });
  await expect(callFunction("outils/saluer", {}, "agent")).rejects.toBeDefined();
  expect(vi.mocked(invoke)).not.toHaveBeenCalled();
});

it("en données d’exemple, une fonction de connecteur rend son exemple sans être lancée", async () => {
  const connector: ResolvedFunction = {
    ...script,
    reference: "jira/lister",
    module: "jira",
    uses: { clients: ["jira"] },
  };
  useShell.setState({ snapshot: { functions: [connector], examples: ["jira"] } as unknown as Snapshot });
  vi.mocked(invoke).mockResolvedValue({ tickets: [] });
  await expect(callFunction("jira/lister", { projet: "ALF" }, "jira/tableau")).resolves.toEqual({ tickets: [] });
  expect(vi.mocked(invoke)).toHaveBeenCalledWith("functions.example", {
    function: "jira/lister",
    input: { projet: "ALF" },
    caller: "jira/tableau",
  });
  // Un appelant en mode exemple y entraîne la fonction d’un module qui n’y est pas (dépendance).
  useShell.setState({ snapshot: { functions: [connector], examples: [] } as unknown as Snapshot });
  await callFunction("jira/lister", {}, "sprint/tableau", true);
  expect(vi.mocked(invoke)).toHaveBeenCalledWith("functions.example", {
    function: "jira/lister",
    input: {},
    caller: "sprint/tableau",
  });
});

it("en données d’exemple, un script sans service est lancé avec l’indicateur", async () => {
  useShell.setState({ snapshot: { functions: [script], examples: ["outils"] } as unknown as Snapshot });
  vi.mocked(invoke).mockResolvedValue(null);
  await callFunction("outils/saluer", {}, "outils/accueil");
  expect(vi.mocked(invoke)).toHaveBeenCalledWith("functions.call", {
    function: "outils/saluer",
    input: {},
    caller: "outils/accueil",
    examples: true,
  });
});

describe("comptes de la page qui appelle", () => {
  it("vont aux fonctions de son module tels quels, et à celles d’une dépendance sous leur propre nom", async () => {
    const { accountsFor } = await import("./functionHost");
    const accounts = { jira: "acme", "atlassian/confluence": "wiki" };
    expect(accountsFor("suivi", "suivi", accounts)).toEqual({ jira: "acme", "atlassian/confluence": "wiki" });
    expect(accountsFor("atlassian", "suivi", accounts)).toEqual({ confluence: "wiki" });
    expect(accountsFor("autre", "suivi", accounts)).toEqual({});
    expect(accountsFor("suivi", "suivi", undefined)).toEqual({});
  });
});
