# Où va chaque chose : guide de placement

Lis ce guide **avant** `place_page`, à chaque demande qui ajoute ou déplace quelque chose à l’écran. Il dit où va chaque élément que l’utilisateur demande, et pourquoi. `DESIGN.md` dit ensuite comment écrire la page ; la spec du composant dit ses options.

Ce guide applique les règles de placement de socle-ui, le design system d’Alfred : `docs/alfred/socle/docs/layout-rules.md`, et les décisions citées ici (D-xxx), dans `docs/alfred/socle/docs/decisions.md`. Il ne les contredit jamais. En cas de doute, la règle de Socle gagne.

Quatre principes :

1. **Tu ne crées aucune place.** Chaque élément va dans une zone qui existe déjà : le menu, la barre du haut, le gabarit de la page, le panneau de droite, une fenêtre, les Réglages. Une zone accepte certaines choses et en refuse d’autres (tableau de la section 2).
2. **Tu prends chaque élément dans Socle.** Un composant, un gabarit ou un motif de `socle-ui`, à la version installée : liste dans `DESIGN.md`, section 8, et spec dans `docs/alfred/socle/specs/<Composant>.md`. Jamais un composant inventé, jamais une imitation en HTML.
3. **Si tu ne sais pas, tu demandes.** Quand ce guide ne tranche pas, pose une question à l’utilisateur, avec ta recommandation (section 9). Tu n’inventes jamais un placement.
4. **Une zone, une responsabilité.** Chaque zone de l’écran fait une seule chose : l’entrée du menu mène à un domaine, un onglet fixe porte un usage, un onglet ouvert montre un élément, le contenu fait le travail de l’onglet, le panneau de droite montre le détail de l’élément sélectionné, la barre du haut porte les actions. Une demande qui réunit plusieurs tâches (envoyer des PDF, lister les documents, poser une question) les sépare dans ces zones : elle ne les empile pas dans une page (section 2, « Pourquoi et quand prendre chaque zone »).

## 1. Les mots

L’utilisateur, les outils d’Alfred et Socle ne disent pas toujours la même chose. Ce guide emploie les mots de la première colonne.

| Ce guide dit | L’utilisateur dit | Les outils d’Alfred | Socle |
|---|---|---|---|
| **Entrée du menu** : un domaine de travail, avec une icône et un libellé | « une page », « une rubrique » | section ; `place_page` avec `{ "kind": "menu" }` | élément de navigation de `Sidebar` (D-002) |
| **Onglet fixe** : une vue d’une entrée du menu | « un onglet », « une vue » | page de la section ; `{ "kind": "tab" }` | vue de la page, dans la barre du haut (D-021) |
| **Onglet ouvert** : un élément ouvert (un ticket, une facture), fermable | « ouvrir le ticket » | `views.open` | vue fermable (D-021) |
| **Sous-entrées** : des objets suivis, sous l’entrée du menu | « les produits dans le menu » | zone de la page ; `menu.setEntries` | sous-pages d’un élément, sur un niveau (D-056) |
| **Section du menu** : un titre repliable, créé par l’usage, avec des entrées dessous | « le projet Atlas dans le menu » | `menu.addSection` | `Sidebar.Section` (D-002, D-045) |
| **Contenu** : le gabarit de la page | « la page » | le fichier de la page | zone `main` |
| **Panneau de droite** : la vue détail de l’élément sélectionné (sa fiche, une source citée, un aperçu) | « le détail », « le panneau » | `{ "kind": "panel" }` | zone `detail`, `Drawer` (D-018) |
| **Fenêtre** : une modale sur la page | « une fenêtre », « un formulaire » | `useOpenForm`, `useConfirm`, `Modal` | `Modal` (D-124, D-197) |
| **Fenêtre à part** : une page seule, dans sa fenêtre du système | « à côté », « dans une autre fenêtre » | `shell.openWindow` | — |
| **Réglages** : les préférences du module | « les paramètres » | `{ "kind": "settings" }` | Réglages (D-015) |

Quand l’utilisateur dit « page », il parle d’une entrée du menu, sauf s’il dit « onglet ».

## 2. Les zones de l’écran

```
┌──────────────┬───────────────────────────────────────────────┬──────────────┐
│ Menu         │ Titre  [Onglet fixe|Onglet fixe|Ticket ×]  ⋯ ⟳ [Action] 🔔 ▯ │ Panneau      │
│ ▸ Entrée     ├───────────────────────────────────────────────┤ de droite    │
│   sous-entrée│ Contenu : un gabarit                          │ (Drawer)     │
│ ▸ Entrée     │ ListPage, DetailPage, FormPage ou Page        │ propriétés   │
│ SECTION ˅    │                                               │ de l’élément │
│   entrée     │                                               │ sélectionné  │
│ Agent        │                                               │              │
│ Espace ˅ ⚙   │                                               │              │
└──────────────┴───────────────────────────────────────────────┴──────────────┘
```

