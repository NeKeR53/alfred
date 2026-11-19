# Système de design d’Alfred

Ce document s’adresse à l’agent qui écrit une page, un panneau de droite ou un onglet de Réglages. Il est recopié en lecture seule dans chaque espace.

**Vous ne dessinez pas : vous décrivez.** Une page dit quelles données elle montre, de quel type elles sont et quelles actions l’utilisateur peut faire. Un gabarit de `@alfred/ui` décide de tout le reste : la barre d’outils, la place et la forme de chaque bouton (texte, icône ou menu « ⋯ »), le tableau, le format des dates et des montants, les champs d’un formulaire et leur largeur, les états de chargement, d’absence et d’erreur, les confirmations et les notifications. Deux agents qui décrivent la même chose obtiennent la même page, au pixel près.

Alfred est précis, calme et fiable ; son ton est direct et opérationnel. Ce qu’Alfred n’est pas : un tableau de bord décoratif, un mur de cartes identiques, des métriques sans action, des dégradés, des effets de verre, des icônes d’ornement.

Le transpileur ne vérifie pas les types : une prop inventée est ignorée en silence, un composant inexistant fait échouer la page. L’outil `check` relit chaque page et signale sous `design` tout ce qui contourne les gabarits ; chaque remarque se corrige.

## 1. Règles non négociables

1. **Un gabarit d’abord.** Une liste d’objets est une `CollectionPage`, un panneau de droite est un `DetailPanel`, un onglet de Réglages est une `SettingsPage`, une saisie est un `openForm`, une confirmation est une `Action` `danger` (section 2). `Page` composée à la main seulement quand aucun gabarit ne convient (section 5).
2. **Des actions, pas des boutons.** Toute action se décrit par une `Action` (`{ label, icon, onClick, primary, danger }`, section 3) passée à un gabarit, à `Page actions` ou à `Section actions`. La page ne pose ni `Button`, ni `IconButton`, ni menu pour une action de page, d’objet ou de ligne : le gabarit choisit. Le reste (recherche, filtres, saisies, compteurs, composants du module) va librement dans les zones de la page (section 5).
3. **Imports.** Une page n’importe que `react`, `lucide-react`, `@alfred/ui`, `@alfred/sdk`, ses librairies et les fichiers de son module par chemin relatif (`./…`).
4. **Racine.** Le fichier exporte son composant par défaut (`export default function …`), qui rend un gabarit (ou `Page`) à la racine, dans tous ses états : le gabarit gère lui-même chargement, vide et erreur.
5. **Aucun style propre.** Ni `style`, ni `<style>`, ni `className`, ni balise HTML (`<div>`, `<span>`, `<button>`…). Une page ne fixe ni couleur, ni taille, ni marge, ni largeur : elle règle les props des composants.
6. **Aucun doublon de la coquille.** Le titre de la section, les onglets, le bouton du panneau, la navigation et les notifications sont dessinés par Alfred : la page ne commence pas par un titre.
7. **Le sens passe par le type et le texte.** Un état est une valeur `status` avec son libellé et son ton, jamais une couleur.
8. **Français.** Les textes affichés sont en français, avec la typographie française (section 8). Les noms du code suivent le vocabulaire du module.
9. **Un manque se compose.** Si aucun gabarit ni composant ne convient tel quel, écrire un composant du module avec ceux de `@alfred/ui` et le placer dans une zone de la page (section 5) : jamais refuser pour autant. Seul le HTML stylé reste interdit.

La règle 5 est absolue : l’utilisateur règle le mode clair ou sombre, l’accent, l’icône et la couleur des entrées du menu, et les composants suivent ces réglages. Une couleur écrite dans une page est illisible dans l’un des thèmes, une marge locale rompt l’alignement, une classe inventée ne correspond à aucune règle.

## 2. La coquille et le choix du gabarit

```
┌───────────┬───────────────────────────────────┬──────────────────┐
│ ▯         │ Titre [Onglet 1|Onglet 2]   cloche ▯ │ Panneau      ⤢ ✕ │ en-têtes : 44 px, alignés
├───────────┼───────────────────────────────────┼──────────────────┤
│ Section A │ [recherche][filtre]  ⟳ ✎ ⋯ [Nouveau] │ Fiche            │ barre de la page
│ Section B ├───────────────────────────────────┤ ▸ Blocs repliés  │
│ …         │  tableau                          │ panneau de droite│
│ Agent     │                                   │ toute la hauteur │
│ Espace ˅  │                                   │ 340, 460 ou large│
│ Réglages  │                                   │                  │
└───────────┴───────────────────────────────────┴──────────────────┘
```

- Comme dans Claude Desktop, le menu, la page et le panneau de droite prennent chacun toute la hauteur et ont chacun leur en-tête de 44 px, alignés en une seule rangée séparée par de fins traits verticaux. L’en-tête du menu porte le bouton qui le replie ; replié, il prend le fond de la barre de la page, qui semble partir du bord gauche, et le bouton ne bouge pas. L’en-tête du panneau dit ce qu’il montre, à gauche, et porte ses actions, Agrandir et Fermer, à droite. Le menu : les sections en haut ; en bas, dans cet ordre, Agent, l’espace ouvert (qui ouvre le menu des espaces) et Réglages. Replier le menu ne change que sa largeur : aucune icône ni aucun texte ne bouge.
- Une entrée du menu de gauche ouvre une **section**, dont les pages sont les **onglets** de la barre du haut. Ils sont à gauche, juste après le titre de la section, en un groupe qui n’a qu’un fond, sans filet, comme les vues d’un produit dans OneApp. À droite, les outils de la page (nouvelle fenêtre, correction de l’interface), un fin trait vertical, puis ceux de la coquille : l’indicateur d’état, la cloche et le bouton du panneau ; sans outil de page, le trait disparaît. Quand la place manque (panneau de droite ouvert), les onglets défilent, et un fondu au bord montre de quel côté la rangée continue : ni le titre ni les actions ne se réduisent pour eux.
- La page **Agent** suit les conversations dans son panneau de droite, comme la liste des agents de OneApp : une seule carte « Conversations » liste toutes les conversations, la plus récemment créée d’abord, chacune sur deux lignes (titre, puis le harnais, suivi de « réponse attendue » ou « en échec » quand c’est le cas), avec une pastille d’état dans la marge (au travail, qui pulse doucement ; réponse attendue ; en échec ; terminée ; neutre en veille) et l’heure de la dernière activité à droite (le jour et le mois avant aujourd’hui), que « Archiver » remplace au survol, sur chaque ligne. Le résumé de la carte dit « N à traiter », sinon « N au travail ». La carte « Modifications » suit. Les messages en attente tiennent une ligne chacun en tête du cadre de la saisie : poignée (ou horloge), texte, Modifier et Retirer en gris, puis le petit bouton d’envoi rond, flèche inclinée, qui l’envoie maintenant ; c’est le même bouton que l’envoi de la saisie.
- Chaque page peut déclarer **un** panneau de droite, que l’utilisateur affiche et masque. Il a trois largeurs, reprises de OneApp : 340 px (sections), 460 px (formulaire) et large (1 100 px au plus, la page gardant au moins 320 px). Le bouton Agrandir de son en-tête passe de l’une à la suivante, puis revient à la plus étroite (« Réduire le panneau » une fois large) ; la largeur choisie est retenue sur le poste. Il n’y a plus de séparateur à faire glisser : comme dans OneApp, les trois tailles le remplacent. Ses blocs se replient d’un clic sur leur titre et se déplacent par leur poignée, et leur disposition est retenue pour la page (4.2).
- Une page peut s’ajouter aux onglets des **Réglages**.
- Le placement d’une page, son titre et l’icône de son entrée se déclarent hors du fichier de la page (voir le guide de l’espace).
- L’état d’une page (données d’exemple, service à configurer…) se signale par un indicateur compact dans sa barre du haut, jamais par un bandeau pleine largeur ; seule la page d’attente remplace une page qui ne peut pas s’afficher.
- La **recherche** d’une page est dans la barre du haut, en tête des actions, comme `PageTopBar` de OneApp : 240 px qui se réduisent, sans barre de filtres à part. La page la déclare (`search` de `CollectionPage` ou de `Page`, ou `useTopBarSearch` du SDK) et Alfred lui renvoie chaque frappe ; ⌘F ou Ctrl+F y mène, même depuis la page, et Échap l’efface. Elle ignore casse et accents et exige chaque mot tapé (`matchesSearch` du SDK). Le texte est retenu tant qu’Alfred est ouvert. Une page sans recherche n’y affiche rien ; un panneau de droite garde la sienne dans son cadre.
- Une page est affichée dans un cadre isolé, sans réseau ni disque : ses données passent par `@alfred/sdk`. Une modale, un menu ou une infobulle restent dans son cadre. `window.alert`, `window.confirm` et `<a href>` ne fonctionnent pas.

Choisir le gabarit d’après ce que la page montre, sans exception :

