# Audit design — Alfred — 2026-11-23 (après la migration)

Version installée : socle-ui 0.3.0 (yalc) — dernière : 0.3.0 (tag `v0.3.0` du dépôt `../app-design/design-system`).

Périmètre : tout (tokens, composants, pages, comportements, garde-fous, pages de l'agent).

L'audit précédent (même jour, avant la migration) comptait 14 écarts, dont 6 bloquants. Les corrections suivent la section « Après les propositions » de [socle-propositions.md](socle-propositions.md).

## Synthèse

Alfred est entièrement sur socle-ui. `@alfred/ui` (`src/ui/`, 130 exports) est supprimé. 94 fichiers importent `socle-ui`, aucun n'importe `@alfred/ui`. Restent 3 écarts mineurs, tous assumés et notés dans « Manques vus pendant la migration ».

| Contrôle | Résultat |
|---|---|
| `biome check` avec `socle-ui/biome` (imports, `style`/`className` sur un composant Socle, couleurs en dur) | vert, sans exception de transition |
| `socle-check-css` sur tout le CSS de l'app | aucune couleur en dur |
| Rayons du CSS | 4, 8, 12 px (tokens `--radius-*`), 999 px ou 50 % pour une pastille |
| Variables CSS | seulement les tokens de Socle, plus trois variables calculées (`--fill`, `--position`, `--voice-level`) |
| `style` en ligne | 5, tous sur un élément HTML de l'app et seulement pour une valeur calculée (niveau du micro, curseur d'effort, position d'un calque et d'une liste flottante) |
| Tests | `pnpm test` : 476 tests verts ; `tsc -b` vert |

## Écarts de l'audit précédent

| Écart | État |
|---|---|
| bloquant — socle-ui n'est pas branché | **Corrigé.** `socle-ui/styles.css`, `src/styles.css` (Tailwind + `socle-ui/theme.css`) et `SocleProvider` à la racine (`src/main.tsx` : densité desktop, plateforme, préfixe `alfred`, file de notifications, accent de l'espace). |
| bloquant — Design system concurrent `@alfred/ui` | **Corrigé.** `src/ui/` supprimé. Les pages de l'agent importent `socle-ui` ; le transpileur et l'outil `check` refusent `@alfred/ui` avec la correspondance. |
| bloquant — Coquille maison | **Corrigé.** `src/shell/AppShell.tsx` rend `AppShell` et `Sidebar` de Socle ; fenêtre de page comprise (`PageWindow.tsx`). `react-resizable-panels` retiré. |
| bloquant — Actions à texte et « ⋯ » dans la barre du haut | **Corrigé.** `ActionBar zone="topbar"` (P13). Les bascules de vue deviennent des actions ordinaires (D-222). |
| bloquant — Pied du menu de gauche | **Corrigé.** Agent en `footer`, espace en `Sidebar.Workspace`, Réglages par `Sidebar.Account`. |
| bloquant — Composants sans équivalent Socle | **Corrigé.** Lots 1 à 4 de socle-ui, puis migration des écrans (correspondance dans `docs/socle-propositions.md`). |
| à corriger — Tokens concurrents | **Corrigé.** Plus aucun token d'Alfred ; `src/ui/styles.css` et `accents.css` supprimés. |
| à corriger — Couleurs en dur (agent, PDF, voix, `uiFix`, `HtmlContent`) | **Corrigé.** `--success`, `--danger`, `--paper`, `--scrim`. L'accent hexadécimal passé à `SocleProvider` (`src/runtime/accent.ts`) est la seule couleur écrite, avec `biome-ignore` justifié (D-012). |
| à corriger — Rayons hors échelle | **Corrigé.** |
| à corriger — Largeur du panneau de droite | **Corrigé.** Largeur et Agrandir d'AppShell (`detailExpandable`, D-240, D-241). |
| mineur — Styles inline | **Corrigé.** Restent cinq valeurs calculées sur du HTML de l'app (voir plus haut). |
| mineur — Garde-fous absents | **Corrigé.** `biome.json` étend `socle-ui/biome` ; `pnpm check` lance `socle-check-css`. |
| mineur — Installation par yalc non commitée | **Inchangé, assumé.** socle-ui reste privé et installé par yalc (`.yalc/` ignoré). |

## Écarts restants

### à corriger — `@alfred/ui` servie en transition aux pages des espaces
- Où : `src/runtime/transition/alfred-ui/` (copie de `src/ui/` au commit `eae37fa`), carte d’imports du cadre (`src-tauri/src/pages.rs`).
- Constat : 80 fichiers de modules des espaces de l’utilisateur importent encore `@alfred/ui`. Depuis le 2026-11-23, le runtime la sert aux cadres, la coquille ne l’importe pas ; ses feuilles ne sont injectées que dans le cadre d’une page qui l’importe. Le transpileur l’accepte et l’outil `check` la signale « à migrer vers socle-ui ». Biome et `socle-check-css` excluent ce dossier.
- Correction : migrer les pages des espaces vers socle-ui, puis supprimer le dossier, l’entrée `ui` du runtime, l’entrée de la carte d’imports et les exceptions.

### mineur — HTML stylé propre à Alfred
- Où : transcript, compositeur et panneau d'informations de l'agent (`src/features/agent/**/*.css`, environ 1 850 lignes), parcours de configuration (`src/features/setup/setup.css`), grille d'icônes (`src/shell/iconPicker.css`), kit local (`src/kit`).
- Règle : layout-rules, Page composée (« aucun HTML stylé côté app »).
- Constat : ces surfaces n'ont pas d'équivalent dans Socle (fil de conversation, zone de saisie, curseur, bouton-image, grille d'icônes). Elles n'emploient que les tokens Socle et aucun composant Socle n'y est surchargé.
- Correction : propositions à socle-ui listées dans « Manques vus pendant la migration » (curseur, bouton-image, `Stack`/`Text`, encart local) ; le reste est propre à Alfred.

### mineur — Fonctions retirées faute d'équivalent
- Où : coquille (`src/shell/AppShell.tsx`, `navigationEditing.tsx`).
- Constat : glisser-déposer des sections et des onglets, couleur par section, recherche dans la barre du haut, seconde action d'un toast, ouverture forcée du panneau de détail, renommage sur place (F2) d'une entrée du menu.
- Correction : remplacements décrits dans « Manques vus pendant la migration ».

### mineur — Pages placées dans les Réglages
- Où : `src/shell/SettingsModal.tsx`.
- Constat : une page de module placée dans les Réglages s'affiche dans le contenu libre d'une section de `SettingsPage` ; Socle ne prévoit pas de sections de réglage sans leur navigation.
- Correction : proposition notée dans les manques.

## Ce qui est conforme
- Coquille : `AppShell`, `Sidebar` (sections, sous-pages, conversations en `TreeItem`, pied), `views`, `pageSummary`, `pageStatus` (« Exemple »), `ActionBar zone="topbar"`, `NotificationCenter`, détail agrandissable.
- Réglages : `Dialog` `xl` avec `SettingsPage` ; chaque rubrique décrit ses sections par données (`useSections`).
- Notifications : file `createNotifications()` unique ; `notify()` d'Alfred s'appuie dessus.
- Confirmations : `useConfirm` ; formulaires courts : `useOpenForm`.
- Pages de l'agent : runtime `socle-ui`, `socle-ui/markdown`, `socle-ui/markdown-editor`, `@alfred/sdk`, `@alfred/kit` ; `SocleProvider` dans chaque cadre ; `DESIGN.md` et l'outil `check` suivent Socle.
