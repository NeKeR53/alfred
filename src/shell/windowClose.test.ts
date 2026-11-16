import { describe, expect, it, vi } from "vitest";
import { type ClosableWindow, registerMainWindowClose } from "./windowClose";

function fakeWindow() {
  let handler: Parameters<ClosableWindow["onCloseRequested"]>[0] = () => undefined;
  const window: ClosableWindow = {
    onCloseRequested: async (next) => {
      handler = next;
      return () => undefined;
    },
    destroy: vi.fn(async () => undefined),
  };
  const preventDefault = vi.fn();
  return { window, close: () => handler({ preventDefault }), preventDefault };
}

describe("fermeture de la fenêtre principale", () => {
  it("enregistre, arrête les agents puis ferme", async () => {
    const { window, close, preventDefault } = fakeWindow();
    const order: string[] = [];
    await registerMainWindowClose(window, {
      save: async () => void order.push("save"),
      stopSessions: async () => void order.push("stop"),
      confirmUnsaved: async () => true,
    });
    await close();
    expect(preventDefault).toHaveBeenCalled();
    expect(order).toEqual(["save", "stop"]);
    expect(window.destroy).toHaveBeenCalledTimes(1);
  });

  it("demande avant de fermer quand l’enregistrement échoue, et reste si l’utilisateur le veut", async () => {
    const { window, close } = fakeWindow();
    const confirmUnsaved = vi.fn(async () => false);
    const stopSessions = vi.fn(async () => undefined);
    await registerMainWindowClose(window, {
      save: async () => {
        throw new Error("disque plein");
      },
      stopSessions,
      confirmUnsaved,
    });
    await close();
    expect(confirmUnsaved).toHaveBeenCalledWith("disque plein");
    expect(stopSessions).not.toHaveBeenCalled();
    expect(window.destroy).not.toHaveBeenCalled();

    confirmUnsaved.mockResolvedValueOnce(true);
    await close();
    expect(window.destroy).toHaveBeenCalledTimes(1);
  });

  it("ferme quand même si la boîte de dialogue est indisponible", async () => {
    const { window, close } = fakeWindow();
    await registerMainWindowClose(window, {
      save: async () => {
        throw new Error("x");
      },
      stopSessions: async () => undefined,
      confirmUnsaved: async () => {
        throw new Error("pas de dialogue");
      },
    });
    await close();
    expect(window.destroy).toHaveBeenCalledTimes(1);
  });

  it("ne retient pas la fenêtre plus de 8 s sur un enregistrement qui ne répond pas", async () => {
    vi.useFakeTimers();
    try {
      const { window, close } = fakeWindow();
      const confirmUnsaved = vi.fn(async () => true);
      await registerMainWindowClose(window, {
        save: () => new Promise(() => undefined),
        stopSessions: () => new Promise(() => undefined),
        confirmUnsaved,
      });
      const closing = close();
      await vi.advanceTimersByTimeAsync(8_000);
      expect(confirmUnsaved).toHaveBeenCalledWith("l’enregistrement ne répond pas.");
      await vi.advanceTimersByTimeAsync(4_000);
      await closing;
      expect(window.destroy).toHaveBeenCalledTimes(1);
    } finally {
      vi.useRealTimers();
    }
  });
});
