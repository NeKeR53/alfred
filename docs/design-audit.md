# Audit design — Alfred (enveloppe seule) — 2026-11-23
Version installée : socle-ui 1.0.0 (yalc) — dernière : 1.0.0 (tag `v1.0.0` de `../app-design/design-system`).

Périmètre : l'enveloppe d'Alfred. Fichiers lus : `src/App.tsx`, `src/main.tsx`, `src/styles.css`, `src/shell/`, `src/features/`, `src/kit/`.
Hors périmètre : les modules et les pages des espaces, le runtime et le SDK des cadres.

## Montée en 1.0.0 (faite)
- `npm run publish:local` dans le dépôt de référence, puis `pnpm update socle-ui` dans Alfred (yalc).
- Deux corrections pour rester vert :
  - `src/kit/index.tsx` : la balise locale `Tag` devient `Element`. La 1.0.0 exporte un composant `Tag`, et la règle Biome D-331 prenait la balise locale pour lui.
  - Actions de ligne de `Table` : la 1.0.0 ajoute le titre de la ligne au nom de l'action (Table.spec.md). Les libellés passent au verbe seul : « Annuler » (`PageHistory.tsx`), « Retirer l'accès » (`SpaceSettings.tsx`). Tests mis à jour.
- Vérifié : `pnpm run check`, `tsc -b`, `vitest` (474 tests), `build:runtime`, `vite build`. Écran d'accueil ouvert dans le navigateur : styles Socle appliqués, sans erreur de script. La coquille complète n'est pas vue : elle demande le backend Tauri.

## Synthèse
14 écarts : 4 bloquants, 7 à corriger, 3 mineurs.

La coquille est conforme : `AppShell`, `Sidebar` (navigation, `footer`, `Workspace`, `Account`), `ActionBar zone="topbar"`, `NotificationCenter`, `SettingsPage` dans une modale, palette de commandes faite de composants Socle. Les écarts sont dans ce que la coquille contient.

La 1.0.0 change le classement de plusieurs écarts : ce qui était « Hors design » en 0.4.0 est maintenant **prévu** (`Alert`, `Slider`, `Accordion`, `Drawer`, `Card`, `SegmentedControl`, `FormPage` en étapes). Ces écarts se corrigent dans Alfred, sans `propose`.

