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
import { findNavigation, getNavigation } from "./support/shell";

it("une page range ses entrées dans le menu, les ouvre et reçoit leurs actions", async () => {
  const backend = new FakeBackend().install().withSpace("/Users/lea/Maison", "Maison", builtModules());
  backend.menuZones = {
    "notes/carnet": { title: "Carnets", order: "page", entries: [{ id: "perso", label: "Personnel", status: "ok" }] },
  };
  const user = userEvent.setup();
  render(<App />);
  const navigation = await findNavigation();

  // Gardée du lancement précédent : la zone de Notes s’affiche avant que la page ne soit chargée.
  const notes = await within(navigation).findByRole("row", { name: "Notes" });
  await waitFor(() => expect(notes).toHaveAttribute("aria-expanded", "false"));
  await user.click(within(notes).getByRole("button", { name: /^Déplier/ }));
  expect(await within(navigation).findByRole("row", { name: "Personnel" })).toBeInTheDocument();

  await user.click(within(navigation).getByRole("row", { name: "Suivi" }));
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
  // Les entrées vont en sous-pages de la section Suivi ; un compteur suit l’entrée.
  const suiviRow = within(navigation).getByRole("row", { name: "Suivi" });
  await waitFor(() => expect(suiviRow).toHaveAttribute("aria-expanded"));
  if (suiviRow.getAttribute("aria-expanded") !== "true")
    await user.click(within(suiviRow).getByRole("button", { name: /^Déplier/ }));
  expect(await within(navigation).findByRole("row", { name: "Boréa" })).toHaveTextContent("2");
  await send("r3", "menu.update", { op: "updateEntry", id: "borea", patch: { status: "ok", badge: null } });
  await waitFor(() => expect(within(navigation).getByRole("row", { name: "Boréa" })).not.toHaveTextContent("2"));

  // Clic : la page affichée reçoit l’entrée dans son contexte, et l’entrée est surlignée à la place de la section.
  await user.click(within(navigation).getByRole("row", { name: "Atlas" }));
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
  expect(within(navigation).getByRole("row", { name: "Atlas" })).toHaveAttribute("aria-selected", "true");
  expect(within(navigation).getByRole("row", { name: "Suivi" })).toHaveAttribute("aria-selected", "false");

  // Action au survol : la page est prévenue, puis lit l’action en attente.
  await user.click(
    within(within(navigation).getByRole("row", { name: "Atlas" })).getByRole("button", { name: "Archiver Atlas" }),
  );
  await waitFor(() => expect(received.some((message) => message.name === "menuEntryAction")).toBe(true));
  await send("r4", "menu.takeActions");
  await waitFor(() =>
    expect(received.find((message) => message.id === "r4")?.result).toEqual([{ entry: "atlas", action: "archive" }]),
  );

  // L’entrée de la section rouvre la page sans entrée.
  await user.click(within(navigation).getByRole("row", { name: "Suivi" }));
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