| La page montre… | Gabarit | Placement |
|---|---|---|
| Des objets du même genre (tâches, contacts, factures, courriels, fichiers), à chercher, filtrer, ouvrir | `CollectionPage` (4.1) | Onglet d’une section |
| Le détail de l’objet sélectionné dans la liste de sa page | `DetailPanel` (4.2) | Panneau de droite (`{ "kind": "panel" }`) |
| Des préférences du module | `SettingsPage` (4.3) | Onglet des Réglages (`{ "kind": "settings" }`) |
| Une saisie (créer, modifier, renommer, inviter) | `openForm(…)` (4.4), appelé par une `Action` | Modale au-dessus de la page qui l’ouvre |
| Une confirmation avant d’agir | `Action` avec `danger` et `confirm` (3), ou `confirmAction(…)` | Modale |
| Un contenu à voir sans quitter la page : un aperçu, un choix dans une liste, un court détail | `openModal(…)` (4.6), appelé par une `Action` ou `onOpen` | Modale au-dessus de la page |
| Un objet à lire ou traiter en entier depuis une liste (un document, une fiche longue), quand un panneau est trop étroit | `openSubpage(…)` (4.7), appelé par `onOpen` ou une `Action` | Sous-page par-dessus la page, avec « Retour » |
| Une autre page de l’espace | `shell.navigate("module/page")` (SDK.md, section 8) ; `shell.openWindow` pour la fenêtre à part | L’onglet de cette page |
| Autre chose : un texte à lire (note, courriel), une synthèse, un éditeur, un graphique | `Page` composée (section 5) | Onglet |

Une page qui liste ET montre le détail est une `CollectionPage` avec `panel`, plus un `DetailPanel` déclaré comme son panneau : jamais une liste et un détail côte à côte dans la même page.

## 3. Les actions

Une `Action` décrit ce que fait un bouton ; le gabarit qui la reçoit en fait un bouton principal, une icône avec infobulle ou une entrée du menu « ⋯ ».

```ts
interface Action {
  label: string;          // verbe et objet : « Nouvelle tâche », « Modifier », « Exporter en CSV »
  icon?: ActionIcon;      // icône Lucide, sans l’instancier : icon: Pencil
  onClick: () => unknown | Promise<unknown>;
  primary?: boolean;      // l’action principale de l’endroit
  danger?: boolean;       // supprimer, révoquer, vider
  confirm?: string;       // question qui nomme l’objet : « Supprimer la tâche « Relancer le client » ? »
  confirmMessage?: string;// conséquence : « Cette action est définitive. »
  success?: string;       // notification après réussite : « Tâche supprimée »
  disabled?: boolean;
  hidden?: boolean;       // l’action n’existe pas dans cet état (Terminer une tâche terminée)
}
```

**Ce que le gabarit fait d’une action** — la page n’a aucun de ces choix à faire :

| Action | Dans une barre de page, un en-tête d’objet | Dans une section | Dans une ligne de tableau |
|---|---|---|---|
| `primary` | Bouton plein en texte, en dernier à droite ; revient dans l’état vide | Bouton plein en texte | Ignoré : icône ou menu |
| Avec `icon` | Icône avec infobulle (`label`), trois au plus | Icône, deux au plus | Icône, deux au plus, toujours visible, en gris au repos |
| Sans `icon`, ou au-delà du nombre d’icônes | Entrée du menu « ⋯ » | Menu « ⋯ » | Menu « ⋯ » |
| `danger` | Entrée rouge du menu « ⋯ », sous « Actions définitives », confirmée | Idem | Idem |

**Ce que le gabarit fait quand on clique :** confirmation si `danger` ou `confirm` (le bouton de la confirmation reprend `label`) ; indicateur d’attente tant que la promesse de `onClick` n’est pas résolue ; notification `success` après réussite ; notification d’échec « « Modifier » n’a pas abouti » avec le message de l’erreur, sans rien faire d’autre ; rechargement des données du gabarit et de l’autre cadre (la liste de la page après une action du panneau, le panneau après une action de la page). Une action qui ouvre `openForm` laisse le formulaire faire tout cela.

Règles d’écriture :

- **Une seule action `primary` par endroit** : la création (« Nouvelle tâche ») dans une liste, l’action attendue dans un en-tête. Les autres n’en ont pas.
- **Une icône pour toute action courante**, toujours la même : `Pencil` modifier, `Trash2` supprimer, `Copy` copier ou dupliquer, `Download` exporter ou télécharger, `Upload` importer, `ExternalLink` ouvrir hors d’Alfred, `Send` envoyer, `Archive` archiver, `Check` terminer ou valider, `RotateCcw` rouvrir, `Share2` partager, `Link` copier le lien, `RefreshCw` actualiser (déjà dans `CollectionPage`), `Settings` réglages, `Filter` filtrer, `Plus` ajouter dans une section. Une action rare ou longue à nommer n’a pas d’icône : elle va dans « ⋯ ».
- **Toute action destructrice est `danger`**, avec un `confirm` qui nomme l’objet et un `success`. Jamais d’icône `Trash2` hors de `danger`.
- **`label` est complet et court** : verbe à l’infinitif et objet si le contexte ne le donne pas (section 8). Le gabarit le complète pour les lecteurs d’écran (« Modifier : Relancer le client »).
- **`onClick` rend la promesse de l’écriture** (`() => db.execute(…)`) pour que l’attente, l’échec et le rechargement soient gérés. Il ne notifie pas lui-même, n’attrape pas l’erreur.

```tsx
const actions: Action[] = [
  { label: "Nouvelle tâche", primary: true, onClick: () => openForm(formulaireTache) },
  { label: "Exporter en CSV", icon: Download, onClick: exporter },
  { label: "Importer un fichier…", onClick: importer },
  {
    label: "Supprimer les tâches terminées",
    danger: true,
    confirm: "Supprimer les tâches terminées ?",
    confirmMessage: "Cette action est définitive.",
    success: "Tâches terminées supprimées",
    onClick: () => db.execute("DELETE FROM suivi_taches WHERE etat = 'terminee'"),
  },
];
```

## 4. Gabarits

Tous s’importent de `@alfred/ui`. Ils rendent eux-mêmes `Page` et tous les états ; la page ne les enveloppe dans rien.

### 4.1 `CollectionPage` — une liste d’objets

Barre (recherche, filtres, vues, Actualiser, actions), tableau dense trié au clic, actions de ligne, état vide avec l’action principale, chargement, erreur avec « Réessayer », « Aucun résultat » avec « Effacer les filtres », lien avec le panneau de détail. Exemple complet en 12.1.

| Prop | Rôle |
|---|---|
| `label: string` | Nom de la collection : « Tâches ». |
| `load: () => Promise<Row[]>` | Charge toutes les lignes (`db.query`, ou `functions.call` pour un service : jamais un client). Rappelé par Actualiser et après chaque écriture. |
| `deps?: unknown[]` | Relance `load` quand ces valeurs changent. |
| `rowKey: (row) => string \| number` | Identifiant stable ; c’est lui que le panneau reçoit. |
| `columns: Column[]` | Colonnes, l’identité de l’objet en premier ; cinq au plus (voir ci-dessous). |
| `emptyTitle: string` | « Aucune tâche » (jamais « Pas encore de… »). |
| `emptyDescription?: string` | À quoi sert la page, une phrase. |
| `search?: { label; placeholder?; text? }` | Recherche, placée dans la barre du haut d’Alfred (section 2) : `label` « Rechercher une tâche » ; `placeholder` le texte grisé (« Rechercher… ») ; `text(row)` le texte où chercher (par défaut, toutes les colonnes). Sans casse ni accents, chaque mot doit y apparaître. Toujours la fournir au-delà de dix lignes possibles. |
| `filters?: CollectionFilter[]` | Deux au plus : `{ label: "État", all: "Tous les états", value: (row) => row.etat, options: [{ value, label }] }`. Rendus en listes à la largeur de leur contenu. |
| `views?: { label; items: { id, label, test(row) }[] }` | Deux à quatre vues prédéfinies (« Ouvertes », « Toutes »), en boutons segmentés ; la première est active. |
| `actions?: Action[]` | Actions sur toute la collection ; la `primary` revient dans l’état vide. |
| `rowActions?: (row) => Action[]` | Actions d’une ligne. |
| `panel?: boolean` | La page a un panneau `DetailPanel` : un clic sur une ligne la sélectionne, publie `{ id: rowKey(row) }` et ouvre le panneau. |
| `onOpen?: (row) => void` | Autre façon d’ouvrir une ligne : `openSubpage(…)`, `openModal(…)` ou `shell.navigate(…)` ; remplace `panel`. |
| `banner?: ReactNode` | Une erreur qui empêche d’agir sur la collection : `FeedbackBanner tone="danger"` avec l’action qui la lève, posé au-dessus du tableau. Jamais pour un prérequis absent ni pour décrire un état (section 9). |

`Column<Row>` : `{ key, header, type?, value?, statuses?, currency? }`. `key` est lu dans la ligne, sauf si `value(row)` est donné ; `header` est court (« Échéance ») ; `type` (section 4.5) fixe le format, l’alignement, la largeur et le tri. Pas de largeur, pas de rendu personnalisé : une donnée qui ne rentre dans aucun type se convertit en texte dans `value`.

### 4.2 `DetailPanel` — le panneau de droite

Il lit lui-même la sélection publiée par la `CollectionPage` de sa page, charge l’objet et couvre les quatre états (rien de sélectionné, chargement, erreur, introuvable). En tête, fixe au-dessus de ce qui défile, le nom, l’état et les actions en icônes ; dessous, la fiche, puis les blocs. Un panneau composé à la main (`Page`) qui montre un objet prend le même en-tête avec `header` (section 5). Exemple complet en 12.2.

