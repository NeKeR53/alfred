# Système de design d’Alfred

Ce document s’adresse à l’agent qui écrit une page, un panneau de droite ou une page des Réglages. Il est recopié en lecture seule dans chaque espace.

**Où mettre chaque chose** (entrée du menu, onglet, panneau, fenêtre, action, message, réglage) : lire d’abord `docs/alfred/PLACEMENT.md`, avant `place_page`. Ce document-ci dit comment écrire la page une fois sa place choisie. La doc de socle-ui à la version installée est dans `docs/alfred/socle/` : `AI.md` (liste et options), `specs/<Composant>.md` (une spec par composant), `docs/layout-rules.md` (règles de placement), `docs/decisions.md` (décisions D-xxx), `recipes/` (recettes de pages, chacune avec sa capture claire et sombre, section 2, « Partir d’une recette »). Sa partie « Mise en place » (styles, `SocleProvider`, Tailwind, Biome) concerne Alfred, pas une page.

**Vous ne dessinez pas : vous décrivez.** Les pages d’Alfred utilisent **socle-ui**, le design system partagé de l’utilisateur. Une page dit quelles données elle montre, de quel type elles sont et quelles actions l’utilisateur peut faire. Un gabarit de `socle-ui` décide du reste : la barre d’outils, la forme de chaque bouton (texte, icône ou menu « … »), le tableau, le format des dates et des montants, les champs d’un formulaire, les états de chargement, d’absence et d’erreur, les confirmations. Deux agents qui décrivent la même chose obtiennent la même page.

Alfred est précis, calme et fiable ; son ton est direct et opérationnel. Ce qu’Alfred n’est pas : un tableau de bord décoratif, un mur de cartes identiques, des métriques sans action, des dégradés, des icônes d’ornement.

**Une vue d’ensemble, pas une pile.** Une page se comprend d’un coup d’œil, sur toute la largeur. Avant d’écrire un bloc, répartissez la demande dans les zones d’Alfred : les vues dans les onglets de la barre du haut, les actions dans la barre du haut ou l’en-tête du gabarit, l’élément sélectionné dans le panneau de droite, l’élément ouvert dans un onglet (section 2, « Répartir avant de composer »). Le contenu garde le reste. Une page n’est pas une colonne étroite au milieu de l’écran, ni une pile de blocs qu’il faut faire défiler pour la comprendre, ni un bloc qui ne porte qu’une action.

Le transpileur ne vérifie pas les types : une option inventée est ignorée en silence, un composant inexistant fait échouer la page. L’outil `check` relit chaque page et signale sous `design` tout ce qui contourne socle-ui ; chaque remarque se corrige. Il avertit aussi d’une page qui mêle plusieurs tâches, empile ses blocs ou se rétrécit (`designWarnings`) et mesure sa capture (`review`) : ces avertissements se corrigent aussi, sauf quand une préférence de l’utilisateur (`designPreferences`) demande ce rendu.

## 1. Règles non négociables

1. **Une recette, puis un gabarit.** Avant d’écrire, partir de la recette la plus proche (section 2, « Partir d’une recette »). Une collection est une `ListPage`, un panneau de droite est un `Drawer` déclaratif, une saisie courte est `useOpenForm`, une saisie longue est une `FormPage`, un élément ouvert en entier est une `DetailPage`, un échange de questions et de réponses est une `ChatPage`. `Page`, avec `PageSection` et `PageGrid`, seulement quand aucun gabarit ne convient : tableau de bord, éditeur, graphique (sections 2 et 10).
2. **Des actions, pas des boutons.** Une action de page, de section, d’objet ou de ligne est une `Action` (section 4) passée au gabarit. Le gabarit choisit bouton à texte, icône ou entrée du menu « … ». `Button` ne sert qu’au pied d’une `Modal`, à l’action d’un `EmptyState`, au pied d’une section de `Drawer` et dans un `Popover` ; `check` avertit ailleurs.
3. **Imports.** Une page importe `react`, `lucide-react`, `socle-ui`, `socle-ui/markdown`, `socle-ui/markdown-editor`, `@alfred/sdk`, `@alfred/kit`, ses librairies npm et les fichiers de son module par chemin relatif (`./…`). Jamais un chemin interne de socle-ui (`socle-ui/dist/…`), ni une librairie que socle-ui enveloppe déjà (React Aria, Radix…). `@alfred/ui` n’existe plus (correspondance en section 15).
4. **Racine.** Le fichier exporte son composant par défaut (`export default function …`). Il rend un gabarit à la racine, dans tous ses états : le gabarit gère chargement, vide et erreur.
5. **Aucun style propre.** Ni `style`, ni `className`, ni `<style>`, ni balise HTML (`<div>`, `<span>`, `<button>`…), ni couleur en dur (`#3366ff`, `rgb(…)`). Une page règle les options des composants (`variant`, `size`, `tone`, `width`, `density`). L’écart entre deux composants vient de `Stack` et `Row` de `@alfred/kit`.
6. **Aucun doublon de la coquille.** Le nom de la page, les onglets, la cloche, le bouton du panneau et la navigation sont dessinés par Alfred. Une page ne rend ni `AppShell`, ni `Sidebar`, ni `NotificationCenter`, ni `SettingsPage`.
7. **Le sens passe par le type et le texte.** Un état est une valeur `status` avec son libellé et son ton (`StatusTone`), jamais une couleur.
8. **Français.** Les textes affichés sont en français, avec la typographie française (section 13).
9. **Un manque se compose.** Si aucun gabarit ne convient tel quel, composer des composants de socle-ui dans une `Page`. Ce que socle-ui ne fait pas du tout (un graphique, une carte, un calendrier, un éditeur riche) passe par une librairie npm (section 8). Pour tout autre manque, demander à l’utilisateur avant de construire (PLACEMENT.md, section 9).
10. **Les noms actuels.** Écrire le nom actuel de chaque composant (catalogue, section 8). Un ancien nom (`Switch`, `TextField`, `Dialog`…) marche encore, mais `check` avertit avec le nouveau nom. Un nom qui n’existe pas dans socle-ui est une erreur de `check`.
11. **Vue d’ensemble d’abord.** Une zone de l’écran, une responsabilité. Répartir avant de composer (section 2) : un usage par onglet, les actions dans la barre du haut ou l’en-tête, l’élément sélectionné au panneau, l’élément ouvert en onglet. Le contenu prend toute la largeur et tient ses informations clés sur un écran. Les blocs courts et de même rang se rangent côte à côte (`PageGrid`) : jamais une longue pile de `PageSection` (sauf une page des Réglages, qui se lit de haut en bas, section 7). Une colonne étroite centrée sert seulement à lire un texte (`width="text"`, `DetailPage`) ou à converser (`ChatPage`). Règle de Socle : layout-rules, « Vue d’ensemble d’abord » (D-404).

La règle 5 est absolue. L’utilisateur règle le mode clair ou sombre et l’accent ; les composants les suivent. Une couleur écrite dans une page est illisible dans l’un des thèmes.

## 2. La coquille et le choix du gabarit

```
┌───────────┬──────────────────────────────────────┬──────────────────┐
│ ▯         │ Titre [Onglet 1|Onglet 2]  ⋯ ⟳ [Nouv.] cloche ▯ │ Panneau ⤢ ✕ │
├───────────┼──────────────────────────────────────┼──────────────────┤
│ Section A │  gabarit de la page                  │ Drawer      │
│ Section B │  (ListPage, Page, DetailPage…)       │ de l’objet       │
│ …         │                                      │ sélectionné      │
│ Agent     │                                      │                  │
│ Espace ˅  │                                      │                  │
│ Réglages  │                                      │                  │
└───────────┴──────────────────────────────────────┴──────────────────┘
```

Le placement se décide avant d’écrire la page : `docs/alfred/PLACEMENT.md` dit, pour chaque demande, si elle devient une entrée du menu, un onglet fixe, un onglet ouvert sur un élément, des sous-entrées, une section du menu, le panneau de droite, une fenêtre ou une page des Réglages. Ce qui compte pour écrire la page :

- La barre du haut appartient à la coquille. Une `Page` composée peut y mettre des actions (`useTopBarActions`, section 4). Elle n’y met **ni résumé ni état** (D-253) : un chiffre clé va dans l’en-tête du gabarit ou dans le contenu, un état durable dans un `Alert` en tête du contenu. Elle n’y met **pas de recherche** : la recherche d’une collection est celle de `ListPage`.
- Chaque page peut déclarer **un** panneau de droite. L’utilisateur l’affiche, le masque et choisit sa largeur.
- **Ouvrir un élément ajoute un onglet fermable** (D-021) : `views.open({ id, label, params })` ; la page lit `usePageContext().view` et rend l’élément (SDK.md, section 8, « Onglet sur un élément »).
- Des entrées du menu sous l’entrée de la page (`menu.setEntries`) ou dans une section créée par l’usage (`menu.addSection`) : SDK.md, section 8.
- Le placement d’une page, son titre et l’icône de son entrée se déclarent hors du fichier de la page (`place_page`).
- Une page est affichée dans un cadre isolé, sans réseau ni disque : ses données passent par `@alfred/sdk`. Une modale, un menu ou une infobulle restent dans son cadre. `window.alert`, `window.confirm` et `<a href>` ne fonctionnent pas.

Choisir le gabarit d’après ce que la page montre :

| La page montre… | Gabarit | Placement |
|---|---|---|
| Des éléments de même nature (tâches, contacts, factures, fichiers), à chercher, filtrer, ouvrir | `ListPage` (section 5) | Onglet d’une section |
| Les propriétés de l’élément sélectionné dans la liste de sa page | `Drawer` déclaratif (section 6) | Panneau de droite (`{ "kind": "panel" }`) |
| Des préférences du module | `Page` et `PageSection`, avec des réglages immédiats (section 7) | Réglages (`{ "kind": "settings" }`) |
| Une saisie courte (créer, renommer, inviter : six champs au plus) | `useOpenForm()` (section 9), appelé par une `Action` | Modale |
| Une saisie longue (une fiche riche, une demande) | `FormPage` (section 9) | Vue de la page |
| Une confirmation avant d’agir | `Action` `danger` ou `confirm` (section 4), ou `useConfirm()` | Modale |
| Un contenu à voir sans quitter la page (aperçu, choix) | `Modal` (section 9) | Modale |
| Un élément à lire ou traiter en entier depuis une liste | `DetailPage` avec `back` (section 10) | Onglet fermable ouvert sur l’élément (`views.open`) |
| Une autre page de l’espace | `shell.navigate("module/page")` ; `shell.openWindow` pour une fenêtre à part | L’onglet de cette page |
| Un échange de questions et de réponses (avec l’IA, sur des documents) | `ChatPage` (section 10) | Un onglet fixe à lui |
| Autre chose : tableau de bord, synthèse, éditeur, graphique | `Page`, `PageSection` et `PageGrid` (section 10) | Onglet |

Une page qui liste ET montre le détail est une `ListPage` qui publie sa sélection, plus un `Drawer` déclaré comme son panneau : jamais une liste et un détail côte à côte dans la même page.

Des vues d’une même page (« À faire », « Terminées », « Planning ») sont des pages distinctes de la section : ses onglets fixes. Un élément ouvert (un ticket, une facture) est un onglet fermable (`views.open`). Jamais des `Tabs` dans le contenu d’une page (spec Tabs, « Exclus » ; `check` avertit), ni des boutons accolés.

### Répartir avant de composer

Une zone de l’écran porte une responsabilité, et une seule : l’entrée du menu mène à un domaine, un onglet fixe porte un usage, un onglet ouvert montre un élément, le contenu fait le travail de l’onglet, le panneau de droite montre le détail de l’élément sélectionné, la barre du haut porte les actions. Le pourquoi et le quand de chaque zone : PLACEMENT.md, section 2. Une page qui fait plusieurs choses ne les empile donc pas : chacune va dans sa zone. Décidez des zones avant d’écrire un bloc (layout-rules, « Vue d’ensemble d’abord », D-404).

