import { screen, waitFor } from "@testing-library/react";

/** L’arbre de la navigation principale (Sidebar de Socle) : une ligne (`row`) par section ou entrée. */
export async function findNavigation(): Promise<HTMLElement> {
  let tree: HTMLElement | undefined;
  await waitFor(() => {
    tree = screen.getAllByRole("treegrid", { name: "Navigation principale" })[0];
  });
  return tree as HTMLElement;
}

export function getNavigation(): HTMLElement {
  return screen.getAllByRole("treegrid", { name: "Navigation principale" })[0];
}
