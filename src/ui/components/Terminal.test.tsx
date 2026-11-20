import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Terminal, type TerminalChannel } from "./Terminal";
import { terminalKeyAction } from "./terminalEngine";

// jsdom ne mesure pas les caractères : l’ajustement à la taille du conteneur est simulé (10 × 20 px par cellule).
vi.mock("@xterm/addon-fit", () => ({
  FitAddon: class {
    private terminal?: { element?: HTMLElement; resize(cols: number, rows: number): void };
    activate(terminal: { element?: HTMLElement; resize(cols: number, rows: number): void }) {
      this.terminal = terminal;
    }
    fit() {
      const host = this.terminal?.element?.parentElement;
      if (!host) return;
      this.terminal?.resize(Math.floor(host.clientWidth / 10), Math.floor(host.clientHeight / 20));
    }
    dispose() {}
  },
}));

let observers: (() => void)[] = [];
let hostSize = { width: 800, height: 480 };

beforeEach(() => {
  observers = [];
  hostSize = { width: 800, height: 480 };
  vi.stubGlobal(
    "matchMedia",
    (media: string) =>
      ({
        matches: false,
        media,
        addEventListener() {},
        removeEventListener() {},
        addListener() {},
        removeListener() {},
      }) as unknown as MediaQueryList,
  );
  vi.stubGlobal(
    "ResizeObserver",
    class {
      constructor(private readonly callback: () => void) {}
      observe() {
        observers.push(this.callback);
      }
      disconnect() {}
    },
  );
  vi.stubGlobal("requestAnimationFrame", (callback: FrameRequestCallback) => setTimeout(() => callback(0), 0));
  vi.spyOn(HTMLCanvasElement.prototype, "getContext").mockReturnValue(null);
  for (const [property, key] of [
    ["clientWidth", "width"],
    ["clientHeight", "height"],
  ] as const) {
    Object.defineProperty(HTMLElement.prototype, property, {
      configurable: true,
      get(this: HTMLElement) {
        return this.classList.contains("ui-terminal__screen") ? hostSize[key] : 0;
      },
    });
  }
});

afterEach(() => {
  vi.unstubAllGlobals();
  for (const property of ["clientWidth", "clientHeight"] as const)
    delete (HTMLElement.prototype as Partial<Record<typeof property, number>>)[property];
});

function connection() {
  const send = vi.fn();
  let output: ((data: string | Uint8Array) => void) | undefined;
  return {
    send,
    write: (data: string) => output?.(data),
    value: {
      send,
      subscribe: (write: (data: string | Uint8Array) => void) => {
        output = write;
        return () => {
          output = undefined;
        };
      },
    },
  };
}

describe("Terminal", () => {
  it("envoie la saisie et le collage au service, et lui dit sa taille quand il change", async () => {
    const service = connection();
    const onResize = vi.fn();
    const { container } = render(
      <Terminal label="Console du conteneur web" connection={service.value} onResize={onResize} />,
    );
    await screen.findByText("Connecté");
    const input = screen.getByRole("textbox", { name: "Console du conteneur web" });
    expect(input).toHaveAttribute("aria-description", expect.stringContaining("F6 pour en sortir"));

    // Taille d’ouverture, ajustée au conteneur (800 × 480 px) et affichée dans la barre d’état.
    await waitFor(() => expect(onResize).toHaveBeenCalledWith({ cols: 80, rows: 24 }));
    expect(screen.getByText("80 × 24")).toBeInTheDocument();

    service.write("\u001b[32mprêt\u001b[0m\r\n$ ");
    await userEvent.type(input, "ls");
    await userEvent.keyboard("{Enter}");
    expect(service.send.mock.calls.map(([data]) => data).join("")).toBe("ls\r");

    fireEvent.paste(input, { clipboardData: { getData: () => "echo collé" } });
    expect(service.send).toHaveBeenLastCalledWith("echo collé");

    // La fenêtre s’élargit : une seule taille part au service, une fois le glissement fini.
    onResize.mockClear();
    vi.useFakeTimers();
    hostSize = { width: 1000, height: 600 };
    act(() => {
      for (const observer of observers) observer();
      vi.advanceTimersByTime(10);
    });
    hostSize = { width: 1200, height: 640 };
    act(() => {
      for (const observer of observers) observer();
      vi.advanceTimersByTime(10);
    });
    expect(onResize).not.toHaveBeenCalled();
    act(() => vi.advanceTimersByTime(200));
    vi.useRealTimers();
    expect(onResize).toHaveBeenCalledTimes(1);
    expect(onResize).toHaveBeenCalledWith({ cols: 120, rows: 32 });
    expect(container.querySelector(".ui-terminal__size")).toHaveTextContent("120 × 32");
  });

  it("lit et écrit un canal WebSocket, et dit quand la session se termine", async () => {
    const write = vi.fn(() => Promise.resolve());
    const channel: TerminalChannel = {
      events: [{ seq: 1, type: "data", data: btoa("bienvenue\r\n"), base64: true }],
      write,
    };
    const { rerender } = render(<Terminal label="Console" channel={channel} />);
    await screen.findByText("Connecté");
    await userEvent.type(screen.getByRole("textbox", { name: "Console" }), "q");
    expect(write).toHaveBeenCalledWith("q");

    rerender(<Terminal label="Console" channel={{ ...channel, closed: true, reason: "code 0" }} />);
    expect(screen.getByRole("status")).toHaveTextContent("Session terminée : code 0");
    await userEvent.type(screen.getByRole("textbox", { name: "Console" }), "x");
    expect(write).toHaveBeenCalledTimes(1);
  });

  it("copie avec Ctrl+C seulement s’il y a une sélection, colle avec Ctrl+V, sort avec F6", () => {
    const key = (init: Partial<KeyboardEvent>) =>
      ({
        type: "keydown",
        key: "c",
        ctrlKey: false,
        shiftKey: false,
        altKey: false,
        metaKey: false,
        ...init,
      }) as KeyboardEvent;
    expect(terminalKeyAction(key({ ctrlKey: true }), false)).toBe("terminal");
    expect(terminalKeyAction(key({ ctrlKey: true }), true)).toBe("copy");
    expect(terminalKeyAction(key({ ctrlKey: true, shiftKey: true }), false)).toBe("copy");
    expect(terminalKeyAction(key({ ctrlKey: true, key: "v" }), false)).toBe("paste");
    expect(terminalKeyAction(key({ key: "F6" }), false)).toBe("leave-forward");
    expect(terminalKeyAction(key({ key: "F6", shiftKey: true }), false)).toBe("leave-backward");
    expect(terminalKeyAction(key({ metaKey: true }), true)).toBe("terminal");
  });
});
