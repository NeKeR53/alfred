# Où va chaque chose : guide de placement

Lis ce guide **avant** `place_page`, à chaque demande qui ajoute ou déplace quelque chose à l’écran. Il dit où va chaque élément que l’utilisateur demande, et pourquoi. `DESIGN.md` dit ensuite comment écrire la page ; la spec du composant dit ses options.

Ce guide applique les règles de placement de socle-ui, le design system d’Alfred : `docs/alfred/socle/docs/layout-rules.md`, et les décisions citées ici (D-xxx), dans `docs/alfred/socle/docs/decisions.md`. Il ne les contredit jamais. En cas de doute, la règle de Socle gagne.

Trois principes :

1. **Tu ne crées aucune place.** Chaque élément va dans une zone qui existe déjà : le menu, la barre du haut, le gabarit de la page, le panneau de droite, une fenêtre, les Réglages. Une zone accepte certaines choses et en refuse d’autres (tableau de la section 2).
2. **Tu prends chaque élément dans Socle.** Un composant, un gabarit ou un motif de `socle-ui`, à la version installée : liste dans `DESIGN.md`, section 8, et spec dans `docs/alfred/socle/specs/<Composant>.md`. Jamais un composant inventé, jamais une imitation en HTML.
3. **Si tu ne sais pas, tu demandes.** Quand ce guide ne tranche pas, pose une question à l’utilisateur, avec ta recommandation (section 9). Tu n’inventes jamais un placement.

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
| **Panneau de droite** : les propriétés de l’élément sélectionné | « le détail », « le panneau » | `{ "kind": "panel" }` | zone `detail`, `Drawer` (D-018) |
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
| Panneau de droite | Les propriétés de l’élément sélectionné, modifiables sur place ; l’aide ; les pièces jointes | Le contenu principal, une liste, une action destructrice sans confirmation | layout-rules, `detail` ; D-018 |
| Fenêtre | Une saisie courte, une confirmation, un aperçu | Une page entière, une navigation | layout-rules, « Fenêtre secondaire » ; D-124 |
| Réglages | Les préférences du module | Le travail de tous les jours, les comptes des services | D-015, D-007 |

La coquille d’Alfred dessine le menu, la barre du haut, la cloche, le bouton du panneau et les Réglages. Une page ne les rend jamais.

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
| Autre chose : tableau de bord, synthèse, éditeur, graphique | `Page` et `PageSection` | D-217, D-218 |

Une page ne met jamais une liste et un détail côte à côte : la liste dans le contenu, le détail dans le panneau de droite, l’élément entier dans un onglet ouvert. Une `DetailPage` ne montre pas les propriétés : elles vont dans le panneau (D-210).

**L’ordre du contenu.** Chaque gabarit a ses zones (layout-rules, « Gabarits ») ; chaque spec a une partie « Contenu » qui dit quoi écrire et dans quel ordre. Lis-les avant de ranger les informations :

- `ListPage` : la première colonne est le nom de l’élément ; puis ce qui sert à choisir (état, échéance, responsable) ; le détail va au panneau. Trois filtres au plus (D-174).
- `DetailPage` : l’en-tête dit quoi (titre, statut, méta) ; les sections suivent l’ordre de lecture : le contenu principal d’abord, l’historique à la fin (D-210).
- `Drawer` : l’état et ce qui se modifie souvent en haut ; les blocs longs repliés (`defaultCollapsed`) ; l’ordre est fixe (D-185).
- `Page` composée : ce qui demande une action d’abord (en retard, à traiter), puis la synthèse, puis le reste (D-217).
- `FormPage` et `useOpenForm` : les champs obligatoires d’abord, regroupés par sens (`Fieldset`, sections) ; la largeur du champ annonce la longueur attendue (D-133).

**Le panneau de droite.** Une page a un panneau au plus. Il rend un `Drawer` seul, à sa racine : l’en-tête de l’élément sélectionné, puis ses propriétés en sections (DESIGN.md, section 6). Une propriété se modifie par l’action de sa ligne : un menu de choix, un interrupteur (`Toggle`, D-137) ou une fenêtre (`useOpenForm`). Le panneau ne contient jamais une liste d’éléments, un formulaire ni le contenu principal (layout-rules, `detail`).

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
- De deux à quatre options, la première est ta recommandation, marquée « (recommandé) ». L’utilisateur peut aussi répondre autre chose.
- Une seule question par réponse, celle du bloc : pas d’autre question dans le texte. Une autre idée (une notification, une page de plus) attend la réponse, et se propose ensuite.
- Puis termine ton tour. Ne construis rien de ce qui dépend de la réponse.
- Dans une conversation lancée par une page ou dans une tâche déléguée, personne ne répond : prends ta recommandation, et écris la question et ton choix dans ta réponse (ou dans `questions` du contrat de retour).

