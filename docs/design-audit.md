# Audit design — Alfred — 2026-11-23

Version installée : socle-ui 0.1.0 (yalc) — dernière : 0.1.0 (dépôt `../app-design/design-system`, aucun tag)

Périmètre : tout (tokens, composants, pages, comportements, garde-fous).

## Synthèse

14 écarts : 6 bloquants, 5 à corriger, 3 mineurs.

Constat principal : socle-ui est installé, mais l'app ne l'utilise pas. Aucun fichier de `src/` n'importe `socle-ui`. Toute l'UI passe par le design system interne `@alfred/ui` (`src/ui/`, 130 exports) et par la coquille `src/shell/`. `DESIGN.md` désigne aussi `@alfred/ui` comme seule source pour les pages écrites par l'agent. Le `CLAUDE.md` et le code se contredisent donc.

La plupart des écarts découlent de ce constat. Les corriger un par un n'a pas de sens avant une décision : migrer vers socle-ui, ou faire de `@alfred/ui` une couche construite sur socle-ui.

## Écarts

### bloquant — socle-ui n'est pas branché
- Où : `src/main.tsx:3`, `src/ui/styles.css:1`
- Règle : AI.md, « Mise en place » (étapes 1 et 2)
- Constat : ni `import "socle-ui/styles.css"`, ni `<SocleProvider>`, ni `@import "socle-ui/theme.css"` ; l'app charge `@alfred/ui` et son propre thème.
- Correction : importer les styles et le thème Socle, puis envelopper `<App />` dans `<SocleProvider>` (accent, densité `desktop`, plateforme, préfixe de mémorisation).

### bloquant — Design system concurrent `@alfred/ui`
- Où : `src/ui/index.ts`, `DESIGN.md`
- Règle : AI.md, « Ne jamais créer un composant qui en remplace un existant » ; SKILL règle 1
- Constat : `src/ui/components/` redéfinit des composants que socle-ui fournit : `Tabs.tsx`, `Menu.tsx`, `MenuButton.tsx`, `OverflowMenu.tsx`, `SearchField.tsx`, `TagSearchField.tsx`, `List.tsx`, `DataTable.tsx`, `DataGrid.tsx`, `templates/DetailPanel.tsx`, `primitives/button.tsx` (bouton-icône).
- Correction : remplacer chacun par l'export Socle (`Tabs`, `Menu`, `SearchField` avec `tagMode`, `List`, `Table`, `DetailPanel`, `IconButton`), puis supprimer la copie locale.