| Prop | Rôle |
|---|---|
| `load: (id) => Promise<Item \| null \| undefined>` | Charge l’objet dont l’identifiant a été publié ; `null` ou `undefined` s’il n’existe plus. |
| `emptyTitle: string` | « Aucune tâche sélectionnée ». |
| `title: (item) => string` | Le nom de l’objet. |
| `subtitle?: (item) => string` | Une ligne de contexte : « Attribuée à Léa Martin », « Reçu le 3 mars ». |
| `status?: { value: (item) => string; statuses: StatusMap }` | État, en badge à côté du nom. |
| `actions?: (item) => Action[]` | Actions sur l’objet : trois icônes au plus, puis « ⋯ ». |
| `fields?: (item) => DetailField[]` | La fiche : `{ label, value, type?, statuses?, currency?, hideEmpty? }`, six lignes au plus ; une valeur vide s’affiche « — » (ou disparaît avec `hideEmpty`). |
| `sections?: (item) => DetailSection[]` | Blocs titrés : `{ id?, title, content, empty?, actions?, summary?, summaryTone?, defaultCollapsed? }`. `content` est un texte (affiché en paragraphe) ou un contenu composé (`List`, `Markdown`, `HtmlContent`, `DataTable` à deux colonnes au plus) ; vide, il affiche `empty` (« Aucune description »). `summary` est un état court lu même bloc replié (« 3 ouverts », « Échec », ton `summaryTone`) ; `defaultCollapsed` replie un bloc long (journal, historique complet) tant que l’utilisateur ne l’a pas ouvert. `id` (par défaut le titre) retient la place et le repli du bloc : garde-le stable. |
| `notFoundTitle?: string` | « Élément introuvable » par défaut. |

Le panneau ne charge jamais une liste à lui seul et ne remplace pas la page : il montre un objet.

**Blocs repliables et déplaçables**, comme les sections du panneau d’infos de OneApp : chaque bloc a un en-tête de 32 px, son titre suivi d’un chevron et, à droite, son résumé puis ses actions. Un clic sur le titre le replie ; la poignée, révélée au survol, le déplace à la souris, ou au clavier avec Alt+↑/↓. L’ordre et les blocs repliés sont retenus pour la page, sur le poste, et survivent à la fermeture d’Alfred ; un bloc nouveau prend sa place déclarée. La fiche reste fixe en tête. Un panneau composé à la main obtient les mêmes blocs avec `PanelSections` (section 5).

### 4.3 `SettingsPage` — un onglet de Réglages

Des blocs titrés de lignes de réglage : titre et explication à gauche, contrôle à droite, aligné sur une colonne de 240 px. Chaque réglage s’applique dès qu’il change ; un échec remet la valeur précédente et notifie. Exemple complet en 12.3.

Toute page placée dans les Réglages (`{ "kind": "settings" }`) est une `SettingsPage`, jamais une `Page` composée ni un `Form` : Alfred lui donne la largeur, les marges et les titres des rubriques intégrées (Général, Modules…). Elle n’impose aucune largeur : pas de `width` sur `Page`, la rubrique prend toute la largeur de la fenêtre des Réglages. Une saisie plus longue qu’un champ passe par `openForm(…)` depuis une ligne `type: "action"`. `check` signale l’écart.

| Prop | Rôle |
|---|---|
| `load?: () => Promise<Values>` | Lit les valeurs enregistrées ; chargement et erreur sont affichés par le gabarit. |
| `sections: (values) => SettingsSection[]` | `{ title, description?, settings: Setting[] }` : un bloc par sujet, deux à six réglages chacun. |

Chaque réglage a `id`, `title` (« Notifier les retards ») et `description?` (une phrase), puis selon son `type` :

| `type` | Contrôle dessiné | Props |
|---|---|---|
| `switch` | Interrupteur, appliqué au clic | `value: boolean`, `save(value)` |
| `select` | Boutons segmentés pour trois choix courts au plus, sinon liste | `value: string`, `options: { value, label }[]`, `save(value)` |
| `text` | Champ de 240 px (96 px pour un nombre) ; Annuler et Enregistrer apparaissent sur la ligne une fois la valeur changée ; Entrée enregistre ; l’erreur remplace l’explication | `value: string`, `save(value)`, `inputType?: "text" \| "number" \| "email" \| "url"`, `placeholder?`, `optional?`, `validate?(value)` |
| `action` | Bouton texte (rouge et confirmé si `danger`) | `action: Action` |
| `info` | Valeur en lecture seule, formatée | `value`, `valueType?`, `statuses?`, `currency?` |

`save` rend la promesse de l’écriture et ne notifie pas : le gabarit s’en charge.

### 4.4 `openForm` — un formulaire en modale

`openForm(spec)` ouvre une modale dessinée d’après des champs déclarés ; il rend `true` une fois enregistré, `false` si l’utilisateur annule. Rien à rendre dans la page. Il s’appelle depuis le `onClick` d’une `Action`.

| Champ de `spec` | Rôle |
|---|---|
| `title: string` | Verbe et objet : « Nouvelle tâche », « Modifier la tâche », « Inviter un membre ». |
| `description?: string` | Une phrase sous le titre. |
| `fields: FormFieldSpec[]` | Les champs, dans l’ordre de saisie ; six au plus (au-delà, découper ou revoir le besoin). |
| `initial?: object` | Valeurs de départ : l’objet lu en base convient tel quel (`initial: tache`). |
| `submitLabel: string` | « Créer », « Enregistrer », « Inviter ». |
| `onSubmit: (values) => Promise<unknown>` | Enregistre. `values` est un objet de textes déjà nettoyés (`""` pour un champ facultatif vide, `"1"` ou `"0"` pour une case). Une erreur levée est notifiée et laisse la saisie ouverte. |
| `success?: string` | Notification après réussite : « Tâche créée ». |

Chaque champ : `{ name, label, type?, options?, optional?, placeholder?, hint?, validate? }`. Tout champ est obligatoire sauf `optional: true`, qui ajoute « (facultatif) » au libellé. `placeholder` est un exemple, sans « Ex. » (ajouté seul). Le type choisit le contrôle, sa largeur et sa vérification :

| `type` | Contrôle | Largeur | Vérification |
|---|---|---|---|
| `text` (défaut) | Champ texte | Toute la colonne | Non vide |
| `email`, `url`, `tel` | Champ texte | Toute la colonne | Adresse de courriel, adresse web complète |
| `number` | Champ texte numérique | 160 px | Nombre (virgule acceptée) |
| `date`, `time` | Sélecteur natif | 160 px | Non vide |
| `textarea` | Zone de plusieurs lignes | Toute la colonne | Non vide |
| `select` | Liste fermée (`options` obligatoire) ; « Aucun » en tête si `optional` | Celle de l’option la plus longue | Une valeur choisie |
| `checkbox` | Case à cocher, libellé à droite | — | Aucune |

Deux champs courts consécutifs (`number`, `date`, `time`, `select`) se partagent une ligne. La modale prend 360 px, ou 480 px au-delà de quatre champs ou avec une zone de texte. Messages d’erreur, attente, fermeture et retour du focus sont gérés. `validate(value, values)` ajoute une règle propre : il rend la phrase à afficher (« La date de fin suit la date de début. ») ou rien.

```tsx
const formulaireTache = (tache?: Tache): FormSpec => ({
  title: tache ? "Modifier la tâche" : "Nouvelle tâche",
  fields: [
    { name: "titre", label: "Titre", placeholder: "Relancer le client" },
    { name: "responsable", label: "Responsable", optional: true },
    { name: "echeance", label: "Échéance", type: "date", optional: true },
    { name: "etat", label: "État", type: "select", options: OPTIONS_ETAT },
  ],
  initial: tache,
  submitLabel: tache ? "Enregistrer" : "Créer",
  success: tache ? undefined : "Tâche créée",
  onSubmit: (v) => enregistrerTache(v, tache?.id),
});
```

`confirmAction({ title, message?, confirmLabel, tone? })` pose une question hors d’une `Action` et rend `true` ou `false`.

### 4.6 `openModal` — un contenu en modale

`openModal(spec)` ouvre une modale de contenu : un aperçu, un choix dans une courte liste, un détail qui ne mérite pas de quitter la page. Il rend `true` quand une de ses actions a réussi (la liste qui l’a ouverte se recharge), `false` quand l’utilisateur la ferme. Rien à rendre dans la page. Une saisie reste un `openForm`, une question un `confirmAction`.

| Champ de `spec` | Rôle |
|---|---|
| `title: string` | Ce que montre la modale : « Aperçu de la facture », « Choisir un modèle ». |
| `description?: string` | Une phrase sous le titre. |
| `size?` | `"small"` (360 px), `"default"` (480 px), `"wide"` (720 px : un tableau, un aperçu). |
| `content` | Des blocs de `@alfred/ui` (`Stack`, `KeyValueList`, `List`, `DataTable`, `Markdown`…), ou `(close) => …` pour qu’un élément de liste choisisse puis ferme. |
| `actions?: Action[]` | Pied de la modale, après « Fermer » (« Annuler » quand une action est `primary`) ; la `primary` en dernier. Une action réussie ferme la modale ; `danger` est confirmé par-dessus. |
| `closeLabel?: string` | Libellé du bouton qui ferme. |

```tsx
{
  label: "Aperçu",
  icon: Eye,
  onClick: () =>
    openModal({
      title: `Facture ${facture.numero}`,
      size: "wide",
      content: <KeyValueList items={lignesFacture(facture)} />,
      actions: [{ label: "Envoyer au client", primary: true, success: "Facture envoyée", onClick: () => functions.call("envoyer-facture", { id: facture.id }) }],
    }),
}
```

### 4.7 `openSubpage` — une sous-page

