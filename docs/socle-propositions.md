# Propositions à socle-ui pour passer Alfred tout en Socle — 2026-11-23

> **État au 2026-11-23 : les lots 1 à 5 sont faits.** Les 21 PR sont fusionnées dans `main` de NeKeR53/app-design. Le lot 1 est sorti en socle-ui 0.2.0 (tag `v0.2.0`, 196 tests), les lots 2 à 5 en 0.3.0 (tag `v0.3.0`, 389 tests). La 0.3.0 est installée dans Alfred par yalc. Le détail des nouveautés et des changements : page « Nouveautés de Socle » (https://claude.ai/artifact/Gqe6DRsnaBzF3MeMvW7Hpc). La section « Après les propositions » est faite aussi : Alfred est entièrement sur socle-ui 0.3.0 (`main`, `eae37fa..5db847b`), `src/ui/` est supprimé, 476 tests passent. Les manques vus pendant la migration sont listés plus bas. P16 (résumé et état dans la barre du haut) est retiré à la relecture : socle-ui 0.4.0 (tag `v0.4.0`, D-253) ; Alfred signale les données d’exemple par un encart dans la page.

Source : [design-audit.md](design-audit.md). Base : socle-ui 0.1.0.

Chaque ligne est un `/design propose`. L'ordre suit les dépendances : une proposition n'utilise que ce que les précédentes ont ajouté. Chaque proposition ajoute une option ou un export facultatif, donc chaque ajout est une version mineure (0.x).

Une proposition suit le mode `propose` :
1. test du générique ;
2. page de validation ;
3. questions une à une ;
4. branche et code dans `../app-design/design-system` ;
5. essai dans Alfred par yalc ;
6. PR.

## Lot 1 — Bases (tout le reste en dépend)

| # | Proposition | Remplace dans Alfred | Générique ? | Dépend de |
|---|---|---|---|---|
| P1 | **Button** à texte : variantes principale, secondaire, discrète, danger ; état chargement. | `Button`, `primitives/button.tsx`, `RefreshButton` | Oui | — |
| P2 | **Modèle `Action`** : `{ id, label, icon?, onPress, primary?, danger?, confirm? }`, et une règle qui décide de sa forme (bouton, icône, entrée de menu) selon la zone. | `templates/actions.tsx` (`Action`, `ActionBar`, `arrangeActions`) | Oui | P1, Menu |
| P3 | **Dialog** et **confirmation** : modale à titre, contenu et pied ; `useConfirm` pour les actions `danger`. | `Dialog`, `Modal`, `ConfirmDialog`, `src/shell/DialogHeader.tsx` | Oui | P1 |
| P4 | **Champs de formulaire** : TextField, TextArea, Select, Checkbox, Radio, Switch, Fieldset ; libellé au-dessus, aide et erreur en dessous (D-022). | `FormControls`, `primitives/*`, `Fieldset`, `ChoiceButton` | Oui | — |
| P5 | **ComboBox** : simple, multiple, avec recherche. | `Combobox`, `MultiSelectCombobox`, `SearchCombobox` | Oui | P4 |
| P6 | **Notifications** : toasts (succès, erreur, action « Annuler ») et centre de notifications dans la barre du haut. | `sonner`, `NotificationCenter.tsx`, `FeedbackBanner` | Oui | P1 |
| P7 | **Petits éléments d'affichage** : StatusBadge, StatusDot, Avatar, ProgressBar, Skeleton, EmptyState, Link, Code, Divider. | composants du même nom | Oui | — |

## Lot 2 — Gabarits de page (l'API de l'agent)

| # | Proposition | Remplace dans Alfred | Générique ? | Dépend de |
|---|---|---|---|---|
| P8 | **ListPage** : `header`, `actions`, `toolbar` (recherche, filtres), `list` (Table ou List), `footer` (compteur, pagination), `empty` ; états chargement et erreur. Données décrites par colonnes typées. | `CollectionPage`, `PageToolbar`, `Pagination`, `FormattedValue` | Oui (déjà dans layout-rules) | P2, P7 |
| P9 | **DetailPanel déclaratif** : sections décrites par des champs typés, actions d'en-tête par `Action`. | `templates/DetailPanel.tsx`, `PanelSections`, `PanelHeader` | Oui | P2 |
| P10 | **FormPage** et formulaire en modale (`openForm`) : sections, barre d'actions collée en bas. | `openForm` (`templates/dialogs.tsx`), `FormActions` | Oui (déjà dans layout-rules) | P3, P4 |
| P11 | **SettingsPage** : nav, sections, lignes de réglage (libellé à gauche, contrôle à droite), listes avec actions de ligne. | `SettingsPage`, `SettingRow`, `settings-surface.css` | Oui (déjà dans layout-rules) | P4 |
| P12 | **DetailPage** : retour, titre, statut, méta, actions ; sections. | pages composées à la main avec `page.tsx` | Oui (déjà dans layout-rules) | P2 |

## Lot 3 — Coquille

| # | Proposition | Écart de l'audit | Générique ? | Dépend de |
|---|---|---|---|---|
| P13 | **Actions de page dans la barre du haut** : une action principale à texte, puis le repli « ⋯ » quand la place manque. Les bascules de vue passent en `views`. | Barre du haut à texte et « ⋯ » | Oui | P1, P2 |
| P14 | **Pied de Sidebar** : entrée fixe (ex. assistant) et sélecteur d'espace de travail au-dessus de `Sidebar.Account`. | Pied du menu de gauche | À tester : « assistant » et « espace » doivent avoir du sens hors d'Alfred | — |
| P15 | **Largeurs du panneau de détail** : largeur par contenu (sections, formulaire) et bouton Agrandir. | Panneau 340 / 460 / large | À tester | — |
| P16 | **Résumé après le titre** dans la barre du haut (`useTopBarSummary`). | — (vu dans les commits) | Oui | — |

## Lot 4 — Composants spécialisés

| # | Proposition | Remplace dans Alfred | Générique ? |
|---|---|---|---|
| P17 | **TreeView** : nœuds, actions, confirmation des actions `danger`. | `TreeView` | Oui |
| P18 | **DataGrid** dense : lignes de groupe, cases de sélection, cases teintées. Ou fusion dans `Table` avec des options. | `DataGrid`, `DataTable` | Oui |
| P19 | **Terminal** et **LogViewer** : filtres par niveau, compteurs, bouton Suivre. | `Terminal`, `LogViewer` | Oui (outils techniques) |
| P20 | **DiffView**. | `DiffView` | Oui |
| P21 | **Markdown** (lecture) et **MarkdownEditor**. | `Markdown`, `MarkdownEditor` | Oui |
| P22 | **DocumentViewer** (PDF, image) et **HtmlContent**. | `DocumentViewer`, `HtmlContent` | Oui |
| P23 | **Disclosure**, **InlineEdit**, **StepList**, **AnchoredMenu / AnchoredPanel**. | composants du même nom | À tester un par un |

## Lot 5 — Garde-fous

| # | Proposition | Raison |
|---|---|---|
| P24 | Règles des garde-fous pour **Biome** (imports interdits, `style` inline, couleurs en dur), en plus de la config ESLint. | Alfred lint avec Biome |
| P25 | Tag `v0.1.0` dans le dépôt de référence et notes sur l'installation par yalc. | Version installée lisible |

## Après les propositions (dans Alfred)

1. Brancher socle-ui : `styles.css`, `theme.css`, `SocleProvider`.
2. Remplacer la coquille par `AppShell` et `Sidebar`.
3. Remplacer les composants de `@alfred/ui` un par un.
4. Réécrire `DESIGN.md` pour que l'agent importe `socle-ui`, puis adapter l'outil `check`.
5. Supprimer `src/ui/`.

Les étapes 1 et 2 peuvent commencer après le lot 1, sans attendre la suite.

## Manques vus pendant la migration (socle-ui 0.3.0)

Chaque manque a une solution locale dans Alfred, faite de composants Socle. Chacun peut devenir un `/design propose`.

### Coquille
| Manque | Ce qu'Alfred fait à la place |
|---|---|
| Glisser-déposer des sections de la Sidebar et des onglets de vues | Menu « … » de la section : « Monter », « Descendre » ; actions de la page : « Déplacer l'onglet vers la gauche / la droite ». |
| Couleur par section (Sidebar : « pas de couleur par section ») | Retirée de l'affichage et du menu. Le réglage reste lisible dans le `layout` de l'espace. |
| Recherche de page dans la barre du haut (`useTopBarSearch`) | Retirée : la recherche va dans la barre d'outils de `ListPage` ou de `Page`. Le message du pont reste accepté et ignoré. |
| Une seule action par toast (D-155) | Le toast porte la première action ; la ligne du centre de notifications rouvre la même action (`onOpen`). La seconde action reste dans l'historique d'Alfred, sans bouton. |
| Ouverture forcée du panneau de détail (`detail` sans option contrôlée) | Le panneau suit l'état mémorisé par AppShell. Une conversation d'agent lancée par une page remplace le contenu du panneau, sans le rouvrir s'il est replié. |
| Bascule de vue à boutons accolés dans `actions` | Exclue par AppShell (D-222) : chaque vue devient une action ordinaire, la vue affichée est désactivée. |
| Raccourci d'ouverture du sélecteur d'espace (Cmd+Maj+O) | Retiré (D-232). |
| Renommer une entrée de la Sidebar sur place (F2) | Action « Renommer » de l'entrée, qui ouvre `useOpenForm`. |
| Statut à plusieurs tons d'une entrée de zone (bon, échec, au travail) | `count` pour un compteur, `indicator="activity"` pour une entrée au travail ; les autres états ne se voient plus dans le menu. |
| Menu contextuel d'un onglet de vue | Ses actions passent dans le « … » de la barre du haut. |
| Compteur sur un onglet de vue | Le compteur s'ajoute au libellé : « Tâches (4) ». |

### Composants
| Manque | Ce qu'Alfred fait à la place |
|---|---|
| Écart entre composants (`Stack`, `Row`) et texte courant hors gabarit (`Text`) | Kit local `src/kit` (Tailwind avec les seuls tokens Socle), aussi servi aux pages sous `@alfred/kit`. |
| Encart local dans une zone (erreur de chargement, précision) | `Notice` du kit : `StatusDot` et texte, bord `--line`. |
| Rendu seul des sections de réglages, sans navigation | Une page de module placée dans les Réglages prend `Page`, `PageSection` et des champs Socle. |
| Sous-partie titrée dans le contenu libre d'une `SettingsSection` ; liste à puces ; paires libellé/valeur hors `DetailPanel` | Composants locaux des modules (`modules/lists.tsx`), faits du kit. |
| Curseur (`Slider`) | Sélecteur d'effort de l'agent gardé en local. |
| Bouton-image (vignette cliquable), bouton d'envoi rond, `type="submit"` sur `IconButton` | Boutons HTML de l'app, stylés avec les tokens Socle. |
| Titre riche de `Disclosure` (icône, roue) | Titre texte seul. |
| Infobulle différente du nom accessible sur `IconButton` | Le nom accessible sert aussi d'infobulle. |
| Notification d'une page avec une action à rappel (`onAction`) | Le pont ne transporte pas une fonction : seules les actions décrites (navigation, fenêtre, fonction) passent. |

## Manques vus en 1.0.0

Relevés en refaisant le parcours de configuration d'un module (`src/features/setup`) et l'écran d'accueil (`src/shell/welcome`) avec les seuls composants de socle-ui 1.0.0. Chacun peut devenir un `/design propose`.

### Gabarits
| Manque | Ce qu'Alfred fait à la place |
|---|---|
| Assistant en étapes dans une modale. `FormPage` en étapes (D-364) est un gabarit du `main`, décrit par des champs, avec récapitulatif et envoi à la fin. Le parcours de configuration écrit tout de suite (pages, comptes), ouvre un sous-assistant de compte et compte de 3 à 10 étapes selon le module. | `Modal` `lg` : `ProgressIndicator` horizontal, puis l'étape en `PageSection`, puis le pied de la modale (« Terminer plus tard », « Précédent », l'action). |
| `PageSection` hors de `Page` et `DetailPage` (placement non prévu : modale, écran d'accueil). | `PageSection` posée dans la modale du parcours et dans l'accueil, pour les titres d'étape et les blocs. |
| Écran centré hors AppShell (accueil, premier démarrage). `LoginPage` en a la forme mais ne sert qu'à la connexion. | Cadre local minimal dans `Accueil.tsx` : fond `--surface-side`, panneau centré de 600 px, titre `h1`. Le reste est en composants Socle. |
| Plus de 7 étapes dans `ProgressIndicator` (le parcours d'un module à beaucoup de pages). | Aucune limite côté Alfred : l'indicateur se resserre seul. |

### Composants
| Manque | Ce qu'Alfred fait à la place |
|---|---|
| Carte de choix riche : un choix parmi des comptes, avec adresse, état (`Badge`) et une action par carte (« Modifier ce compte »). `RadioButtonGroup.Option` n'accepte qu'un libellé texte et une description. `Card` n'a pas d'état choisi. | `RadioButtonGroup` : l'état passe dans la description (« jenkins.acme.fr · Connecté »). Un `Alert` sous le groupe porte l'échec et « Modifier ce compte », ou ce qu'il manque au compte choisi (« Vérifier », « Autoriser »…). « Connecter un nouveau compte » est un `Button` sous le groupe. |
| Choisir de nouveau l'option déjà choisie (`RadioButtonGroup` ne prévient pas). L'ancienne carte relançait la vérification au clic. | L'`Alert` du compte choisi porte l'action qui le termine. |
| Nom accessible d'une option de `RadioButtonGroup` ou d'une `Checkbox` avec description : la description est collée au libellé (« Recetterecette.acme.fr · Connecté »), en plus d'être reliée par `aria-describedby`. | Rien : à corriger dans Socle. Les tests d'Alfred cherchent l'option par libellé et description. |
| Actions par case dans un `CheckboxGroup` (renommer une page, en ajouter une du même modèle). | Le `CheckboxGroup` choisit ; une seconde `PageSection` « Noms dans le menu » liste les pages gardées avec `InlineEdit` (ouvert par « Renommer ») et « Une autre ». |
| État par case (`Badge` « Déjà là », « Indisponible ») dans un `CheckboxGroup` ; liste longue qui défile (catalogue d'un marketplace, plus de 10 modules). | L'état passe dans la description de la case ; l'erreur d'import dans `error` de la case. La liste ne défile plus dans un cadre. |
| Bouton visible sur une ligne de `List` (« Ouvrir » un espace récent). Les actions de ligne n'apparaissent qu'au survol. | `List` avec `itemActions` (« Ouvrir l'espace … ») et `onAction` (Entrée, double-clic). |
| Paires libellé/valeur hors du panneau de détail (résumé « C'est prêt » de l'accueil). | `PropertyRow` posées dans l'écran d'accueil, sans cadre. |

## État des manques (socle-ui 1.5.0)

Relevé en refaisant puis en nettoyant la conversation (`src/features/agent/`) avec les composants de chat (D-371 à D-378, D-380). socle-ui 1.5.0 n'ajoute que `quickActions` à `Sidebar.TreeItem` (D-381) : aucun de ces manques n'est couvert. Chacun peut devenir un `/design propose`. Rien n'est implémenté autrement en local : l'existant est gardé, ou la fonction passe par une option voisine, dite ici.

Ce qu'il reste dans la conversation : 32 `className`, 1 bouton HTML brut, 299 lignes de CSS. Les propositions sont classées par ce qu'elles retireraient.

### Priorité 1 — ce qui retirerait le plus de code local
| Manque | Ce qu'Alfred fait à la place | Retiré si Socle le prévoit |
|---|---|---|
| **Gabarit de page de chat** : `ChatTranscript` en haut, puis un pied aligné sur sa colonne de 760 px (`ChoicePrompt`, `ChatComposer`, `ChatOptions`), une ligne de contexte en tête du relevé (« Depuis Notes · 24/11/2026 09:03 », modèle en infobulle), une zone de dépôt de fichiers sur toute la page. Les stories de Socle posent ce pied dans une `div` à classes. | `agents-page__main`, `__footer`, `__question`, `__context` dans `agent.css`. | 6 `className`, ~60 lignes de CSS. |
| **Vignette d'image cliquable** (bouton-image) : image envoyée, citée ou produite, qui s'agrandit (`DocumentViewer` dans une `Modal`), avec chargement et « Réessayer ». `AttachmentChip` ne s'ouvre pas en grand et n'a pas de nouvel essai. Option possible : `onPress` et `status` sur `AttachmentChip` `image`, ou un composant `ImageThumbnail`. | `ImagePreview` local : le seul bouton HTML brut de la conversation ; tailles `message`, `sent`, `capture`. | 1 bouton brut, ~8 `className`, ~70 lignes de CSS. |
| **Galerie de captures** : vignettes groupées par page, légende coupée, « + N » pour les plus anciennes, parcours aux flèches dans la vue agrandie. | `PageCaptures` local (`figure`, `figcaption`). | 5 `className`, ~35 lignes de CSS. |
| **`AgentActivity` avec un objet cliquable** (ouvrir le fichier lu ou modifié). La spec exclut le lien. | Les outils qui citent un chemin gardent une ligne locale avec un `Link` ; les autres passent en `ActivityGroup`, dans l'ordre. Le résumé « n outils » ne compte que les outils d'un même groupe. | 3 `className`, ~20 lignes de CSS. |
| **`AgentActivity` avec images et fichiers dans la sortie** (capture, image générée). | Ligne locale : `Accordion`, `TextArea` en lecture seule, images et fichiers. | 1 `className`. |

### Priorité 2 — fonctions gardées par un contournement
| Manque | Ce qu'Alfred fait à la place |
|---|---|
| `ChoicePrompt` repliable en pastille (« Question de l'agent en attente »), pour relire le relevé derrière. | Deux `Button` `subtle` `sm` hors de la carte. |
| `ChatComposer` : touche propre à l'app dans le champ (`onKeyDown`) — Échap annulait une dictée en cours. | Échap arrête l'agent ; la dictée s'arrête par son bouton. |
| `ChatComposer` : dépôt de fichiers par le système (Tauri donne des chemins ; aucun `drop` n'arrive dans la page). Le cadre en tirets ne paraît pas. | Écouteur Tauri ; la page se couvre de sa zone de dépôt. |
| `ChatComposer` : emplacement au-dessus du cadre pour des encarts liés à la saisie (relances prévues). | Un `Alert` par relance, posé avant `ChatComposer`, dans un `Stack` du kit. |
| `AgentActivity` : état « Arrêté » (outil interrompu), à côté de `running`, `done`, `error`. | `status: "done"` et « · Arrêté » ajouté au verbe. |
| `WorkStatus` : heure de début (« Début à 09:06:48 »). | Retirée ; l'heure d'envoi reste dans la ligne du message. |
| `WorkSummary` : durée inconnue (ancien historique ; l'ancien résumé disait « Travail terminé »). | `durationMs: 0`, donc « A travaillé pendant 0 s ». |
| `ChatMessage` sans texte (pièces jointes seules) : la bulle reste vide sous les pièces. | Les pièces jointes passent dans la bulle. |
| `MentionText` : infobulle d'une pastille (description d'une commande). | Plus d'infobulle sur les pastilles d'un message envoyé. |
| `MentionReference` enregistrée sans son caractère déclencheur. | Le caractère est déduit du type : `@` fichier, `$` skill, `/` commande (un skill choisi par `/` se relit avec `$`). |
| `Popover` au-dessus de son bouton (`top end`) : D-380 l'ouvre depuis `ChatOptions`, sous la saisie. `UsageRing` note la même limite. | `bottom end` ; le volet change de côté faute de place. |
| `Slider` à un seul niveau (modèle sans raisonnement réglable). | Pas de curseur ; « Raisonnement : par défaut du modèle. » en aide du champ Modèle. |
| Liste de fichiers modifiés : chemin cliquable et `DiffStat` par ligne, « Afficher N de plus ». | `ul` local dans une `Card`, avec `Link`, `DiffStat` et un `Button` `subtle`. |
| `List` du suivi : état « au travail » distinct de l'accent. L'ancienne pastille clignotait, car l'accent d'Alfred est proche du rouge d'échec. | `Badge` `info` (bleu), sans animation. |

### Priorité 3 — détails et garde-fous
| Manque | Ce qu'Alfred fait à la place |
|---|---|
| `DiffStat` ne sépare pas les milliers selon la langue (« +1200 » au lieu de « +1 200 »). | Rien : à corriger dans Socle. |
| Libellés de Socle avec apostrophe droite (« Repartir d'ici », « Question de l'agent ») au milieu des libellés d'Alfred en apostrophe typographique (’). | Rien : à harmoniser dans les `messages` de Socle, ou par `SocleProvider` `messages` côté Alfred. |
| `PropertyRow` : valeur longue en chasse fixe et coupée au milieu (chemin d'un dossier). | Le chemin en texte, qui passe à la ligne. |
| Mise en page dans un contenu libre (`Popover`, `Card`, pied de `Modal`) : pile et rangée avec un écart de l'échelle Socle ; texte secondaire (`muted`, `meta`). Socle n'exporte ni `Stack`, ni `Row`, ni `Text`. | `Stack`, `Row` et `Text` du kit d'Alfred (`src/kit`), dans 7 fichiers de la conversation. |
| `InlineEdit` dans la barre d'outils d'une `Page` : largeur bornée. | `agents-page__title` (420 px au plus). |
| Fenêtre secondaire avec panneau de détail, sans `AppShell` (fenêtre Agent détachée). | `agents-page__side` : largeur `--detail-w`, bord gauche. |
| Calque de sélection d'une zone sur une capture (correction d'interface). | `uiFix.tsx` et `ui-fix.css`, hors conversation. |
| Schéma Mermaid : rendu d'un SVG dans le Markdown (`renderCode`). | `MermaidDiagram` local ; la source en `Code` `block` si le dessin échoue. |
| `socle-ui/biome` : `lint/a11y/useValidAriaRole` refuse `role="user"` et `role="assistant"` de `ChatMessage`. | `biome.json` d'Alfred : `allowInvalidRoles: ["user", "assistant"]`. À mettre dans la configuration de Socle. |
