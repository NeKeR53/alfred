// Les guides que lit l’agent d’Alfred (DESIGN.md, PLACEMENT.md, AGENTS.md, SDK.md) suivent la version installée de
// socle-ui : aucun ancien nom, aucun composant qui n’existe pas, et le catalogue de DESIGN.md est à jour.
import { readFileSync } from "node:fs";
import * as lucide from "lucide-react";
import * as socle from "socle-ui";
import * as socleMarkdown from "socle-ui/markdown";
import * as socleEditor from "socle-ui/markdown-editor";
import { describe, expect, it } from "vitest";
// @ts-expect-error : script Node sans déclarations de types.
import { END, readDeprecated, readExports, render, START } from "../scripts/gen-design-components.mjs";

// Vitest tourne depuis la racine du dépôt.
const read = (path: string) => readFileSync(`${process.cwd()}/${path}`, "utf8");
const ai = read("node_modules/socle-ui/ai/AI.md");
const design = read("DESIGN.md");
const guides: Record<string, string> = {
  "DESIGN.md": design.slice(0, design.indexOf(START)) + design.slice(design.indexOf(END)),
  "docs/espace/PLACEMENT.md": read("docs/espace/PLACEMENT.md"),
  "docs/espace/AGENTS.md": read("docs/espace/AGENTS.md"),
  "docs/espace/SDK.md": read("docs/espace/SDK.md"),
};

/** Noms exportés par socle-ui, types compris (lus dans ses déclarations). */
const typeNames = ["dist/index.d.ts", "dist/entries/markdown.d.ts", "dist/entries/markdown-editor.d.ts"].flatMap(
  (file) => {
    const text = read(`node_modules/socle-ui/${file}`);
    return [
      ...[...text.matchAll(/export (?:type )?\{([^}]*)\}/g)].flatMap((match) =>
        match[1].split(",").map(
          (item) =>
            item
              .trim()
              .replace(/^type /, "")
              .split(" as ")
              .pop()
              ?.trim() ?? "",
        ),
      ),
      ...[...text.matchAll(/export (?:declare )?(?:interface|type|const|function) (\w+)/g)].map((match) => match[1]),
    ];
  },
);
const socleNames = new Set([
  ...Object.keys(socle),
  ...Object.keys(socleMarkdown),
  ...Object.keys(socleEditor),
  ...typeNames,
]);
/** Ce qui n’est pas de socle-ui mais peut paraître en JSX dans un exemple : `@alfred/kit`, icônes, `Fragment`. */
const otherComponents = new Set(["Stack", "Row", "Text", "Notice", "Fragment", ...Object.keys(lucide)]);
const deprecated: [string, string][] = readDeprecated(ai);

describe("guides de l’agent et socle-ui installé", () => {
  it("le catalogue de DESIGN.md suit AI.md", () => {
    expect(render(design, ai)).toBe(design);
    const listed = readExports(ai).flatMap((row: { names: string[] }) => row.names);
    for (const name of listed) expect(design).toContain(`\`${name}\``);
  });

  it("aucun guide n’écrit un ancien nom, sauf pour dire qu’il est ancien", () => {
    expect(deprecated.length).toBeGreaterThan(5);
    const found: string[] = [];
    for (const [file, text] of Object.entries(guides)) {
      const lines = text.split("\n");
      const legacy = text.indexOf("## 15. Correspondance avec l’ancienne `@alfred/ui`");
      let offset = 0;
      lines.forEach((line, index) => {
        const inLegacyTable = file === "DESIGN.md" && legacy >= 0 && offset > legacy && line.startsWith("|");
        offset += line.length + 1;
        // La correspondance avec `@alfred/ui` cite les noms d’avant dans sa première colonne.
        const checked = inLegacyTable ? line.split("|").slice(2).join("|") : line;
        if (/ancien/i.test(checked)) return;
        for (const [old, current] of deprecated) {
          if (new RegExp(`(\`|<)${old}(?![A-Za-z])`).test(checked))
            found.push(`${file}:${index + 1} ${old} → ${current}`);
        }
      });
    }
    expect(found).toEqual([]);
  });

  it("chaque composant écrit dans un guide existe dans socle-ui", () => {
    const found: string[] = [];
    for (const [file, text] of Object.entries(guides)) {
      const local = new Set([...text.matchAll(/(?:function|const|class) ([A-Z]\w*)/g)].map((match) => match[1]));
      // Composants importés de socle-ui dans les exemples.
      for (const match of text.matchAll(/import \{([^}]*)\} from "socle-ui(?:\/markdown(?:-editor)?)?"/g)) {
        for (const item of match[1].split(",")) {
          const name = item
            .trim()
            .replace(/^type /, "")
            .split(" as ")[0]
            .trim();
          if (name && !socleNames.has(name)) found.push(`${file} : import ${name}`);
        }
      }
      // Balises JSX des exemples.
      for (const match of text.matchAll(/(?<![\w.$/])<([A-Z]\w*)(?:\.\w+)?[\s/>]/g)) {
        const name = match[1];
        if (!socleNames.has(name) && !otherComponents.has(name) && !local.has(name)) found.push(`${file} : <${name}>`);
      }
    }
    expect(found).toEqual([]);
  });
});