`openSubpage(spec)` ouvre un écran par-dessus la page, avec un en-tête fixe : « Retour », le nom, l’état et les actions de l’objet. La page reste dessous telle quelle (recherche, filtres, défilement) ; « Retour » ou Échap y revient. Une sous-page peut en ouvrir une autre. `closeSubpage()` ferme celle du dessus (après une suppression). La promesse se résout à la fermeture.

| Champ de `spec` | Rôle |
|---|---|
| `title: string` | Le nom de l’objet : « Relancer le client ». |
| `subtitle?: string` | Une ligne de contexte : « Créée le 3 mars par Léa ». |
| `status?: { label, tone }` | État, en badge à côté du nom. |
| `actions?: Action[]` | Actions de l’objet : trois icônes au plus, puis « ⋯ », la `primary` en texte. |
| `content` | Les blocs de la sous-page (`Section`, `KeyValueList`, `DataTable`, `Markdown`…) : jamais un gabarit ni une `Page`. |
| `width?` | `"text"` pour un document à lire (760 px), `"full"` par défaut. |

```tsx
<CollectionPage
  label="Contrats"
  onOpen={(contrat) =>
    openSubpage({
      title: contrat.nom,
      status: { label: "Signé", tone: "success" },
      width: "text",
      content: <Markdown>{contrat.texte}</Markdown>,
    })
  }
  …
/>
```

### 4.5 Types de valeurs

Le même `type` sert aux colonnes, aux lignes de fiche et aux réglages `info`. Il fixe le format français, l’alignement, la largeur de colonne et le tri. Une valeur vide s’affiche « — ».

| `type` | Affiché | Colonne |
|---|---|---|
| `text` (défaut) | Le texte | Prend la place restante |
| `longtext` | Paragraphe | Fiche seulement |
| `number` | « 1 234,5 » | 110 px, à droite |
| `money` | « 1 234,50 € » (`currency` pour une autre devise) | 130 px, à droite |
| `percent` | 0,25 → « 25 % » | 110 px, à droite |
| `date` | « 20 nov. 2026 » (texte `AAAA-MM-JJ`, ISO, horodatage) | 130 px, à droite |
| `datetime` | « 20 nov. 2026, 14:30 » | 170 px, à droite |
| `relative` | « il y a 3 jours », « demain » | 140 px, à droite |
| `boolean` | « Oui » ou « Non » | 90 px |
| `status` | Badge coloré d’après `statuses` | 140 px |
| `email`, `url` | Lien qui s’ouvre hors d’Alfred | Place restante |
| `code` | Identifiant à chasse fixe | 160 px |
| `tags` | « a, b, c » | Place restante |

`StatusMap` relie chaque valeur enregistrée à son libellé et à son ton : `neutral` (à faire, brouillon), `warning` (en cours, en attente, bientôt dû), `success` (terminé, payé, actif), `danger` (en retard, échec, refusé). Le définir une fois en haut du fichier et le réutiliser dans la colonne, le filtre, le panneau et le formulaire.

```tsx
const ETATS: StatusMap = {
  a_faire: { label: "À faire", tone: "neutral" },
  en_cours: { label: "En cours", tone: "warning" },
  terminee: { label: "Terminée", tone: "success" },
};
const OPTIONS_ETAT = Object.entries(ETATS).map(([value, etat]) => ({ value, label: etat.label }));
```

## 5. Page composée

Seulement quand aucun gabarit ne convient : lire un document, une synthèse de quelques blocs, un éditeur ou un graphique de librairie. La page reste une colonne de blocs, dans cet ordre : objet principal, blocs de détail ; aucun bandeau en tête de page.

**Zones de la page.** `Page` se découpe en zones, toutes facultatives, de haut en bas :

```
┌───────────────────────────────────────────────────────────┐
│ header   en-tête fixe (nom, état, actions — ou contenu libre) │
├───────────────────────────────────────────────────────────┤
│ barre    [search][bar : contenu libre…]        [actions] │  fixe
├───────────────────────────────────────────────────────────┤
│ children les blocs, seule zone qui défile                 │
├───────────────────────────────────────────────────────────┤
│ footer   pied fixe, contenu libre                         │
└───────────────────────────────────────────────────────────┘
```

Une zone libre reçoit **ce que la page veut** : des composants de `@alfred/ui` (`ChoiceGroup`, `SelectControl`, `MultiSelectCombobox`, `Text`, `StatusBadge`…), ou un composant du module écrit avec eux (une recherche à étiquettes avec autocomplétion, par exemple, dans un fichier `./RechercheEtiquettes.tsx`). La zone fixe la place, la hauteur, l’alignement et l’espacement ; le contenu reste celui de la page. Rien n’y est obligatoire ni figé : un besoin que les composants ne couvrent pas se compose dans une zone, il ne se refuse pas.

**`Page`** — racine. Props :
- `header?` : soit `{ title, subtitle?, status?: { label, tone }, actions?: Action[] }` (l’en-tête de l’objet que montre la page : un panneau de droite composé, la fiche d’un document), soit un contenu libre. Jamais le titre de la section, que la coquille affiche.
- `search?: { label, placeholder?, value, onChange(value) }` : la recherche simple, qu’Alfred place dans sa barre du haut (section 2). Sans autre état à partager, `useTopBarSearch` du SDK fait la même chose et filtre en plus (`recherche.matches(…)`).
- `bar?: ReactNode` : zone libre de la barre, après la recherche (ou à sa place) : filtres, recherche à étiquettes, compteur, choix de vue. Elle s’étire sur la largeur disponible et tient sur **une seule ligne**, comme dans OneApp : quand la largeur manque, elle défile horizontalement, avec un fondu au bord du côté où elle continue. Rien n’y passe à la ligne, même dans un `Row wrap` ; seule une recherche à étiquettes se réduit, jusqu’à sa largeur minimale.
- `actions?: Action[]` : à droite de la barre (icônes, « ⋯ », action principale, disposées comme en section 3).
- `footer?: ReactNode` : pied fixe sous ce qui défile (total, sélection, pagination).
- `width`: `"full" \| "text"` (`"full"` ; `text` pour de la lecture : 760 px au plus) ; `fill?: boolean` (le contenu occupe la hauteur sans défiler : pour un `DataTable fill` ou un éditeur) ; `children`.

**Ce qui doit survivre au départ de la page** : quand l’utilisateur quitte une page et y revient, son cadre est recréé. Toute valeur qu’il s’attend à retrouver (texte de recherche, étiquettes, filtres, onglet, vue, élément ouvert) se déclare avec `usePageState(clé, valeurDeDépart)` de `@alfred/ui`, qui s’emploie exactement comme `useState` : Alfred la retient et la rend au retour, sans clignotement. Les gabarits le font d’eux-mêmes (`CollectionPage` retrouve sa recherche, ses filtres, sa vue et sa ligne ouverte). Réserve-le à l’état de l’écran, petit et en JSON ; les données restent dans la base. Les clés qui commencent par `alfred.` sont réservées aux gabarits (disposition des blocs d’un panneau) : n’en choisis pas.

```tsx
const [etiquettes, setEtiquettes] = usePageState<string[]>("etiquettes", []);
<Page bar={<TagSearchField label="Rechercher un ticket" tags={etiquettes} onTagsChange={setEtiquettes} suggestions={projets} />}>
```

**La barre** est la petite bande fixe sous l’en-tête : elle apparaît dès que `search`, `bar` ou `actions` est donné. Une page composée qui veut une recherche ou des filtres en haut s’en sert, toujours (seule la prop `toolbar`, une barre toute faite, est réservée aux gabarits). Marge, défilement et espacement des blocs (24 px) sont fixés ; l’en-tête, la barre et le pied restent fixes.

**`Section`** — un bloc titré : `title`, `description?` (une phrase), `actions?: Action[]` (à droite du titre : deux icônes au plus, une action principale en texte s’il le faut, le reste dans « ⋯ »), `children`. Un bloc par sujet ; pas de titre de page au-dessus.

**`PanelSections`** — les blocs d’un panneau de droite composé à la main, repliables et déplaçables comme ceux de `DetailPanel` : `sections: { id, title, content, summary?, summaryTone?, action?, defaultCollapsed? }[]`, et `name?` pour distinguer deux listes dans le même panneau. L’ordre et le repli sont retenus pour la page (clé réservée `alfred.sections.<name>`). Dans un panneau, préfère-le à une suite de `Section`.

**Disposer dans un bloc** — `Stack` (empile, `gap` `"md"` par défaut), `Row` (aligne, `gap` `"sm"`, `align`, `justify`, `wrap`), `Grid` (colonnes fluides d’au moins `minColumnWidth` px, 240 par défaut), `Divider` (filet entre deux groupes d’un même bloc). `Surface` (`title?`, `footer?`) encadre un contenu autonome dans une page large ; un bloc qui suit une `Section` dans la surface (le pied d’une carte : état et `ProgressBar`) est collé au bas de la surface, quelle que soit la hauteur du contenu, comme `footer` : dans une `Grid`, les surfaces d’une rangée ont la même hauteur et leurs pieds s’alignent ; jamais autour d’une liste ou d’un tableau, jamais imbriquée, jamais répétée en grille de chiffres. Une carte qui ouvre son objet dans le panneau de droite (une carte de déploiement) prend `onOpen` (un bouton couvre la carte : clic hors de ses boutons, Entrée ou Espace au clavier), `openLabel` (« Ouvrir le détail de … », obligatoire) et `selected` pour la carte ouverte, comme un `ListItem`.