| La demande contient… | Sa place | Pas |
|---|---|---|
| Deux usages d’un même domaine (poser des questions, gérer les documents) | Deux onglets fixes de l’entrée (`place_page`, `kind: "tab"`) | Deux blocs l’un sous l’autre |
| Une collection (documents, factures, tâches) | Une `ListPage` sur toute la page : recherche, filtres, compteur | Une `List` dans un bloc |
| L’élément sélectionné : sa fiche, une source citée, un PDF | Le panneau de droite (`Drawer`) : la vue détail | Un bloc de détail à côté de la liste |
| Un élément à lire en entier (un PDF, un ticket) | Un onglet ouvert (`views.open`) : `DetailPage`, `DocumentViewer` | Un aperçu dans un bloc |
| Une action de la page (ajouter, importer, actualiser, exporter) | L’en-tête du gabarit (`actions`) ; pour une `Page`, la barre du haut (`useTopBarActions`) ou la barre d’outils | Un bloc qui ne porte qu’une action |
| Des fichiers à importer | Ajout par l’en-tête ou dépôt sur la page : une action « Ajouter des PDF » (`files.pick`), et `useFileDrop` de `@alfred/sdk`, dont `isDraggingFiles` va au gabarit (SDK.md, section 9) | Un bloc `FileUpload`, une zone de dépôt dessinée dans la page |
| Une question et sa réponse | Un onglet `ChatPage` : la saisie en bas, les réponses et leurs sources dans le relevé | Un champ de texte et un bloc « Réponse » |
| Des exemples (questions types, premiers pas) | L’état vide de la zone : `suggestions` de l’`EmptyState`, quatre au plus ; ils partent avec lui | Un bloc permanent |
| Des chiffres clés, des listes courtes de même rang | Une `PageGrid` : côte à côte, sur un écran | Une pile de `PageSection` |
| Un état durable (modèle à installer, données d’exemple) | Un `Alert` en tête du contenu | Un bandeau, un bloc à part |
| Ce qui attend l’utilisateur (non lus, échecs à reprendre) | Le compteur de l’entrée du menu (`badge.set`) | Un chiffre dans un titre de bloc |

Le contenu garde ce qui reste, sur toute la largeur. Une page composée tient ses informations clés sur un écran : une fenêtre de 1440 × 900, panneau ouvert (la page y a 928 × 862 px). Une colonne étroite centrée ne sert qu’à lire un texte (`DetailPage`, `width="text"`) ou à converser (`ChatPage`).

**Exemple : une base documentaire** (des PDF indexés, des questions en langage courant). À ne pas faire : une `Page` de 760 px qui empile « Poser une question », des questions d’exemple, une zone de dépôt, la liste des documents et la réponse. À faire : une responsabilité par zone.
- Onglet « Questions », le premier : une `ChatPage`. On pose une question en bas, on lit la réponse et ses sources dans le relevé ; les questions d’exemple sont dans l’état vide du relevé (`suggestions` de l’`EmptyState`).
- Panneau de droite de « Questions » : un clic sur une source l’ouvre là, avec le passage cité puis le PDF à la page citée (`DocumentViewer` avec `page`). Les sources d’une réponse sont des puces (`SourceList`, dans `sources` de `ChatMessage`). Le relevé reste visible à côté.
- Onglet « Documents » : une `ListPage` (nom, état, pages, date d’ajout ; recherche, filtre d’état), « Ajouter des PDF » en action principale de l’en-tête, le document sélectionné dans son panneau de droite (état, passages, « Ouvrir », « Relancer l’indexation », « Supprimer »).
- Toute la page, dans les deux onglets : un PDF glissé depuis le Finder s’ajoute aux documents (`useFileDrop`, et `isDraggingFiles` de la `ListPage` ou de la `ChatPage`).

PLACEMENT.md, section 11.4, détaille ce cas ; la recette `KnowledgeBase` le montre en entier.

### Partir d’une recette

socle-ui livre des recettes de pages : des pages complètes des types courants, faites seulement de ses gabarits et composants. Chacune dit quand la prendre ; puis, pour chaque zone, sa responsabilité dans la page, son composant, quand la prendre et pourquoi (les zones de « Répartir avant de composer ») ; ses actions, ses états (vide, chargement, erreur), son comportement, un squelette de code, ce qu’il faut éviter. Elle montre la page finie en deux captures, en clair et en sombre. Elles sont dans `docs/alfred/socle/recipes/` : la fiche (`KnowledgeBase.md`) et ses deux captures (`KnowledgeBase-clair.png`, `KnowledgeBase-sombre.png`), de même pour chaque recette.

Avant d’écrire une page, partez de la recette la plus proche : lisez sa fiche, regardez sa capture (l’outil de lecture de votre harnais ouvre une image), reprenez ses zones et ses composants. Après `page_screenshot`, comparez votre page à la capture.

| La page… | Recette |
|---|---|
| cherche des réponses dans des documents, avec leurs sources | `KnowledgeBase` (base de connaissances) |
| donne une vue d’ensemble chiffrée, sur un écran | `Dashboard` (tableau de bord) |
| traite des éléments un par un jusqu’à vider la file | `TriageQueue` (file de tri) |
| montre une collection et la fiche de l’élément choisi | `ListDetail` (liste et fiche) |
| montre des éléments qu’on reconnaît à leur image | `Catalog` (catalogue) |

Une recette est écrite pour la coquille de socle-ui (`AppShell`). Dans Alfred, chaque zone a son équivalent :

| Dans la recette | Dans Alfred |
|---|---|
| Onglet fixe : une vue de la barre du haut (`views`) | Un onglet fixe de la section : une page par vue (`place_page`, `kind: "tab"`) |
| Onglet ouvert : un élément ouvert en entier (vue fermable) | `views.open({ id, label, params })` ; la page lit `usePageContext()?.view` |
| Barre du haut : les actions de la page (`ActionBar` zone `topbar`) | `useTopBarActions` ; une `ListPage` garde ses actions dans son en-tête |
| Panneau de droite : la vue détail (`detail`, un `Drawer`) | La page du panneau (`kind: "panel"`) : un `Drawer` à sa racine, qui lit `useSelection()` ; la page publie sa sélection (`shell.publish`) |
| Le panneau ouvert par la page (`isDetailOpen`) | `shell.setPanelVisible(true)` ; la largeur (`detailWidth`, `detailExpandable`) reste le choix de l’utilisateur |
| Sous-entrées de la sidebar : naviguer par objet (`children` de `Sidebar.Item`) | `menu.setEntries` (SDK.md, section 8) |
| Le compteur d’une entrée de la sidebar (`count`) | `badge.set(total)` |
| Des fichiers déposés sur la page (`onDropFiles`) | `useFileDrop({ accept, onFiles })` de `@alfred/sdk`, et `isDraggingFiles` sur le gabarit : Alfred capte le dépôt, copie les fichiers dans ceux du module et les remet à `onFiles`. Jamais `onDropFiles` : le cadre ne voit pas le dépôt |
| `AppShell`, `Sidebar` | Dessinés par Alfred : une page ne les rend jamais (règle 6) |
| Le graphique d’un tableau de bord | Une librairie npm et les tokens (section 8) |

Une page qui ne ressemble à aucune recette suit « Répartir avant de composer ».

## 3. Imports et structure d’une page

```tsx
import { Plus } from "lucide-react";                         // icônes
import { db, shell, useAsync, notifyActionError } from "@alfred/sdk"; // données et coquille
import { ListPage, useOpenForm } from "socle-ui";            // composants et gabarits
import { Markdown } from "socle-ui/markdown";                 // rendu Markdown
import { MarkdownEditor } from "socle-ui/markdown-editor";    // éditeur Markdown
import { Row, Stack, Text } from "@alfred/kit";               // écart et texte hors gabarit
```

- **`socle-ui`** : tous les composants et gabarits. Avant d’employer un composant, relire ses options dans ce document ; un nom ou une option absente n’existe pas.
- **`@alfred/sdk`** : base, fonctions, fichiers, coquille, état retenu (`usePageState`), chargement (`useAsync`) et moteurs (`loadTerminal`, `loadPdf`). Référence : SDK.md.
- **Code Python du module** (`import alfred`) : il ne dessine rien. Une page qui lance un travail Python long montre sa progression en lisant le canal que le code publie (`alfred.channels.open("nom")` → `useChannel("<module>:nom")`), par exemple dans une `ProgressBar` ; la fin se dit par une notification (`alfred.notify`). Référence : SDK.md, section 2, « SDK Python ».
- **`@alfred/kit`** : de petits composants d’Alfred, là où socle-ui n’a rien :
  - `Stack` (`gap` : `none`, `xs`, `sm`, `md`, `lg`) empile des blocs ;
  - `Row` (`gap`, `wrap`, `justify` : `start`, `between`, `end`) aligne de petits éléments sur une ligne (badges, boutons d’un `Popover`) ; des blocs côte à côte se rangent dans une `PageGrid` de socle-ui ;
  - `Text` (`as` : `p` ou `span` ; `tone` : `default`, `muted`, `danger`, `warning`, `success` ; `size` : `default` ou `meta` ; `weight` : `normal`, `medium`, `strong`) écrit une phrase ;
  - `Notice` est l’ancien encart : écrire `Alert` de `socle-ui` (`tone`, `title`, `children`, `action`), qui le remplace.
- L’hôte du cadre enveloppe déjà la page dans `SocleProvider` (thème de l’utilisateur, densité desktop). Ne pas en ajouter un.

## 4. Les actions

Une `Action` décrit ce que fait un bouton. Le gabarit qui la reçoit en fait un bouton principal, une icône avec infobulle ou une entrée du menu « … ».

```ts
interface Action {
  id: string;                 // stable et unique dans la barre : "nouvelle", "exporter"
  label: string;              // verbe et objet : « Nouvelle tâche », « Exporter en CSV »
  onPress: () => unknown | Promise<unknown>; // une promesse met le bouton en attente
  icon?: ReactNode;           // <Pencil size={16} /> ; sans icône, l’action va dans « … »
  primary?: boolean;          // l’action attendue de la zone ; une seule
  danger?: boolean;           // supprimer, révoquer, vider : dans « … », en rouge, toujours confirmée
  confirm?: string | { title: string; message?: string; confirmLabel?: string };
  shortcut?: string;          // « Mod+E », affiché dans l’infobulle
  isDisabled?: boolean;       // garde sa place, désactivée
  isHidden?: boolean;         // n’existe pas dans cet état
}
```

La zone fixe la forme. La page ne choisit rien :

| Zone | Où | Action `primary` | Icônes visibles | Reste |
|---|---|---|---|---|
| `topbar` | `useTopBarActions` (barre du haut d’Alfred) | Première icône ; sans icône, bouton à texte | 3, puis selon la place | « … » |
| `header` | `actions` de `ListPage` et de `DetailPage` | Bouton à texte, à droite | 3 | « … » |
| `toolbar` | `actions` de `Page`, actions groupées d’une sélection | Bouton à texte, à droite | 3 | « … » |
| `section` | `actions` de `PageSection`, en-tête et sections de `Drawer` | Bouton secondaire `sm` | 2 | « … » |
| `row` | `rowActions` de `ListPage`, actions d’un nœud de `TreeView` | Sans effet | 1 | « … » |
| `empty` | État vide | Bouton à texte, seul | 0 | rien |

- Ordre : icônes, « … », action principale à droite. Un seul bouton plein par écran.
- Une action `danger` est confirmée. `confirm` nomme l’objet : « Supprimer la tâche « Relancer le client » ? » ; `message` dit la conséquence : « Cette action est définitive. »
- Les gabarits ne notifient pas l’échec d’une action : passer `onActionError={notifyActionError}` (de `@alfred/sdk`) à `ListPage`, `DetailPage` et `Drawer`. Alfred affiche « « Supprimer » n’a pas abouti » avec la cause. `onActionDone` sert à recharger les données.
- Après une écriture qui réussit, notifier seulement si le résultat ne se voit pas : `shell.notify({ title: "Tâche supprimée", tone: "success" })`.

