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
  HTMLElement.prototype.showPopover ??= () => {};
  HTMLElement.prototype.hidePopover ??= () => {};
});

import { invoke, onNativeEvent } from "../../lib/native";
import { VoiceSettings } from "./VoiceSettings";

const config = {
  whisperLevel: null as string | null,
  whisperModel: "/m/ggml.bin",
  whisperServer: "whisper-server",
  language: "fr",
  voice: "",
  rate: 165,
  ttsBackend: "qwen",
  kokoroPython: null,
  kokoroModel: null,
  kokoroVoices: null,
  kokoroVoice: "ff_siwis",
  qwenPython: null,
  qwenModel: "Qwen/Qwen3-TTS-12Hz-1.7B-Base",
  qwenReference: null,
  qwenReferenceText: "Bonsoir.",
  partialIntervalMs: 700,
  readReplies: true,
  enabled: true,
};
let installed: boolean;
const GB = 1024 * 1024 * 1024;
const level = (id: string, bytes: number, summary: string) => ({
  id,
  file: `ggml-${id}.bin`,
  bytes,
  summary,
  installed: false,
  revision: null as string | null,
});
let levels: {
  levels: ReturnType<typeof level>[];
  current: string | null;
  custom: string | null;
  downloading: { level: string; received: number; total: number } | null;
  error: { level: string; message: string } | null;
};
const levelsState = () => ({
  repo: "ggerganov/whisper.cpp",
  recommended: "large-v3-turbo",
  recommendedReason: "Conseillé avec 32 Go de mémoire.",
  ...levels,
});
const saved: unknown[] = [];
/** La ligne de réglage qui porte ce titre. */
const row = (title: string) => screen.getByText(title).closest(".setting-row") as HTMLElement;
const status = () => ({
  configured: true,
  listenError: null,
  speakError: installed ? null : "Réglages vocaux invalides : la voix d'Alfred n'est pas installée.",
  listening: false,
  readReplies: true,
  enabled: true,
  qwenInstalled: installed,
});

beforeEach(() => {
  installed = false;
  saved.length = 0;
  config.whisperLevel = null;
  levels = {
    levels: [
      level("tiny", 77_691_713, "Le plus rapide, mais beaucoup de fautes : pour essayer."),
      level("small", 487_601_967, "Rapide et correct en français : pour un ordinateur modeste."),
      level("large-v3-turbo", 1.51 * GB, "Presque aussi précis que large-v3, plusieurs fois plus rapide."),
    ],
    current: null,
    custom: "/m/ggml.bin",
    downloading: null,
    error: null,
  };
  levels.levels[1] = { ...levels.levels[1], installed: true, revision: "5359861" };
  vi.mocked(invoke).mockImplementation(async (command, args = {}) => {
    if (command === "voice.whisper.levels") return levelsState();
    if (command === "voice.whisper.use") {
      levels.current = (args as { level: string }).level;
      config.whisperLevel = levels.current;
      return levelsState();
    }
    if (command === "voice.whisper.download") {
      const id = (args as { level: string }).level;
      levels.downloading = { level: id, received: 300 * 1024 * 1024, total: 1.51 * GB };
      return levelsState();
    }
    if (command === "voice.settings.set") {
      saved.push((args as { config: unknown }).config);
      return status();
    }
    if (command === "voice.settings.get") return config;
    if (command === "voice.status") return status();
    if (command === "voice.voices") return [];
    if (command === "voice.qwen.install") {
      installed = true;
      return status();
    }
    throw new Error(`Commande inattendue : ${command}`);
  });
});

it("la voix d’Alfred s’installe depuis les Réglages ; en attendant, la voix du système parle", async () => {
  const user = userEvent.setup();
  render(<VoiceSettings />);
  expect(
    await screen.findByText("La voix d’Alfred n’est pas installée : en attendant, la voix du système parle."),
  ).toBeVisible();
  expect(screen.getByRole("radio", { name: "Alfred" })).toBeChecked();
  await user.click(screen.getByRole("button", { name: "Installer" }));
  expect(await screen.findByRole("button", { name: "Réinstaller" })).toBeVisible();
  await waitFor(() => expect(screen.queryByText(/n’est pas installée : en attendant/)).not.toBeInTheDocument());
});