### Catalogue des composants

Tout ce qu’une page affiche existe déjà dans `@alfred/ui`, dessiné et accessible : la page les **emploie**, elle ne les dessine pas. Cherche ici le besoin, prends le composant, règle ses props. Un besoin absent se compose avec eux (règle 9).

**Rechercher et filtrer** (la recherche dans la barre du haut, les filtres dans la barre de la page : `bar`)

| Besoin | Composant | Props essentielles |
|---|---|---|
| Recherche dans la page, placée par Alfred dans la barre du haut | `useTopBarSearch` du SDK, ou `Page search` | `label`, `placeholder?` ; `recherche.matches(champ, …)` filtre sans accents, chaque mot exigé. Le texte est retenu au retour. Jamais un `SearchField` en tête de page : il ne sert que dans un bloc (une recherche propre à une liste secondaire) |
| Recherche à étiquettes : suggestions pendant la frappe, Entrée pose la première (ou le texte saisi s’il n’y en a pas, ou après Échap), la croix ou Retour arrière la retire | `TagSearchField` | `label`, `tags`, `onTagsChange`, `suggestions?`, `formatTag?` (`ville:lyon` → « Ville : Lyon »), `allowFreeText?` (vrai), `onQueryChange?` |
| Filtre à plusieurs valeurs d’une liste connue (états, responsables) | `MultiSelectCombobox` | `label`, `values`, `options`, `onChange`, `formatOption?`, `valueMode?` (`"custom"` accepte une valeur saisie), `display?` |
| Deux à quatre choix exclusifs visibles (vue, période) | `ChoiceGroup appearance="segmented"` + `ChoiceButton` | `label` ; chaque bouton `label`, `selected`, `onClick`, `variant="label"`, `size="compact"` |
| Un choix dans une liste fermée | `SelectControl` | props d’un `<select>` + `<option>` |

**Montrer des données**

| Besoin | Composant | Props essentielles |
|---|---|---|
| Collection principale d’une page (tri, recherche, filtres, sélection) | `CollectionPage` (4.1) | `columns`, `load`, `search`, `filters` |
| Tableau secondaire dans un bloc | `DataTable` | `label`, `columns` (`key`, `header`, `align?`, `render?`, `sortable?`), `rows`, `rowKey`, `onRowClick?`, `selectedKey?`, `loading?`, `emptyTitle?`, `fill?` (sous `Page fill` : seules les lignes défilent, l’en-tête reste fixe) |
| Découper une longue liste | `Pagination` dans `Page footer`, et `pageOf(rows, page, pageSize)` | `page` (dès 1), `pageSize`, `total`, `onChange` |
| Quelques éléments hétérogènes (personnes, fichiers, résultats) | `List` + `ListItem` | `title`, `description?`, `leading?` (un `Avatar`, une icône), `trailing?` (un `StatusBadge`, une date), `onClick?`, `selected?` |
| Fiche « libellé : valeur » d’un objet | `KeyValueList` | `items: { label, value }[]` |
| Une valeur formatée (montant, date, durée) | `FormattedValue` | `value`, `options: { type, statuses, currency }` |
| Un état | `StatusBadge` (`tone`, `size="compact"`), `StatusDot` | — |
| Une personne | `Avatar` | `name`, `src?` (`data:`/`blob:`), `size?` (`sm`, `md`, `lg`) |
| Avancement, quota | `ProgressBar` | `label`, `value`, `max?` (100), `showValue?`, `tone?` |

**Lire un contenu** (section « Texte et contenus venus des données » ci-dessous)

`Text`, `Heading`, `Code` (identifiant, extrait), `Link`, `Image` (`data:`/`blob:`), `Markdown` (texte riche venu des données), `HtmlContent` (corps d’un courriel, nettoyé et isolé), `DocumentViewer` (un document entier : PDF, image, texte, Markdown, avec page x/y, zoom et ouverture dans l’application du système).

**Organiser et naviguer**

| Besoin | Composant | Props essentielles |
|---|---|---|
| Rubriques d’un même objet | `Tabs` | `label`, `items: { id, label, content? }[]`, `activeId`, `onChange` |
| Contenu secondaire replié | `Disclosure` | `label`, `children`, `appearance?` |
| Étapes d’un parcours | `StepList` | `label`, `steps`, `current`, `onSelect?` |
| Disposer | `Stack`, `Row`, `Grid`, `Divider`, `Surface`, `Section`, `PanelSections` (panneau) | voir plus haut |
| Ouvrir un objet en entier, une saisie, un contenu | `openSubpage`, `openForm`, `openModal` (section 4) | — |

**Agir**

| Besoin | Composant | Props essentielles |
|---|---|---|
| Action de page, d’objet, de section ou de ligne | une `Action` (section 3) dans `actions` | `label`, `icon?`, `onClick`, `primary?`, `danger?` |
| Bouton dans le contenu d’un bloc (« Tester la connexion » sous une explication) | `Button` | `variant?` (`primary`, `secondary`, `subtle`, `danger`, hiérarchie ci-dessous), `loading?`, `onClick` |
| Icône seule dans un contenu | `IconButton` | `label` (obligatoire, devient l’infobulle), `onClick`, `size?` |
| Menu de quelques choix dans un contenu | `MenuButton` (texte) ou `OverflowMenu` (« ⋯ ») + `MenuItem` | `label`, `children` |
| Modifier une valeur isolée sur place | `InlineEdit` | `label`, `value`, `onSave`, `renderEditor` |

Hiérarchie des boutons texte, du plus au moins appuyé. Tous se voient comme des boutons au repos, sans survol, en clair comme en sombre :

| `variant` | Rendu | Pour |
|---|---|---|
| `primary` | Plein | L’action attendue de l’endroit, une seule : « Ajouter votre compte » quand il n’y en a aucun, « Enregistrer » |
| `secondary` (par défaut) | Contour et fond | Toute autre action : « Ajouter un compte », « Tester », « Annuler », « Tout voir » |
| `subtle` | Discret, sans contour | Un retour avec `ArrowLeft` (« Tous les modules », « Terminer plus tard ») ; rien d’autre |
| `danger` | Contour et texte rouges | Une action destructrice hors d’une `Action` |

`outline` est l’ancien nom de `secondary`. Une action utile ne se cache ni dans un menu « ⋯ » quand elle est l’action courante de la ligne (« Tester » un compte prêt), ni derrière un survol : elle reste visible, le menu garde les autres.

**Saisir** (dans `openForm` de préférence ; ailleurs, toujours dans un `FormField`)

`FormField` (`label`, `hint?`, `error?`) autour de `TextInput`, `TextArea`, `SelectControl`, `CheckboxControl`, `RadioControl`, `SwitchControl` ; `Combobox` (saisie libre avec suggestions : `value`, `options`, `onChange`) ; `SearchCombobox` (choisir une entité dans une recherche distante : `value`, `options`, `onChange`, `onSelect`, `getOptionKey`, `getOptionLabel`, `loading?`).

**Dire ce qui se passe** (section 9)

`FeedbackBanner` (`tone`: `"danger" \| "warning"`, `action?` : une erreur qui empêche d’agir, dans le bloc concerné), `EmptyState` (`title`, `description?`, `size="compact"` dans un bloc), `LoadingSkeleton` (premier chargement), `Spinner` (opération de fond, à côté d’un `Text`), `ProgressBar` (opération longue mesurable), `shell.notify` (événement ponctuel).

**Réservé aux gabarits et à la coquille** — ne s’emploient pas dans une page (`check` signale la plupart) : `PageToolbar`, `ToolbarSeparator`, `SettingRow`, `SettingRows`, `Modal` (passer par `openModal`), `ConfirmDialog`, `useConfirm`, `FormActions`, `AnchoredPanel`, `ObjectHeader` (passer par `Page header`), `PageTopBar`, `PanelToggleButton`, `PanelHeader`, `Dialog`, `Menu`, la prop `toolbar` de `Page`, et des boutons en JSX passés à `actions`. `Button`, `IconButton`, `OverflowMenu` et `MenuButton` ne servent qu’au contenu d’un bloc (« Tester la connexion » sous une explication), jamais pour une action de page, d’objet ou de ligne.

### Texte et contenus venus des données

