import { act, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { Download, Trash2 } from "lucide-react";
import { beforeAll, describe, expect, it, vi } from "vitest";
import { Page } from "../components/page";
import { installDialogPolyfill } from "../dialog.test-helper";
import { type FrameServices, FrameServicesContext } from "./services";

const noop = () => undefined;
beforeAll(() => installDialogPolyfill());

function frame(topBarActions?: FrameServices["topBarActions"]): FrameServices {
  return {
    notify: vi.fn(),
    publish: noop,
    setPanelVisible: noop,
    openExternal: noop,
    send: noop,
    onPeer: () => noop,
    onSelection: () => noop,
    ...(topBarActions ? { topBarActions } : {}),
  };
}

describe("actions de page dans la barre du haut", () => {
  it("ne passent que leur description à la coquille, et un clic revient à la page, confirmé s’il est danger", async () => {
    const user = userEvent.setup();
    let activate: (id: string) => void = noop;
    const declared = vi.fn();
    const declare = vi.fn((descriptors: unknown, onActivate: (id: string) => void) => {
      declared(descriptors);
      activate = onActivate;
      return { update: declared, dispose: noop };
    });
    const exporter = vi.fn();
    const vider = vi.fn();
    render(
      <FrameServicesContext.Provider value={frame(declare)}>
        <Page
          actions={[
            { label: "Exporter", icon: Download, onClick: exporter },
            { label: "Vider", icon: Trash2, danger: true, confirm: "Vider la liste ?", onClick: vider },
          ]}
        >
          <p>Contenu</p>
        </Page>
      </FrameServicesContext.Provider>,
    );
    await waitFor(() => expect(declare).toHaveBeenCalledOnce());
    expect(declared).toHaveBeenCalledWith([
      { id: "0:Exporter", label: "Exporter", icon: "Download" },
      { id: "1:Vider", label: "Vider", icon: "Trash2", danger: true },
    ]);
    // La page ne dessine plus sa barre d’actions.
    expect(screen.queryByRole("button", { name: "Exporter" })).toBeNull();
    act(() => activate("0:Exporter"));
    await waitFor(() => expect(exporter).toHaveBeenCalledOnce());
    act(() => activate("1:Vider"));
    expect(vider).not.toHaveBeenCalled();
    await user.click(await screen.findByRole("button", { name: "Vider" }));
    await waitFor(() => expect(vider).toHaveBeenCalledOnce());
  });

  it("restent dans la barre de la page hors d’un cadre de page (panneau, capture, tests)", () => {
    render(
      <FrameServicesContext.Provider value={frame()}>
        <Page actions={[{ label: "Exporter", icon: Download, onClick: noop }]}>
          <p>Contenu</p>
        </Page>
      </FrameServicesContext.Provider>,
    );
    expect(screen.getByRole("button", { name: "Exporter" })).toBeInTheDocument();
  });
});