**Barre du haut.** `useTopBarActions(actions)` de `@alfred/sdk` place des actions de la page dans la barre du haut d’Alfred (zone `topbar`). Elle confirme une action `danger` ou `confirm`, montre l’attente et notifie l’échec. À réserver à une `Page` composée, qui n’a pas d’en-tête ; une `ListPage` ou une `DetailPage` garde ses actions dans son en-tête. Un panneau n’en a pas. `useTopBarSummary` est retiré (D-253) : il reste pour les pages anciennes et ne fait rien ; ne plus l’écrire.

## 5. `ListPage` — une collection

```tsx
<ListPage
  title="Tâches"                       // au pluriel : ce qui est listé
  description="Les tâches de l’équipe, par échéance."   // facultatif
  rows={taches.data}                   // undefined : premier chargement (squelettes)
  columns={COLONNES}                   // la première est le nom de l’élément
  empty={{ title: "Aucune tâche", description: "Créez la première tâche de l’équipe." }}
  actions={[{ id: "nouvelle", label: "Nouvelle tâche", icon: <Plus size={16} />, primary: true, onPress: creer }]}
  rowActions={(tache) => [{ id: "modifier", label: "Modifier", icon: <Pencil size={16} />, onPress: () => modifier(tache) }]}
  filters={[{ id: "etat", label: "État", allLabel: "Tous les états", options: ETATS_OPTIONS }]}
  selectedId={choisie}
  onSelect={(row) => choisir(row)}     // sélection : publier pour le panneau
  onOpen={(row) => void views.open({ id: row.id, label: row.titre })} // double-clic ou Entrée : un onglet par élément
  isLoading={taches.loading}           // rechargement : barre fine
  hasError={Boolean(taches.error)}
  onRetry={taches.reload}
  onActionError={notifyActionError}
  onActionDone={taches.reload}
/>
```

| Option | Rôle |
|---|---|
| `title`, `description` | En-tête de la page. |
| `rows` | Lignes, chacune avec un `id` texte. `undefined` pendant le premier chargement. |
| `columns` | `{ id, label, value?, sortable?, type, statuses, currency, decimals, durationUnit }` : `id` est lu dans la ligne, sauf si `value(row)` est donné ; le `type` décide du format, de l’alignement, de la largeur et du tri (section 11). |
| `layout`, `item` | `"list"` quand chaque élément se lit seul ; `"grid"` pour des vignettes, quand on reconnaît les éléments à leur image (recette `Catalog`) ; `item: { title, subtitle, meta, status }` nomme les colonnes de chaque pièce. |
| `thumbnail` | `(row) => ({ src, type })` : l’image de l’élément (aperçu 4:3 en `grid`, visuel de 40 px en `list`) ; sans image, `type` (« pdf ») montre l’icône du fichier. |
| `advanceOnRemove` | File de tri : quand la ligne sélectionnée quitte `rows` (traitée), la sélection passe à la suivante à l’écran (recette `TriageQueue`). |
| `search` | Recherche dans la barre (vrai par défaut). `{ label: "les tâches", text: (row) => … }`. Sans casse ni accents, chaque mot doit apparaître. |
| `filters` | Trois au plus : `{ id, label, allLabel, options: [{ id, label }], value?: (row) => clé }`. |
| `actions`, `rowActions` | Actions de la page (zone `header`) et d’une ligne (zone `row`). L’action `primary` revient dans l’état vide. |
| `selectionMode="multiple"`, `selectionActions` | Cases à cocher et actions groupées sur la sélection. |
| `selectedId`, `onSelect`, `onOpen` | Sélection (clic, flèches) et ouverture (double-clic, Entrée). |
| `pagination` | `{ mode: "more" \| "pages", pageSize }` ; « Afficher plus » de 50 par défaut. |
| `empty` | `{ title, description, icon }` : obligatoire. |
| `isLoading`, `hasError`, `onRetry` | États de chargement. |
| `isDraggingFiles`, `dropLabel` | Dépôt de fichiers sur toute la page : `isDraggingFiles` de `useFileDrop` (SDK.md, section 9) montre le cadre, `dropLabel` dit ce qui se passe (« Déposez les PDF pour les ajouter »). Pendant la copie, `isImporting` va dans `isLoading`. Jamais `onDropFiles` : Alfred capte le dépôt. |
| `remote`, `total`, `onStateChange` | Données filtrées côté base : le gabarit signale `{ query, filters, sort, page }` et ne filtre rien. |
| `storageId` | Clé de mémorisation des filtres et du tri. |

- Pas de rendu de cellule libre, pas de largeur de colonne : le type décide.
- Pas de bouton « Actualiser » automatique : une `Action` avec l’icône `RefreshCw` si les données changent hors d’Alfred.
- Une ligne sélectionnée se publie pour le panneau : `onSelect={(row) => { setChoisie(row?.id ?? null); void shell.publish(row?.id ?? null); }}`.

## 6. `Drawer` — le panneau de droite

**Un panneau de droite ne contient qu’un `Drawer`.** Une page placée en panneau (`{ "kind": "panel" }`) rend un `Drawer` de socle-ui à sa racine, jamais une `Page`, une `ListPage`, un fragment ou du HTML ; l’outil `check` refuse une autre racine. Les panneaux d’Alfred lui-même suivent la même règle. `DetailPanel` est l’ancien nom de `Drawer` (socle-ui 1.0.0) : il marche encore, ne plus l’écrire.

Le panneau lit la sélection publiée par sa page, charge l’objet et le décrit. Il ne charge rien lui-même.

```tsx
const id = useSelection<string>();                         // de @alfred/sdk
const tache = useAsync(() => (id ? lireTache(id) : Promise.resolve(null)), [id]);
return (
  <Drawer
    header={tache.data ? { title: tache.data.titre, status: STATUT[tache.data.etat], actions: [...] } : undefined}
    sections={tache.data ? SECTIONS(tache.data) : undefined}
    isLoading={tache.loading}
    hasError={Boolean(tache.error)}
    onRetry={tache.reload}
    isNotFound={Boolean(id) && tache.data === null && !tache.loading}
    emptyMessage="Sélectionnez une tâche pour voir son détail."
    onActionError={notifyActionError}
    onActionDone={() => { tache.reload(); void announceChange(); }}
  />
);
```

- `header` : `{ title, subtitle, status: { label, tone }, actions }` (zone `section`). `title` est le nom de l’objet (« ALF-12 · Export en échec »), jamais « Détails · … » : le panneau porte déjà « Détail ». `subtitle` est une ligne de contexte (« Bug · Projet Alfred »), jamais une phrase d’aide (« Chaque changement est enregistré aussitôt. ») ; `check` en avertit.
- `sections` : `{ id, title, fields, content, empty, actions, summary, defaultCollapsed }`. `id` est stable : il mémorise le repli. `summary` dit l’état d’un mot, lisible replié : « 2 en retard ».
- `fields` : `{ label, value, type, statuses, hideEmpty, icon, action }`. La valeur est brute ; le `type` la met en forme (section 11). Jamais un élément React en `value` : il s’afficherait « [object Object] » (`check` le refuse).
- `content` : un composant de socle-ui sous les champs (`Table`, `List`, `Markdown`, `DocumentViewer` pour l’aperçu d’un document). Un texte devient un paragraphe. Ce qui n’est pas une propriété (une liste, un relevé) va dans le `content` d’une section, pas à côté du `Drawer`.
- L’ordre des sections est fixe : l’utilisateur les replie, il ne les déplace pas (D-185).
- Après une écriture dans le panneau, `announceChange()` de `@alfred/sdk` prévient la page : ses `useAsync` se relancent. Dans l’autre sens, la page fait de même.
- **Pas de champ de saisie dans une ligne ni dans une section.** Ni `Select`, `ComboBox`, `TextInput`, `TextArea`, `NumberField`, `DatePicker`, `Checkbox`, `RadioButtonGroup`, `SegmentedControl`, `Slider`… (anciens noms compris) dans `value` d’un champ, dans `PropertyRow`, dans `Drawer.Section` ou dans `content`, écrits là ou rendus par un composant du module. `check` le refuse, en suivant les composants et les fonctions du module importés par `./…`. La valeur se lit en texte (valeur brute et son `type`) ; on la modifie par **l’action de la ligne** : un menu de choix (`action: { type: "icon", icon, label, menu }`, avec un `DropdownMenu.Section` `selectionMode`), un interrupteur (`type: "switch"`), ou un bouton qui ouvre `useOpenForm` pour une saisie (texte, date, personne). `InlineEdit` (texte modifiable sur place) n’existe que dans `PropertyRow`, la forme à composants, sans en-tête : dans `fields`, un texte se modifie par la fenêtre. Une modification s’enregistre tout de suite ; un échec garde l’ancienne valeur et notifie.

```tsx
import { ChevronDown, Pencil } from "lucide-react";
import { DropdownMenu, useOpenForm } from "socle-ui";

fields: [
  // Un choix : la valeur en texte, le menu dans l’action de la ligne.
  { label: "Priorité", value: t.priorite, type: "status", statuses: PRIORITES,
    action: { type: "icon", icon: <ChevronDown size={16} />, label: "Changer la priorité", menu: (
      <DropdownMenu.Section selectionMode="single" selectedKeys={[t.priorite]}
        onSelectionChange={(cles) => void enregistrer({ priorite: String([...cles][0]) })}>
        {PRIORITES_LISTE.map((p) => <DropdownMenu.Item key={p.id} id={p.id} label={p.label} />)}
      </DropdownMenu.Section>
    ) } },
  // Une saisie (texte, date, personne) : la valeur en texte, une fenêtre ouverte par l’action.
  { label: "Responsable", value: t.responsable,
    action: { type: "icon", icon: <Pencil size={16} />, label: "Changer le responsable", onPress: () =>
      openForm({ title: "Responsable", fields: [{ type: "combobox", name: "responsable", label: "Responsable", loadItems: chercher }],
        initialValues: { responsable: t.responsableId }, submitLabel: "Enregistrer",
        onSubmit: (v) => enregistrer({ responsable: v.responsable }) }) } },
  // Un oui ou non : l’interrupteur de la ligne.
  { label: "Suivie", value: t.suivie, type: "boolean",
    action: { type: "switch", isSelected: t.suivie, onChange: (suivie) => void enregistrer({ suivie }) } },
]
```

## 7. Une page des Réglages

Une page placée dans les Réglages (`{ "kind": "settings" }`) est une rubrique : la fenêtre des Réglages porte déjà la navigation et le titre. La page est une `Page` sans `width`, faite de `PageSection`, chacune avec des réglages qui s’appliquent **tout de suite** :

```tsx
<Page state={reglages.loading && !reglages.data ? "loading" : reglages.error ? "error" : "ready"} onRetry={reglages.reload}>
  <PageSection title="Lecture" description="Comment les messages s’affichent.">
    <Stack gap="md">
      <Toggle isSelected={valeurs.apercu} onChange={(v) => enregistrer("apercu", v)} description="Une ligne du message sous l’objet.">
        Aperçu des messages
      </Toggle>
      <Select label="Tri" width="md" options={TRIS} value={valeurs.tri} onChange={(v) => enregistrer("tri", v)} />
      <TextInput label="Signature" width="lg" defaultValue={valeurs.signature} onBlur={…} />
    </Stack>
  </PageSection>
</Page>
```

- Un interrupteur, une liste ou un texte s’enregistre seul ; un texte à la sortie du champ. Pas de bouton « Enregistrer », pas de notification « Réglage enregistré ».
- Une liste gérée (comptes, clés) : une `Table` dans la section, avec `rowActions`, et une action « Ajouter… » en `actions` de la section, qui ouvre `useOpenForm`.
- Pas de `FormPage`, pas de `SettingsPage` (elle dessinerait une seconde navigation).

## 8. Composants de socle-ui et librairies