| Composant | Rôle | Props (défaut) |
|---|---|---|
| `Heading` | Titre ; niveaux 1, 2, 3 sans saut | `level`: `1 \| 2 \| 3` (`2`) |
| `Text` | Tout texte | `tone` (`"default"`), `size`: `"meta" \| "body" \| "panel"` (`"body"`), `weight`: `"normal" \| "medium" \| "strong"` (`"normal"`), `as`: `"p" \| "span" \| "div"` (`"p"`) |
| `KeyValueList` | Fiche « libellé : valeur » d’un objet (exemple en 12.2) ; pas pour des données tabulaires | `items: { id?: string \| number; label: string; value: ReactNode }[]` |
| `Code` | Texte à chasse fixe et chiffres tabulaires : identifiant, chemin, valeur technique ; `block` pour un extrait de plusieurs lignes, qui défile et se joint au clavier | `children`, `block` (`false`), `label` (`"Extrait de code"`, nom du bloc) |
| `Link` | Lien texte souligné dans une phrase ou une cellule | Avec `href: string` et `onNavigate: (href) => void` : un lien, dont l’adresse web ou `mailto:` porte l’icône « hors d’Alfred ». Sans `href` : `onClick`, bouton d’apparence lien |
| `Image` | Image venue des données (`data:` ou `blob:` ; une adresse distante affiche son texte de remplacement) | `src`, `alt: string` (obligatoire ; `""` si décorative), `size`: `"sm" \| "md" \| "lg" \| "full"` (`"md"` : 120, 240, 480 px, toute la largeur), `fit`: `"contain" \| "cover"` (`"contain"` ; `cover` : vignette carrée) |
| `Markdown` | Affiche un texte Markdown venu des données (note, réponse d’un agent) : titres, listes, tableaux, code. Pas pour composer la page elle-même | `children: string`, `onLink?: (href: string) => void` |
| `HtmlContent` | Affiche un HTML venu de l’extérieur, le corps d’un courriel (Outlook, Gmail…) : nettoyé par liste blanche (ni script, ni gestionnaire `on…`, ni formulaire, ni cadre) et isolé dans une racine fantôme, ses styles ne débordent pas. Le seul moyen d’afficher du HTML : jamais `dangerouslySetInnerHTML` ni `innerHTML` | `html: string`, `onLink?: (url) => void`, `resolveImage?: (source) => Promise<string \| null>` (image jointe `cid:` ou distante → adresse `data:`/`blob:` ; sans, elle reste masquée), `label?: string` |
| `DocumentViewer` | Affiche un document en entier dans la page : PDF (dessiné par pdf.js, chargé à la première demande), image, texte brut (`.txt`, `.log`, `.csv`, `.json`…) ou Markdown (`.md`). Barre : page x/y, zoom (aussi Ctrl+molette), ajuster à la largeur, et pour un fichier du module « Ouvrir avec l’application du système » (`files.open`). États chargement, « Document illisible » (message) et « Format non pris en charge » (avec l’ouverture dans l’application du système). Un PDF a une hauteur fixe ; le reste prend celle de son contenu | Une source : `file` (id d’un fichier du module, lu par `files.read`), `src` (adresse `data:` ; `blob:` pour une image seulement, la page ne pouvant pas lire une adresse `blob:`) ou `blob: Blob` (un `File` déposé) ; `label: string` (obligatoire), `name?` (nom affiché, reconnaît le format), `type?` (MIME forcé), `fill?` (`false` ; occupe la hauteur restante d’une `Page fill`) |

Utiliser `as="span"` quand le texte est dans une `Row`, à côté d’une icône ou d’une pastille. Dans `Markdown` comme dans `Link`, un lien ne navigue jamais seul : `onLink` ou `onNavigate` reçoit l’adresse et décide quoi en faire.

```tsx
<Markdown
  onLink={(href) => {
    if (/^https?:\/\//.test(href)) void shell.openExternal(href);
  }}
>
  {note}
</Markdown>
<Link href="https://exemple.fr/aide" onNavigate={(href) => void shell.openExternal(href)}>
  Lire l’aide
</Link>
```

Corps HTML d’un courriel Outlook (Microsoft Graph : `body.contentType === "html"`) ; les images jointes `cid:` se
chargent par la pièce jointe du message, les images distantes restent masquées :

```tsx
<HtmlContent
  label={`Message de ${message.from.emailAddress.name}`}
  html={message.body.content}
  onLink={(url) => void shell.openExternal(url)}
  resolveImage={async (source) => {
    if (!source.startsWith("cid:")) return null;
    const attachment = message.attachments?.find((item) => item.contentId === source.slice(4));
    return attachment ? `data:${attachment.contentType};base64,${attachment.contentBytes}` : null;
  }}
/>
```

## 6. Couleurs et thèmes

La palette est restreinte : des neutres chauds, un seul accent, et trois couleurs sémantiques réservées aux états. Alfred suit le thème du système ou le choix clair ou sombre de l’utilisateur, et applique lui-même l’accent choisi. Une page ne lit ni n’écrit aucun jeton.

Jetons, pour comprendre les composants : `--color-bg` (fond de page, de champ, de modale), `--color-surface` et `--color-surface-strong` (barre d’outils, en-tête de tableau, survol, élément enfoncé, badge neutre), `--color-ink` (texte et bouton principal), `--color-muted` (métadonnées, aides, icônes au repos), `--color-primary` et `--color-primary-strong` (l’accent : focus, sélection, choix actif, jamais une décoration), `--color-success`, `--color-warning`, `--color-danger` et leurs variantes `-ink` et `-bg` (états), `--line` et `--control-border` (séparateurs ; contour des champs à 3:1 au moins).

Le sens passe toujours par une prop, accompagnée d’un texte :

| Ce qu’il faut dire | Comment |
|---|---|
| État d’un objet | Valeur de type `status` avec son `StatusMap` (4.5) ; hors gabarit, `<StatusBadge tone="…">Libellé</StatusBadge>` |
| Pastille devant un libellé d’état | `<StatusDot tone="success \| warning \| danger \| neutral \| pending" />` |
| Texte secondaire ou d’état | `<Text tone="default \| muted \| success \| warning \| danger">` |
| Erreur qui empêche d’agir | `<FeedbackBanner tone="danger \| warning">` dans le bloc concerné, avec l’action qui la lève |
| Notification | `shell.notify({ tone: "info" \| "success" \| "warning" \| "error" })` |
| Action principale, action destructrice | `Action` avec `primary` ; `Action` avec `danger` |

L’échec s’écrit `danger` dans tout `@alfred/ui` (`FeedbackBanner` accepte aussi `error`, son synonyme) ; seul `shell.notify` l’écrit `error`. Choisir le ton selon la gravité, jamais selon la couleur souhaitée. Les huit teintes (`steel`, `blue`, `violet`, `pink`, `red`, `orange`, `green`, `teal`) servent à la couleur de chaque entrée du menu, qui ne teinte que son icône, et à l’accent choisi par l’utilisateur, qu’Alfred applique aux jetons primaires avec un contraste d’au moins 4,5:1 : une page ne les nomme jamais.

## 7. Typographie, espacement, densité

Alfred est une application de bureau dense, utilisée à la souris et au clavier. La police, les tailles, les hauteurs et les espacements sont fixés par les gabarits et les composants ; cette section les décrit pour une page composée.

Tailles : 12 px pour les métadonnées, aides et en-têtes de tableau (`<Text size="meta">`) ; 13 px pour le texte courant, les cellules, champs et boutons (`<Text>`, `<Heading level={3}>` en gras) ; 14 px pour un titre de section ou de panneau (`<Section title>`, `<Heading level={2}>`, `<Text size="panel">`) ; 18 px pour le nom de l’objet auquel une page entière est consacrée (`<Heading level={1}>`, une fois par page au plus).

Graisses de `Text` : `normal` (400), `medium` (500), `strong` (600). Un texte long se lit sur 65 à 75 caractères par ligne : c’est le rôle de `Page width="text"`, sans effet dans les Réglages, qui prennent toute la largeur.

Échelle d’espacement, commune à `Stack`, `Row` et `Grid` :

| `gap` | Pixels | Usage |
|---|---|---|
| `none` | 0 | Lignes déjà séparées par leur hauteur (cases à cocher) |
| `xs` | 4 | Icône et texte, pastille et libellé, titre et sous-titre |
| `sm` | 8 | Boutons voisins, éléments d’une même ligne (défaut de `Row`) |
| `md` | 12 | Champs d’un formulaire, blocs d’une section (défaut de `Stack` et `Grid`) |
| `lg` | 24 | Entre deux groupes distincts |

Hauteurs fixées par les composants : bouton, champ et liste déroulante 32 px ; zone de texte 72 px au moins ; bouton icône 28 px (24 px en `small`) ; barre d’outils 40 px ; en-tête de tableau 32 px, ligne 36 px environ ; icônes 16 px. Rayons : 6 px pour les contrôles, 8 px pour les surfaces. Les nombres d’une colonne s’alignent à droite.

## 8. Vocabulaire des actions et libellés

Un libellé d’action est un verbe à l’infinitif, suivi de son objet quand le contexte ne le donne pas, avec une seule majuscule et sans point final. Le même verbe désigne la même action partout.

| Libellé | Sens | Règle |
|---|---|---|
| « Nouveau… », « Nouvelle… » (« Nouvelle tâche ») | Ouvre la création d’un objet de premier niveau | Action principale de la barre d’outils et de l’état vide |
| « Ajouter… » (« Ajouter un membre ») | Insère un élément dans un ensemble qui existe déjà | |
| « Créer » | Valide un formulaire de création | Action principale du formulaire |
| « Enregistrer » | Valide les modifications d’un objet existant | Pendant l’opération : « Enregistrement… » |
| « Modifier » | Ouvre l’édition | Icône `Pencil`, ouvre `openForm` |
| « Supprimer » | Efface définitivement | `danger`, avec `confirm` et `success` |
| « Retirer » | Enlève une appartenance sans effacer l’objet | Confirmé si l’effet est difficile à défaire |
| « Archiver » | Masque sans effacer | Sans confirmation |
| « Annuler » | Abandonne la saisie ou ferme sans effet | Posé par `openForm` et les confirmations |
| « Actualiser » | Recharge les données | Déjà dans `CollectionPage` ; ailleurs, icône `RefreshCw` |
| « Réessayer » | Relance ce qui a échoué | Posé par les gabarits après un échec de chargement |

