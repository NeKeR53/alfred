# Audit design — Alfred (enveloppe seule) — 2026-11-24
Version installée : socle-ui 1.6.0 (yalc). Mesures de la conversation refaites en 1.6.0 ; le reste de l'audit date de la 1.2.0.

Périmètre : l'enveloppe d'Alfred : `src/App.tsx`, `src/main.tsx`, `src/styles.css`, `src/shell/`, `src/features/`, `src/kit/`.
Hors périmètre : les modules et les pages des espaces, le runtime et le SDK des cadres.

L'audit du 2026-11-23 (socle-ui 1.0.0) comptait 14 écarts, dont 4 bloquants. Cet audit refait les mesures après les corrections.

## Synthèse
Hors conversation : 0 bloquant, 2 à corriger, 3 mineurs, tous Hors design ou de placement non couvert.
La conversation (`src/features/agent/`) est refaite avec les composants de chat de socle-ui 1.4.0 : ses mesures et ses manques sont listés à part.

| Contrôle | 2026-11-23 | 2026-11-24 | 2026-11-24, conversation en socle-ui 1.6.0 |
|---|---|---|---|
| `pnpm run check`, `tsc -b`, `vitest`, `cargo test --lib` | vert | vert (476 tests JS, 363 tests Rust) | vert (518 tests JS ; Rust non relancé) |
| `className` sur un élément HTML de l'app | ~330 | 220, dont 164 dans la conversation | 69, dont 13 dans `src/features/agent/` |
| CSS propre à l'enveloppe | 2 261 lignes | 1 633, dont 1 531 dans la conversation | 221, dont 119 dans `src/features/agent/` |
| Éléments interactifs HTML bruts | 27 | 15 : 13 dans la conversation, 2 dans `IconPicker` | 2, dans `IconPicker` |
| Noms dépréciés de la 1.0.0 | ~50 fichiers | 7 fichiers, tous dans la conversation | 0 |
| `Notice` du kit | 21 fichiers | 3 fichiers, tous dans la conversation | 0 |
| Panneau de droite | `aside` maison, panneau d'agent maison | `Drawer` partout ; `check` refuse une page en panneau sans `Drawer` | inchangé |

## Corrigé depuis le 2026-11-23
- Panneau de l'agent : `Drawer` ; le suivi des conversations passe dans le slot `detail` d'AppShell (bouton Mod+.) — 7b09c04, 3591f60, 511be37.
- Parcours de configuration et accueil en composants Socle — 4d9143f.
- Noms 1.0.0, `Notice` → `Alert`, titres des réglages de modules, nom de la personne dans `Sidebar.Account`, titre de ligne des accès — 1ee748f.
- macOS : barre de titre intégrée à la barre du haut (D-020) — 3124742 ; plein écran sans réserve de 78 px (socle-ui 1.2.0, D-370) — f2dc832.
- Sidebar : hauteur fixe des lignes au survol, espace de travail sans avatar (socle-ui 1.1.0).

## Écarts restants — enveloppe hors conversation

### à corriger — Encart des données d'exemple hors du gabarit
- Où : `src/shell/AppShell.tsx:266`
- Règle : spec `Alert` (« en tête du contenu ») ; D-253 ; layout-rules, `main`
- Constat : l'`Alert` est posée dans un `<div className="shrink-0 px-4 pt-3">` au-dessus du gabarit, avec ses propres marges. La page de module est dans un cadre : l'enveloppe ne peut pas la mettre dans son gabarit.
- Correction : Placement non couvert → propose une zone d'encart d'AppShell, au-dessus de `main`.

### à corriger — Kit local `Stack`, `Row`, `Text`
- Où : `src/kit/index.tsx` (aussi servi aux pages sous `@alfred/kit`)
- Règle : règle 1 du design (« Rien hors spec dans une app »)
- Constat : Socle 1.2.0 ne livre ni primitives d'espacement ni texte courant.
- Correction : Hors design → propose `Stack`, `Row`, `Text`. `Notice` reste exporté, déprécié vers `Alert`.

### mineur — Sélecteur d'icône fait à la main
- Où : `src/shell/IconPicker.tsx:130`, `:142` ; `src/shell/iconPicker.css` (53 lignes)
- Constat : grille de `<input type="radio">` masqués.
- Correction : Hors design → propose un sélecteur d'icône.