| Zone | Ce qui y va | Ce qui n’y va jamais | Règle de Socle |
|---|---|---|---|
| Menu → entrées | Les domaines de travail : une icône, un libellé | Les vues d’un domaine (des onglets), des réglages | layout-rules, « sidebar → navigation » ; D-021 |
| Menu → sous-entrées | Des objets que l’utilisateur suit en permanence, sous l’entrée de leur page | Une icône par sous-entrée, un deuxième niveau | D-056 |
| Menu → sections | Les éléments d’une notion créée par l’utilisateur (un projet et ses lots) | Des réglages, du contenu de travail | layout-rules, « sidebar → sections » ; D-002 |
| Barre du haut | Le nom de l’entrée, ses onglets, les actions d’une `Page` composée | Recherche, filtres, résumé, état, actions sur un élément précis | layout-rules, `topbar` ; D-220, D-253 |
| Contenu | Un seul gabarit | La navigation, un deuxième gabarit, des onglets dans la page | layout-rules, `main` ; spec Tabs, « Exclus » |
| Panneau de droite | La vue détail de l’élément sélectionné : ses propriétés, modifiables sur place ; une source citée, un aperçu (PDF) ; l’aide ; les pièces jointes | Le contenu principal, une liste, une action destructrice sans confirmation | layout-rules, `detail` ; D-018 |
| Fenêtre | Une saisie courte, une confirmation, un aperçu | Une page entière, une navigation | layout-rules, « Fenêtre secondaire » ; D-124 |
| Réglages | Les préférences du module | Le travail de tous les jours, les comptes des services | D-015, D-007 |

La coquille d’Alfred dessine le menu, la barre du haut, la cloche, le bouton du panneau et les Réglages. Une page ne les rend jamais.

### Pourquoi et quand prendre chaque zone

Une zone porte une responsabilité, et une seule. C’est ce qui rend l’écran lisible d’un coup d’œil : l’utilisateur sait où regarder pour chaque chose, et chaque tâche garde toute sa place. Avant d’écrire une page, range chaque partie de la demande dans sa zone.

| Zone | Sa responsabilité | Quand la prendre | Pourquoi |
|---|---|---|---|
| Entrée du menu | Un domaine de travail | Un nouveau sujet que l’utilisateur rouvrira (« ma base documentaire », « mes factures ») | Le menu est la carte de l’espace. Une entrée par vue ou par élément le rendrait illisible. |
| Sous-entrées (`menu.setEntries`) | Aller d’un clic à un objet suivi | L’utilisateur navigue par objet et revient aux mêmes : un client, un projet, un tableau suivi | L’objet devient un lieu ; la page reste une seule, qui lit l’entrée choisie. |
| Section du menu (`menu.addSection`) | Une notion créée et nommée par l’utilisateur, avec ses éléments | L’utilisateur crée la notion (« le projet Atlas ») et veut la retrouver sous son nom | Le menu suit l’usage, sans une page par élément. |
| Onglet fixe | Un usage du domaine, un contexte | Deux tâches différentes dans un domaine (« Questions » et « Documents »), ou une autre façon de voir les mêmes données (« Synthèse ») | Chaque contexte garde sa place, son état et son gabarit. On passe de l’un à l’autre d’un clic, sans faire défiler. |
| Onglet ouvert (`views.open`) | Un élément précis, ouvert en entier | L’utilisateur ouvre un élément pour le lire ou le traiter : un document, un ticket, une conversation | L’élément a sa vue, fermable ; la liste reste intacte dans son onglet. Plusieurs éléments restent ouverts dans la barre. |
| Contenu (le gabarit) | Le travail de l’onglet, et lui seul | Toujours : c’est la tâche principale de l’onglet | Il prend toute la largeur pour une seule tâche ; le reste va dans les autres zones. |
| Panneau de droite (`Drawer`) | La vue détail de l’élément sélectionné | L’utilisateur choisit un élément dans le contenu et veut le voir sans quitter sa tâche : une fiche, une source citée, un PDF | Le contenu reste visible à côté ; choisir un autre élément change le détail. |
| Barre du haut, en-tête du gabarit | Les actions de la page ou de la collection | Ajouter, importer, actualiser, exporter | Une action est toujours au même endroit. Un gros bloc d’action au centre prend la place du travail. Quand la zone est vide, l’action revient dans son état vide. |
| Toute la page (`useFileDrop`) | Recevoir les fichiers glissés depuis le Finder | La page reçoit des fichiers (des PDF à indexer, des photos, un relevé), en plus de l’action « Ajouter… » de l’en-tête | On dépose là où l’on est, sans viser un cadre ; aucun bloc de dépôt ne prend la place du travail. |
| Fenêtre (`useOpenForm`, `Modal`) | Un geste court qui se termine | Créer, renommer, confirmer | Elle passe devant le travail, puis le rend tel quel. |
| Fenêtre à part (`shell.openWindow`) | Un élément gardé à côté | Un journal, une console à surveiller pendant un autre travail | Elle vit hors de la fenêtre principale. |
| Réglages | Les préférences du module | Un choix qui change rarement (« rappel la veille ») | Le travail de tous les jours n’en est pas encombré. |
| Notification, compteur | Prévenir | Un événement à signaler (notification) ; ce qui attend l’utilisateur (compteur de l’entrée) | L’information arrive sans occuper la page. |

## 3. L’arbre de décision

Pars de ce que l’utilisateur demande. Prends la première ligne qui convient.