Chaque élément d’une page se prend dans socle-ui. Cette section a deux parts : **quand utiliser quoi**, écrite à la main, puis le **catalogue** de la version installée, généré depuis la doc de socle-ui (`AI.md`). Un composant absent du catalogue n’existe pas : ne pas l’inventer, demander (PLACEMENT.md, section 9).

### Quand utiliser quoi

Composer ces composants dans une `Page`, une `PageSection`, une `PageGrid`, une `DetailPage` ou le `content` d’une section. Chaque composant marqué ★ demande un nom accessible ; options exactes dans sa spec (`docs/alfred/socle/specs/`).

| Besoin | Composant | À retenir |
|---|---|---|
| Une collection entière | `ListPage` (section 5) | Pas une `Table` seule dans une `Page`. |
| Des blocs côte à côte (chiffres clés, listes courtes de même rang) | `PageGrid` | `columns` : 2 (défaut), 3 ou 4. Les colonnes passent l’une sous l’autre quand la place manque. Jamais `Row` pour des blocs. |
| Une conversation : une question, sa réponse | `ChatPage`, avec `ChatTranscript`, `ChatMessage` et `ChatComposer` | Section 10. Les exemples dans `empty` du relevé. |
| Un tableau dans un bloc | `Table` | `density="compact"`, `groupBy`, `rowActions`. |
| Une liste qui se lit élément par élément | `List` ★ `label` | `items: [{ id, title, subtitle, meta, status, unread }]`. |
| Une hiérarchie (dossiers, chemins, catégories) | `TreeView` ★ `aria-label` | `loadChildren` pour un niveau à l’ouverture. Jamais des `List` imbriquées. |
| Un journal horodaté | `LogViewer` ★ `label` | `lines`, `live`, `fill`. |
| Une console interactive | `Terminal` ★ `label` | `engine={loadTerminal}`, `{...useTerminalConnection(canal)}`. |
| Ce qui a changé entre deux textes | `DiffView` ★ `label` | `before` et `after`, ou `patch`. |
| Un PDF ou une image à lire | `DocumentViewer` ★ `label` | `data`, `loadPdf={loadPdf}` ; `page` l’ouvre à une page (une source citée). Une image seule, en vignette : `ImageThumbnail`. |
| Les sources d’une réponse | `SourceList` | `sources` (`id`, `title`, `detail` « p. 12 », `excerpt`), `onOpen`, `currentId` ; dans `sources` de `ChatMessage`. |
| Un HTML reçu (courriel) | `HtmlContent` ★ `label` | Nettoie le HTML. |
| Du Markdown à lire, à écrire | `Markdown` (`socle-ui/markdown`), `MarkdownEditor` ★ `label` (`socle-ui/markdown-editor`) | Jamais une `TextArea` pour du Markdown. |
| L’état d’un élément | `Badge` (libellé), `BadgeDot` (point nommé) | Tons `StatusTone` ; dans un gabarit, le `type: "status"` d’une colonne ou d’un champ. |
| Une valeur typée hors gabarit | `FormattedValue` | `value`, `type`. La page ne formate rien. |
| Un chiffre clé qui mène quelque part | `Card` `variant="metric"`, avec `onPress` | Pas de chiffre sans action, pas de mur de cartes (D-361). Une rangée de chiffres : une `PageGrid`. |
| Un encart de message dans le contenu | `Alert` | Au-dessus de ce qu’il concerne ; une action au plus (D-355). |
| Un avancement, un quota | `ProgressBar` ; `UsageRing` pour une jauge compacte | `label`, `value`, `max`. |
| Les étapes d’un parcours | `ProgressIndicator` | `label`, `steps`, `current`. |
| Un bloc secondaire repliable | `Accordion` | « Options avancées », détails d’une erreur. |
| Une propriété avec son action, hors `fields` | `PropertyRow`, `InlineEdit` | Forme à composants du `Drawer`. |
| Un mode d’affichage, une période, appliqués tout de suite | `SegmentedControl` | Dans la `toolbar` d’une `Page` ; jamais pour des vues (onglets fixes). |
| Un volet sans voile | `Popover` | Filtrer, partager, aperçu rapide. |
| Un menu d’actions, un menu contextuel | `DropdownMenu`, `useContextMenu()` | Dans un gabarit, une `Action` sans icône va d’elle-même dans « … ». |
| La recherche d’une `Page` composée | `SearchInput` | `ListPage` a la sienne. |
| Des étiquettes à retirer ou à choisir | `TagGroup` et `Tag` | |
| Un champ de saisie | `TextInput`, `TextArea`, `NumberField`, `Select`, `ComboBox`, `DatePicker`, `Checkbox`, `RadioButtonGroup`, `Toggle`, `Slider`, `Fieldset` | Hors formulaire de `useOpenForm` : seulement dans une page des Réglages ou une `Page` composée. Un réglage immédiat : `Toggle` ; une case d’un formulaire qu’on envoie : `Checkbox` (D-137). Une question à poser : `ChatComposer` d’une `ChatPage`, pas une `TextArea`. |
| Des fichiers à ajouter | Une `Action` qui appelle `files.pick`, et le dépôt sur toute la page : `useFileDrop` (SDK.md, section 9) | `isDraggingFiles` de `ListPage`, `Page` ou `ChatPage` montre le cadre de dépôt. Jamais un bloc de dépôt (`FileUpload`) : le dépôt prend toute la page. |
| Une couleur à choisir dans un nuancier | `ColorPicker` | |
| Un identifiant, une commande | `Code` | `block` pour un extrait. |
| Une personne | `Avatar` | `name`, `src`. |
| Un lien | `Link` | `href` externe, ou `onPress`. |
| Une attente locale | `Skeleton` ; `Spinner` pour une attente courte | Les gabarits ont déjà leurs états. |
| Un bloc vide | `EmptyState` ; dans un gabarit, `empty` | `action={<Button variant="primary">…</Button>}`. Des exemples à essayer : `suggestions` (`id`, `label`, `onPress`), quatre au plus. |

<!-- socle-ui:catalogue:début : généré par scripts/gen-design-components.mjs depuis node_modules/socle-ui/ai/AI.md ; ne pas modifier à la main -->

### Catalogue de socle-ui 1.24.0

Tous les composants, motifs et gabarits de la version installée, avec leur rôle. Avant d’employer l’un d’eux, lire sa spec : ses options, ce qu’il exclut, son contenu.