### mineur — Listes des réglages de modules
- Où : `src/features/modules/ModuleUserPages.tsx` (15 `className`), `src/features/modules/lists.tsx` (6)
- Constat : liste à puces et paires libellé/valeur hors `Drawer`, faites du kit.
- Correction : Hors design → propose.

### mineur — Écran d'accueil centré hors AppShell
- Où : `src/shell/welcome/Accueil.tsx` (4 `className`)
- Constat : la carte centrée n'a pas de gabarit (`LoginPage` sert seulement à la connexion).
- Correction : Hors design → propose.

## Conversation (`src/features/agent/`) — refaite en composants de chat (socle-ui 1.6.0)
Refonte du 2026-11-24 : relevé 5951e91, activités 8282386, question 573cba2 (et 81690b6), saisie 02b921f, file 521f519, modèle et effort 9a5aa01 ; nettoyage f4a74d7 ; puis socle-ui 1.6.0 (D-382 `ChatPage`, D-383 `ImageThumbnail` et `ImageGallery`, D-384 `AgentActivity`), proposée depuis Alfred et appliquée.

| Mesure | Avant | Refonte (1.4.0) | Nettoyage (1.5.0) | 1.6.0 |
|---|---|---|---|---|
| `className` sur un élément HTML | 164 | 68 | 32 | 13, dont 6 dans `uiFix.tsx` (hors conversation) |
| Éléments interactifs HTML bruts | 13 (+1 `fieldset`) | 1 | 1 | 0 |
| CSS | 1 531 lignes, 5 fichiers | 544 lignes | 299 lignes | 119 lignes (`agent.css` 45, `transcript.css` 12, `ui-fix.css` 62) |
| Noms dépréciés, `Notice` | 7 fichiers, 3 fichiers | 0, 0 | 0, 0 | 0, 0 |

Correspondance :
- Page : `ChatPage` (barre d'outils, alertes, question bornée, saisie, cadre de dépôt), `ChatTranscript` avec sa ligne de contexte et son emplacement `empty` (chargement, échec, conversation vide).
- Relevé : `ChatMessage`, `MessageActions`, `MentionText`, `AttachmentChip`, `Card` + `DiffStat` + `Link` (bilan), `Card` (fichier produit, carte de placement), `Code` (source Mermaid), `Alert`.
- Images : `ImageThumbnail` (image du Markdown), `ImageGallery` (images citées et produites, images jointes, captures de l'agent par page avec « + N »), `DocumentViewer` (PDF).
- Activités : un seul `ActivityGroup` ; chemin cliquable (`onObjectPress`), images et fichiers dans la sortie (`attachments`), état `stopped` ; `WorkStatus`, `WorkSummary`.
- Question et autorisation : `ChoicePrompt`. Saisie : `ChatComposer`, `ChatOptions`, `ChatOptionButton`, `MentionInput`, `AttachmentList`, `AttachmentChip` ; relances en `Alert`. File : `MessageQueue`. Modèle et effort : D-380.
- Panneau de détail : `Drawer`, `List` (état en `Badge`), `PropertyRow` + `DiffStat`.

`className` restants (7 dans la conversation), tous Hors design :
- `AgentPage.tsx` (4) : colonne et suivi de la fenêtre Agent détachée ; nom de la conversation borné.
- `Transcript.tsx` (2) : liste des fichiers du bilan.
- `MermaidDiagram.tsx` (1) : SVG du schéma.

Les manques sont listés dans `docs/socle-propositions.md`, section « État des manques (socle-ui 1.6.0) ».

## Non vérifié
Les corrections ne sont pas vues dans l'app lancée par une session : Alfred tourne en debug pour la relecture d'Alexandre.
Conversation : chaque partie est vue dans un aperçu servi par le Vite d'Alfred (`output/chat-preview/`, hors dépôt), avec une conversation de test, pas dans la fenêtre Tauri (la fenêtre de debug n'est pas accessible au contrôle d'écran). Non vus en vrai : dépôt de fichiers par le système, dictée, envoi à un agent, suggestions `/`, `$`, `@` sur un vrai dossier, curseur de raisonnement sur un vrai modèle.