| Contrôle | Résultat |
|---|---|
| `pnpm run check` (Biome avec `socle-ui/biome`, puis `socle-check-css`) | vert |
| Mise en place (`styles.css`, `theme.css`, `SocleProvider`) | conforme (`src/main.tsx`, `src/styles.css`) |
| Imports interdits | aucun ; `socle-ui`, `socle-ui/markdown` et `lucide-react` (icônes de l'app, D-011) |
| Noms dépréciés de la 1.0.0 (retirés en 2.0.0) | **utilisés dans environ 50 fichiers** |
| `className` sur un élément HTML de l'app | **environ 330**, dans 40 fichiers |
| CSS propre à l'enveloppe | **2 261 lignes**, dans 10 fichiers (`agent.css` : 749) |
| Éléments interactifs HTML bruts (`button`, `input`, `textarea`) | **27** |

Pourquoi les contrôles sont verts : la règle Biome D-331 refuse `className` et `style` **sur un composant Socle**. Elle ne voit pas un `<div>`, un `<button>` ou un `<h3>` stylé avec les tokens Tailwind de Socle. `socle-check-css` ne refuse que les couleurs en dur.

## Écarts

### bloquant — Panneau de l'agent fait à la main
- Où : `src/features/agent/panel/InfoPanel.tsx:88`, `:207`, `:221` ; `src/features/agent/panel/info-panel.css` (278 lignes)
- Règle : specs `Drawer` (contenu du slot `detail`, ex-`DetailPanel`) et `Accordion` (bloc repliable)
- Constat : le slot `detail` reçoit des cartes repliables, des lignes sélectionnables et une poignée de glisser, faites de `<button>` et de CSS maison.
- Correction : `Drawer` et ses sections (repliables, D-321). Réordonner les cartes au glisser reste Hors design → propose.

### bloquant — Parcours de configuration fait à la main
- Où : `src/features/setup/SetupFlow.tsx:374`, `:420`, `:473`–`:868`, `:878` ; `src/features/setup/setup.css` (311 lignes)
- Règle : `FormPage` en étapes (`steps`, D-364) ; `RadioButtonGroup` ; `CheckboxGroup` ; D-217 (pas de HTML stylé)
- Constat : cartes de compte en `<button aria-pressed>` stylés, titres en `<h3>`/`<h4>` bruts, choix des pages en `<input>` brut. Seule la liste d'étapes vient de Socle.
- Correction : `FormPage` avec `steps` pour le parcours ; `RadioButtonGroup` pour choisir un compte ; `CheckboxGroup` pour les pages. La carte de choix avec état (`Card` n'a pas d'état sélectionné) reste Hors design → propose, si `RadioButtonGroup` ne suffit pas.

### bloquant — Page Agent : relevé et compositeur en HTML stylé
- Où : `src/features/agent/Transcript.tsx:427`, `:448` ; `Activities.tsx:119`, `:183`, `:207` ; `QueueList.tsx:239` ; `transcript/AgentQuestionCard.tsx:36`, `:70`, `:86` ; `transcript/ImagePreview.tsx:137` ; `ReferenceSuggestions.tsx:187` ; `agent.css` (749), `agent-composer.css` (345), `transcript/transcript.css` (323)
- Règle : D-217 (« L'app pose des composants du socle dans les zones, sans HTML stylé ») ; specs `Link`, `Button`, `Code`, `RadioButtonGroup`
- Constat : `AgentPage` pose `Page`, mais son contenu est fait de `<button>` bruts (fichiers, réponses proposées, file d'attente), d'un `<textarea readonly>` pour la sortie d'un outil et de 1 400 lignes de CSS.
- Correction : `Link` (sans `href`) pour ouvrir un fichier ; `Button` ou `RadioButtonGroup` pour les réponses proposées ; `Code block` (ou `LogViewer`) pour la sortie d'un outil. La bulle de message et le compositeur riche (pastilles de référence, pièces jointes) restent Hors design → propose un pattern « conversation ».

### bloquant — `Notice` du kit remplace `Alert`
- Où : `src/kit/index.tsx` (`Notice`), utilisé dans 21 fichiers de l'enveloppe ; `ExampleNotice` (`src/shell/AppShell.tsx`)
- Règle : spec `Alert` (depuis 1.0.0, D-355) ; AI.md, « Ne jamais créer un composant qui en remplace un existant »
- Constat : `Notice` refait l'encart que Socle livre maintenant, avec un dessin différent (fond `--surface-side`, point de statut au lieu de l'icône de ton).
- Correction : remplacer `Notice` par `Alert` (une action au plus, `{ label, onPress }`), puis le retirer du kit.

### à corriger — Noms dépréciés de la 1.0.0
- Où : environ 50 fichiers ; les plus fréquents : `TextField` (16 fichiers), `Dialog` (17), `RadioGroup` (6), `Menu` (5), `Disclosure` (8), `StatusBadge` (4)
- Règle : CHANGELOG 1.0.0, « Cassé » (D-336) : anciens noms en alias dépréciés, retirés en 2.0.0
- Constat : l'enveloppe garde les noms de la 0.4.0.
- Correction : remplacer en mot entier, imports `socle-ui` et balises seulement, selon la liste du CHANGELOG.

### à corriger — Curseur d'effort fait à la main
- Où : `src/features/agent/panel/EffortSlider.tsx:44` ; `effort-slider.css` (91 lignes)
- Règle : spec `Slider` (depuis 1.0.0, D-366)
- Constat : `<input type="range">` stylé en local.
- Correction : `Slider`.

### à corriger — Kit local `Stack`, `Row`, `Text`
- Où : `src/kit/index.tsx` ; `Stack` dans 28 fichiers, `Text` dans 27, `Row` dans 21 (aussi servi aux pages sous `@alfred/kit`)
- Règle : règle 1 du design (« Rien hors spec dans une app »)
- Constat : la 1.0.0 ne livre toujours ni primitives d'espacement ni texte courant.
- Correction : Hors design → propose `Stack`, `Row`, `Text`. Garder le kit d'ici là, sans l'étendre.

### à corriger — Encart des données d'exemple hors du gabarit
- Où : `src/shell/AppShell.tsx:267`–`:273`
- Règle : spec `Alert` (« en tête du contenu ») ; D-253 ; layout-rules, `main`
- Constat : l'enveloppe pose un `<div className="shrink-0 px-4 pt-3">` au-dessus du gabarit, avec ses propres marges.
- Correction : `Alert` en tête du contenu du gabarit. Aucun gabarit n'a de zone prévue pour lui : Placement non couvert → demander la règle à Socle.

### à corriger — Accueil : titres et mise en page à la main
- Où : `src/shell/welcome/Accueil.tsx:53` (`<h1>`), `src/shell/welcome/BasicsStep.tsx:40` (`<h2>`), `SpaceChoice.tsx`, `ModulesStep.tsx`
- Règle : D-217 ; layout-rules, `main` ; `FormPage` en étapes (D-364)
- Constat : l'écran d'accueil (trois étapes) n'utilise aucun gabarit.
- Correction : `FormPage` avec `steps` pour les étapes. Un écran d'accueil centré hors AppShell reste Hors design → propose (`LoginPage` en est proche, mais ne sert qu'à la connexion).

### à corriger — Titres et listes des réglages de modules en HTML
- Où : `src/features/modules/ModulePart.tsx:30` (`<h3>`), `src/features/modules/lists.tsx`, `src/features/modules/ModuleUserPages.tsx` (15 `className`)
- Règle : D-217 ; spec `Page` (`PageSection`)
- Constat : les réglages d'un module posent leurs propres titres et listes.
- Correction : `PageSection` pour le titre ; liste à puces et paires libellé/valeur hors `Drawer` restent Hors design → propose.

### à corriger — Le compte de la sidebar s'appelle « Alfred »
- Où : `src/shell/AppShell.tsx:522`
- Règle : layout-rules, `sidebar` → `account` (« L'avatar, le nom et le plan ») ; spec `Sidebar.Account`
- Constat : la zone du compte montre « Alfred », l'assistant, pas la personne qui utilise l'app.
- Correction : le nom de la personne (ou de son poste), avec `detail` pour le rôle.

### mineur — Sélecteur d'icône fait à la main
- Où : `src/shell/IconPicker.tsx:130`, `:142` ; `src/shell/iconPicker.css` (53 lignes)
- Règle : règle 1 du design
- Constat : grille de `<input type="radio">` masqués. `ColorPicker` (D-367) a une grille de choix, mais pour des couleurs.
- Correction : Hors design → propose un sélecteur d'icône.

### mineur — Action « Retirer l'accès » ambiguë
- Où : `src/features/space/SpaceSettings.tsx:580`
- Règle : Table.spec.md (« Les actions de ligne ont un nom qui reprend la ligne »)
- Constat : le nom devient « Retirer l'accès Page « … » ». Deux accès de la même page à deux clients ont le même nom.
- Correction : prendre pour titre de ligne une colonne qui distingue l'accès (page et client).

### mineur — Les contrôles ne voient pas le HTML stylé
- Où : `biome.json` (`socle-ui/biome`)
- Règle : garde-fous du skill (`assets/guardrails.md`)
- Constat : les 330 `className` et les 27 éléments interactifs bruts passent les contrôles.
- Correction : propose une règle `socle-ui/biome` sur les éléments interactifs bruts (`button`, `input`, `textarea`) dans une app.