- **Un nouveau domaine de travail** (« gère mes factures », « suis mes tickets Jira ») → une **entrée du menu**, donc un nouveau module (`place_page`, `kind: "menu"`). Sa première page est sa vue principale.
- **Une autre façon de voir le même domaine** (« une vue des factures en retard », « un tableau de bord des factures », « un planning ») → un **onglet fixe** de l’entrée existante (`kind: "tab"`).
- **Ouvrir un élément pour le lire ou le traiter en entier** (« ouvrir un ticket », « voir la facture ») → un **onglet ouvert** sur l’élément : `views.open` depuis `onOpen` de la liste, et une `DetailPage` dans cet onglet.
- **Voir et modifier les propriétés de l’élément choisi dans une liste** (état, priorité, responsable, dates) → le **panneau de droite** de la page (`kind: "panel"`), un `Drawer`.
- **Retrouver des objets précis dans le menu** (« mes cinq produits dans le menu », « chaque tableau suivi ») → des **sous-entrées** de l’entrée (`menu.setEntries`).
- **Une notion que l’utilisateur crée et nomme, dont il veut les éléments dans le menu** (un projet et ses lots, un client et ses contrats) → une **section du menu**, créée par l’usage (`menu.addSection`), avec ses entrées dessous.
- **Créer ou modifier un élément** → une **fenêtre** de formulaire (`useOpenForm`) jusqu’à six champs ; au-delà, une `FormPage` dans la page.
- **Confirmer une action irréversible** → l’action `danger` ou `confirm`, ou `useConfirm` (D-007, D-115).
- **Lancer une action** → une **`Action`**, dans la zone de ce qu’elle touche (section 6). Jamais un bouton posé dans la page.
- **Prévenir l’utilisateur** → un toast, une notification, un compteur ou un encart, selon le message (section 7).
- **Une préférence du module** (« rappel la veille ou le jour même ») → une page des **Réglages** (`kind: "settings"`).
- **Garder un élément à côté pendant le travail** (un journal, une console) → une **fenêtre à part** (`shell.openWindow`).
- **Rien de cela** → pose la question (section 9).

Ce qui n’est **pas** une entrée du menu : une vue (onglet fixe), un élément (onglet ouvert ou sous-entrée), un formulaire (fenêtre), un détail (panneau), une préférence (Réglages), une action. Un module a le plus souvent une seule entrée.

Une entrée du menu a de un à cinq onglets fixes. Le premier est la vue de tous les jours. Au-delà de cinq, le domaine est sans doute trop large : propose de le séparer en deux entrées (section 9).

## 4. Le menu : entrées, sous-entrées, sections

**Entrée du menu.** Elle ouvre son domaine sur son dernier onglet ouvert (D-021). Son libellé est un nom au pluriel ou un nom de service : « Factures », « Jira ». Son icône est une icône Lucide, ou le logo du service (AGENTS.md, « Icône de l’entrée »). Elle peut porter un compteur (`badge.set`) : ce qui attend l’utilisateur. La sidebar choisit l’entrée ; elle n’ouvre ni ne ferme d’onglet (D-021).

**Sous-entrées.** Elles se placent sous l’entrée, sur un seul niveau, sans icône (D-056). Prends-les quand l’utilisateur suit **en permanence** quelques objets et veut y aller d’un clic : ses produits, ses tableaux, ses boîtes. Une page, plusieurs sous-entrées : jamais une page par objet. Au-delà d’une dizaine d’objets, `visible` limite l’affichage (« Afficher plus », D-045). Pour une longue collection, garde la liste dans la page : le menu n’est pas une liste de données.

**Section du menu.** Un titre repliable, avec des entrées dessous (D-002). Elle naît de l’usage : quand l’utilisateur crée une notion qu’il nomme lui-même (« le projet Atlas ») et veut ses éléments dans le menu. La page la crée avec `menu.addSection` au moment où la notion est créée, la renomme avec le même `id`, la retire avec `menu.removeSection` quand la notion disparaît. Chaque entrée d’une section a une icône. Une section ne contient ni réglage ni contenu de travail (layout-rules).

Choisir entre les trois :

| L’utilisateur veut… | Place |
|---|---|
| Un domaine de travail | Entrée du menu |
| Aller d’un clic à quelques objets du domaine, toujours les mêmes | Sous-entrées de l’entrée |
| Retrouver dans le menu, sous son nom, une notion qu’il a créée, et ses éléments | Section du menu |
| Parcourir, chercher, filtrer beaucoup d’objets | Pas le menu : une `ListPage` |

## 5. La barre du haut et le contenu

**Onglets fixes.** Ils sont les vues d’une même entrée (D-021). Chaque onglet fixe est une page du module (`place_page`, `kind: "tab"`). Un onglet fixe ne se ferme pas. Prends-en un quand l’utilisateur passe souvent d’une vue à l’autre du même domaine : la liste, les relances, la synthèse. Jamais des `Tabs`, des `SegmentedControl` ni des boutons accolés dans le contenu pour faire des vues (spec Tabs, « Exclus »). Un `SegmentedControl` reste permis dans la barre d’outils d’une `Page` pour un mode d’affichage ou une période qui s’applique tout de suite (spec SegmentedControl).

**Onglets ouverts.** Ouvrir un élément ajoute un onglet fermable à son nom, après les onglets fixes, ou active celui qui le montre déjà (D-021) : `views.open({ id, label, params })` dans `onOpen` de la `ListPage` (double-clic ou Entrée). La même page lit `usePageContext()?.view` et rend la `DetailPage` de l’élément ; sans `view`, elle rend sa liste. Un onglet ouvert sert à lire ou traiter un élément en entier : son texte, ses commentaires, ses lignes. Pour seulement voir ses propriétés, le panneau suffit. Un élément qui n’a rien d’autre que ses propriétés (une facture de cinq champs) n’a pas d’onglet : pas d’`onOpen`, les propriétés au panneau, « Modifier » en action de ligne. N’utilise jamais `onOpen` pour ouvrir une fenêtre : dans Socle, ouvrir ajoute une vue (D-021).

