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
import { useNotifications } from "../../shell/notifications";
import { DictationButton } from "./DictationButton";
import { useVoice } from "./store";

let configured: boolean;
let enabled: boolean;
const status = () => ({
  configured,
  listenError: configured ? null : "Aucun modèle.",
  speakError: null,
  listening: false,
  readReplies: true,
  enabled,
  qwenInstalled: false,
});

beforeEach(() => {
  configured = true;
  enabled = true;
  useNotifications.getState().clear();
  useVoice.setState({ status: undefined, dictation: "idle", partial: "", speaking: false });
  vi.mocked(onNativeEvent).mockReturnValue(() => undefined);
  vi.mocked(invoke).mockImplementation(async (command, args = {}) => {
    if (command === "voice.status") return status();
    if (command === "voice.listen.start") return null;
    if (command === "voice.listen.stop") return { text: "  Bonjour Alfred  " };
    if (command === "voice.listen.cancel") return null;
    if (command === "voice.enabled.set") {
      enabled = Boolean((args as { enabled: boolean }).enabled);
      return status();
    }
    throw new Error(`Commande inattendue : ${command}`);
  });
});

it("sans modèle Whisper, aucun micro n’est proposé", async () => {
  configured = false;
  render(<DictationButton onTranscript={() => undefined} />);
  await waitFor(() => expect(useVoice.getState().status).toBeDefined());
  expect(screen.queryByRole("button", { name: "Dicter un message" })).not.toBeInTheDocument();
});

it("un clic ouvre le micro, un second rend la transcription nettoyée", async () => {
  const onTranscript = vi.fn();
  const user = userEvent.setup();
  render(<DictationButton onTranscript={onTranscript} />);
  await user.click(await screen.findByRole("button", { name: "Dicter un message" }));
  await user.click(await screen.findByRole("button", { name: "Terminer la dictée et envoyer" }));
  await waitFor(() => expect(onTranscript).toHaveBeenCalledWith("Bonjour Alfred"));
  expect(await screen.findByRole("button", { name: "Dicter un message" })).toBeVisible();
});

it("un micro qui ne s’ouvre pas est signalé et le bouton revient", async () => {
  vi.mocked(invoke).mockImplementation(async (command) => {
    if (command === "voice.status") return status();
    if (command === "voice.listen.start") throw new Error("Le micro est déjà utilisé par la page notes/liste.");
    throw new Error(`Commande inattendue : ${command}`);
  });
  const user = userEvent.setup();
  render(<DictationButton onTranscript={() => undefined} />);
  await user.click(await screen.findByRole("button", { name: "Dicter un message" }));
  await waitFor(() =>
    expect(useNotifications.getState().items.at(0)?.description).toBe(
      "Le micro est déjà utilisé par la page notes/liste.",
    ),
  );
  expect(screen.getByRole("button", { name: "Dicter un message" })).toBeVisible();
});

it("couper la voix retire le micro ; la réactiver le rend", async () => {
  const user = userEvent.setup();
  render(<DictationButton onTranscript={() => undefined} />);
  await user.click(await screen.findByRole("button", { name: "Couper la voix" }));
  expect(await screen.findByRole("button", { name: "Activer la voix" })).toBeVisible();
  expect(screen.queryByRole("button", { name: "Dicter un message" })).not.toBeInTheDocument();
  expect(invoke).toHaveBeenCalledWith("voice.enabled.set", { enabled: false });
  await user.click(screen.getByRole("button", { name: "Activer la voix" }));
  expect(await screen.findByRole("button", { name: "Dicter un message" })).toBeVisible();
});
