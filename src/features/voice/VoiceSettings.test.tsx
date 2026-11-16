import { render, screen, waitFor } from "@testing-library/react";
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

import { invoke } from "../../lib/native";
import { VoiceSettings } from "./VoiceSettings";

const config = {
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
  vi.mocked(invoke).mockImplementation(async (command) => {
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
