# Audit design — Alfred (enveloppe seule) — 2026-11-24
Version installée : socle-ui 1.2.0 (yalc) — dernière : 1.2.0 (tag `v1.2.0` de `../app-design/design-system`).

Périmètre : l'enveloppe d'Alfred : `src/App.tsx`, `src/main.tsx`, `src/styles.css`, `src/shell/`, `src/features/`, `src/kit/`.
Hors périmètre : les modules et les pages des espaces, le runtime et le SDK des cadres.

L'audit du 2026-11-23 (socle-ui 1.0.0) comptait 14 écarts, dont 4 bloquants. Cet audit refait les mesures après les corrections.

## Synthèse
Hors conversation : 0 bloquant, 2 à corriger, 3 mineurs, tous Hors design ou de placement non couvert.
La conversation (`src/features/agent/`, relevé et compositeur) est en cours de refonte par Alexandre : ses écarts sont listés à part.

| Contrôle | 2026-11-23 | 2026-11-24 |
|---|---|---|
| `pnpm run check`, `tsc -b`, `vitest`, `cargo test --lib` | vert | vert (476 tests JS, 363 tests Rust) |
| `className` sur un élément HTML de l'app | ~330 | 220, dont 164 dans la conversation |
| CSS propre à l'enveloppe | 2 261 lignes | 1 633, dont 1 531 dans la conversation |
| Éléments interactifs HTML bruts | 27 | 15 : 13 dans la conversation, 2 dans `IconPicker` |
| Noms dépréciés de la 1.0.0 | ~50 fichiers | 7 fichiers, tous dans la conversation |
| `Notice` du kit | 21 fichiers | 3 fichiers, tous dans la conversation |
| Panneau de droite | `aside` maison, panneau d'agent maison | `Drawer` partout ; `check` refuse une page en panneau sans `Drawer` |

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

## Conversation (`src/features/agent/`) — à reprendre avec la refonte
- HTML stylé : 164 `className`, 13 éléments interactifs bruts, 1 531 lignes de CSS (`agent.css`, `agent-composer.css`, `transcript.css`, `effort-slider.css`, `ui-fix.css`).
- Noms dépréciés : `Disclosure`, `Dialog`, `Menu`, `TextField`, `RadioGroup` dans 7 fichiers.
- `Notice` du kit dans 3 fichiers (`Composer.tsx`, `AgentPage.tsx`, `transcript/ErrorBoundary.tsx`) → `Alert`.
- Curseur d'effort maison (`panel/EffortSlider.tsx`) → `Slider` (socle-ui 1.0.0, D-366).
- Bulle de message et compositeur riche : Hors design → pattern « conversation » (page de validation des composants de chat en cours dans le dépôt de référence).

## Non vérifié
Les corrections ne sont pas vues dans l'app lancée par une session : Alfred tourne en debug pour la relecture d'Alexandre.
