/**
 * Zone du menu d’une page (`menu.*` du SDK) : la page publie ses entrées par le pont des cadres, elles s’affichent
 * sous l’entrée de sa section ; un clic ouvre la page avec l’entrée (contexte poussé au cadre), et une action
 * choisie au survol est remise à la page. Une zone gardée d’un lancement précédent s’affiche dès l’ouverture.
 */
import "./support/dom";
import { act, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { expect, it } from "vitest";
import { App } from "../src/App";
import { ALFRED_MESSAGE } from "../src/sdk/protocol";
import { FakeBackend } from "./support/fakeBackend";
import { builtModules } from "./support/fixtures";

it("une page range ses entrées dans le menu, les ouvre et reçoit leurs actions", async () => {
  const backend = new FakeBackend().install().withSpace("/Users/lea/Maison", "Maison", builtModules());
  backend.menuZones = {
    "notes/carnet": { title: "Carnets", order: "page", entries: [{ id: "perso", label: "Personnel", status: "ok" }] },
  };
  const user = userEvent.setup();
  render(<App />);
  const navigation = await screen.findByRole("navigation", { name: "Sections de l’espace de travail" });

  // Gardée du lancement précédent : la zone de Notes s’affiche avant que la page ne soit chargée.
  const carnets = await within(navigation).findByRole("list", { name: "Carnets · Notes" });
  expect(within(carnets).getByRole("button", { name: "Personnel · Bon" })).toBeVisible();

  await user.click(within(navigation).getByRole("button", { name: "Suivi" }));
  const frame = (await screen.findByTitle("Tâches")) as HTMLIFrameElement;
  const received: Array<{ name?: string; payload?: unknown; result?: unknown; id?: string }> = [];
  const original = frame.contentWindow?.postMessage.bind(frame.contentWindow);
  if (frame.contentWindow)
    frame.contentWindow.postMessage = ((message: never) => {
      received.push(message);
      original?.(message, "*");
    }) as typeof window.postMessage;
  const send = (id: string, method: string, params: Record<string, unknown> = {}) =>
    act(() => {
      window.dispatchEvent(
        new MessageEvent("message", {
          data: { alfred: ALFRED_MESSAGE, kind: "request", id, method, params },
          source: frame.contentWindow,
        }),
      );
    });

  await send("r1", "menu.update", { op: "setZone", title: "Projets", visible: 1 });
  await send("r2", "menu.update", {
    op: "setEntries",
    entries: [
      {
        id: "atlas",
        label: "Atlas",
        status: "running",
        actions: [{ id: "archive", label: "Archiver", icon: "archive" }],
      },
      { id: "borea", label: "Boréa", status: "error", badge: 2 },
    ],
  });
  expect(backend.lastCall("frame.menuZones.update")).toMatchObject({
    subject: { kind: "page", module: "suivi", reference: "suivi/taches" },
    page: "suivi/taches",
  });
  const projets = await within(navigation).findByRole("list", { name: "Projets · Suivi" });
  expect(within(projets).getByRole("button", { name: "Afficher plus (1)" })).toBeVisible();
  await user.click(within(projets).getByRole("button", { name: "Afficher plus (1)" }));
  await send("r3", "menu.update", { op: "updateEntry", id: "borea", patch: { status: "ok", badge: null } });
  expect(await within(projets).findByRole("button", { name: "Boréa · Bon" })).toBeVisible();

  // Clic : la page affichée reçoit l’entrée dans son contexte, et l’entrée est surlignée à la place de la section.
  await user.click(within(projets).getByRole("button", { name: "Atlas · Au travail" }));
  await waitFor(() =>
    expect(
      received.some(
        (message) => message.name === "context" && (message.payload as { entry?: unknown })?.entry !== null,
      ),
    ).toBe(true),
  );
  const context = received.filter((message) => message.name === "context").at(-1)?.payload as {
    entry: { id: string; label: string };
  };
  expect(context.entry).toEqual({ id: "atlas", label: "Atlas" });
  expect(within(projets).getByRole("button", { name: "Atlas · Au travail" })).toHaveAttribute("aria-current", "page");
  expect(within(navigation).getByRole("button", { name: "Suivi" })).not.toHaveAttribute("aria-current");

  // Action au survol : la page est prévenue, puis lit l’action en attente.
  await user.click(within(projets).getByRole("button", { name: "Archiver Atlas" }));
  await waitFor(() => expect(received.some((message) => message.name === "menuEntryAction")).toBe(true));
  await send("r4", "menu.takeActions");
  await waitFor(() =>
    expect(received.find((message) => message.id === "r4")?.result).toEqual([{ entry: "atlas", action: "archive" }]),
  );

  // L’entrée de la section rouvre la page sans entrée.
  await user.click(within(navigation).getByRole("button", { name: "Suivi" }));
  const lastEntry = () =>
    (received.filter((message) => message.name === "context").at(-1)?.payload as { entry?: unknown } | undefined)
      ?.entry;
  await waitFor(() => expect(lastEntry()).toBe(null));

  // Une page ne règle pas la zone d’un autre module.
  await send("r5", "menu.update", { op: "clear", page: "notes/carnet" });
  await waitFor(() => expect(received.find((message) => message.id === "r5")).toBeDefined());
  expect(backend.menuZones["notes/carnet"]).toBeDefined();
  // Les commandes d’autres chantiers en cours (agents, canaux) ne sont pas encore toutes dans le faux backend.
  expect(backend.unknown.filter((command) => /menuZones|badges/.test(command))).toEqual([]);
});