**Le gabarit.** Le contenu rend un seul gabarit, choisi d’après ce que la page montre (DESIGN.md, section 2) :

| La page montre… | Gabarit | Règle de Socle |
|---|---|---|
| Des éléments de même nature à chercher, filtrer, ouvrir | `ListPage` | D-173 |
| Un élément ouvert en entier | `DetailPage`, avec `back` | D-210 à D-216 |
| Un formulaire long (plus de six champs, en sections) | `FormPage` | D-022, D-190 |
| Un échange de questions et de réponses | `ChatPage` | D-382 |
| Autre chose : tableau de bord, synthèse, éditeur, graphique | `Page`, `PageSection` et `PageGrid` | D-217, D-218, D-403 |

Une page ne met jamais une liste et un détail côte à côte : la liste dans le contenu, le détail dans le panneau de droite, l’élément entier dans un onglet ouvert. Une `DetailPage` ne montre pas les propriétés : elles vont dans le panneau (D-210).

**Vue d’ensemble d’abord** (layout-rules, D-404 ; DESIGN.md, section 2). Une zone, une responsabilité (section 2). Avant le gabarit, répartis la demande : un usage par onglet fixe, l’élément sélectionné au panneau, l’élément entier dans un onglet ouvert, les actions dans l’en-tête du gabarit ou la barre du haut. Le contenu garde le reste, sur toute la largeur, et tient ses informations clés sur un écran. Une page qui empile des blocs dans une colonne étroite (une question, des exemples, une zone de dépôt, une liste, une réponse) mélange plusieurs usages : sépare-les (exemple en section 11.4).

**L’ordre du contenu.** Chaque gabarit a ses zones (layout-rules, « Gabarits ») ; chaque spec a une partie « Contenu » qui dit quoi écrire et dans quel ordre. Lis-les avant de ranger les informations :

- `ListPage` : la première colonne est le nom de l’élément ; puis ce qui sert à choisir (état, échéance, responsable) ; le détail va au panneau. Trois filtres au plus (D-174).
- `DetailPage` : l’en-tête dit quoi (titre, statut, méta) ; les sections suivent l’ordre de lecture : le contenu principal d’abord, l’historique à la fin (D-210).
- `Drawer` : l’état et ce qui se modifie souvent en haut ; les blocs longs repliés (`defaultCollapsed`) ; l’ordre est fixe (D-185).
- `Page` composée : ce qui demande une action d’abord (en retard, à traiter), puis la synthèse, puis le reste (D-217) ; les blocs courts de même rang côte à côte dans une `PageGrid`, les informations clés sur un écran (D-403, D-404).
- `FormPage` et `useOpenForm` : les champs obligatoires d’abord, regroupés par sens (`Fieldset`, sections) ; la largeur du champ annonce la longueur attendue (D-133).

**Le panneau de droite.** C’est la vue détail de ce que l’utilisateur a sélectionné dans le contenu. Par défaut, il n’existe pas : Alfred ne le montre, avec son bouton, que quand la page a publié un élément choisi (`shell.publish`). Ne le crée que pour une page qui a une sélection, ou à la demande de l’utilisateur. Jamais de « Sélectionnez… » ni de configuration de compte dedans (`check` les refuse). Une page a un panneau au plus. Il rend un `Drawer` seul, à sa racine : l’en-tête de l’élément sélectionné, puis ses propriétés en sections (DESIGN.md, section 6). Une source citée y montre son passage, puis son document (`DocumentViewer` dans le `content` d’une section). Une propriété se modifie par l’action de sa ligne : un menu de choix, un interrupteur (`Toggle`, D-137) ou une fenêtre (`useOpenForm`). Le panneau ne contient jamais une liste d’éléments, un formulaire ni le contenu principal (layout-rules, `detail`).

## 6. Les actions

Une action est une **`Action`** (`id`, `label`, `icon`, `onPress`, `primary`, `danger`, `confirm`), passée au gabarit de la zone qu’elle touche. Le gabarit choisit sa forme : bouton à texte, icône ou entrée du menu « … » (D-111). Tu ne choisis jamais un bouton.

| L’action touche… | Elle va dans… | Zone (D-111) |
|---|---|---|
| Toute la collection : créer, importer, exporter, actualiser | `actions` de `ListPage` | `header` |
| Une ligne | `rowActions` de `ListPage` | `row` (une icône visible, le reste dans « … », D-114) |
| Les lignes cochées | `selectionActions` de `ListPage` (`selectionMode="multiple"`) | `toolbar` |
| L’élément ouvert dans un onglet | `actions` de `DetailPage` | `header` |
| L’élément sélectionné, dans le panneau | `header.actions` du `Drawer` | `section` |
| Une propriété de cet élément | `action` de sa ligne dans le `Drawer` | ligne (D-059) |
| Un groupe de propriétés | `actions` de la section du `Drawer` | `section` |
| Toute une `Page` composée | `actions` de `Page`, ou `useTopBarActions` | `toolbar`, ou `topbar` |
| Un bloc d’une `Page` | `actions` de `PageSection` | `section` |
| Une zone vide | l’action `primary` de la `ListPage` revient seule ; `empty.action` d’une `PageSection` | `empty` |

