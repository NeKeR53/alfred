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

import { invoke, onNativeEvent } from "../../lib/native";
import { frameServices } from "../../shell/frameBridge";
import { DictationButton } from "./DictationButton";
import { useVoice } from "./store";
import { VoiceSettings } from "./VoiceSettings";

let preferences: { dictation: boolean; readNotifications: boolean };
const spoken: string[] = [];
const status = () => ({
  configured: true,
  listenError: null,
  speakError: null,
  listening: false,
  readReplies: true,
  enabled: true,
  qwenInstalled: true,
  ...preferences,
});

beforeEach(() => {
  preferences = { dictation: true, readNotifications: false };
  spoken.length = 0;
  useVoice.setState({ status: undefined, dictation: "idle", partial: "", speaking: false });
  vi.mocked(onNativeEvent).mockReturnValue(() => undefined);
  vi.mocked(invoke).mockImplementation(async (command, args = {}) => {
    if (command === "voice.status") return status();
    if (command === "voice.settings.get") return { ...status(), language: "fr", ttsBackend: "qwen", voice: "" };
    if (command === "voice.voices") return [];
    if (command === "voice.preferences.set") {
      preferences = { ...preferences, ...(args as Partial<typeof preferences>) };
      return status();
    }
    if (command === "voice.speak") {
      spoken.push(String((args as { text: string }).text));
      return { interrupted: false };
    }
    throw new Error(`Commande inattendue : ${command}`);
  });
});

it("bloquer la dictée retire le micro, sans couper la voix", async () => {
  const user = userEvent.setup();
  render(
    <>
      <VoiceSettings />
      <DictationButton onTranscript={() => undefined} />
    </>,
  );
  expect(await screen.findByRole("button", { name: "Dicter un message" })).toBeVisible();
  await user.click(await screen.findByRole("switch", { name: "Autoriser la dictée" }));
  expect(invoke).toHaveBeenCalledWith("voice.preferences.set", { dictation: false });
  await waitFor(() => expect(screen.queryByRole("button", { name: "Dicter un message" })).not.toBeInTheDocument());
  expect(screen.getByRole("button", { name: "Couper la voix" })).toBeVisible();
  expect(screen.getByText("La dictée est bloquée : aucun micro ne s’ouvre.")).toBeVisible();
});

it("les notifications ne sont lues que si l’utilisateur l’a permis", async () => {
  await frameServices.announce?.("Essai. Bonjour");
  await new Promise((resolve) => setTimeout(resolve, 0));
  expect(spoken).toEqual([]);

  const user = userEvent.setup();
  render(<VoiceSettings />);
  await user.click(await screen.findByRole("switch", { name: "Lire les notifications à voix haute" }));
  expect(invoke).toHaveBeenCalledWith("voice.preferences.set", { readNotifications: true });
  await useVoice.getState().announce("Essai. Bonjour");
  expect(spoken).toEqual(["Essai. Bonjour"]);

  // Pendant une autre lecture, la notification n’est pas lue.
  useVoice.setState({ speaking: true });
  await useVoice.getState().announce("Autre");
  expect(spoken).toEqual(["Essai. Bonjour"]);
});
