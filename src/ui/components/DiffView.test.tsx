import { fireEvent, render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it } from "vitest";
import { DiffView } from "./DiffView";
import { diffSequences, diffTexts, parsePatch } from "./diffModel";

const numbered = (count: number, change?: (index: number) => string | undefined) =>
  `${Array.from({ length: count }, (_, index) => change?.(index) ?? `ligne ${index + 1}`).join("\n")}\n`;

describe("DiffView", () => {
  it("compare deux textes côte à côte puis en ligne, surligne les mots, déplie et va d’un changement à l’autre", async () => {
    const user = userEvent.setup();
    const before = numbered(40, (index) => (index === 4 ? "const total = prix * quantite;" : undefined));
    const after = numbered(40, (index) =>
      index === 4 ? "const total = prix * quantite * taux;" : index === 30 ? "ligne trente et une" : undefined,
    );
    const { container } = render(<DiffView label="Modifications de calcul.ts" before={before} after={after} />);

    const diff = screen.getByRole("region", { name: "Modifications de calcul.ts" });
    expect(diff).toHaveAccessibleDescription(/F7/);
    expect(screen.getByText("2 changements")).toBeInTheDocument();
    expect(screen.getByRole("radio", { name: "Côte à côte" })).toHaveAttribute("aria-checked", "true");
    // Le mot ajouté est surligné, pas toute la ligne.
    expect(container.querySelector("ins")).toHaveTextContent("* taux");
    // Les lignes inchangées loin des changements sont repliées.
    expect(within(diff).queryByText("ligne 18")).not.toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Afficher 19 lignes inchangées" }));
    expect(within(diff).getAllByText("ligne 18")).toHaveLength(2);

    await user.click(screen.getByRole("radio", { name: "En ligne" }));
    expect(within(diff).getAllByText("ligne 18")).toHaveLength(1);
    expect(within(diff).getAllByText("Retirée :", { exact: false })).toHaveLength(2);

    diff.focus();
    await user.keyboard("{F7}");
    expect(screen.getByText("Changement 1 sur 2 : avant, ligne 5 ; après, ligne 5")).toBeInTheDocument();
    await user.keyboard("{Alt>}{ArrowDown}{/Alt}");
    expect(screen.getByText("Changement 2 sur 2 : avant, ligne 31 ; après, ligne 31")).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Changement précédent (Maj+F7)" }));
    expect(screen.getByText(/Changement 1 sur 2/)).toBeInTheDocument();
    expect(container.querySelectorAll(".is-current")).toHaveLength(2);
  });

  it("affiche le diff de git.diff : plusieurs fichiers, renommage, binaire, fin de fichier et CRLF", () => {
    const patch = [
      "diff --git a/src/app.ts b/src/app.ts",
      "index 1111111..2222222 100644",
      "--- a/src/app.ts",
      "+++ b/src/app.ts",
      "@@ -10,2 +10,2 @@ export function app() {",
      "   const a = 1;",
      "-  return a;",
      "+  return a + 1;",
      "\\ No newline at end of file",
      "diff --git a/docs/vieux.md b/docs/neuf.md",
      "similarity index 90%",
      "rename from docs/vieux.md",
      "rename to docs/neuf.md",
      "diff --git a/logo.png b/logo.png",
      "Binary files a/logo.png and b/logo.png differ",
      "diff --git a/notes.txt b/notes.txt",
      "--- a/notes.txt",
      "+++ b/notes.txt",
      "@@ -1 +1 @@",
      "-bonjour\r",
      "+bonjour",
      "",
    ].join("\n");
    render(<DiffView label="Modifications du dépôt" patch={patch} truncated mode="unified" />);

    const headings = screen.getAllByRole("heading", { level: 3 });
    expect(headings.map((heading) => heading.textContent)).toEqual([
      "src/app.ts+1 −1",
      "docs/vieux.md → docs/neuf.mdRenommé+0 −0",
      "logo.png",
      "notes.txt+1 −1",
    ]);
    expect(screen.getByText("9 lignes inchangées (à partir de la ligne 1)")).toBeInTheDocument();
    expect(screen.getByText("Fichier binaire : contenu non comparé")).toBeInTheDocument();
    expect(screen.getByText("sans fin de ligne")).toBeInTheDocument();
    // Seule la fin de ligne change : elle est dite des deux côtés.
    expect(screen.getByText("CRLF")).toBeInTheDocument();
    // La ligne retirée finissait par LF, l’ajoutée n’a plus de fin de ligne ; puis CRLF → LF dans notes.txt.
    expect(screen.getAllByText("LF")).toHaveLength(2);
    expect(screen.getByText("Diff coupé : la suite n’est pas affichée")).toBeInTheDocument();
  });

  it("reste fluide sur un gros fichier : seules les rangées visibles sont dessinées", () => {
    const before = numbered(60_000);
    const after = numbered(60_000, (index) => (index % 5000 === 0 ? `ligne ${index + 1} modifiée` : undefined));
    const started = performance.now();
    const { container } = render(<DiffView label="Gros fichier" before={before} after={after} mode="unified" />);
    expect(performance.now() - started).toBeLessThan(3000);
    expect(screen.getByText("12 changements")).toBeInTheDocument();
    expect(container.querySelectorAll(".ui-diff__row").length).toBeLessThan(80);

    const diff = screen.getByRole("region", { name: "Gros fichier" });
    fireEvent.keyDown(diff, { key: "F7", shiftKey: true });
    expect(screen.getByText("Changement 12 sur 12 : avant, ligne 55001 ; après, ligne 55001")).toBeInTheDocument();
    expect(
      within(diff).getByText(
        (_, element) => element?.className === "ui-diff__text" && element.textContent === "ligne 55001 modifiée",
      ),
    ).toBeInTheDocument();
  });
});

describe("diffModel", () => {
  it("rend un script d’édition qui transforme a en b, Myers comme patience", () => {
    let seed = 7;
    const random = () => {
      seed = (seed * 1103515245 + 12345) % 2147483648;
      return seed / 2147483648;
    };
    for (let round = 0; round < 200; round++) {
      const a = Array.from({ length: Math.floor(random() * 60) }, () => Math.floor(random() * 8));
      const b = a.flatMap((value) => (random() < 0.2 ? [] : random() < 0.2 ? [value, 9] : [value]));
      // maxD faible : force le découpage sur les lignes uniques.
      for (const maxD of [1000, 2]) {
        const ops = diffSequences(a, b, maxD);
        const rebuilt: number[] = [];
        let i = 0;
        let j = 0;
        for (const op of ops) {
          if (op === 0) {
            expect(a[i]).toBe(b[j]);
            rebuilt.push(a[i]);
            i++;
            j++;
          } else if (op === 1) i++;
          else rebuilt.push(b[j++]);
        }
        expect(i).toBe(a.length);
        expect(rebuilt).toEqual(b);
      }
    }
  });

  it("dit une conversion de fins de ligne une fois, et reconnaît un fichier binaire", () => {
    const converted = diffTexts("a\r\nb\r\n", "a\nb\n");
    expect(converted).toMatchObject({ added: 0, removed: 0, eolChange: { from: "crlf", to: "lf" } });
    expect(diffTexts("PNG\0\x01", "PNG\0\x02").binary).toBe(true);
    expect(parsePatch("--- a/x\n+++ b/x\n@@ -1,2 +1,2 @@\n--- titre\n+--- titre !\n fin\n")[0]).toMatchObject({
      oldPath: "x",
      newPath: "x",
      added: 1,
      removed: 1,
    });
  });
});