- Une seule action `primary` par zone, un seul bouton plein par écran (D-220).
- Une action destructrice est `danger` : dans « … », en dernier, toujours confirmée (D-115).
- `Button` ne sert qu’au pied d’une `Modal`, à l’action d’un `EmptyState`, au pied d’une section de `Drawer` et dans un `Popover`. `check` avertit d’un `Button` ailleurs.
- Aller vers une autre page n’est pas une action de bouton : c’est le menu, un onglet ou un `Link` (spec Button).

## 7. Les fenêtres et les messages

**Fenêtres.**

| Besoin | Composant | Règle de Socle |
|---|---|---|
| Créer, renommer, inviter : six champs au plus | `useOpenForm()`, appelé par une `Action` | D-197, D-198 |
| Confirmer une action irréversible | Action `danger` ou `confirm`, ou `useConfirm()` | D-007, D-126 à D-128 |
| Voir un contenu sans quitter la page (aperçu, choix) | `Modal`, pied « Annuler » puis l’action | D-124 |
| Un contenu court sans voile (filtrer, partager, réglage rapide) | `Popover` | spec Popover |
| Garder un élément à côté (journal, console) | `shell.openWindow` | — |

**Messages.** Jamais de bandeau pleine largeur (D-159). Jamais d’état ni de résumé dans la barre du haut (D-253).

| Message | Place | Règle de Socle |
|---|---|---|
| Le résultat d’une action, quand il ne se voit pas à l’écran | Toast : `shell.notify({ title, tone: "success" })` ; il va aussi au centre de notifications | D-154, D-156 |
| L’échec d’une action | `onActionError={notifyActionError}` sur le gabarit | D-116 |
| Un événement de fond (un ticket assigné, un import fini) | Notification d’une fonction ou d’une page : `shell.notify`, au centre de notifications (la cloche) | D-156, D-157 |
| Ce qui attend l’utilisateur (non lus, demandes) | Compteur de l’entrée du menu : `badge.set` | D-044 |
| Un état durable de la page (lecture seule, compte à relier, données d’exemple) | `Alert` en tête du contenu | D-085, D-253 |
| Une information sur un bloc précis | `Alert` en tête de ce bloc | D-085 ; spec Alert |
| Une erreur de saisie | Sous le champ, par `validate` ou `errors` du formulaire | D-132 |
| Un bloc sans données | `empty` de `PageSection`, ou de `ListPage` | D-166, D-176 |

Un réglage qui s’applique réussit en silence : pas de toast « Réglage enregistré » (D-007).

## 8. Les réglages d’un module

Une préférence du module (un rappel, un tri par défaut, un seuil) va dans une page des **Réglages** (`place_page`, `kind: "settings"`, avec `module`) : une `Page` sans `width`, des `PageSection`, des réglages qui s’appliquent tout de suite (DESIGN.md, section 7 ; D-007, D-200).

- Jamais une entrée du menu « Paramètres », ni un onglet « Réglages » dans l’entrée du module.
- Les comptes d’un service (adresse, identifiant, jeton) ne sont pas un réglage du module : Alfred les gère dans la fiche du module (Réglages → Modules).
- Un réglage d’un seul élément (« suivre ce ticket ») est une propriété : il va dans le panneau, en interrupteur de sa ligne.

## 9. Quand tu ne sais pas : demander

**Quand demander.** Avant de construire, pose une question si l’un de ces cas se présente :

- **Placement ambigu** : deux lignes de l’arbre (section 3) conviennent, et la demande ne les départage pas. Exemple : « ajoute les avoirs » alors qu’une entrée Factures existe (onglet de Factures, ou nouvelle entrée ?).
- **Aucun gabarit ni composant ne convient** : ce qui est demandé ne se range dans aucune zone, ou demande un composant que Socle n’a pas (une frise chronologique, un tableau croisé modifiable, un plan).
- **Demande hors Socle** : l’utilisateur demande une forme que Socle exclut (des onglets dans le contenu, une couleur propre, un bandeau, un bouton à un endroit interdit).
- **Domaine trop large** : plus de cinq onglets fixes, ou deux domaines mêlés dans une entrée.

Ne demande pas quand l’arbre de décision tranche, ni pour un détail qui se corrige en un instant. Une librairie npm pour un graphique, une carte, un calendrier ou un éditeur riche est déjà prévue (DESIGN.md, règle 9) : pas de question.

**Comment demander.** Une question à la fois, avec ta recommandation, à la fin de ta réponse, par le bloc que l’app montre en carte de choix au-dessus de la saisie :

````
J’hésite sur la place des avoirs.

```alfred-question
{"question":"Où dois-je mettre les avoirs ?","options":["Un onglet de Factures (recommandé)","Une nouvelle entrée du menu"]}
```
````

- La question nomme les deux places, en mots de l’utilisateur (« un onglet de Factures »), jamais en noms de composants.
- De deux à quatre options, la première est ta recommandation, marquée « (recommandé) ». Une option peut dire pourquoi elle convient : `{"label":"Un onglet de Factures (recommandé)","why":"Les avoirs se lisent avec les factures."}` ; la carte montre cette raison sous l’option. L’utilisateur peut aussi répondre autre chose.
- Une seule question par réponse, celle du bloc : pas d’autre question dans le texte. Une autre idée (une notification, une page de plus) attend la réponse, et se propose ensuite.
- Puis termine ton tour. Ne construis rien de ce qui dépend de la réponse.
- Dans une conversation lancée par une page ou dans une tâche déléguée, personne ne répond : prends ta recommandation, et écris la question et ton choix dans ta réponse (ou dans `questions` du contrat de retour).