- Une confirmation pose une question qui nomme l’objet (« Supprimer la tâche « Relancer le client » ? »), décrit la conséquence dans `message` et reprend le verbe dans `confirmLabel`.
- Une notification constate un fait : « Tâche supprimée », « La tâche n’a pas été supprimée ». La cause va dans `description`.
- Les points de suspension marquent une opération en cours (« Enregistrement… »), un texte d’exemple (« Rechercher… ») ou une action qui demandera un choix avant de s’exécuter (« Importer un fichier… »).
- Typographie française : apostrophe « ’ », guillemets « », espace avant « : », « ? » et « ! ». Dates et nombres passent par `Intl.DateTimeFormat("fr-FR", …)` et `Intl.NumberFormat("fr-FR")`.
- Nommer les choses comme l’utilisateur les nomme : pas d’identifiant technique, de nom de table ni de message d’erreur brut à la place d’une phrase.

## 9. États : chargement, vide, erreur, notification

Les gabarits rendent chaque état ; une page composée applique le même tableau (`useAsync(charger, deps)` de `@alfred/sdk` rend `{ data, error, loading, reload }`).

| Situation | Rendu (posé par le gabarit) |
|---|---|
| Premier chargement | `LoadingSkeleton`, après 200 ms |
| Rechargement | Les données restent affichées ; tableau et Actualiser en attente |
| Action en cours | Indicateur dans le bouton de l’action ; modale bloquée pendant un enregistrement |
| Collection vide | `EmptyState` : `emptyTitle` nomme l’absence (« Aucune tâche »), `emptyDescription` dit à quoi sert la page, l’action `primary` est proposée ; ni barre d’outils, ni filtres, ni compteurs à zéro |
| Aucun résultat après recherche ou filtre | « Aucun résultat » avec « Effacer les filtres » |
| Rien de sélectionné, objet introuvable (panneau) | `EmptyState` compact : `emptyTitle`, `notFoundTitle` |
| Échec de chargement | `FeedbackBanner tone="danger"` avec « Réessayer », à la place du bloc qui n’a pas pu se charger |
| Prérequis absent, le bloc ne peut rien montrer | `EmptyState` (`size="compact"` dans un bloc) qui nomme ce qui manque, avec l’action qui le résout (« Choisir un dossier ») |
| Prérequis absent, le bloc montre quand même quelque chose ; données dégradées | Un message court dans le bloc lui-même (`<Text size="meta" tone="muted">`), à côté de ce qu’il concerne |
| Champ invalide | Message sous le champ, posé par `openForm` ou la ligne de réglage |
| Résultat d’une action | Notification `success` d’une `Action` ou d’un `openForm` (`success`) |
| Échec d’une action | Notification d’erreur posée par le gabarit, avec la cause |

Une **notification** est transitoire : elle s’efface après 5 secondes (une erreur reste jusqu’à sa fermeture) et demeure consultable dans la cloche. **Aucune page n’a de bandeau en tête**, ni dans la coquille ni dans son code : un état qui dure se dit dans le bloc qu’il concerne (`EmptyState` ou message court), et l’état de toute la page (données d’exemple…) par un indicateur de la barre du haut, que pose la coquille. `FeedbackBanner` est réservé à une erreur qui empêche d’agir, dans le bloc concerné. Pas de notification pour un état qui dure, rien pour dire « enregistré ». Un réglage appliqué réussit en silence.

## 10. Icônes

- Les icônes viennent de `lucide-react`, importées par leur nom en PascalCase : `import { Trash2 } from "lucide-react"`.
- Dans une `Action`, l’icône se passe sans l’instancier (`icon: Pencil`) : taille, nom accessible et infobulle sont posés par le gabarit. Dans une page composée, `size={16}` et `aria-hidden="true"`.
- Une icône sert une action ou un état. Pas d’icône d’ornement devant un titre, dans un état vide ou pour remplir une surface ; pas d’émoji à la place d’une icône.
- Un bouton texte ne porte pas d’icône qui répète le verbe de son libellé : « Ajouter un compte », pas « + Ajouter un compte ». L’icône accompagne le texte seulement si elle dit ce que le libellé ne dit pas, par exemple une ouverture hors d’Alfred (`ExternalLink`) ou un retour (`ArrowLeft` devant « Tous les modules »).
- La même action garde la même icône dans toutes les pages : la liste est en section 3.
- L’icône d’une entrée du menu de gauche se désigne par son nom Lucide en minuscules et tirets : `list-checks` pour `ListChecks`, `calendar-days` pour `CalendarDays`. Un nom inconnu affiche un carré. La choisir pour ce qu’elle évoque du contenu, distincte de celles des autres entrées.

## 11. Accessibilité et mouvement

L’objectif est WCAG 2.2 AA. Les composants en portent l’essentiel ; la page ne doit pas le défaire.

- **Clavier.** Les gabarits sont entièrement utilisables au clavier. Ne jamais rendre cliquable un `Text` ou une `Surface` à la main : une action est une `Action`, un `Link`, un `ListItem`, une ligne de tableau ou une `Surface onOpen`, qui gère elle-même le focus, Entrée et Espace.
- **Focus.** Il est visible sur chaque contrôle et revient au déclencheur à la fermeture d’une modale ou d’un menu. Ne pas le déplacer à la main.
- **Noms accessibles.** Ils viennent des libellés : `label` d’une `Action`, d’une collection, d’un champ, `title` d’un réglage. Un libellé décrit l’action et son objet.
- **Couleur.** Un état n’est jamais porté par la couleur seule : `StatusBadge` contient son libellé, `StatusDot` est suivie d’un texte, une erreur de champ est une phrase.
- **Titres.** Dans une page composée, `Heading` et `Section` se suivent sans saut de niveau : le contenu d’une `Section` (niveau 2) utilise `Heading level={3}` ou `Surface title`.
- **Annonces.** Les composants d’état annoncent déjà leur contenu ; ne pas doubler un message par un second canal.
- **Texte.** Un libellé long doit pouvoir passer à la ligne.
- **Mouvement.** Une page n’anime rien. Les transitions des composants sont brèves, expliquent un changement d’état et sont neutralisées quand le système demande un mouvement réduit.

## 12. Exemples complets

Un module `suivi` avec les tables `suivi_taches` (`id`, `titre`, `etat`, `echeance`, `responsable`, `description`) et `suivi_reglages` (`cle`, `valeur`). Ce qui sert à plusieurs pages (le type, les états, le formulaire) est écrit une fois dans `lib/`.

### 12.0 Fichier partagé : `modules/suivi/lib/taches.ts`

```tsx
import { type Action, type FormSpec, type FormValues, type StatusMap } from "@alfred/ui";
import { db } from "@alfred/sdk";

export interface Tache {
  id: number;
  titre: string;
  etat: string;
  echeance: string | null;
  responsable: string | null;
  description: string | null;
}

export const ETATS: StatusMap = {
  a_faire: { label: "À faire", tone: "neutral" },
  en_cours: { label: "En cours", tone: "warning" },
  terminee: { label: "Terminée", tone: "success" },
};

export const OPTIONS_ETAT = Object.entries(ETATS).map(([value, etat]) => ({ value, label: etat.label }));

function enregistrer(v: FormValues, id?: number) {
  const valeurs = [v.titre, v.responsable || null, v.echeance || null, v.etat];
  return id === undefined
    ? db.execute("INSERT INTO suivi_taches (titre, responsable, echeance, etat) VALUES (?, ?, ?, ?)", valeurs)
    : db.execute("UPDATE suivi_taches SET titre = ?, responsable = ?, echeance = ?, etat = ? WHERE id = ?", [
        ...valeurs,
        id,
      ]);
}

/** Formulaire de création (sans tâche) ou de modification (avec la tâche). */
export function formulaireTache(tache?: Tache): FormSpec {
  return {
    title: tache ? "Modifier la tâche" : "Nouvelle tâche",
    fields: [
      { name: "titre", label: "Titre", placeholder: "Relancer le client" },
      { name: "responsable", label: "Responsable", optional: true },
      { name: "echeance", label: "Échéance", type: "date", optional: true },
      { name: "etat", label: "État", type: "select", options: OPTIONS_ETAT },
    ],
    initial: tache,
    submitLabel: tache ? "Enregistrer" : "Créer",
    success: tache ? undefined : "Tâche créée",
    onSubmit: (v) => enregistrer(v, tache?.id),
  };
}

export function supprimerTache(tache: Tache): Action {
  return {
    label: "Supprimer",
    danger: true,
    confirm: `Supprimer la tâche « ${tache.titre} » ?`,
    confirmMessage: "Cette action est définitive.",
    success: "Tâche supprimée",
    onClick: () => db.execute("DELETE FROM suivi_taches WHERE id = ?", [tache.id]),
  };
}
```

### 12.1 Liste : `modules/suivi/pages/taches.tsx`

```tsx
import { Copy, Pencil } from "lucide-react";
import { CollectionPage, type Column, openForm } from "@alfred/ui";
import { db } from "@alfred/sdk";
import { ETATS, formulaireTache, OPTIONS_ETAT, supprimerTache, type Tache } from "../lib/taches";

const colonnes: Column<Tache>[] = [
  { key: "titre", header: "Titre" },
  { key: "responsable", header: "Responsable" },
  { key: "etat", header: "État", type: "status", statuses: ETATS },
  { key: "echeance", header: "Échéance", type: "date" },
];

export default function TachesPage() {
  return (
    <CollectionPage<Tache>
      label="Tâches"
      load={() => db.query<Tache>("SELECT * FROM suivi_taches ORDER BY echeance")}
      rowKey={(tache) => tache.id}
      columns={colonnes}
      panel
      emptyTitle="Aucune tâche"
      emptyDescription="Les tâches créées ici apparaissent dans cette liste."
      search={{ label: "Rechercher une tâche" }}
      filters={[{ label: "État", all: "Tous les états", value: (tache) => tache.etat, options: OPTIONS_ETAT }]}
      actions={[{ label: "Nouvelle tâche", primary: true, onClick: () => openForm(formulaireTache()) }]}
      rowActions={(tache) => [
        { label: "Modifier", icon: Pencil, onClick: () => openForm(formulaireTache(tache)) },
        {
          label: "Dupliquer",
          icon: Copy,
          success: "Tâche dupliquée",
          onClick: () =>
            db.execute("INSERT INTO suivi_taches (titre, etat) VALUES (?, 'a_faire')", [`${tache.titre} (copie)`]),
        },
        supprimerTache(tache),
      ]}
    />
  );
}
```