it("Whisper : chaque niveau dit sa taille et ce qu’il apporte ; un niveau téléchargé se choisit tout de suite", async () => {
  const user = userEvent.setup();
  render(<VoiceSettings />);
  expect(await screen.findByText("Whisper large-v3-turbo")).toBeVisible();
  expect(screen.getByText("Conseillé")).toHaveAttribute("title", "Conseillé avec 32 Go de mémoire.");
  expect(screen.getByText(/^74 Mo · Le plus rapide/)).toBeVisible();
  expect(screen.getByText(/Rapide et correct en français.*Téléchargé, version 5359861\./)).toBeVisible();
  // Le fichier indiqué à la main est celui qui sert.
  expect(screen.getByRole("textbox", { name: "Fichier du modèle Whisper" })).toHaveValue("/m/ggml.bin");
  expect(within(row("Fichier existant")).getByText("Utilisé")).toBeVisible();
  await user.click(screen.getByRole("button", { name: "Utiliser" }));
  expect(vi.mocked(invoke)).toHaveBeenCalledWith("voice.whisper.use", { level: "small" });
  await waitFor(() => expect(within(row("Whisper small")).getByText("Utilisé")).toBeVisible());
  expect(within(row("Fichier existant")).queryByText("Utilisé")).not.toBeInTheDocument();
  expect(screen.queryByRole("button", { name: "Utiliser" })).not.toBeInTheDocument();
});

it("Whisper : un niveau se télécharge par la source des modèles, avec sa progression, puis sert", async () => {
  const user = userEvent.setup();
  let changed: (() => void) | undefined;
  vi.mocked(onNativeEvent).mockImplementation((event, handler) => {
    if (event === "voice:whisper") changed = () => handler(null);
    return () => undefined;
  });
  render(<VoiceSettings />);
  await user.click(await screen.findByRole("button", { name: "Télécharger Whisper large-v3-turbo" }));
  expect(vi.mocked(invoke)).toHaveBeenCalledWith("voice.whisper.download", { level: "large-v3-turbo" });
  expect(await screen.findByText("Téléchargement : 300 Mo sur 1,5 Go.")).toBeVisible();
  // Un seul téléchargement à la fois.
  expect(screen.getByRole("button", { name: "Télécharger Whisper tiny" })).toBeDisabled();
  // Fin du téléchargement : Alfred choisit le niveau, l’interface relit les réglages.
  const reads = () => vi.mocked(invoke).mock.calls.filter(([command]) => command === "voice.settings.get").length;
  const before = reads();
  levels.downloading = null;
  levels.levels[2] = { ...levels.levels[2], installed: true, revision: "5359861" };
  levels.current = "large-v3-turbo";
  config.whisperLevel = "large-v3-turbo";
  changed?.();
  await waitFor(() => expect(within(row("Whisper large-v3-turbo")).getByText("Utilisé")).toBeVisible());
  await waitFor(() => expect(reads()).toBe(before + 1));
});

it("Whisper : une erreur de téléchargement est lisible et se réessaie", async () => {
  levels.error = { level: "tiny", message: "127.0.0.1:9 est injoignable." };
  render(<VoiceSettings />);
  expect(await screen.findByText("Le téléchargement a échoué : 127.0.0.1:9 est injoignable.")).toBeVisible();
  expect(screen.getByRole("button", { name: "Télécharger Whisper tiny" })).toHaveTextContent("Réessayer");
});

it("Whisper : un fichier ggml existant remplace le niveau", async () => {
  const user = userEvent.setup();
  config.whisperLevel = "small";
  levels.current = "small";
  render(<VoiceSettings />);
  const field = await screen.findByRole("textbox", { name: "Fichier du modèle Whisper" });
  await user.clear(field);
  await user.type(field, "/autre/ggml-medium.bin");
  await user.tab();
  await waitFor(() => expect(saved).toHaveLength(1));
  expect(saved[0]).toMatchObject({ whisperLevel: null, whisperModel: "/autre/ggml-medium.bin" });
});
