# Audit design — Alfred (enveloppe seule) — 2026-11-24
Version installée : socle-ui 1.4.0 (yalc). Mesures de la conversation refaites en 1.4.0 ; le reste de l'audit date de la 1.2.0.

Périmètre : l'enveloppe d'Alfred : `src/App.tsx`, `src/main.tsx`, `src/styles.css`, `src/shell/`, `src/features/`, `src/kit/`.
Hors périmètre : les modules et les pages des espaces, le runtime et le SDK des cadres.

L'audit du 2026-11-23 (socle-ui 1.0.0) comptait 14 écarts, dont 4 bloquants. Cet audit refait les mesures après les corrections.

## Synthèse
Hors conversation : 0 bloquant, 2 à corriger, 3 mineurs, tous Hors design ou de placement non couvert.
La conversation (`src/features/agent/`) est refaite avec les composants de chat de socle-ui 1.4.0 : ses mesures et ses manques sont listés à part.

| Contrôle | 2026-11-23 | 2026-11-24 | 2026-11-24, conversation refaite (socle-ui 1.4.0) |
|---|---|---|---|
| `pnpm run check`, `tsc -b`, `vitest`, `cargo test --lib` | vert | vert (476 tests JS, 363 tests Rust) | vert (489 tests JS ; Rust non relancé) |
| `className` sur un élément HTML de l'app | ~330 | 220, dont 164 dans la conversation | 124, dont 68 dans `src/features/agent/` |
| CSS propre à l'enveloppe | 2 261 lignes | 1 633, dont 1 531 dans la conversation | 646, dont 544 dans `src/features/agent/` |
| Éléments interactifs HTML bruts | 27 | 15 : 13 dans la conversation, 2 dans `IconPicker` | 3 : 1 dans la conversation (vignette d'image), 2 dans `IconPicker` |
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

## Conversation (`src/features/agent/`) — refaite en composants de chat (socle-ui 1.4.0)
Refonte du 2026-11-24, une partie par commit : relevé 5951e91, activités 8282386, question 573cba2 (et 81690b6), saisie 02b921f, file 521f519, modèle et effort 9a5aa01.

| Mesure | Avant | Après |
|---|---|---|
| `className` sur un élément HTML | 164 | 68 |
| Éléments interactifs HTML bruts (`button`, `input`, `textarea`, `fieldset`…) | 13 (+1 `fieldset`) | 1 |
| CSS | 1 531 lignes, 5 fichiers | 544 lignes, 4 fichiers (`agent.css` 282, `transcript.css` 172, `ui-fix.css` 62, `watches.css` 28) |
| Noms dépréciés | 7 fichiers | 0 |
| `Notice` du kit | 3 fichiers | 0 (`Alert`) |
| Fichiers maison retirés | — | `ComposerEditor`, `ReferenceSuggestions`, `TextPreview`, `AgentSendButton`, `transcript/MessageActions`, `transcript/ReferencePills`, `agent-composer.css`, `effort-slider.css` |

Correspondance :
- Relevé : `ChatTranscript` (suivi du bas, `followKey` à chaque envoi, annonce « Réponse terminée »), `ChatMessage`, `MessageActions`, `MentionText`, `AttachmentChip` (collages et long message), `Card` + `DiffStat` + `Link` (bilan des modifications), `Alert` (arrêt, erreur, limite d'erreur).
- Activités : `ActivityGroup`, `WorkStatus`, `WorkSummary`.
- Question et autorisation : `ChoicePrompt`.
- Saisie : `ChatComposer`, `ChatOptions`, `ChatOptionButton`, `MentionInput` (déclencheurs `/`, `$`, `@`), `AttachmentList`, `AttachmentChip`.
- File : `MessageQueue`.
- Modèle et effort : D-380 (`ChatOptionButton` → `Popover` : `RadioButtonGroup` du harnais, `Select`, `Slider` à crans) ; autonomie en `DropdownMenu`.
- Jauge de contexte : rien à remplacer, Alfred n'en a pas ; les harnais ne lui donnent pas l'usage du contexte (`UsageRing` attend une donnée).

`className` restants (68) et pourquoi :
- `ConversationList.tsx` (18) : panneau de détail de la page Agent, réglé à part ; sa structure ne change pas dans cette refonte.
- `AgentPage.tsx` (12), `pageAgent.tsx` (1), `Transcript.tsx` (1, en-tête « Depuis … · date ») : cadre de la page et colonne de 760 px du pied (question, saisie, options), alignée sur celle de `ChatTranscript`. Hors design : Socle n'a pas de gabarit de page de chat (ses stories posent le pied dans une `div` à classes).
- `Transcript.tsx` (2) : liste des fichiers du bilan, chemin cliquable et `DiffStat` par ligne. Hors design.
- `Activities.tsx` (4) : ligne d'outil avec chemin cliquable, et images d'une sortie. Hors design (`AgentActivity` exclut lien et images).
- `transcript/ImagePreview.tsx` (5, dont le seul bouton brut), `ConversationImages.tsx`, `ChatAttachments.tsx`, `PageCaptures.tsx` (5), `LoadedImage.tsx` : vignettes d'images agrandissables, avec chargement et « Réessayer ». Hors design (`AttachmentChip` ne s'ouvre pas en grand) ; `DocumentViewer` reste à essayer pour la vue agrandie.
- `ConversationFiles.tsx` (4) : fichier produit par l'agent avec « Ouvrir », « Enregistrer… » et aperçu PDF.
- `MermaidDiagram.tsx` (3) : schéma Mermaid dans le Markdown.
- `watches.tsx` (2) : relances prévues au-dessus de la saisie (pas d'emplacement dans `ChatComposer`).
- `PlacementCard.tsx` (2) : carte de placement d'une page, posée par l'agent dans le relevé.
- `uiFix.tsx` (6) : correctif d'interface, hors conversation.

Les manques sont listés dans `docs/socle-propositions.md`, section « Manques vus en 1.4 ».

## Non vérifié
Les corrections ne sont pas vues dans l'app lancée par une session : Alfred tourne en debug pour la relecture d'Alexandre.
Conversation : chaque partie est vue dans un aperçu servi par le Vite d'Alfred (`output/chat-preview/`, hors dépôt), avec une conversation de test, pas dans la fenêtre Tauri (la fenêtre de debug n'est pas accessible au contrôle d'écran). Non vus en vrai : dépôt de fichiers par le système, dictée, envoi à un agent, suggestions `/`, `$`, `@` sur un vrai dossier, curseur de raisonnement sur un vrai modèle.
