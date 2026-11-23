# Transition — `@alfred/ui` (depuis le 2026-11-23)

`alfred-ui/` est la copie de `src/ui/` au commit `eae37fa`, servie aux cadres des pages de modules par la carte
d'imports (`src-tauri/src/pages.rs`, entrée `ui` de `vite.runtime.config.ts`). La coquille ne l'importe pas.

- Les feuilles de style sont injectées seulement dans le cadre d'une page qui importe `@alfred/ui` (`index.ts`).
- Les services des anciens gabarits passent par `@alfred/sdk` (`templates/frameServices.ts`).
- Biome (`biome.json`, dernier `overrides`) et `socle-check-css` (`package.json`) excluent ce dossier.
- Le transpileur accepte l'import ; l'outil `check` le signale « à migrer vers socle-ui ».

À supprimer, avec ces exceptions, quand les pages des espaces sont passées à socle-ui.
