import { act, renderHook } from "@testing-library/react";
import { createElement } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  describeTopBarActions,
  initPageState,
  runTopBarAction,
  setFrameConfirm,
  type TopBarAction,
  usePageState,
} from "./index";
import type { FrameRequest } from "./protocol";

function Download() {
  return null;
}
Download.displayName = "Download";

const sent: FrameRequest[] = [];
const spyPost = () =>
  vi.spyOn(window.parent, "postMessage").mockImplementation((message: unknown) => {
    if ((message as FrameRequest).kind === "request") sent.push(message as FrameRequest);
  });

afterEach(() => {
  sent.length = 0;
  setFrameConfirm(null);
  vi.restoreAllMocks();
});

describe("actions de la barre du haut au format Socle", () => {
  it("décrit une Action de socle-ui : icône en élément, isDisabled, isHidden", () => {
    const actions: TopBarAction[] = [
      { id: "exporter", label: "Exporter", icon: createElement(Download, { size: 16 }), onPress: () => undefined },
      { id: "cachee", label: "Cachée", isHidden: true, onPress: () => undefined },
      { id: "vider", label: "Vider", danger: true, isDisabled: true, onPress: () => undefined },
    ];
    expect(describeTopBarActions(actions)).toEqual([
      { id: "0:Exporter", label: "Exporter", icon: "Download" },
      { id: "1:Vider", label: "Vider", danger: true, disabled: true },
    ]);
  });

  it("confirme une action danger avant d’agir, et n’agit pas si l’utilisateur annule", async () => {
    spyPost();
    const onPress = vi.fn();
    const confirm = vi.fn().mockResolvedValueOnce(false).mockResolvedValueOnce(true);
    setFrameConfirm(confirm);
    const action: TopBarAction = { label: "Vider", danger: true, confirm: { title: "Vider la corbeille ?" }, onPress };
    await runTopBarAction(action);
    expect(onPress).not.toHaveBeenCalled();
    await runTopBarAction(action);
    expect(onPress).toHaveBeenCalledOnce();
    expect(confirm).toHaveBeenCalledWith({ title: "Vider la corbeille ?", confirmLabel: "Vider", tone: "danger" });
  });

  it("notifie l’échec d’une action", async () => {
    spyPost();
    await runTopBarAction({ label: "Exporter", onPress: () => Promise.reject(new Error("Disque plein")) });
    expect(sent.at(-1)).toMatchObject({
      method: "shell.notify",
      params: { title: "« Exporter » n’a pas abouti", description: "Disque plein", tone: "error" },
    });
  });
});

describe("usePageState", () => {
  it("rend la valeur retenue par Alfred et lui envoie chaque changement", () => {
    spyPost();
    initPageState({ vue: "planning" });
    const { result } = renderHook(() => usePageState("vue", "liste"));
    expect(result.current[0]).toBe("planning");
    act(() => result.current[1]("liste"));
    expect(sent.at(-1)).toMatchObject({ method: "shell.state.set", params: { key: "vue", value: "liste" } });
  });
});
