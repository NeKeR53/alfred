/**
 * Pages gardées (`src/shell/keptPages.ts`) : quitter une page puis y revenir la retrouve telle qu’on l’a laissée.
 * Son cadre n’est ni démonté ni rechargé ; il est seulement masqué.
 */
import "./support/dom";
import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { expect, it } from "vitest";
import { App } from "../src/App";
import type { ResolvedPage, Snapshot } from "../src/lib/types";
import { emptyKept, type KeptPage, keepPage } from "../src/shell/keptPages";
import { FakeBackend } from "./support/fakeBackend";
import { builtModules } from "./support/fixtures";
import { findNavigation } from "./support/shell";

type PageWindow = Window & { pageState?: { filter: string; scroll: number } };

it("une page quittée puis rouverte garde son état : même cadre, même document, rien de rechargé", async () => {
  new FakeBackend().install().withSpace("/Users/lea/Maison", "Maison", builtModules());
  const user = userEvent.setup();
  render(<App />);
  const navigation = await findNavigation();

  await user.click(await within(navigation).findByRole("row", { name: "Suivi" }));
  const frame = (await screen.findByTitle("Tâches")) as HTMLIFrameElement;
  const source = frame.src;
  // L’état local de la page vit dans son document : un filtre choisi, un défilement.
  const page = frame.contentWindow as PageWindow;
  page.pageState = { filter: "urgent", scroll: 480 };

  // Une autre section, puis la page Agent : la page Tâches est masquée, pas démontée.
  await user.click(within(navigation).getByRole("row", { name: "Notes" }));
  expect(await screen.findByTitle("Carnet")).toBeVisible();
  expect(frame).toBeInTheDocument();
  expect(frame).not.toBeVisible();
  await user.click(
    within(screen.getByRole("treegrid", { name: "Navigation du bas" })).getByRole("row", { name: "Agent" }),
  );
  expect(await screen.findByText("Que puis-je faire pour vous ?")).toBeVisible();
  expect(frame).toBeInTheDocument();

  // Retour sur Suivi : le même cadre réapparaît, avec son document et son état.
  await user.click(within(navigation).getByRole("row", { name: "Suivi" }));
  await waitFor(() => expect(screen.getByTitle("Tâches")).toBeVisible());
  expect(screen.getByTitle("Tâches")).toBe(frame);
  expect(frame.src).toBe(source);
  expect((frame.contentWindow as PageWindow).pageState).toEqual({ filter: "urgent", scroll: 480 });
  // La page Carnet, quittée à son tour, reste gardée.
  expect(screen.getByTitle("Carnet")).not.toBeVisible();
});

const pageOf = (reference: string): ResolvedPage =>
  ({ reference, module: reference.split("/")[0], id: reference.split("/")[1], title: reference }) as ResolvedPage;

function spaceWith(references: string[], path = "/Users/lea/Maison"): Snapshot {
  return {
    path,
    sections: [{ id: "s/principal", label: "S", pages: references.map(pageOf) }],
    settingsPages: [],
  } as unknown as Snapshot;
}

const visit = (snapshot: Snapshot, reference: string): KeptPage => ({
  key: reference,
  page: snapshot.sections[0]?.pages.find((page) => page.reference === reference) as ResolvedPage,
  view: null,
});

it("pages gardées : limite par récence, ordre de rendu stable, page retirée ou espace changé", () => {
  const snapshot = spaceWith(["s/a", "s/b", "s/c", "s/d"]);
  let state = emptyKept();
  for (const reference of ["s/a", "s/b", "s/c", "s/a"])
    state = keepPage(state, visit(snapshot, reference), snapshot, 3);
  // Revenir sur « a » ne la déplace pas : un cadre déplacé dans le DOM se recharge.
  expect(state.pages.map((entry) => entry.key)).toEqual(["s/a", "s/b", "s/c"]);
  // Une quatrième page : la moins récemment affichée (« b ») part, pas la première rendue.
  state = keepPage(state, visit(snapshot, "s/d"), snapshot, 3);
  expect(state.pages.map((entry) => entry.key)).toEqual(["s/a", "s/c", "s/d"]);
  // Aucune page à l’écran (Agent, Réglages) : rien ne part.
  expect(keepPage(state, null, snapshot, 3)).toBe(state);
  // Une page qui quitte l’espace est démontée.
  const smaller = spaceWith(["s/a", "s/d"]);
  expect(keepPage(state, null, smaller, 3).pages.map((entry) => entry.key)).toEqual(["s/a", "s/d"]);
  // Un autre espace : plus rien de l’ancien.
  const other = spaceWith(["s/a"], "/Users/lea/Bureau");
  expect(keepPage(state, visit(other, "s/a"), other, 3).pages).toHaveLength(1);
  // Un seul cadre par page : un autre onglet de la même page remplace le cadre gardé.
  const view = { ...visit(snapshot, "s/a"), key: "view:s/a\u0000PROJ-1" };
  expect(keepPage(state, view, snapshot, 3).pages.map((entry) => entry.key)).toEqual(["s/c", "s/d", view.key]);
});
