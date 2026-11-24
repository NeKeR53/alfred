// Génère le catalogue des composants de DESIGN.md (section 8) depuis la doc livrée avec socle-ui
// (node_modules/socle-ui/ai/AI.md) : noms actuels, rôle, spec à lire, anciens noms. La part écrite à la main
// (quand utiliser quoi) reste hors des marqueurs.
//
//   node scripts/gen-design-components.mjs          réécrit le catalogue
//   node scripts/gen-design-components.mjs --check  échoue si DESIGN.md n’est pas à jour
import { readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

export const START = "<!-- socle-ui:catalogue:début";
export const END = "<!-- socle-ui:catalogue:fin -->";

/** Ce que la coquille d’Alfred ou l’hôte du cadre rendent : une page ne le rend jamais. */
const SHELL = new Set([
  "SocleProvider",
  "AppShell",
  "Sidebar",
  "Tabs",
  "NotificationCenter",
  "SettingsPage",
  "LoginPage",
]);

function section(text, title) {
  const start = text.indexOf(`\n## ${title}`);
  if (start < 0) throw new Error(`AI.md : section « ${title} » introuvable`);
  const end = text.indexOf("\n## ", start + 4);
  return text.slice(start, end < 0 ? undefined : end);
}

/** Lignes du tableau « Exports » : noms, type, rôle, spec. */
export function readExports(ai) {
  return section(ai, "Exports")
    .split("\n")
    .filter((line) => line.startsWith("| `"))
    .map((line) => {
      const cells = line
        .slice(1, -1)
        .split(/(?<!\\)\|/)
        .map((cell) => cell.trim());
      const [names, kind, role, spec] = cells;
      const specFile = /\(specs\/([^)]+)\)/.exec(spec ?? "")?.[1];
      return {
        names: [...names.matchAll(/`([^`]+)`/g)].map((match) => match[1]),
        kind,
        role,
        spec: specFile ? `docs/alfred/socle/specs/${specFile}` : null,
      };
    });
}

/** Anciens noms : [ancien, nouveau]. */
export function readDeprecated(ai) {
  return [...section(ai, "Anciens noms").matchAll(/^- `(\w+)` → `(\w+)`/gm)].map((match) => [match[1], match[2]]);
}

export function readVersion(ai) {
  return /^# socle-ui (\S+)/.exec(ai)?.[1] ?? "?";
}

export function catalogue(ai) {
  const rows = readExports(ai);
  const version = readVersion(ai);
  const usable = rows.filter((row) => !row.names.some((name) => SHELL.has(name)));
  const shell = rows.filter((row) => row.names.some((name) => SHELL.has(name)));
  const lines = [
    `${START} : généré par scripts/gen-design-components.mjs depuis node_modules/socle-ui/ai/AI.md ; ne pas modifier à la main -->`,
    "",
    `### Catalogue de socle-ui ${version}`,
    "",
    "Tous les composants, motifs et gabarits de la version installée, avec leur rôle. Avant d’employer l’un d’eux, lire sa spec : ses options, ce qu’il exclut, son contenu.",
    "",
    "| Composant | Type | Rôle | Spec à lire |",
    "|---|---|---|---|",
    ...usable.map(
      (row) =>
        `| ${row.names.map((name) => `\`${name}\``).join(", ")} | ${row.kind} | ${row.role} | ${row.spec ? `\`${row.spec}\`` : "—"} |`,
    ),
    "",
    `Réservés à la coquille d’Alfred ou à l’hôte du cadre, jamais rendus par une page : ${shell
      .flatMap((row) => row.names)
      .map((name) => `\`${name}\``)
      .join(", ")}.`,
    "",
    "Anciens noms : ils marchent encore, mais `check` avertit et ils disparaîtront en socle-ui 2.0.0 (D-336). Écrire le nom actuel.",
    "",
    "| Ancien nom | Nom actuel |",
    "|---|---|",
    ...readDeprecated(ai).map(([old, current]) => `| \`${old}\` | \`${current}\` |`),
    "",
    END,
  ];
  return lines.join("\n");
}

export function render(design, ai) {
  const start = design.indexOf(START);
  const end = design.indexOf(END);
  if (start < 0 || end < start) throw new Error("DESIGN.md : marqueurs du catalogue introuvables");
  return design.slice(0, start) + catalogue(ai) + design.slice(end + END.length);
}

if (import.meta.url.startsWith("file:") && process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  const root = fileURLToPath(new URL("..", import.meta.url));
  const designPath = `${root}DESIGN.md`;
  const aiPath = `${root}node_modules/socle-ui/ai/AI.md`;
  const design = readFileSync(designPath, "utf8");
  const next = render(design, readFileSync(aiPath, "utf8"));
  if (process.argv.includes("--check")) {
    if (next !== design) {
      console.error(
        "DESIGN.md n’est pas à jour avec socle-ui installé : lancer `node scripts/gen-design-components.mjs`.",
      );
      process.exit(1);
    }
  } else if (next !== design) {
    writeFileSync(designPath, next);
    console.log("DESIGN.md : catalogue de socle-ui régénéré.");
  }
}