**Ce que tu ne fais jamais.** Inventer une zone, un composant, une option d’un composant, ou une imitation en HTML de ce que Socle n’a pas. Si l’utilisateur confirme un besoin que Socle n’a pas, dis-lui que les composants d’Alfred ne le prévoient pas encore, construis la solution la plus proche que Socle permet, et dis laquelle.

## 10. Proposer avant de construire

Pour un nouveau module, une nouvelle entrée du menu, ou un changement de structure (nouvel onglet fixe, panneau, section du menu), propose d’abord la disposition, puis construis après l’accord. L’utilisateur voit la page avant que tu écrives les données, les fonctions et les connecteurs : il corrige tôt, et tu ne refais rien.

1. **Le plan, en quelques phrases.** Dis où va chaque chose, avec les mots de l’utilisateur : « Une entrée Factures dans le menu, avec deux onglets : la liste des factures et les relances. Une facture choisie montre ses montants et son état à droite ; un double-clic l’ouvre dans un onglet. “Nouvelle facture” en haut de la liste. » Pas de tableau ni de nom de composant : ta réponse est lue à voix haute.
2. **La maquette.** Place les pages (`place_page`) et écris-les avec les vrais gabarits de Socle et quelques données d’exemple écrites dans le fichier (une constante `EXEMPLE`), sans migration, sans fonction, sans client. `check`, puis `page_screenshot` de chaque page : l’utilisateur voit la capture dans la conversation, et la page dans son menu.
3. **La question.** Termine par un bloc `alfred-question` : `{"question":"Je construis les factures ainsi ?","options":["Oui, construis (recommandé)","Changer la disposition","Changer les informations montrées"]}`. Termine ton tour.
4. **Après l’accord**, remplace les données d’exemple par les vraies (migration, fonctions, connecteur) et livre une page entièrement fonctionnelle (`docs/alfred/guides/page.md`, « Créer une page »). Après une correction, reprends la maquette et redemande. Si l’utilisateur renonce, retire les pages (`delete_page`).

Ne propose pas pour une correction, une petite addition dont la place est évidente (une colonne, une action, un champ), ou quand l’utilisateur a dit de construire directement. Dans une conversation lancée par une page ou dans une tâche déléguée, construis directement.

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
    isLoading={tickets.loading} hasError={Boolean(tickets.error) && !tickets.data} onRetry={tickets.refresh}
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
- **Chiffres clés** : une `Card` `variant="metric"` par chiffre qui mène quelque part (« À encaisser », « En retard »), avec `onPress` qui ouvre la liste (`shell.navigate`). Pas de chiffre sans action, pas de mur de cartes.
- **Blocs** : `PageSection` « Factures en retard » avec une `Table` et son `empty` (« Aucune facture en retard ») ; un graphique par une librairie npm, aux couleurs `--chart-1` à `--chart-8` (principes de Socle, D-338).
- **Actions** : « Exporter » dans `actions` de `Page` (zone `toolbar`).

```tsx
<Page state={…} onRetry={…}
  toolbar={<SegmentedControl label="Période" options={PERIODES} value={periode} onChange={setPeriode} />}
  actions={[{ id: "exporter", label: "Exporter en CSV", icon: <Download size={16} />, onPress: exporter }]}>
  <Row gap="md" wrap>
    <Card variant="metric" label="À encaisser" value={formatMontant(total)} onPress={() => void shell.navigate("factures/liste")} />
    <Card variant="metric" label="En retard" value={String(retard.length)} onPress={() => void shell.navigate("factures/relances")} />
  </Row>
  <PageSection title="Factures en retard" empty={retard.length ? undefined : { title: "Aucune facture en retard" }}>
    <Table … />
  </PageSection>
</Page>
```

Vérifie les options exactes de `SegmentedControl`, `Card` et `Table` dans leur spec (`docs/alfred/socle/specs/`).