**Ce que tu ne fais jamais.** Inventer une zone, un composant, une option d’un composant, ou une imitation en HTML de ce que Socle n’a pas. Si l’utilisateur confirme un besoin que Socle n’a pas, dis-lui que les composants d’Alfred ne le prévoient pas encore, construis la solution la plus proche que Socle permet, et dis laquelle.

## 10. Le parcours de création d’une page

Une nouvelle page, un nouveau module, une nouvelle entrée du menu ou un changement de structure (onglet fixe, panneau, section du menu) suivent toujours ce parcours : **questions, proposition, puis construction**. L’utilisateur choisit avant que tu écrives les données, les fonctions et les connecteurs : il corrige tôt, et tu ne refais rien. Après son accord, tu restes autonome : secrets, clients, accès et placement, sans rien lui laisser à faire (AGENTS.md).

**1. Les questions.** Avant toute ligne de code, éclaircis ces quatre points, dans cet ordre :

| Point | Ce que tu cherches | Exemple de question |
|---|---|---|
| Le but | Suivre, traiter une file, chercher, saisir, comparer | « À quoi doit servir la page ? » |
| Les données et le compte | Quels éléments, d’où, quel compte du service | « Quels builds dois-je montrer ? » |
| Les actions | Ce que l’utilisateur fait depuis la page | « Que voulez-vous faire depuis la page ? » |
| La fraîcheur | À quel rythme les données doivent se relire | « À quel rythme dois-je relire les builds ? » |

- **Saute ce qui est déjà dit.** Une demande précise (« la liste de mes factures impayées, avec relance en un clic ») répond déjà aux quatre : passe à la proposition. Ne pose une question que si sa réponse change la page.
- **Une question par réponse**, en carte de choix (section 9) : deux à quatre options, la première est ta recommandation, marquée « (recommandé) », et chaque option dit en une ligne pourquoi elle convient (`why`). Puis termine ton tour.
- **Quatre questions au plus** pour une page. Ce que tu peux lire toi-même (comptes existants, tables, données d’un service) ne se demande pas : lis-le (`space_overview`, `alfred api`, `alfred run`).

```alfred-question
{"question":"À quoi doit servir la page des builds ?","options":[{"label":"Surveiller les échecs (recommandé)","why":"Vous parlez de builds cassés : un coup d’œil, les échecs en haut."},{"label":"Lancer et relancer des builds","why":"Une liste avec les actions sur chaque job."},{"label":"Comparer les durées","why":"Un tableau de bord avec l’évolution."}]}
```

**2. La proposition.** Quand les points sont clairs, propose une structure concrète, ou deux variantes quand deux formes se valent vraiment (jamais plus de deux) :

- **Le plan, en quelques phrases**, avec les mots de l’utilisateur : la recette de départ, ce que montre chaque zone (barre du haut, contenu, panneau s’il y a une sélection), les actions et leur place. « Une entrée Builds dans le menu. En haut, quatre chiffres : en échec, en cours, en file, réussis aujourd’hui. Dessous, les jobs suivis côte à côte, chacun avec son état, sa dernière exécution et “Relancer”. Un job choisi montre ses derniers builds à droite. » Pas de tableau ni de nom de composant : ta réponse est lue à voix haute.
- **La maquette de ta recommandation.** Place les pages (`place_page`) et écris-les à partir de la recette (`// Recette : …` en première ligne), avec les vrais gabarits de Socle et des données d’exemple réalistes écrites dans le fichier (une constante `EXEMPLE` : assez de lignes pour remplir l’écran, des états variés), sans migration, sans fonction, sans client. Passe l’auto-revue (`docs/alfred/guides/page.md`, étapes 7 bis et 7 ter), puis `page_screenshot` : l’utilisateur voit la capture dans la conversation, et la page dans son menu.
- **La validation**, en carte de choix : `{"question":"Je construis la page des builds ainsi ?","options":[{"label":"Oui, construis (recommandé)","why":"Les échecs se voient d’un coup d’œil."},{"label":"Plutôt la variante B","why":"La liste des builds, filtrable, détail à droite."},{"label":"Changer les informations montrées"}]}`. Termine ton tour.

**3. La construction**, après l’accord : remplace les données d’exemple par les vraies (migration, fonctions, connecteur) et livre une page entièrement fonctionnelle (`docs/alfred/guides/page.md`, « Créer une page »). Après une correction, reprends la maquette et redemande. Si l’utilisateur renonce, retire les pages (`delete_page`).

**Un défaut raisonnable.** Ta recommandation est toujours le défaut. Si l’utilisateur répond sans trancher (« vas-y », « comme tu veux », « je ne sais pas »), prends-la et passe à l’étape suivante. Ne repose jamais la même question.

Pas de parcours pour une correction, une petite addition dont la place est évidente (une colonne, une action, un champ), ou quand l’utilisateur a dit de construire directement. Dans une conversation lancée par une page ou dans une tâche déléguée, personne ne répond : prends tes recommandations, construis, et écris-les dans ta réponse.

## 11. Exemples complets

### 11.1 Jira : les tickets, un ticket ouvert, ses propriétés

Demande : « Je veux suivre mes tickets Jira. »