### bloquant — Coquille maison à la place d'AppShell et Sidebar
- Où : `src/shell/AppShell.tsx`, `src/shell/MenuZone.tsx`, `src/shell/PageFrame.tsx`, `src/shell/ResizablePanel.tsx`
- Règle : spec AppShell (« Chaque écran d'une app est rendu dans un AppShell »), spec Sidebar
- Constat : la barre du haut, le menu de gauche et le panneau de droite sont faits à la main avec `react-resizable-panels`.
- Correction : rendre chaque écran dans `AppShell` de Socle, avec `Sidebar` dans le slot `sidebar` et le panneau dans le slot `detail`.

### bloquant — Actions à texte et menu « ⋯ » dans la barre du haut
- Où : `src/shell/topBarActions.tsx:5`, `:92-108`
- Règle : spec AppShell, option `actions` (« boutons-icônes `IconButton` uniquement ») ; layout-rules, zone `topbar`
- Constat : la barre du haut porte une action principale à texte, des bascules de vue à deux boutons et un menu « ⋯ » de repli.
- Correction : Hors design → `/design propose "action principale et repli « ⋯ » dans la barre du haut"`. Les bascules de vue vont dans `views` (Tabs).

### bloquant — Pied du menu de gauche
- Où : `src/shell/MenuZone.tsx`, `DESIGN.md` section 2
- Règle : layout-rules, zone `sidebar → account` (« avatar, nom, plan ; le bouton Réglages. Toute autre action : non »)
- Constat : le pied porte Agent, le sélecteur d'espace et Réglages, sans `Sidebar.Account`.
- Correction : Réglages passe par `Sidebar.Account onSettings`. Agent et le sélecteur d'espace : Hors design → `/design propose`.

### bloquant — Composants sans équivalent Socle
- Où : `src/ui/components/` : `Button.tsx`, `Dialog.tsx`, `Modal.tsx`, `ConfirmDialog.tsx`, `FormControls.tsx`, `Combobox.tsx`, `primitives/*` (champs, cases, interrupteurs), `TreeView.tsx`, `Terminal.tsx`, `LogViewer.tsx`, `DiffView.tsx`, `MarkdownEditor.tsx`, `DocumentViewer.tsx`, `StatusBadge.tsx`, `EmptyState.tsx`, `FeedbackBanner.tsx`, `StepList.tsx` ; `src/shell/NotificationCenter.tsx` (sonner)
- Règle : CLAUDE.md, « Si la spec ne prévoit pas ce qui est demandé : Hors design »
- Constat : socle-ui 0.1.0 n'a ni bouton à texte, ni modale, ni champ de formulaire, ni notification, ni arbre, ni gabarit de page ; l'app en a besoin partout.
- Correction : Hors design → `/design propose` par famille (bouton, Dialog, champs, notifications, gabarits ListPage / FormPage / SettingsPage). La migration ne peut pas se finir avant.

### à corriger — Tokens concurrents
- Où : `src/ui/styles.css:5-20`, `src/ui/accents.css`
- Règle : AI.md, étape 2 (« seules les couleurs Socle existent »)
- Constat : l'app définit ses propres variables (`--color-ink`, `--color-muted`, `--color-primary`, `--line`…) au lieu de `--color-fg`, `--color-fg-2`, `--color-accent`, `--color-line`.
- Correction : passer aux tokens de `socle-ui/theme.css` et supprimer les tokens locaux.

### à corriger — Couleurs en dur dans le module agent
- Où : `src/features/agent/agent.css:192-208`, `:632-648`
- Règle : garde-fou « pas de couleur en dur »
- Constat : vert et rouge des diffs écrits en hexadécimal (`#147d3f`, `#c52238`, `#31d879`, `#ff4659`).
- Correction : utiliser `--color-success` et `--color-danger`.

### à corriger — Autres couleurs en dur
- Où : `src/features/agent/transcript/pdf-preview.css:49-50`, `src/features/voice/voice.css:26-28`, `src/features/agent/uiFix.tsx:57,62`, `src/ui/components/HtmlContent.tsx:249-250`
- Règle : garde-fou « pas de couleur en dur »
- Constat : fonds, ombres et replis en `#fff`, `rgb()`, `#c2410c`, `#e5484d`, `#4b6bfb`.
- Correction : remplacer par un token Socle ; le blanc de la page PDF peut rester (rendu du document), avec un commentaire.

### à corriger — Rayons hors échelle
- Où : CSS de `src/ui/` et `src/shell/` (2, 3, 6, 7, 9 px : 15 occurrences) ; `src/ui/styles.css:17-19`
- Règle : layout-rules, D-040 (8 px contrôle, 4 px petit contrôle, 12 px conteneur ; « Aucun autre rayon »)
- Constat : l'app utilise 2, 3, 4, 6, 7, 8, 9 et 12 px, et fixe `--radius-md: 6px`.
- Correction : ramener chaque rayon à 4, 8 ou 12 px (999 px reste pour les pastilles rondes, à confirmer).

### à corriger — Largeur du panneau de droite
- Où : `src/shell/shell.css:106-120`, `src/shell/ResizablePanel.tsx:58`
- Règle : spec AppShell / DetailPanel, token `--detail-w` (272 px compact, 300 px confortable)
- Constat : trois largeurs reprises de OneApp (340 px, 460 px, large) et un bouton Agrandir.
- Correction : Hors design pour les largeurs multiples et Agrandir → `/design propose` ; sinon `--detail-w`.

### mineur — Styles inline dans les modules
- Où : `src/features/agent/panel/ModelPicker.tsx:191`, `EffortSlider.tsx:52,63`, `src/features/voice/DictationButton.tsx:85`, `src/features/agent/uiFix.tsx:262`, `src/features/agent/transcript/PdfPreview.tsx:341`
- Règle : garde-fou « pas d'attribut `style` inline »
- Constat : six `style={{…}}` ; quatre ne posent qu'une variable CSS ou une taille calculée.
- Correction : garder les variables calculées (niveau, position), vérifier qu'aucune ne vise un composant Socle ; déplacer le reste dans le CSS.

### mineur — Garde-fous absents
- Où : `biome.json`, `package.json` (scripts)
- Règle : AI.md, étape 3 ; `assets/guardrails.md`
- Constat : l'app lint avec Biome ; ni `socle-ui/eslint-config`, ni `socle-check-css` ne tournent.
- Correction : ajouter `npx socle-check-css "src/**/*.css"` au script `check` ; pour les règles ESLint, ajouter un ESLint limité à ces règles, ou demander une version Biome → `/design propose`.

### mineur — Installation par yalc non commitée
- Où : `package.json:40` (`"socle-ui": "file:.yalc/socle-ui"`), `.gitignore`
- Règle : contexte « app », version installée lisible
- Constat : la dépendance pointe vers `.yalc/`, ignoré par git ; un clone propre ne trouve pas socle-ui. Le dépôt de référence n'a aucun tag 0.1.0.
- Correction : documenter `yalc add socle-ui` dans le README, et poser le tag `v0.1.0` dans le dépôt de référence.

## Ce qui est déjà conforme
- Barre du haut de 44 px (`src/shell/shell.css:301`) : même valeur que `--bar-h` en densité confortable.
- Réglages en modale sur bureau (`src/shell/SettingsModal.tsx`), comme D-015.
- Pas d'import direct de `radix-ui` hors de `src/ui/`.