| Composant | Type | Rôle | Spec à lire |
|---|---|---|---|
| `Accordion` | Composant | Bloc secondaire repliable, avec un titre toujours visible : « Options avancées » d'un formulaire, détails d'une erreur, éléments repliés d'un panneau (D-321). | `docs/alfred/socle/specs/Accordion.md` |
| `AgentActivity` | Composant | `AgentActivity` montre un outil appelé par l'agent sur une ligne ; `ActivityGroup` montre une suite d'outils et la groupe derrière un résumé au-delà de 3, ou du seuil choisi par l'app (D-376, D-390). | `docs/alfred/socle/specs/AgentActivity.md` |
| `Alert` | Composant | `Alert` est un encart de message dans le contenu, au-dessus de ce qu'il concerne : un stock bas sur une fiche, une synchronisation impossible au-dessus d'une liste, une adresse vérifiée sous un formulaire. Il dit aussi un état durable de la page ou de l'app (lecture seule, hors ligne, données d'exemple), en tête du contenu : la barre du haut n'en affiche plus (D-253). | `docs/alfred/socle/specs/Alert.md` |
| `AttachmentChip` | Composant | Pièce jointe d'un message, avant l'envoi : une image, un fichier, ou un long texte collé. On la voit, on l'ouvre (texte), on la retire. | `docs/alfred/socle/specs/AttachmentChip.md` |
| `Avatar` | Composant | Représenter une personne (ou un compte) par son image ou ses initiales, à côté de son nom. | `docs/alfred/socle/specs/Avatar.md` |
| `BackgroundTasks` | Composant | Tâches qui durent, lancées par un agent ou par l'app : une commande en arrière-plan (un serveur), un sous-agent, un script long. On voit ce qui tourne, depuis quand, et on l'arrête ; puis combien de tâches sont finies, et combien ont échoué (D-401). | `docs/alfred/socle/specs/BackgroundTasks.md` |
| `Badge` | Composant | Montrer l'état d'un élément : « Terminé », « En retard », « À venir ». `Badge` montre un point et un libellé ; `BadgeDot` montre le point seul, nommé, quand le libellé ne tient pas. | `docs/alfred/socle/specs/Badge.md` |
| `Button` | Composant | Bouton avec un libellé, et une icône facultative. Il déclenche une action : envoyer un formulaire, confirmer, annuler, réessayer, exporter. | `docs/alfred/socle/specs/Button.md` |
| `Card` | Composant | `Card` regroupe un contenu court qui forme un tout : un résumé, un chiffre clé, un élément d'une grille. Elle peut être entièrement cliquable quand elle a une seule action principale. | `docs/alfred/socle/specs/Card.md` |
| `ChatComposer` | Composant | Zone de saisie d'un chat avec un agent : écrire un message, citer des ressources (`@fichier`, `/commande`), joindre des fichiers, mettre un message en file pendant une réponse, arrêter l'agent. | `docs/alfred/socle/specs/ChatComposer.md` |
| `ChatTranscript` | Composant | Zone défilante d'une conversation avec un agent : colonne centrée de 760 px qui reçoit les messages (`ChatMessage`) et le travail de l'agent (`ActivityGroup`, `WorkStatus`, `WorkSummary`). Elle suit la réponse en cours tant que l'utilisateur est en bas (D-375). | `docs/alfred/socle/specs/ChatTranscript.md` |
| `Checkbox` | Composant | `Checkbox` : une valeur oui/non qui fait partie d'un formulaire qu'on envoie, ou une acceptation (« J'ai lu les conditions »). `CheckboxGroup` : plusieurs choix indépendants dans une liste courte, sous un libellé commun. | `docs/alfred/socle/specs/Checkbox.md` |
| `ChoicePrompt` | Composant | Carte posée au-dessus de la zone de saisie quand l'agent attend une réponse : une question avec des options numérotées, ou une autorisation (D-377). | `docs/alfred/socle/specs/ChoicePrompt.md` |
| `Code` | Composant | Texte à chasse fixe : identifiant, chemin, commande, valeur technique (`Code`), ou extrait sur plusieurs lignes (`Code block`). | `docs/alfred/socle/specs/Code.md` |
| `CodeField` | Composant | `CodeField` saisit un code à usage unique de 4 à 8 caractères : code reçu par SMS ou par e-mail, code d'une application d'authentification. | `docs/alfred/socle/specs/CodeField.md` |
| `ColorPicker` | Composant | `ColorPicker` choisit une couleur dans un nuancier prédéfini : la couleur d'une étiquette, d'un projet, d'une catégorie d'agenda. | `docs/alfred/socle/specs/ColorPicker.md` |
| `ComboBox` | Composant | Champ de formulaire qui propose une liste de choix pendant la saisie. On choisit un élément (choix simple) ou plusieurs (choix multiple, en étiquettes), dans une liste connue ou chargée par une API (D-140). La valeur choisie (un id, ou une liste d'ids) est enregistrée avec le formulaire. | `docs/alfred/socle/specs/ComboBox.md` |
| `DatePicker` | Composant | `DatePicker` saisit une date : une échéance, une date de livraison, une date de naissance. `DateRangePicker` saisit une période : du 3 au 24 novembre. | `docs/alfred/socle/specs/DatePicker.md` |
| `DiffView` | Composant | Différences entre deux versions d'un texte (code, Markdown, configuration), ou lecture d'un diff unifié (`git diff`, `diff -u`). `DiffStat` montre seul les compteurs « +12 −3 » (D-290). | `docs/alfred/socle/specs/DiffView.md` |
| `DocumentViewer` | Composant | Montrer l'aperçu d'un document dans une page : PDF (dessiné par pdf.js) ou image (D-310). | `docs/alfred/socle/specs/DocumentViewer.md` |
| `DropdownMenu` | Composant | Liste d'actions ou de choix qui s'ouvre depuis un bouton : « … » d'un élément, « Plus d'actions », menu du compte, liste « Toutes les vues ». Il s'ouvre aussi au clic droit sur une zone (menu contextuel), au point du clic (D-327). | `docs/alfred/socle/specs/DropdownMenu.md` |
| `EmptyState` | Composant | Dire qu'une zone est vide et proposer la suite : zone `empty` de ListPage (aucune donnée), panneau sans élément. | `docs/alfred/socle/specs/EmptyState.md` |
| `Fieldset` | Composant | Regroupe des champs différents qui forment un tout, sous une légende : une adresse (rue, code postal, ville), une période (début, fin). | `docs/alfred/socle/specs/Fieldset.md` |
| `FileUpload` | Composant | `FileUpload` ajoute des fichiers à un formulaire ou à un élément : par glisser-déposer ou par le bouton. Il vérifie le type et la taille avant de transmettre les fichiers à l'app. Il n'envoie rien : l'app envoie et rend l'état de chaque fichier (D-357). | `docs/alfred/socle/specs/FileUpload.md` |
| `FormattedValue` | Composant | Afficher une valeur de donnée d'après son **type** : texte, nombre, montant, date, statut, lien… Le type fixe le format de la langue, l'alignement, la largeur de colonne et le tri. L'app ne formate rien elle-même : elle déclare le type. | `docs/alfred/socle/specs/FormattedValue.md` |
| `HtmlContent` | Composant | Afficher sans risque un HTML reçu de l'extérieur : corps d'un courriel, page enregistrée, description riche d'un service (D-317). | `docs/alfred/socle/specs/HtmlContent.md` |
| `IconButton` | Composant | Bouton qui ne montre qu'une icône. Il sert aux actions fréquentes et connues : barre supérieure, actions d'une ligne, pied de sidebar, en-tête du panneau de détail. | `docs/alfred/socle/specs/IconButton.md` |
| `ImageThumbnail` | Composant | Montrer une image qu'on consulte (envoyée, citée, produite, capturée) en vignette ; un clic l'agrandit (D-383). `ImageGallery` range plusieurs vignettes en groupes. | `docs/alfred/socle/specs/ImageThumbnail.md` |
| `InlineEdit` | Composant | Texte modifiable sur place : le titre d'un élément, une valeur du panneau de détail (layout-rules : « propriétés modifiables sur place »), le nom d'une liste ou d'une vue. | `docs/alfred/socle/specs/InlineEdit.md` |
| `Link` | Composant | Lien dans un texte, une cellule ou une ligne de détail : aller vers une page, un document, une adresse externe ; ou action secondaire dans une phrase (sans `href`). | `docs/alfred/socle/specs/Link.md` |
| `List` | Composant | Liste d'éléments qui se lisent un par un : un titre, un sous-titre, une méta. Elle sert dans la zone `list` du gabarit `ListPage` (messages, demandes, tâches, contacts) et remplace le tableau sur mobile (spec de Table). | `docs/alfred/socle/specs/List.md` |
| `LogViewer` | Composant | Journal en lignes horodatées : build, conteneur, tâche planifiée, service. On le lit, on y cherche, on le filtre par niveau, on le suit en direct et on le copie. Il tient des centaines de milliers de lignes. | `docs/alfred/socle/specs/LogViewer.md` |
| `MentionInput` | Composant | Champ de texte multiligne où l'on cite des ressources de l'app par un caractère : `@` pour un fichier, `/` pour une commande, `#` pour un ticket. Chaque ressource choisie devient une pastille non éditable, à sa place dans le texte. | `docs/alfred/socle/specs/MentionInput.md` |
| `MessageQueue` | Composant | Messages écrits pendant une réponse de l'agent, qui partiront à la fin de l'étape en cours. On les réordonne, on les modifie, on les retire, ou on en envoie un tout de suite. | `docs/alfred/socle/specs/MessageQueue.md` |
| `Modal` | Composant | `Modal` ouvre une fenêtre secondaire, bloquante, posée sur l'app : un formulaire court (créer, renommer), un aperçu à vérifier, un espace à part comme les Réglages (D-015). AppShell y renvoie pour toute fenêtre secondaire. | `docs/alfred/socle/specs/Modal.md` |
| `NumberField` | Composant | Champ de saisie d'un nombre : une quantité, un prix, un pourcentage, une durée en heures. | `docs/alfred/socle/specs/NumberField.md` |
| `Pagination` | Composant | `Pagination` permet d'aller d'une page de résultats à une autre : précédent, numéros, suivant. `ListPage` l'utilise en mode `pages` (D-175, D-359). | `docs/alfred/socle/specs/Pagination.md` |
| `Popover` | Composant | Volet flottant ouvert depuis un bouton, sans voile : un contenu court et riche (texte, quelques champs, liste courte) sans quitter la page. Exemples : partager, filtrer, aperçu rapide, réglages rapides. | `docs/alfred/socle/specs/Popover.md` |
| `ProgressBar` | Composant | Montrer l'avancement d'une tâche (import, envoi) ou la part utilisée d'un quota. | `docs/alfred/socle/specs/ProgressBar.md` |
| `ProgressIndicator` | Composant | Étapes numérotées d'un parcours guidé, avec leur état : installation, configuration d'un compte, import en plusieurs temps. | `docs/alfred/socle/specs/ProgressIndicator.md` |
| `RadioButtonGroup` | Composant | Un seul choix parmi 2 à 5 options qu'on veut toutes voir, chacune avec une description courte si besoin. | `docs/alfred/socle/specs/RadioButtonGroup.md` |
| `SearchInput` | Composant | Barre de recherche : elle recueille les critères de l'utilisateur (texte en cours, étiquettes) et les transmet à l'app (D-077). L'app s'en sert pour filtrer ou trier un tableau, une liste, souvent par une API. La barre n'affiche ni ne filtre de résultats. | `docs/alfred/socle/specs/SearchInput.md` |
| `SegmentedControl` | Composant | `SegmentedControl` choisit une option parmi 2 à 4, et l'applique tout de suite : un mode d'affichage (liste, grille), une période (jour, semaine, mois). | `docs/alfred/socle/specs/SegmentedControl.md` |
| `Select` | Composant | Choix d'une valeur dans une liste fermée et courte (2 à 15 options environ), sans saisie de texte. | `docs/alfred/socle/specs/Select.md` |
| `Separator` | Composant | Séparer deux groupes d'une même zone par un trait, quand un écart ne suffit pas. | `docs/alfred/socle/specs/Separator.md` |
| `Skeleton` | Composant | Réserver la place d'un contenu en cours de chargement, avec des formes qui annoncent sa disposition. | `docs/alfred/socle/specs/Skeleton.md` |
| `Slider` | Composant | `Slider` règle une valeur approximative dans une étendue : un seuil d'alerte, un volume, une opacité, une fourchette de prix. | `docs/alfred/socle/specs/Slider.md` |
| `SourceList` | Composant | `SourceList` montre les sources citées par une réponse : une puce numérotée par source, sous la réponse. Un clic ouvre la source : le document à la bonne page, la page web citée, l'élément de l'app (D-411). | `docs/alfred/socle/specs/SourceList.md` |
| `Spinner` | Composant | `Spinner` montre une attente courte et locale : une cellule, un panneau, une ligne qui se met à jour. C'est l'indicateur rotatif de `Button` et `SearchInput` (D-081), exposé. | `docs/alfred/socle/specs/Spinner.md` |
| `SplitButton` | Composant | `SplitButton` lance une action par défaut et propose ses variantes dans un menu : « Enregistrer », puis « Enregistrer sous… » et « Enregistrer et fermer ». | `docs/alfred/socle/specs/SplitButton.md` |
| `Table` | Composant | Tableau de données : des éléments en lignes, leurs propriétés en colonnes, avec tri et sélection. Il sert dans la zone `list` du gabarit `ListPage` quand on compare plusieurs propriétés d'un élément à l'autre. | `docs/alfred/socle/specs/Table.md` |
| `Tag` | Composant | `TagGroup` affiche une liste d'étiquettes interactives (`Tag`) : des mots-clés qu'on retire (étiquettes d'un ticket), ou des filtres qu'on choisit (« Urgent », « Client »). | `docs/alfred/socle/specs/Tag.md` |
| `Terminal` | Composant | Terminal interactif : console d'un conteneur, d'un serveur ou d'un processus local. Il affiche ce que le programme écrit et lui envoie ce que l'utilisateur tape. | `docs/alfred/socle/specs/Terminal.md` |
| `TextArea` | Composant | Champ de saisie d'un texte libre sur plusieurs lignes : une note, une description, un commentaire. | `docs/alfred/socle/specs/TextArea.md` |
| `TextInput` | Composant | Champ de saisie d'une ligne de texte libre : un nom, une adresse e-mail, une URL, un numéro de téléphone, un mot de passe. | `docs/alfred/socle/specs/TextInput.md` |
| `Toggle` | Composant | Interrupteur marche/arrêt pour un réglage qui s'applique tout de suite (D-007, D-137). | `docs/alfred/socle/specs/Toggle.md` |
| `Tooltip` | Composant | Info-bulle : un court texte qui nomme ou complète un élément au survol ou au focus clavier. Elle sert surtout aux boutons-icônes (`IconButton`) et aux textes tronqués. | `docs/alfred/socle/specs/Tooltip.md` |
| `TreeView` | Composant | Arbre de nœuds dépliables, dans le contenu d'une page : fichiers et dossiers, chemins, catégories, toute hiérarchie de données. On y explore, on choisit un ou plusieurs nœuds, on agit sur eux. Une ligne par nœud, autant de niveaux que nécessaire. | `docs/alfred/socle/specs/TreeView.md` |
| `UsageRing` | Composant | `UsageRing` montre une part utilisée (contexte d'une conversation, quota) dans une petite jauge en anneau. Un clic ouvre le volet des limites, dont l'app donne le contenu, le plus souvent des lignes `UsageMeter`. | `docs/alfred/socle/specs/UsageRing.md` |
| `ActionBar` | Pattern | Une app décrit ses actions par des données (`Action`). `ActionBar` les dessine selon la zone où elle se trouve : bouton à texte, bouton-icône ou entrée du menu « … ». La page ne choisit aucun bouton. Les gabarits (ListPage, DetailPage, Drawer) s'appuient sur ce modèle. | `docs/alfred/socle/specs/ActionBar.md` |
| `Drawer` | Pattern | Contenu du panneau de détail d'AppShell (D-018) : les propriétés et les réglages de l'élément sélectionné, rangés en sections. Il se place dans le slot `detail` d'AppShell. | `docs/alfred/socle/specs/Drawer.md` |
| `ChatPage` | Gabarit | Gabarit d'une page de chat avec un agent, dans la zone `main` d'AppShell ou dans une fenêtre à part : barre d'outils, relevé (`ChatTranscript`), puis un pied aligné sur la colonne de 760 px du relevé (alertes, question de l'agent, saisie, options). Il porte la zone de dépôt de fichiers de toute la page (D-382). | `docs/alfred/socle/specs/ChatPage.md` |
| `DetailPage` | Gabarit | Gabarit de la zone `main` d'AppShell pour un élément ouvert en entier : une demande, une facture, un document. Il montre le contenu principal de l'élément, en sections. | `docs/alfred/socle/specs/DetailPage.md` |
| `FormPage` | Gabarit | `FormPage` montre un formulaire long, rangé en sections : créer un objet riche, modifier sa fiche, remplir une demande. L'app décrit ses champs par des données ; le gabarit les dessine avec les champs du lot 1 (D-190). | `docs/alfred/socle/specs/FormPage.md` |
| `ListPage` | Gabarit | Gabarit d'une page qui liste des éléments de même nature : demandes, contacts, factures, fichiers. L'app **décrit** sa page par des données (titre, colonnes typées, filtres, actions) ; le gabarit dessine tout, y compris le chargement, le vide, l'absence de résultat et l'erreur (D-173). Il se place dans la zone `main` d'`AppShell`. | `docs/alfred/socle/specs/ListPage.md` |
| `Page` | Gabarit | Page composée : gabarit libre de la zone `main` d'AppShell, quand aucun autre gabarit ne convient (tableau de bord, éditeur, graphique, synthèse de quelques blocs). Elle pose les zones standard ; l'app y place des composants du socle, sans HTML stylé (D-217). Ses blocs s'empilent, ou se rangent côte à côte dans `PageGrid` pour tenir sur un écran (D-403, D-404). Elle reçoit les fichiers déposés n'importe où sur la page (D-418). | `docs/alfred/socle/specs/Page.md` |

Réservés à la coquille d’Alfred ou à l’hôte du cadre, jamais rendus par une page : `SocleProvider`, `useSocle`, `Tabs`, `AppShell`, `NotificationCenter`, `Sidebar`, `LoginPage`, `SettingsPage`.

Anciens noms : ils marchent encore, mais `check` avertit et ils disparaîtront en socle-ui 2.0.0 (D-336). Écrire le nom actuel.

| Ancien nom | Nom actuel |
|---|---|
| `Disclosure` | `Accordion` |
| `Switch` | `Toggle` |
| `Divider` | `Separator` |
| `Dialog` | `Modal` |
| `Menu` | `DropdownMenu` |
| `TextField` | `TextInput` |
| `SearchField` | `SearchInput` |
| `StepList` | `ProgressIndicator` |
| `StatusBadge` | `Badge` |
| `StatusDot` | `BadgeDot` |
| `DetailPanel` | `Drawer` |
| `RadioGroup` | `RadioButtonGroup` |

<!-- socle-ui:catalogue:fin -->

`Button` et `IconButton` prennent `onPress`, jamais `onClick`.

**Terminal.** xterm.js vient de `loadTerminal` ; le canal vient d’une fonction du connecteur (`client(id).socket`) :

```tsx
const { canal } = useAsync(() => functions.call("docker/console", { conteneur }), [conteneur]).data ?? {};
<Terminal label={`Console de ${conteneur}`} engine={loadTerminal} {...useTerminalConnection(canal)} fill />
```

**Document.** `const fichier = await files.read(id)` rend `{ info, data }` (base64) ; décoder en octets et passer `data={octets} name={fichier.info.name} loadPdf={loadPdf}`.

**Librairies npm.** Seulement pour ce que socle-ui ne fait pas : graphique, carte, calendrier, éditeur de texte riche. `check` refuse une librairie que socle-ui couvre (xterm, diff, éditeur ou rendu Markdown, pdf.js, grille, arbre, toasts, React Aria, Radix…) et nomme le composant à prendre. Une librairie reçoit un conteneur (`<div ref={ref} />`, seul HTML admis) et les tokens de socle-ui pour ses couleurs, lus avec `getComputedStyle(document.documentElement).getPropertyValue("--accent")` : `--fg`, `--fg-2`, `--fg-3`, `--surface`, `--surface-side`, `--line`, `--accent`, `--success`, `--warning`, `--danger`. Elle se redessine quand `usePageContext()?.theme` change.

## 9. Saisies et modales

**Saisie courte : `useOpenForm`.** Six champs au plus, en modale.

```tsx
const openForm = useOpenForm();
const creer = async () => {
  await openForm({
    title: "Nouvelle tâche",
    fields: CHAMPS_TACHE,
    initialValues: { etat: "a_faire" },
    submitLabel: "Créer",
    onSubmit: async (valeurs) => {
      await db.execute("INSERT INTO suivi_taches (titre, etat) VALUES (?, ?)", [valeurs.titre, valeurs.etat]);
    },
  });
};
```

La promesse rend les valeurs, ou `null` si l’utilisateur ferme. `onSubmit` peut rendre `{ errors: { champ: "Message" }, message }` ou lever une erreur : la modale reste ouverte et l’affiche.

**Le modèle de champ (`FormField`).** `{ type, name, label, description, isRequired, isDisabled, width, defaultValue, validate(valeur, valeurs) }`, et selon le type :

| `type` | Valeur rendue | Options propres |
|---|---|---|
| `text` (défaut), `email`, `url`, `tel`, `password` | `string` | `placeholder`, `maxLength` |
| `number` | `number \| null` | `min`, `max` |
| `textarea` | `string` | `minRows`, `maxRows`, `maxLength` |
| `select` | `string \| null` | `options: [{ id, label }]` |
| `combobox` | `string \| null`, ou `string[]` avec `selectionMode: "multiple"` | `items` ou `loadItems`, `allowsCustomValue` |
| `radio` | `string \| null` | `options: [{ value, label, description }]` |
| `checkbox` | `boolean` | — |
| `checkboxGroup` | `string[]` | `options` |
| `fieldset` | — | `legend`, `fields` |

**Saisie longue : `FormPage`.** `title`, `description`, `sections: [{ title, description, fields }]`, `initialValues`, `submitLabel`, `onSubmit`, `onCancel`, `isLoading`. Elle prend la place de la liste dans la page (état de la page), puis la liste revient après `onSubmit` ou `onCancel`.

**Confirmation : `useConfirm`.** `const confirm = useConfirm(); if (await confirm({ title: "Vider la corbeille ?", message: "Les 12 éléments seront effacés.", confirmLabel: "Vider" })) …`. Une `Action` `danger` le fait déjà.

**Contenu à voir : `Modal`.** `isOpen`, `onOpenChange`, `title`, `description`, `size` (`sm` à `xl`), `footer` : des `Button`, « Annuler » puis l’action.

## 10. Page composée et élément ouvert

**`Page`, `PageSection` et `PageGrid`** : un tableau de bord, une synthèse, un éditeur.

- `Page` : `toolbar` (contenu libre sur une ligne : `SearchInput`, `SegmentedControl` ou `Select` de période), `actions` (zone `toolbar`), `footer`, `width` (`full`, le défaut ; `text`, une colonne de 760 px, seulement pour un texte à lire : une note, une procédure), `fill` (le contenu prend la hauteur, pour un `LogViewer` ou un `Terminal` en `fill`), `state` (`ready`, `loading`, `error`), `onRetry`, `isDraggingFiles` et `dropLabel` (dépôt de fichiers sur toute la page, avec `useFileDrop` : SDK.md, section 9).
- `PageSection` : `title` (obligatoire), `description`, `actions` (zone `section`), `state`, `onRetry`, `empty: { title, description, action }`.
- `PageGrid` : `columns` (`2` par défaut, `3` ou `4`). Elle range ses enfants (`PageSection`, `Card`) côte à côte, en colonnes égales, à 24 px ; les blocs d’une ligne ont la même hauteur. Une colonne garde 240 px au moins : panneau ouvert ou fenêtre étroite, la grille prend moins de colonnes, puis une seule. Elle va dans le contenu de la `Page`, ou dans une `PageSection` pour une rangée de `Card` ; jamais dans une `DetailPage`, un `Drawer` ou une autre `PageGrid`.
- Les informations clés tiennent sur un écran : ce qui demande une action (en retard, à traiter) en haut, côte à côte ; le détail ensuite. Pas de longue pile de `PageSection`.
- Pas de titre de page : il est dans la barre du haut. Pas de cartes décoratives ni de chiffres sans action. Pas de bloc de texte seul (« À savoir ») : une précision va dans la `description` du bloc qu’elle concerne.

**`ChatPage`** : un échange de questions et de réponses (avec l’IA, sur des documents), dans un onglet fixe à lui. Le relevé défile, la saisie reste en bas, les exemples vont dans l’état vide du relevé :

```tsx
import { ChatComposer, ChatMessage, ChatPage, ChatTranscript, EmptyState, SourceList } from "socle-ui";
import { Markdown } from "socle-ui/markdown";

const ouvrir = (source: Source) => { setOuverte(source.id); void shell.publish(source); void shell.setPanelVisible(true); };

<ChatPage composer={<ChatComposer label="Question sur les documents" placeholder="Posez une question" isRunning={enCours} onSubmit={(texte) => void demander(texte)} />}>
  <ChatTranscript label="Questions et réponses" followKey={echanges.length}
    empty={<EmptyState title="Posez une question à vos documents" description="La réponse cite ses sources : un clic ouvre le document à la bonne page."
      suggestions={EXEMPLES.map((q) => ({ id: q, label: q, onPress: () => void demander(q) }))} />}>
    {echanges.flatMap((e) => [
      <ChatMessage key={`${e.id}-q`} role="user">{e.question}</ChatMessage>,
      <ChatMessage key={`${e.id}-r`} role="assistant"
        sources={<SourceList sources={e.sources} currentId={ouverte} onOpen={ouvrir} />}>
        <Markdown onLinkPress={(lien) => ouvrirParNumero(e, lien)}>{e.reponse}</Markdown>
      </ChatMessage>,
    ])}
  </ChatTranscript>
</ChatPage>
```

Les sources d’une réponse sont des puces sous son texte : `SourceList` dans `sources` de `ChatMessage` (`id`, `title` : le document, `detail` : « p. 12 », `excerpt` : le passage). Le texte les cite par leur numéro, en lien (`[[1]](#source-1)`) ; `onLinkPress` ouvre la même source. `onOpen` publie la source pour le panneau de droite (`shell.publish`) et l’ouvre (`shell.setPanelVisible(true)`) ; `currentId` marque la source ouverte. Le panneau (un `Drawer`) montre la source : le document et la page en en-tête, le passage cité, puis le PDF à la page citée (`DocumentViewer` avec `page={source.page}`, dans le `content` d’une section). Les échanges se gardent en base : le cadre est recréé à chaque changement d’onglet. Un PDF glissé sur la conversation s’ajoute aux documents : `useFileDrop` et `isDraggingFiles` de `ChatPage`, comme pour une `ListPage`. La recette `KnowledgeBase` montre la page finie (section 2, « Partir d’une recette »).

**`DetailPage`** : un élément ouvert en entier, depuis `onOpen` d’une liste. `onOpen` ouvre l’élément dans un onglet fermable (`views.open({ id, label, params })`) ; dans cet onglet, `usePageContext()?.view` porte l’élément et la page rend la `DetailPage` à la place de la `ListPage`. Le lien de retour ferme l’onglet et revient à la liste :

```tsx
const view = usePageContext()?.view ?? null;
if (view) return (
  <DetailPage
    title={facture.numero}
    back={{ label: "Factures", onPress: () => void views.close() }}
    status={STATUT[facture.etat]}
    meta={[facture.client, formatDate(facture.date)]}
    actions={[...]}
    state={…}
    onActionError={notifyActionError}
  >
    <DetailPage.Section title="Lignes"><Table … /></DetailPage.Section>
  </DetailPage>
);
```

Les propriétés de l’élément vont dans le panneau de droite, pas dans la `DetailPage`.

## 11. Types de valeurs

Une colonne de `ListPage`, un champ de `Drawer` et `FormattedValue` prennent la valeur brute et son `type`. La page ne formate rien elle-même.

| `type` | Valeur attendue | Rendu |
|---|---|---|
| `text` (défaut), `longtext` | texte | coupé avec infobulle ; `longtext` sur plusieurs lignes |
| `number`, `money`, `percent`, `bytes` | nombre | format français, aligné à droite ; `currency` (défaut `EUR`), `decimals` |
| `date`, `datetime`, `relative` | ISO 8601, ou millisecondes | « 3 févr. 2026 », « il y a 2 h » |
| `duration` | nombre (`durationUnit` : `ms`, `s`, `min`) | « 1 h 05 » |
| `boolean` | `true` / `false` | « Oui » / « Non » |
| `status` | clé | `Badge` d’après `statuses` |
| `email`, `url` | texte | lien |
| `code` | texte | chasse fixe |
| `tags` | liste de textes | étiquettes |

Un `StatusMap` se partage entre la liste et le panneau, dans `lib/` :

```ts
export const ETATS: StatusMap = {
  a_faire: { label: "À faire", tone: "neutral" },
  en_cours: { label: "En cours", tone: "pending" },
  bloquee: { label: "Bloquée", tone: "danger" },
  terminee: { label: "Terminée", tone: "success" },
};
```

## 12. États et notifications

Les gabarits rendent chaque état. Une `Page` composée les rend par `state` et par section. `useAsync(charger, deps)` de `@alfred/sdk` rend `{ data, error, loading, reload }`.

| Situation | Rendu |
|---|---|
| Premier chargement | `rows={undefined}`, `state="loading"`, `isLoading` sans données : squelettes |
| Rechargement | Les données restent ; barre fine |
| Collection vide | `empty` de `ListPage` : titre qui nomme l’absence, phrase qui dit à quoi sert la page, action `primary` |
| Aucun résultat | Posé par `ListPage`, avec « Effacer la recherche » |
| Échec de chargement | `hasError` et `onRetry` (ou `state="error"`) |
| Prérequis absent dans un bloc | `empty` de `PageSection`, avec l’action qui le résout |
| Précision locale, état durable de la page | `Alert` de `socle-ui`, en tête du bloc ou du contenu (D-085, D-253) |
| Résultat d’une action qui ne se voit pas | `shell.notify({ title, tone: "success" })` |
| Échec d’une action | `onActionError={notifyActionError}` |
| Calcul long (fonction, noyau Python) | `ProgressBar` dans le bloc concerné, avec le message de l’avancement (`usePythonChannel`, SDK.md § 19) ; sans fraction connue, barre indéterminée |
| Première fonction Python d’un module à paquets | Elle peut attendre une minute (installation) : `isPending` sur l’action, ou une tâche de fond ; l’échec arrive avec `notifyActionError` |

- Une notification de la page part à Alfred (toast et cloche). `useNotify()` de `socle-ui` et `shell.notify` de `@alfred/sdk` y vont tous deux ; `shell.notify` seul sait porter des actions (`navigate`, `window`, `function`). Tons de `shell.notify` : `info`, `success`, `warning`, `error`.
- **Aucun bandeau en tête de page.** Un état qui dure se dit dans le bloc qu’il concerne. Un réglage appliqué réussit en silence.

## 13. Libellés, icônes, accessibilité

**Libellés.** Un verbe à l’infinitif, suivi de son objet quand le contexte ne le donne pas, une seule majuscule, sans point final. Le même verbe désigne la même action partout.

| Libellé | Sens | Règle |
|---|---|---|
| « Nouveau… », « Nouvelle… » | Création d’un objet de premier niveau | Action `primary` de la page et de l’état vide |
| « Ajouter… » | Insère dans un ensemble existant | |
| « Créer », « Enregistrer » | Valide un formulaire | `submitLabel` |
| « Modifier » | Ouvre l’édition | Icône `Pencil` |
| « Supprimer » | Efface définitivement | `danger` |
| « Retirer » | Enlève une appartenance | Confirmé si difficile à défaire |
| « Archiver » | Masque sans effacer | Sans confirmation |
| « Actualiser » | Recharge | Icône `RefreshCw` |

- Typographie française : apostrophe « ’ », guillemets « », espace avant « : », « ? » et « ! ».
- Nommer les choses comme l’utilisateur : pas d’identifiant technique ni de message d’erreur brut à la place d’une phrase.

**Icônes.** Elles viennent de `lucide-react` : `import { Trash2 } from "lucide-react"`, puis `icon: <Trash2 size={16} />` dans une `Action`. Une icône sert une action ou un état, jamais l’ornement. La même action garde la même icône partout. L’icône d’une entrée du menu se désigne par son nom en minuscules et tirets : `list-checks`.

**Accessibilité.** WCAG 2.2 AA. Les composants en portent l’essentiel ; la page ne doit pas le défaire. Une action est une `Action`, un `Link`, une ligne de liste ou un nœud d’arbre, jamais un texte rendu cliquable. Les noms accessibles viennent des libellés (`label` d’une action, d’un champ, d’un composant ★). Un état n’est jamais porté par la couleur seule. Une page n’anime rien.

## 14. Exemples complets

Un module `suivi` avec la table `suivi_taches` (`id`, `titre`, `etat`, `echeance`, `responsable`, `description`). Ce qui sert à plusieurs pages est écrit une fois dans `lib/`.

### 14.0 `modules/suivi/lib/taches.ts`

```ts
import { db } from "@alfred/sdk";
import type { FormField, StatusMap } from "socle-ui";

export interface Tache {
  id: string;
  titre: string;
  etat: string;
  echeance: string | null;
  responsable: string | null;
  description: string | null;
}

export const ETATS: StatusMap = {
  a_faire: { label: "À faire", tone: "neutral" },
  en_cours: { label: "En cours", tone: "pending" },
  bloquee: { label: "Bloquée", tone: "danger" },
  terminee: { label: "Terminée", tone: "success" },
};

export const CHAMPS: FormField[] = [
  { type: "text", name: "titre", label: "Titre", isRequired: true },
  { type: "select", name: "etat", label: "État", width: "md", isRequired: true,
    options: Object.entries(ETATS).map(([id, { label }]) => ({ id, label })) },
  { type: "text", name: "echeance", label: "Échéance", width: "sm", placeholder: "2026-12-01" },
  { type: "textarea", name: "description", label: "Description" },
];

export const lister = () =>
  db.query<Tache>("SELECT * FROM suivi_taches ORDER BY echeance IS NULL, echeance");
export const lire = async (id: string) =>
  (await db.query<Tache>("SELECT * FROM suivi_taches WHERE id = ?", [id]))[0] ?? null;
export const enregistrer = (valeurs: Record<string, unknown>, id = crypto.randomUUID()) =>
  db.execute(
    "INSERT INTO suivi_taches (id, titre, etat, echeance, description) VALUES (?, ?, ?, ?, ?) " +
      "ON CONFLICT(id) DO UPDATE SET titre = excluded.titre, etat = excluded.etat, " +
      "echeance = excluded.echeance, description = excluded.description",
    [id, valeurs.titre as string, valeurs.etat as string, (valeurs.echeance as string) || null, (valeurs.description as string) || null],
  );
export const supprimer = (id: string) => db.execute("DELETE FROM suivi_taches WHERE id = ?", [id]);
```

(Vérifier dans SDK.md la forme exacte de `db.query` et `db.execute`.)

### 14.1 Liste : `modules/suivi/pages/taches.tsx`

```tsx
import { announceChange, notifyActionError, shell, useAsync, usePageState } from "@alfred/sdk";
import { Pencil, Plus, Trash2 } from "lucide-react";
import { ListPage, useOpenForm } from "socle-ui";
import { CHAMPS, ETATS, enregistrer, lister, supprimer, type Tache } from "../lib/taches";

export default function Taches() {
  const taches = useAsync(lister, []);
  const openForm = useOpenForm();
  const [choisie, setChoisie] = usePageState<string | null>("choisie", null);

  const saisir = async (tache?: Tache) => {
    await openForm({
      title: tache ? "Modifier la tâche" : "Nouvelle tâche",
      fields: CHAMPS,
      initialValues: tache ?? { etat: "a_faire" },
      submitLabel: tache ? "Enregistrer" : "Créer",
      onSubmit: async (valeurs) => {
        await enregistrer(valeurs, tache?.id);
        taches.reload();
        void announceChange();
      },
    });
  };

  return (
    <ListPage
      title="Tâches"
      rows={taches.data}
      columns={[
        { id: "titre", label: "Titre" },
        { id: "etat", label: "État", type: "status", statuses: ETATS },
        { id: "echeance", label: "Échéance", type: "date" },
        { id: "responsable", label: "Responsable" },
      ]}
      filters={[{ id: "etat", label: "État", allLabel: "Tous les états",
        options: Object.entries(ETATS).map(([id, { label }]) => ({ id, label })) }]}
      empty={{ title: "Aucune tâche", description: "Créez la première tâche de l’équipe." }}
      actions={[{ id: "nouvelle", label: "Nouvelle tâche", icon: <Plus size={16} />, primary: true, onPress: () => saisir() }]}
      rowActions={(tache) => [
        { id: "modifier", label: "Modifier", icon: <Pencil size={16} />, onPress: () => saisir(tache) },
        { id: "supprimer", label: "Supprimer", icon: <Trash2 size={16} />, danger: true,
          confirm: { title: `Supprimer la tâche « ${tache.titre} » ?`, message: "Cette action est définitive." },
          onPress: async () => { await supprimer(tache.id); void announceChange(); } },
      ]}
      selectedId={choisie}
      onSelect={(row) => {
        setChoisie(row?.id ?? null);
        void shell.publish(row?.id ?? null);
      }}
      isLoading={taches.loading}
      hasError={Boolean(taches.error)}
      onRetry={taches.reload}
      onActionError={notifyActionError}
      onActionDone={taches.reload}
    />
  );
}
```

### 14.2 Panneau de droite : `modules/suivi/pages/detail.tsx`

```tsx
import { announceChange, notifyActionError, useAsync, useSelection } from "@alfred/sdk";
import { Pencil } from "lucide-react";
import { Drawer, useOpenForm } from "socle-ui";
import { CHAMPS, ETATS, enregistrer, lire } from "../lib/taches";

export default function Detail() {
  const id = useSelection<string>();
  const tache = useAsync(() => (id ? lire(id) : Promise.resolve(null)), [id]);
  const openForm = useOpenForm();
  const t = tache.data;

  return (
    <Drawer
      header={t ? {
        title: t.titre,
        status: ETATS[t.etat],
        actions: [{ id: "modifier", label: "Modifier", icon: <Pencil size={16} />, onPress: () =>
          openForm({ title: "Modifier la tâche", fields: CHAMPS, initialValues: t, submitLabel: "Enregistrer",
            onSubmit: (valeurs) => enregistrer(valeurs, t.id) }) }],
      } : undefined}
      sections={t ? [
        { id: "suivi", title: "Suivi", fields: [
          { label: "État", value: t.etat, type: "status", statuses: ETATS },
          { label: "Échéance", value: t.echeance, type: "date" },
          { label: "Responsable", value: t.responsable },
        ] },
        { id: "description", title: "Description", content: t.description ?? undefined, empty: "Aucune description" },
      ] : undefined}
      isLoading={tache.loading}
      hasError={Boolean(tache.error)}
      onRetry={tache.reload}
      isNotFound={Boolean(id) && !tache.loading && !tache.error && t === null}
      emptyMessage="Sélectionnez une tâche pour voir son détail."
      onActionError={notifyActionError}
      onActionDone={() => { tache.reload(); void announceChange(); }}
    />
  );
}
```

### 14.3 Page des Réglages : `modules/suivi/pages/reglages.tsx`

```tsx
import { db, notifyActionError, useAsync } from "@alfred/sdk";
import { Stack } from "@alfred/kit";
import { Page, PageSection, Select, Toggle } from "socle-ui";

const RAPPELS = [{ id: "jamais", label: "Jamais" }, { id: "veille", label: "La veille" }, { id: "jour", label: "Le jour même" }];

export default function Reglages() {
  const reglages = useAsync(() => db.query<{ cle: string; valeur: string }>("SELECT * FROM suivi_reglages"), []);
  const valeur = (cle: string) => reglages.data?.find((ligne) => ligne.cle === cle)?.valeur ?? null;
  const enregistrer = (cle: string, v: string) =>
    db.execute("INSERT OR REPLACE INTO suivi_reglages (cle, valeur) VALUES (?, ?)", [cle, v])
      .then(reglages.reload, (erreur) => notifyActionError({ label: "Enregistrer le réglage" }, erreur));

  return (
    <Page state={reglages.error ? "error" : !reglages.data ? "loading" : "ready"} onRetry={reglages.reload}>
      <PageSection title="Rappels" description="Quand Alfred vous rappelle une échéance.">
        <Stack gap="md">
          <Select label="Rappel" width="md" options={RAPPELS} value={valeur("rappel") ?? "veille"} onChange={(id) => id && enregistrer("rappel", id)} />
          <Toggle isSelected={valeur("weekend") === "1"} onChange={(v) => enregistrer("weekend", v ? "1" : "0")}
            description="Les rappels du samedi passent au lundi.">
            Pas de rappel le week-end
          </Toggle>
        </Stack>
      </PageSection>
    </Page>
  );
}
```

### 14.4 Page composée : `modules/suivi/pages/semaine.tsx`

La semaine d’un coup d’œil : trois chiffres qui mènent à la liste, puis les deux listes qui demandent une action, côte à côte. Rien n’est caché derrière un choix d’affichage.

```tsx
import { shell, useAsync } from "@alfred/sdk";
import { Card, List, Page, PageGrid, PageSection } from "socle-ui";
import { ETATS, lister, type Tache } from "../lib/taches";

const elements = (taches: Tache[]) =>
  taches.map((t) => ({ id: t.id, title: t.titre, subtitle: t.responsable ?? undefined, meta: t.echeance ?? undefined, status: ETATS[t.etat] }));

export default function Semaine() {
  const taches = useAsync(lister, []);
  const aujourdhui = new Date().toISOString().slice(0, 10);
  const dansUneSemaine = new Date(Date.now() + 7 * 86_400_000).toISOString().slice(0, 10);
  const ouvertes = (taches.data ?? []).filter((t) => t.etat !== "terminee");
  const enRetard = ouvertes.filter((t) => t.echeance && t.echeance < aujourdhui);
  const bloquees = ouvertes.filter((t) => t.etat === "bloquee");
  const aRendre = ouvertes.filter((t) => t.echeance && t.echeance >= aujourdhui && t.echeance <= dansUneSemaine);
  const voirLaListe = () => void shell.navigate("suivi/taches");

  return (
    <Page state={taches.error ? "error" : !taches.data ? "loading" : "ready"} onRetry={taches.reload}>
      <PageGrid columns={3}>
        <Card variant="metric" label="En retard" value={String(enRetard.length)} onPress={voirLaListe} />
        <Card variant="metric" label="Bloquées" value={String(bloquees.length)} onPress={voirLaListe} />
        <Card variant="metric" label="À rendre sous 7 jours" value={String(aRendre.length)} onPress={voirLaListe} />
      </PageGrid>
      <PageGrid>
        <PageSection title="En retard" empty={enRetard.length ? undefined : { title: "Rien en retard" }}>
          <List label="Tâches en retard" selectionMode="none" items={elements(enRetard)} />
        </PageSection>
        <PageSection title="Bloquées" description="Elles attendent une réponse d’un autre service."
          empty={bloquees.length ? undefined : { title: "Rien de bloqué" }}>
          <List label="Tâches bloquées" selectionMode="none" items={elements(bloquees)} />
        </PageSection>
      </PageGrid>
    </Page>
  );
}
```

## 15. Correspondance avec l’ancienne `@alfred/ui`

Une page écrite avant socle-ui ne compile plus : `@alfred/ui` est refusée. La réécrire ainsi :

| `@alfred/ui` | socle-ui |
|---|---|
| `CollectionPage` | `ListPage` : `columns` en `{ id, label, type }`, `emptyTitle` → `empty.title`, `load` → `rows` + `useAsync` |
| `DetailPanel` (`load`, `sections`) | `Drawer` déclaratif : `header`, `sections`, `isLoading`, `hasError` ; la page charge avec `useSelection` et `useAsync` |
| `SettingsPage` | `Page` + `PageSection` + `Toggle`, `Select`, `TextInput` (section 7) |
| `openForm` | `useOpenForm()` ; champs `{ name, label, type, isRequired }` (`optional` disparaît : le champ est facultatif sans `isRequired`) |
| `openModal` | `Modal` |
| `openSubpage` | `DetailPage` avec `back`, rendue à la place de la liste |
| `confirmAction`, `ConfirmDialog` | `useConfirm()`, ou `Action` `danger` |
| `Action` (`onClick`, `icon: Pencil`, `disabled`, `hidden`) | `Action` (`id`, `onPress`, `icon: <Pencil size={16} />`, `isDisabled`, `isHidden`) ; `success` → `shell.notify` dans `onPress` |
| `Page` (`search`, `bar`, `actions`, `header`) | `Page` (`toolbar`, `actions`) ; recherche : `ListPage` ou `SearchInput` dans `toolbar` |
| `Section`, `Surface`, `Heading` | `PageSection` |
| `Grid` | `PageGrid` (blocs côte à côte) |
| `Stack`, `Row`, `Text` | `@alfred/kit` |
| `FeedbackBanner` | `Alert` de `socle-ui` (encart dans la zone), ou une notification |
| `DataTable`, `DataGrid` | `Table`, ou `ListPage` |
| `List`, `ListItem` | `List` (`items`) |
| `KeyValueList` | `fields` d’un `Drawer` |
| `TextInput`, `SelectControl`, `CheckboxControl`, `SwitchControl`, `RadioControl`, `FormField` | `TextInput`, `Select`, `Checkbox`, `Toggle`, `RadioButtonGroup` (libellé porté par le champ) |
| `Combobox`, `MultiSelectCombobox` | `ComboBox` (`selectionMode`) |
| `ChoiceGroup`, bascule de vue (`group`, `selected`) | des onglets fixes (PLACEMENT.md), `SegmentedControl` pour un mode d’affichage, ou `RadioButtonGroup orientation="horizontal"` dans un formulaire |
| `Spinner`, `LoadingSkeleton` | état `loading` du gabarit, `ProgressBar`, `Skeleton` |
| `Pagination` | `pagination` de `ListPage` |
| `Terminal channel={useChannel(id)}` | `Terminal engine={loadTerminal} {...useTerminalConnection(id)}` |
| `DocumentViewer fileId` | `DocumentViewer data={octets} loadPdf={loadPdf}` |
| `Markdown`, `MarkdownEditor` | `socle-ui/markdown`, `socle-ui/markdown-editor` |
| `TreeView label` | `TreeView aria-label` |
| `usePageState` | `usePageState` de `@alfred/sdk` |
| `useTopBarSearch` | recherche de `ListPage` |
| `copyText` | `navigator.clipboard.writeText` |

## 16. Checklist avant de dire qu’une page est terminée

- [ ] Chaque chose est à sa place selon PLACEMENT.md (entrée du menu, onglet, panneau, fenêtre, action, message) ; un doute a été posé en question à l’utilisateur.
- [ ] La page part de la recette la plus proche (section 2, « Partir d’une recette ») ; sa capture ressemble à celle de la recette.
- [ ] Le gabarit correspond à ce que la page montre (section 2) ; `Page` seulement si aucun ne convient.
- [ ] Vue d’ensemble (règle 11) : un usage par onglet ; les actions dans la barre du haut ou l’en-tête ; l’élément sélectionné au panneau ; le contenu sur toute la largeur ; les blocs courts côte à côte (`PageGrid`) ; aucun bloc qui ne porte qu’une action ; les exemples dans l’état vide.
- [ ] Chaque composant vient du catalogue (section 8), sous son nom actuel ; sa spec a été lue.
- [ ] `check` rend `"ok": true`, sans remarque `design`, sans avertissement `designWarnings` ni remarque `review`, sauf ce que demande une préférence de l’utilisateur (`designPreferences`).
- [ ] Toutes les actions sont des `Action` avec `id` et `onPress` ; une seule `primary` par zone ; une icône pour chaque action courante ; `danger` avec un `confirm` qui nomme l’objet.
- [ ] `onActionError={notifyActionError}` sur chaque gabarit qui porte des actions.
- [ ] Une page qui reçoit des fichiers : ajout par l’en-tête (`files.pick`) ou dépôt sur la page (`useFileDrop`, `isDraggingFiles` sur le gabarit) ; aucun bloc de dépôt.
- [ ] Les colonnes et les champs ont le bon `type` ; les états ont un `StatusMap` partagé.
- [ ] Le panneau lit `useSelection()` ; la page publie sa sélection ; une écriture appelle `announceChange()`.
- [ ] Aucun `style`, `className`, balise HTML ni couleur en dur.
- [ ] Textes : `empty.title` nomme l’absence, libellés à l’infinitif, typographie française.
- [ ] `page_snapshot` et `page_screenshot` montrent la page attendue, en clair et en sombre, panneau ouvert et fermé. L’écran se comprend d’un coup d’œil : ni pile de blocs, ni colonne étroite, ni grand vide (guide `page.md`, étape 7 ter).

## 17. Accueil au premier démarrage

Cette partie décrit un écran de la coquille, que les pages ne reproduisent pas : elle fixe ce que l’accueil promet à quelqu’un qui découvre Alfred (`src/shell/welcome/`).

- **Quand.** Au premier démarrage, quand aucun espace n’est connu (aucun espace récent, aucun ouvert). Quelqu’un qui a déjà un espace ne le voit jamais d’office. Il se relance depuis Réglages › Général (« Revoir l’accueil ») ; il propose alors de garder l’espace ouvert et se ferme par sa croix. Quand le dernier espace est fermé, la version courte (« Quel espace ouvrir ? ») montre les espaces récents, chacun avec « Ouvrir », puis le choix créer ou ouvrir.
- **Le parcours.** Bienvenue (une phrase, « Commencer ») ; Votre espace de travail (étape 1 sur 3) ; Vos modules (2) ; Quelques réglages (3) ; C’est prêt (résumé, « Ouvrir Alfred »). « Retour » sur chaque étape ; « Plus tard » sur toutes sauf l’espace, sans lequel rien ne peut s’écrire. Le parcours reste affiché une fois l’espace ouvert, jusqu’à « Ouvrir Alfred ».
- **L’espace.** Deux grandes cartes, « Créer un nouvel espace » (un nom, et le dossier `~/Alfred/<nom>` proposé, modifiable, avec « Parcourir… ») et « Ouvrir un espace existant » (un dossier). Un dossier qui n’est pas un espace se dit en une phrase sous le champ, sans créer d’espace vide. Il n’y a pas de carte « Récupérer depuis git » : Alfred ne sait pas encore cloner un espace.
- **Les modules.** Sans marketplace branché, un champ « Adresse git du marketplace », prérempli par une suggestion (le marketplace public d’Alfred) que l’aide présente comme telle et qui se remplace librement. Avec un marketplace, son catalogue en une liste à cocher : le nom, ce que fait le module, ce qu’il demande en une ligne (« Demande : comptes Jira et Bitbucket · 7 actions pour l’agent · 5 relevés planifiés »). Un module déjà là est coché et grisé, un module bloqué grisé avec sa raison. Le bouton principal dit ce qu’il fera (« Importer 2 modules », « Continuer » sans rien coché). « Ouvrir Alfred » enchaîne sur la configuration du premier module importé ; les autres attendent dans Réglages › Modules.
- **Les réglages.** Un seul écran, chaque réglage déjà à une valeur raisonnable et appliqué tout de suite : Apparence (thème et accent, la section des Réglages), Agent (seuls les harnais installés, avec leur état ; sans aucun, deux lignes et « Comment l’installer », sans rien lancer), Réseau d’entreprise replié (la source des modèles), Voix (une phrase : à activer plus tard, rien n’est téléchargé).
- **Rien à part.** Chaque étape relit l’état réel : espaces récents, marketplaces branchés et leur catalogue, réglages, harnais. Seul le parcours en cours (étape, modules importés pendant le parcours) est gardé en mémoire.
- **Forme.** Une fenêtre centrée de 600 px (au plus la largeur disponible) sur le fond de la coquille, bordure et rayon de 8 px. En haut « Étape n sur 3 » ; un titre de 18 px ; une phrase en gris ; le contenu ; en bas, les boutons secondaires discrets à gauche et le seul bouton principal à droite. Alfred y parle à la première personne et vouvoie. Ni bandeau, ni pastille jaune : un échec se dit sous le champ ou la ligne qu’il concerne.