- **Entrée du menu** « Jira », logo de Jira : un nouveau domaine. Module `jira`, avec le connecteur du service (AGENTS.md, « Connecteur d’un service »).
- **Onglet fixe** « Mes tickets » : `ListPage` des tickets (clé, résumé, état en `status`, priorité, mise à jour en `relative`), recherche et filtre d’état du gabarit. Un deuxième onglet fixe, « Suivis », seulement si l’utilisateur en parle.
- **Panneau de droite** de « Mes tickets » : un `Drawer` sur le ticket sélectionné. En-tête : « ALF-12 · Export en échec », état, actions « Ouvrir dans Jira » et « Commenter ». Sections « Suivi » (état et priorité, modifiables par le menu de leur ligne ; responsable, modifiable par une fenêtre) et « Dates ».
- **Onglet ouvert** sur un ticket : double-clic → `views.open({ id: ticket.key, label: \`${ticket.key} ${ticket.summary}\`, params: { key: ticket.key } })`. La même page rend une `DetailPage` : description en `Markdown`, commentaires dans une section, action `primary` « Commenter », action `danger` « Supprimer » qui ferme l’onglet (`views.close()`).
- **Actions** : « Nouveau ticket » (`primary`, en-tête de la liste) ouvre `useOpenForm` (projet, type, résumé, priorité) ; « Actualiser » (icône `RefreshCw`) en en-tête, car les tickets changent hors d’Alfred ; « Ouvrir dans Jira » en action de ligne.
- **États** (règle obligatoire, SDK.md section 3) : le module `jira` est **fournisseur**. Il déclare l’entité `ticket` (`key: "cle"`) et l’état `mes-tickets` (liste de tickets), avec sa politique : `refresh: { "function": "rafraichir-mes-tickets", "every": 30, "incremental": true }` (la fonction ne demande à Jira que les tickets modifiés depuis `since`). `lire-ticket` alimente l’entité (`param: "cle"`). La liste s’abonne à `mes-tickets`, le panneau et l’onglet à `jira/ticket` avec la clé : jamais `functions.call` pour afficher une donnée. Un tableau de bord d’un autre module s’abonne aux mêmes états par `requires`, sans écrire sa propre lecture ; un filtre choisi par l’utilisateur est un état à paramètres (`tickets-du-filtre`, `params: ["jql"]`). Relire un ticket met à jour la liste, le panneau, l’onglet et le tableau de bord ; « Commenter » (une écriture) fait relire les états suivis.
- **Messages** : une fonction planifiée relève les tickets assignés ; un nouveau ticket → `shell.notify` (au centre de notifications) et `badge.set` sur l’entrée.
- **Réglages** : « Projet par défaut » dans une page des Réglages du module.

```tsx
// pages/tickets.tsx : la liste, ou le ticket ouvert dans un onglet.
const tickets = useAlfredState<Ticket[]>("mes-tickets");
const view = usePageContext()?.view ?? null;
if (view) return <Ticket cle={String(view.params?.key ?? view.id)} />;
return (
  <ListPage
    title="Mes tickets"
    rows={tickets.data}
    columns={[{ id: "key", label: "Clé" }, { id: "summary", label: "Résumé" },
      { id: "status", label: "État", type: "status", statuses: ETATS }, { id: "updated", label: "Mis à jour", type: "relative" }]}
    empty={{ title: "Aucun ticket", description: "Les tickets qui vous sont assignés s’affichent ici." }}
    actions={[{ id: "nouveau", label: "Nouveau ticket", icon: <Plus size={16} />, primary: true, onPress: creer },
      { id: "actualiser", label: "Actualiser", icon: <RefreshCw size={16} />, onPress: tickets.refresh }]}
    rowActions={(t) => [{ id: "jira", label: "Ouvrir dans Jira", icon: <ExternalLink size={16} />, onPress: () => shell.openExternal(t.url) }]}
    selectedId={choisi}
    onSelect={(row) => { setChoisi(row?.id ?? null); void shell.publish(row?.key ?? null); }}
    onOpen={(t) => void views.open({ id: t.key, label: `${t.key} ${t.summary}`, params: { key: t.key } })}
    isLoading={tickets.refreshing} hasError={Boolean(tickets.error) && !tickets.data} onRetry={tickets.refresh}
    onActionError={notifyActionError}
  />
);
```

### 11.2 Une notion créée par l’usage : des chantiers et leurs lots

Demande : « Je gère des chantiers. Chaque chantier a des lots, et je veux retrouver les lots de chaque chantier dans le menu. »

- **Entrée du menu** « Chantiers » : `ListPage` des chantiers, « Nouveau chantier » en action `primary`.
- **Section du menu** par chantier : à la création, `menu.addSection({ id, title: nom, page: "lot" })`, puis `menu.setEntries(lots, { section: id })`, une entrée par lot avec son icône et son état. Renommer le chantier rappelle `addSection` avec le même `id` ; le supprimer appelle `menu.removeSection(id)`.
- **Onglet fixe** « Lot » (page `lot`) : ouverte par une entrée de section, elle lit `usePageContext()?.entry` (`{ id, label, section }`) et rend la `DetailPage` du lot ; sans entrée, elle liste tous les lots.
- **Panneau de droite** du lot : avancement, responsable, dates.

Pourquoi une section et pas des sous-entrées : l’utilisateur crée et nomme chaque chantier, et chaque chantier a ses propres éléments. Des sous-entrées conviennent à une seule liste d’objets suivis, sous l’entrée.

### 11.3 Un tableau de bord

Demande : « Ajoute une synthèse de mes factures. »