### 12.2 Panneau de droite : `modules/suivi/pages/detail.tsx`

```tsx
import { Check, Pencil } from "lucide-react";
import { DetailPanel, openForm } from "@alfred/ui";
import { db } from "@alfred/sdk";
import { ETATS, formulaireTache, supprimerTache, type Tache } from "../lib/taches";

export default function TacheDetail() {
  return (
    <DetailPanel<Tache>
      load={async (id) => (await db.query<Tache>("SELECT * FROM suivi_taches WHERE id = ?", [Number(id)]))[0]}
      emptyTitle="Aucune tâche sélectionnée"
      notFoundTitle="Tâche introuvable"
      title={(tache) => tache.titre}
      subtitle={(tache) => (tache.responsable ? `Attribuée à ${tache.responsable}` : "Non attribuée")}
      status={{ value: (tache) => tache.etat, statuses: ETATS }}
      actions={(tache) => [
        { label: "Modifier", icon: Pencil, onClick: () => openForm(formulaireTache(tache)) },
        {
          label: "Terminer",
          icon: Check,
          hidden: tache.etat === "terminee",
          success: "Tâche terminée",
          onClick: () => db.execute("UPDATE suivi_taches SET etat = 'terminee' WHERE id = ?", [tache.id]),
        },
        supprimerTache(tache),
      ]}
      fields={(tache) => [
        { label: "Échéance", value: tache.echeance, type: "date" },
        { label: "Responsable", value: tache.responsable },
      ]}
      sections={(tache) => [
        {
          title: "Description",
          content: tache.description,
          empty: "Aucune description",
          actions: [
            {
              label: "Modifier la description",
              icon: Pencil,
              onClick: () =>
                openForm({
                  title: "Modifier la description",
                  fields: [{ name: "description", label: "Description", type: "textarea", optional: true }],
                  initial: tache,
                  submitLabel: "Enregistrer",
                  onSubmit: (v) =>
                    db.execute("UPDATE suivi_taches SET description = ? WHERE id = ?", [v.description || null, tache.id]),
                }),
            },
          ],
        },
      ]}
    />
  );
}
```

### 12.3 Onglet de Réglages : `modules/suivi/pages/reglages.tsx`

```tsx
import { SettingsPage } from "@alfred/ui";
import { db } from "@alfred/sdk";

const ECRIRE =
  "INSERT INTO suivi_reglages (cle, valeur) VALUES (?, ?) ON CONFLICT(cle) DO UPDATE SET valeur = excluded.valeur";
const ecrire = (cle: string, valeur: string) => db.execute(ECRIRE, [cle, valeur]);

async function lire() {
  const rows = await db.query<{ cle: string; valeur: string }>("SELECT cle, valeur FROM suivi_reglages");
  return new Map(rows.map((row) => [row.cle, row.valeur]));
}

export default function ReglagesSuivi() {
  return (
    <SettingsPage
      load={lire}
      sections={(valeurs) => [
        {
          title: "Nouvelles tâches",
          description: "Valeurs proposées à la création d’une tâche.",
          settings: [
            {
              id: "equipe",
              type: "text",
              title: "Nom de l’équipe",
              description: "Affiché sur chaque tâche.",
              value: valeurs.get("equipe") ?? "",
              save: (valeur) => ecrire("equipe", valeur),
            },
            {
              id: "delai",
              type: "select",
              title: "Échéance par défaut",
              value: valeurs.get("delai") ?? "7",
              options: [
                { value: "1", label: "Un jour" },
                { value: "7", label: "Une semaine" },
                { value: "30", label: "Un mois" },
              ],
              save: (valeur) => ecrire("delai", valeur),
            },
            {
              id: "rappel",
              type: "text",
              inputType: "number",
              title: "Rappel avant l’échéance, en jours",
              value: valeurs.get("rappel") ?? "2",
              save: (valeur) => ecrire("rappel", valeur),
            },
          ],
        },
        {
          title: "Notifications",
          settings: [
            {
              id: "retards",
              type: "switch",
              title: "Tâches en retard",
              description: "Une notification quand une tâche dépasse son échéance.",
              value: valeurs.get("notifier_retards") === "1",
              save: (actif) => ecrire("notifier_retards", actif ? "1" : "0"),
            },
          ],
        },
        {
          title: "Données",
          settings: [
            {
              id: "purger",
              type: "action",
              title: "Tâches terminées",
              description: "Les retirer définitivement de la liste.",
              action: {
                label: "Supprimer",
                danger: true,
                confirm: "Supprimer toutes les tâches terminées ?",
                confirmMessage: "Cette action est définitive.",
                success: "Tâches terminées supprimées",
                onClick: () => db.execute("DELETE FROM suivi_taches WHERE etat = 'terminee'"),
              },
            },
          ],
        },
      ]}
    />
  );
}
```

### 12.4 Page composée : `modules/suivi/pages/semaine.tsx`

Une synthèse de la semaine : aucun gabarit ne convient, la page compose des blocs. Les actions passent quand même par `Page actions` et `Section actions`.

```tsx
import { Download, RefreshCw } from "lucide-react";
import {
  Button,
  EmptyState,
  FeedbackBanner,
  FormattedValue,
  KeyValueList,
  List,
  ListItem,
  LoadingSkeleton,
  Page,
  Section,
} from "@alfred/ui";
import { db, shell, useAsync, useTopBarSearch } from "@alfred/sdk";
import { ETATS, type Tache } from "../lib/taches";

export default function SemainePage() {
  const taches = useAsync(
    () =>
      db.query<Tache>(
        "SELECT * FROM suivi_taches WHERE echeance BETWEEN date('now') AND date('now', '+7 days') ORDER BY echeance",
      ),
    [],
  );
  // La recherche, dans la barre du haut d’Alfred : sans accents ni casse, chaque mot doit être dans le titre.
  const recherche = useTopBarSearch({ label: "Rechercher une tâche de la semaine" });
  const liste = (taches.data ?? []).filter((tache) => recherche.matches(tache.titre));
  const ouvertes = liste.filter((tache) => tache.etat !== "terminee").length;

  return (
    <Page
      width="text"
      actions={[
        { label: "Actualiser", icon: RefreshCw, onClick: taches.reload },
        { label: "Exporter la semaine", icon: Download, onClick: () => shell.navigate("suivi/export") },
      ]}
    >
      {taches.error ? (
        <FeedbackBanner tone="danger" action={<Button onClick={taches.reload}>Réessayer</Button>}>
          La semaine n’a pas pu être chargée : {taches.error.message}
        </FeedbackBanner>
      ) : taches.data === undefined ? (
        <LoadingSkeleton variant="page" rows={4} label="Chargement de la semaine…" />
      ) : (
        <>
          <Section title="En bref">
            <KeyValueList
              items={[
                { label: "Tâches de la semaine", value: liste.length },
                { label: "Encore ouvertes", value: ouvertes },
              ]}
            />
          </Section>
          <Section title="Échéances">
            {liste.length === 0 ? (
              <EmptyState size="compact" title="Aucune échéance cette semaine" />
            ) : (
              <List label="Échéances de la semaine">
                {liste.map((tache) => (
                  <ListItem
                    key={tache.id}
                    title={tache.titre}
                    description={tache.echeance ? <FormattedValue value={tache.echeance} options={{ type: "date" }} /> : undefined}
                    trailing={<FormattedValue value={tache.etat} options={{ type: "status", statuses: ETATS }} />}
                    onClick={() => shell.navigate("suivi/taches")}
                  />
                ))}
              </List>
            )}
          </Section>
        </>
      )}
    </Page>
  );
}
```

## 13. Checklist avant de dire qu’une page est terminée

- [ ] Le gabarit correspond à ce que la page montre (section 2) ; une `Page` composée n’est employée que si aucun ne convient.
- [ ] `check` rend `"ok": true`, sans remarque `design`.
- [ ] Toutes les actions sont des `Action` : une seule `primary` par endroit, une icône pour chaque action courante (section 3), `danger` avec `confirm` et `success` pour toute destruction ; `onClick` rend la promesse de l’écriture.
- [ ] Les colonnes, fiches et réglages ont le bon `type` (section 4.5) ; les états ont un `StatusMap` partagé.
- [ ] Les saisies passent par `openForm`, champs typés, facultatifs marqués `optional` ; un contenu à voir sans quitter la page par `openModal`, un objet à traiter en entier par `openSubpage`.
- [ ] Un panneau composé qui montre un objet a son `header` ; aucune page n’appelle un client (les données d’un service viennent de `functions.call`).
- [ ] Textes : `emptyTitle` nomme l’absence, libellés à l’infinitif (section 8), typographie française.
- [ ] `page_snapshot` et `page_screenshot` montrent la page attendue, en clair et en sombre, panneau ouvert et fermé.
