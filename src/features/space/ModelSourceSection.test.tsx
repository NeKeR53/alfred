import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, expect, it, vi } from "vitest";

vi.mock("../../lib/native");
vi.mock("../../shell/notifications", () => ({ notify: vi.fn() }));
vi.hoisted(() => {
  window.matchMedia ??= ((query: string) => ({
    matches: false,
    media: query,
    addEventListener: () => {},
    removeEventListener: () => {},
  })) as unknown as typeof window.matchMedia;
  HTMLDialogElement.prototype.showModal ??= function (this: HTMLDialogElement) {
    this.setAttribute("open", "");
  };
  HTMLDialogElement.prototype.close ??= function (this: HTMLDialogElement) {
    this.removeAttribute("open");
    this.dispatchEvent(new Event("close"));
  };
});

import { invoke } from "../../lib/native";
import { type ModelSource, ModelSourceSection } from "./ModelSourceSection";

const ARTIFACTORY = "https://jfrog.exemple.fr/artifactory/api/huggingfaceml/hf-remote";
let source: ModelSource;
let saved: unknown;

beforeEach(() => {
  saved = undefined;
  source = {
    endpoint: "https://huggingface.co",
    host: "huggingface.co",
    origin: "default",
    custom: null,
    hasToken: false,
    envEndpoint: false,
    envToken: false,
    loginToken: false,
    cacheDir: "/Users/moi/.cache/huggingface/hub",
  };
  vi.mocked(invoke).mockImplementation(async (command, args) => {
    if (command === "models.source") return source;
    if (command === "models.setSource") {
      saved = args;
      const { endpoint, token } = args as { endpoint: string | null; token?: string | null };
      source = {
        ...source,
        endpoint: endpoint ?? "https://huggingface.co",
        host: endpoint ? "jfrog.exemple.fr" : "huggingface.co",
        origin: endpoint ? "setting" : "default",
        custom: endpoint,
        hasToken: typeof token === "string" || (token === undefined && source.hasToken),
      };
      return source;
    }
    throw new Error(`Commande inattendue : ${command}`);
  });
});

it("dit la source utilisée et où sont rangés les modèles", async () => {
  render(<ModelSourceSection />);
  expect(await screen.findByText(/Hugging Face \(huggingface\.co\)\. Les modèles sont rangés/)).toBeInTheDocument();
  expect(screen.getByText(/\/Users\/moi\/\.cache\/huggingface\/hub/)).toBeInTheDocument();
});

it("nomme la variable HF_ENDPOINT quand elle décide", async () => {
  source = { ...source, origin: "env", host: "miroir.exemple.fr", envEndpoint: true };
  render(<ModelSourceSection />);
  expect(await screen.findByText(/miroir\.exemple\.fr, d’après la variable HF_ENDPOINT/)).toBeInTheDocument();
});

it("enregistre l’adresse d’un Artifactory et son jeton", async () => {
  const user = userEvent.setup();
  render(<ModelSourceSection />);
  await user.click(await screen.findByRole("button", { name: "Modifier…" }));
  await user.selectOptions(screen.getByRole("combobox", { name: "Source" }), "custom");
  await user.type(screen.getByRole("textbox", { name: "Adresse" }), ARTIFACTORY);
  await user.type(screen.getByLabelText("Jeton (facultatif)"), "jeton-secret");
  await user.click(screen.getByRole("button", { name: "Enregistrer" }));
  expect(saved).toEqual({ endpoint: ARTIFACTORY, token: "jeton-secret" });
  await waitFor(() =>
    expect(screen.getByText(/jfrog\.exemple\.fr, l’adresse réglée ici, avec son jeton\./)).toBeInTheDocument(),
  );
  expect(screen.queryByText(/jeton-secret/)).not.toBeInTheDocument();
});

it("garde le jeton tant que l’adresse ne change pas, et revient à Hugging Face", async () => {
  source = {
    ...source,
    origin: "setting",
    custom: ARTIFACTORY,
    endpoint: ARTIFACTORY,
    host: "jfrog.exemple.fr",
    hasToken: true,
  };
  const user = userEvent.setup();
  render(<ModelSourceSection />);
  await user.click(await screen.findByRole("button", { name: "Modifier…" }));
  expect(screen.getByText("Laisser vide pour conserver le jeton enregistré.")).toBeInTheDocument();
  await user.click(screen.getByRole("button", { name: "Enregistrer" }));
  expect(saved).toEqual({ endpoint: ARTIFACTORY });

  await user.click(await screen.findByRole("button", { name: "Modifier…" }));
  await user.selectOptions(screen.getByRole("combobox", { name: "Source" }), "huggingface");
  await user.click(screen.getByRole("button", { name: "Enregistrer" }));
  expect(saved).toEqual({ endpoint: null, token: null });
});

it("refuse une adresse qui n’en est pas une", async () => {
  const user = userEvent.setup();
  render(<ModelSourceSection />);
  await user.click(await screen.findByRole("button", { name: "Modifier…" }));
  await user.selectOptions(screen.getByRole("combobox", { name: "Source" }), "custom");
  await user.type(screen.getByRole("textbox", { name: "Adresse" }), "jfrog.exemple.fr");
  await user.click(screen.getByRole("button", { name: "Enregistrer" }));
  expect(screen.getByText(/Saisissez l’adresse du miroir/)).toBeInTheDocument();
  expect(saved).toBeUndefined();
});