- **Onglet fixe** « Synthèse » de l’entrée Factures : une autre vue du même domaine. Pas une nouvelle entrée du menu.
- **Gabarit** `Page` : aucun autre ne convient (D-217). Dans `toolbar`, un `SegmentedControl` de période (« Mois », « Trimestre », « Année »), qui s’applique tout de suite.
- **Chiffres clés** : une `Card` `variant="metric"` par chiffre qui mène quelque part (« À encaisser », « En retard », « Encaissé ce mois »), avec `onPress` qui ouvre la liste (`shell.navigate`), côte à côte dans une `PageGrid`. Pas de chiffre sans action, pas de mur de cartes.
- **Blocs**, côte à côte dans une seconde `PageGrid` : `PageSection` « Factures en retard » avec une `Table` et son `empty` (« Aucune facture en retard ») ; `PageSection` « Encaissements » avec un graphique par une librairie npm, aux couleurs `--chart-1` à `--chart-8` (principes de Socle, D-338). Toute la synthèse tient sur un écran.
- **Actions** : « Exporter » dans `actions` de `Page` (zone `toolbar`).

```tsx
<Page state={…} onRetry={…}
  toolbar={<SegmentedControl label="Période" options={PERIODES} value={periode} onChange={setPeriode} />}
  actions={[{ id: "exporter", label: "Exporter en CSV", icon: <Download size={16} />, onPress: exporter }]}>
  <PageGrid columns={3}>
    <Card variant="metric" label="À encaisser" value={formatMontant(total)} onPress={() => void shell.navigate("factures/liste")} />
    <Card variant="metric" label="En retard" value={String(retard.length)} onPress={() => void shell.navigate("factures/relances")} />
    <Card variant="metric" label="Encaissé ce mois" value={formatMontant(encaisse)} onPress={() => void shell.navigate("factures/liste")} />
  </PageGrid>
  <PageGrid>
    <PageSection title="Factures en retard" empty={retard.length ? undefined : { title: "Aucune facture en retard" }}>
      <Table … />
    </PageSection>
    <PageSection title="Encaissements">
      <div ref={graphique} />
    </PageSection>
  </PageGrid>
</Page>
```

Vérifie les options exactes de `SegmentedControl`, `Card`, `PageGrid` et `Table` dans leur spec (`docs/alfred/socle/specs/`).

### 11.4 Une base documentaire : questionner et gérer les documents

Demande : « Une base documentaire : mes PDF indexés, et des réponses à mes questions, avec les sources. »

Trois tâches dans une demande : poser une question, consulter une source, gérer les documents. Chacune a sa zone ; aucune page ne les empile.

- **Entrée du menu** « Base documentaire » : un nouveau domaine.
- **Onglet fixe** « Questions », le premier, la vue de tous les jours : une `ChatPage` (DESIGN.md, section 10). On pose une question en bas ; on lit la réponse dans le relevé, avec ses sources en puces (`SourceList` : document et page). L’état vide du relevé dit à quoi sert la page et propose deux ou trois questions d’exemple (`suggestions` de l’`EmptyState`) : elles partent à la première question. Un modèle à installer se dit par un `Alert` dans la zone `alerts`. Les échanges se gardent en base. Un PDF déposé sur la conversation s’ajoute aux documents (`useFileDrop`, `isDraggingFiles` de la `ChatPage`).
- **Panneau de droite** de « Questions » : un clic sur une source la publie (`shell.publish`) et ouvre le panneau (`shell.setPanelVisible(true)`) ; le panneau montre cette source : le document et la page en en-tête, le passage cité, puis le PDF à la page citée (`DocumentViewer` avec `page={source.page}`, `files.read`, `loadPdf`). Le relevé reste visible à côté.
- **Onglet fixe** « Documents » : une `ListPage` sur toute la page (nom, état en `status`, pages, passages, date d’ajout en `date`), recherche et filtre d’état du gabarit. Ajout par l’en-tête ou dépôt sur la page : « Ajouter des PDF » est l’action principale de l’en-tête, qui appelle `files.pick` ; un PDF glissé n’importe où sur la page s’ajoute aussi, par `useFileDrop({ accept: ["pdf"], onFiles })`, dont `isDraggingFiles` montre le cadre de dépôt de la `ListPage` (SDK.md, section 9). Une liste vide propose l’action dans son état vide. Pas de bloc de dépôt : le dépôt prend toute la page.
- **Panneau de droite** de « Documents » : le document sélectionné. En-tête : son nom, son état ; actions « Ouvrir », « Relancer l’indexation », « Supprimer » (`danger`). Sections « Indexation » (pages, passages, date, erreur) et « Fichier ».
- **Onglet ouvert** sur un document : double-clic dans la liste → `views.open` ; la page lit `usePageContext()?.view` et rend une `DetailPage` (retour « Documents ») dont le corps est le `DocumentViewer` du PDF.
- **Messages** : une indexation en échec → `badge.set` sur l’entrée, tant qu’elle reste à reprendre.

À ne pas faire : une `Page` de 760 px (`width="text"`) qui empile « Poser une question », des questions d’exemple, une zone de dépôt `FileUpload`, la liste des documents et la réponse. Chacune de ces parties a sa zone ci-dessus.

La recette `KnowledgeBase` de socle-ui montre cette page finie, avec, pour chaque zone, sa responsabilité, quand la prendre et pourquoi (`docs/alfred/socle/recipes/KnowledgeBase.md` et sa capture ; DESIGN.md, section 2, « Partir d’une recette »).
