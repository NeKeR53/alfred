# Système de design d’Alfred

Ce document s’adresse à l’agent qui écrit une page, un panneau de droite ou une page des Réglages. Il est recopié en lecture seule dans chaque espace.

**Vous ne dessinez pas : vous décrivez.** Les pages d’Alfred utilisent **socle-ui**, le design system partagé de l’utilisateur. Une page dit quelles données elle montre, de quel type elles sont et quelles actions l’utilisateur peut faire. Un gabarit de `socle-ui` décide du reste : la barre d’outils, la forme de chaque bouton (texte, icône ou menu « … »), le tableau, le format des dates et des montants, les champs d’un formulaire, les états de chargement, d’absence et d’erreur, les confirmations. Deux agents qui décrivent la même chose obtiennent la même page.

Alfred est précis, calme et fiable ; son ton est direct et opérationnel. Ce qu’Alfred n’est pas : un tableau de bord décoratif, un mur de cartes identiques, des métriques sans action, des dégradés, des icônes d’ornement.

Le transpileur ne vérifie pas les types : une option inventée est ignorée en silence, un composant inexistant fait échouer la page. L’outil `check` relit chaque page et signale sous `design` tout ce qui contourne socle-ui ; chaque remarque se corrige.

## 1. Règles non négociables

1. **Un gabarit d’abord.** Une collection est une `ListPage`, un panneau de droite est un `DetailPanel` déclaratif, une saisie courte est `useOpenForm`, une saisie longue est une `FormPage`, un élément ouvert en entier est une `DetailPage`. `Page` et `PageSection` seulement quand aucun gabarit ne convient : tableau de bord, éditeur, graphique (section 2).
2. **Des actions, pas des boutons.** Une action de page, de section, d’objet ou de ligne est une `Action` (section 4) passée au gabarit. Le gabarit choisit bouton à texte, icône ou entrée du menu « … ». `Button` ne sert qu’au pied d’une `Dialog` et à l’action d’un `EmptyState`.
3. **Imports.** Une page importe `react`, `lucide-react`, `socle-ui`, `socle-ui/markdown`, `socle-ui/markdown-editor`, `@alfred/sdk`, `@alfred/kit`, ses librairies npm et les fichiers de son module par chemin relatif (`./…`). Jamais un chemin interne de socle-ui (`socle-ui/dist/…`), ni une librairie que socle-ui enveloppe déjà (React Aria, Radix…). `@alfred/ui` ne s’importe plus dans une page nouvelle : elle reste servie en transition aux pages anciennes, que `check` signale « à migrer vers socle-ui » (correspondance en section 15).
4. **Racine.** Le fichier exporte son composant par défaut (`export default function …`). Il rend un gabarit à la racine, dans tous ses états : le gabarit gère chargement, vide et erreur.
5. **Aucun style propre.** Ni `style`, ni `className`, ni `<style>`, ni balise HTML (`<div>`, `<span>`, `<button>`…), ni couleur en dur (`#3366ff`, `rgb(…)`). Une page règle les options des composants (`variant`, `size`, `tone`, `width`, `density`). L’écart entre deux composants vient de `Stack` et `Row` de `@alfred/kit`.
6. **Aucun doublon de la coquille.** Le nom de la page, les onglets, la cloche, le bouton du panneau et la navigation sont dessinés par Alfred. Une page ne rend ni `AppShell`, ni `Sidebar`, ni `NotificationCenter`, ni `SettingsPage`.
7. **Le sens passe par le type et le texte.** Un état est une valeur `status` avec son libellé et son ton (`StatusTone`), jamais une couleur.
8. **Français.** Les textes affichés sont en français, avec la typographie française (section 13).
9. **Un manque se compose.** Si aucun gabarit ne convient tel quel, composer des composants de socle-ui dans une `Page`. Ce que socle-ui ne fait pas du tout (un graphique, un calendrier, un éditeur riche) passe par une librairie npm (section 8).

La règle 5 est absolue. L’utilisateur règle le mode clair ou sombre et l’accent ; les composants les suivent. Une couleur écrite dans une page est illisible dans l’un des thèmes.

## 2. La coquille et le choix du gabarit

```
┌───────────┬──────────────────────────────────────┬──────────────────┐
│ ▯         │ Titre [Onglet 1|Onglet 2]  ⋯ ⟳ [Nouv.] cloche ▯ │ Panneau ⤢ ✕ │
├───────────┼──────────────────────────────────────┼──────────────────┤
│ Section A │  gabarit de la page                  │ DetailPanel      │
│ Section B │  (ListPage, Page, DetailPage…)       │ de l’objet       │
│ …         │                                      │ sélectionné      │
│ Agent     │                                      │                  │
│ Espace ˅  │                                      │                  │
│ Réglages  │                                      │                  │
└───────────┴──────────────────────────────────────┴──────────────────┘
```

- Une entrée du menu de gauche ouvre une **section**. Ses pages sont les **onglets** de la barre du haut, après le titre de la section.
- La barre du haut appartient à la coquille. Une page peut y mettre des actions (`useTopBarActions`) et un résumé court après le titre (`useTopBarSummary`) : voir section 4. Elle n’y met **pas de recherche** : la recherche d’une collection est celle de `ListPage`.
- Chaque page peut déclarer **un** panneau de droite. L’utilisateur l’affiche, le masque et choisit sa largeur.
- Une page peut s’ajouter aux **Réglages** (section 7).
- Une page peut ajouter sa **zone** au menu de gauche : des entrées sous l’entrée de sa section, une par objet suivi (`menu.setEntries`, SDK.md, section 8).
- Le placement d’une page, son titre et l’icône de son entrée se déclarent hors du fichier de la page (voir le guide de l’espace).
- L’état d’une page (données d’exemple, service à configurer) se signale dans sa barre du haut, par la coquille. Jamais par un bandeau pleine largeur.
- Une page est affichée dans un cadre isolé, sans réseau ni disque : ses données passent par `@alfred/sdk`. Une modale, un menu ou une infobulle restent dans son cadre. `window.alert`, `window.confirm` et `<a href>` ne fonctionnent pas.

Choisir le gabarit d’après ce que la page montre :

| La page montre… | Gabarit | Placement |
|---|---|---|
| Des éléments de même nature (tâches, contacts, factures, fichiers), à chercher, filtrer, ouvrir | `ListPage` (section 5) | Onglet d’une section |
| Les propriétés de l’élément sélectionné dans la liste de sa page | `DetailPanel` déclaratif (section 6) | Panneau de droite (`{ "kind": "panel" }`) |
| Des préférences du module | `Page` et `PageSection`, avec des réglages immédiats (section 7) | Réglages (`{ "kind": "settings" }`) |
| Une saisie courte (créer, renommer, inviter : six champs au plus) | `useOpenForm()` (section 9), appelé par une `Action` | Modale |
| Une saisie longue (une fiche riche, une demande) | `FormPage` (section 9) | Vue de la page |
| Une confirmation avant d’agir | `Action` `danger` ou `confirm` (section 4), ou `useConfirm()` | Modale |
| Un contenu à voir sans quitter la page (aperçu, choix) | `Dialog` (section 9) | Modale |
| Un élément à lire ou traiter en entier depuis une liste | `DetailPage` avec `back` (section 10) | Vue de la page, à la place de la liste |
| Une autre page de l’espace | `shell.navigate("module/page")` ; `shell.openWindow` pour une fenêtre à part | L’onglet de cette page |
| Autre chose : tableau de bord, synthèse, éditeur, graphique | `Page` et `PageSection` (section 10) | Onglet |

Une page qui liste ET montre le détail est une `ListPage` qui publie sa sélection, plus un `DetailPanel` déclaré comme son panneau : jamais une liste et un détail côte à côte dans la même page.

Des vues d’une même page (« À faire », « Terminées », « Planning ») sont des `Tabs` en tête de la page, ou des pages distinctes de la section. Jamais des boutons accolés.

## 3. Imports et structure d’une page

```tsx
import { Plus } from "lucide-react";                         // icônes
import { db, shell, useAsync, notifyActionError } from "@alfred/sdk"; // données et coquille
import { ListPage, useOpenForm } from "socle-ui";            // composants et gabarits
import { Markdown } from "socle-ui/markdown";                 // rendu Markdown
import { MarkdownEditor } from "socle-ui/markdown-editor";    // éditeur Markdown
import { Notice, Row, Stack, Text } from "@alfred/kit";       // écart et texte hors gabarit
```

- **`socle-ui`** : tous les composants et gabarits. Avant d’employer un composant, relire ses options dans ce document ; un nom ou une option absente n’existe pas.
- **`@alfred/sdk`** : base, fonctions, fichiers, coquille, état retenu (`usePageState`), chargement (`useAsync`) et moteurs (`loadTerminal`, `loadPdf`). Référence : SDK.md.
- **`@alfred/kit`** : quatre petits composants d’Alfred, là où socle-ui n’a rien :
  - `Stack` (`gap` : `none`, `xs`, `sm`, `md`, `lg`) empile des blocs ;
  - `Row` (`gap`, `wrap`, `justify` : `start`, `between`, `end`) aligne sur une ligne ;
  - `Text` (`as` : `p` ou `span` ; `tone` : `default`, `muted`, `danger`, `warning`, `success` ; `size` : `default` ou `meta` ; `weight` : `normal`, `medium`, `strong`) écrit une phrase ;
  - `Notice` (`tone` : `info`, `success`, `warning`, `danger` ; `title`, `children`, `action`) pose un encart dans une zone.
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
| `section` | `actions` de `PageSection`, en-tête et sections de `DetailPanel` | Bouton secondaire `sm` | 2 | « … » |
| `row` | `rowActions` de `ListPage`, actions d’un nœud de `TreeView` | Sans effet | 1 | « … » |
| `empty` | État vide | Bouton à texte, seul | 0 | rien |

- Ordre : icônes, « … », action principale à droite. Un seul bouton plein par écran.
- Une action `danger` est confirmée. `confirm` nomme l’objet : « Supprimer la tâche « Relancer le client » ? » ; `message` dit la conséquence : « Cette action est définitive. »
- Les gabarits ne notifient pas l’échec d’une action : passer `onActionError={notifyActionError}` (de `@alfred/sdk`) à `ListPage`, `DetailPage` et `DetailPanel`. Alfred affiche « « Supprimer » n’a pas abouti » avec la cause. `onActionDone` sert à recharger les données.
- Après une écriture qui réussit, notifier seulement si le résultat ne se voit pas : `shell.notify({ title: "Tâche supprimée", tone: "success" })`.

**Barre du haut.** `useTopBarActions(actions)` de `@alfred/sdk` place des actions de la page dans la barre du haut d’Alfred (zone `topbar`). Elle confirme une action `danger` ou `confirm`, montre l’attente et notifie l’échec. À réserver à une `Page` composée, qui n’a pas d’en-tête ; une `ListPage` ou une `DetailPage` garde ses actions dans son en-tête. `useTopBarSummary("3 en retard · 12 ouvertes")` met un résumé court après le titre. Un panneau n’a ni l’un ni l’autre.

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
  onOpen={(row) => ouvrir(row)}        // double-clic ou Entrée : DetailPage
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
| `layout`, `item` | `"list"` quand chaque élément se lit seul ; `item: { title, subtitle, meta, status }` nomme les colonnes de chaque pièce. |
| `search` | Recherche dans la barre (vrai par défaut). `{ label: "les tâches", text: (row) => … }`. Sans casse ni accents, chaque mot doit apparaître. |
| `filters` | Trois au plus : `{ id, label, allLabel, options: [{ id, label }], value?: (row) => clé }`. |
| `actions`, `rowActions` | Actions de la page (zone `header`) et d’une ligne (zone `row`). L’action `primary` revient dans l’état vide. |
| `selectionMode="multiple"`, `selectionActions` | Cases à cocher et actions groupées sur la sélection. |
| `selectedId`, `onSelect`, `onOpen` | Sélection (clic, flèches) et ouverture (double-clic, Entrée). |
| `pagination` | `{ mode: "more" \| "pages", pageSize }` ; « Afficher plus » de 50 par défaut. |
| `empty` | `{ title, description, icon }` : obligatoire. |
| `isLoading`, `hasError`, `onRetry` | États de chargement. |
| `remote`, `total`, `onStateChange` | Données filtrées côté base : le gabarit signale `{ query, filters, sort, page }` et ne filtre rien. |
| `storageId` | Clé de mémorisation des filtres et du tri. |

- Pas de rendu de cellule libre, pas de largeur de colonne : le type décide.
- Pas de bouton « Actualiser » automatique : une `Action` avec l’icône `RefreshCw` si les données changent hors d’Alfred.
- Une ligne sélectionnée se publie pour le panneau : `onSelect={(row) => { setChoisie(row?.id ?? null); void shell.publish(row?.id ?? null); }}`.

## 6. `DetailPanel` — le panneau de droite

Le panneau lit la sélection publiée par sa page, charge l’objet et le décrit. Il ne charge rien lui-même.

```tsx
const id = useSelection<string>();                         // de @alfred/sdk
const tache = useAsync(() => (id ? lireTache(id) : Promise.resolve(null)), [id]);
return (
  <DetailPanel
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

- `header` : `{ title, subtitle, status: { label, tone }, actions }` (zone `section`).
- `sections` : `{ id, title, fields, content, empty, actions, summary, defaultCollapsed }`. `id` est stable : il mémorise le repli. `summary` dit l’état d’un mot, lisible replié : « 2 en retard ».
- `fields` : `{ label, value, type, statuses, hideEmpty, icon, action }`. La valeur est brute ; le `type` la met en forme (section 11). Une valeur modifiable sur place est un `InlineEdit` en `value`.
- `content` : un composant de socle-ui sous les champs (`Table`, `List`, `Markdown`). Un texte devient un paragraphe.
- Après une écriture dans le panneau, `announceChange()` de `@alfred/sdk` prévient la page : ses `useAsync` se relancent. Dans l’autre sens, la page fait de même.
- Pas de champ de saisie dans une ligne : une modification passe par une action (menu, interrupteur, `useOpenForm`) ou par `InlineEdit`.

## 7. Une page des Réglages

Une page placée dans les Réglages (`{ "kind": "settings" }`) est une rubrique : la fenêtre des Réglages porte déjà la navigation et le titre. La page est une `Page` sans `width`, faite de `PageSection`, chacune avec des réglages qui s’appliquent **tout de suite** :

```tsx
<Page state={reglages.loading && !reglages.data ? "loading" : reglages.error ? "error" : "ready"} onRetry={reglages.reload}>
  <PageSection title="Lecture" description="Comment les messages s’affichent.">
    <Stack gap="md">
      <Switch isSelected={valeurs.apercu} onChange={(v) => enregistrer("apercu", v)} description="Une ligne du message sous l’objet.">
        Aperçu des messages
      </Switch>
      <Select label="Tri" width="md" options={TRIS} value={valeurs.tri} onChange={(v) => enregistrer("tri", v)} />
      <TextField label="Signature" width="lg" defaultValue={valeurs.signature} onBlur={…} />
    </Stack>
  </PageSection>
</Page>
```

- Un interrupteur, une liste ou un texte s’enregistre seul ; un texte à la sortie du champ. Pas de bouton « Enregistrer », pas de notification « Réglage enregistré ».
- Une liste gérée (comptes, clés) : une `Table` dans la section, avec `rowActions`, et une action « Ajouter… » en `actions` de la section, qui ouvre `useOpenForm`.
- Pas de `FormPage`, pas de `SettingsPage` (elle dessinerait une seconde navigation).

## 8. Composants de socle-ui et librairies

Composer ces composants dans une `Page`, une `PageSection`, une `DetailPage` ou le `content` d’une section. Chaque composant marqué ★ demande un nom accessible.

| Besoin | Composant | Options utiles |
|---|---|---|
| Tableau dans un bloc | `Table` | `columns: [{ id, label, align?, width?, sortable? }]`, `rows`, `selectionMode`, `onAction`, `rowActions`, `density="compact"`, `groupBy`, `rowDescription` |
| Liste qui se lit élément par élément | `List` | `items: [{ id, title, subtitle, meta, status, unread }]`, `onAction`, `itemActions`, `groups` |
| Hiérarchie (dossiers, chemins, catégories) | `TreeView` ★ `aria-label` | `nodes: [{ id, label, icon, meta, children, hasChildren }]`, `loadChildren(node, signal)`, `selectionMode`, `onAction`, `actions(node)`, `onMove` |
| Journal horodaté (build, conteneur) | `LogViewer` ★ `label` | `lines` (texte ANSI ou `{ text, time, level }`), `live`, `levels`, `fill`, `actions(view)`, `ref` (`append`, `clear`) |
| Console interactive | `Terminal` ★ `label` | `engine={loadTerminal}`, `{...useTerminalConnection(canal)}`, `onResize`, `readOnly`, `fill` |
| Différences entre deux textes | `DiffView` ★ `label` | `before` et `after`, ou `patch` (le `text` de `git.diff`), `fileName`, `truncated`, `fill` |
| Aperçu d’un PDF ou d’une image | `DocumentViewer` ★ `label` | `data` (octets de `files.read`) ou `src`, `name`, `type`, `loadPdf={loadPdf}`, `onDownload`, `actions`, `height` |
| HTML reçu (courriel) | `HtmlContent` ★ `label` | `html`, `onLink`, `resolveImage`, `surface` |
| Texte Markdown | `Markdown` (de `socle-ui/markdown`) | `children` (le texte), `headingLevel`, `onLinkPress`, `renderImage` |
| Écrire du Markdown | `MarkdownEditor` ★ `label` (de `socle-ui/markdown-editor`) | `value`, `onChange`, `preview="toggle"`, `fill`, `onPasteImage` |
| État d’un élément | `StatusBadge` (`tone`, libellé en enfant), `StatusDot` (`label`, `tone`) | Tons : `neutral`, `pending`, `info`, `success`, `warning`, `danger` |
| Valeur typée hors gabarit | `FormattedValue` | `value`, `type`, `statuses`, `currency` |
| Avancement, quota | `ProgressBar` | `label`, `value`, `max`, `tone` |
| Étapes d’un parcours | `StepList` | `label`, `steps`, `current`, `onSelect` |
| Bloc repliable | `Disclosure` | `title`, `defaultExpanded` |
| Propriété avec action | `PropertyRow` | `label`, `value`, `action` |
| Texte modifiable sur place | `InlineEdit` | `value`, `label`, `onSave` |
| Vues d’une page | `Tabs` | `items: [{ id, label }]`, `selectedId`, `onSelectionChange` |
| Volet sans voile | `Popover` | `trigger`, `title`, `children` |
| Menu d’un bouton, menu contextuel | `Menu`, `useContextMenu()` | `trigger`, `items={<Menu.Item label onAction />}` |
| Champ de recherche d’une `Page` | `SearchField` | `label`, `onChange({ text, tags })`, `tagMode` |
| Champs | `TextField`, `TextArea`, `Select`, `ComboBox`, `Checkbox`, `RadioGroup`, `Switch`, `Fieldset` | `label`, `description`, `error`, `isRequired`, `width` (`xs` à `lg`) |
| Identifiant, commande | `Code` | `block` pour un extrait |
| Personne | `Avatar` | `name`, `src`, `size` |
| Lien | `Link` | `href` externe, ou `onPress` |
| Squelette d’attente | `Skeleton` | `shape`, `width` |
| Bloc vide | `EmptyState` | `title`, `description`, `icon`, `action={<Button variant="primary">…</Button>}` |

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

**Contenu à voir : `Dialog`.** `isOpen`, `onOpenChange`, `title`, `description`, `size` (`sm` à `xl`), `footer` : des `Button`, « Annuler » puis l’action.

## 10. Page composée et élément ouvert

**`Page` et `PageSection`** : un tableau de bord, une synthèse, un éditeur.

- `Page` : `toolbar` (contenu libre sur une ligne : `SearchField`, `Select` de période), `actions` (zone `toolbar`), `footer`, `width` (`full` ou `text`), `fill` (le contenu prend la hauteur, pour un `LogViewer` ou un `Terminal` en `fill`), `state` (`ready`, `loading`, `error`), `onRetry`.
- `PageSection` : `title` (obligatoire), `description`, `actions` (zone `section`), `state`, `onRetry`, `empty: { title, description, action }`.
- Pas de titre de page : il est dans la barre du haut. Pas de cartes décoratives ni de chiffres sans action.

**`DetailPage`** : un élément ouvert en entier, depuis `onOpen` d’une liste. La page garde l’élément ouvert dans `usePageState("ouvert", null)` et rend la `DetailPage` à la place de la `ListPage` :

```tsx
if (ouvert) return (
  <DetailPage
    title={facture.numero}
    back={{ label: "Factures", onPress: () => setOuvert(null) }}
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

Une colonne de `ListPage`, un champ de `DetailPanel` et `FormattedValue` prennent la valeur brute et son `type`. La page ne formate rien elle-même.

| `type` | Valeur attendue | Rendu |
|---|---|---|
| `text` (défaut), `longtext` | texte | coupé avec infobulle ; `longtext` sur plusieurs lignes |
| `number`, `money`, `percent`, `bytes` | nombre | format français, aligné à droite ; `currency` (défaut `EUR`), `decimals` |
| `date`, `datetime`, `relative` | ISO 8601, ou millisecondes | « 3 févr. 2026 », « il y a 2 h » |
| `duration` | nombre (`durationUnit` : `ms`, `s`, `min`) | « 1 h 05 » |
| `boolean` | `true` / `false` | « Oui » / « Non » |
| `status` | clé | `StatusBadge` d’après `statuses` |
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
| Précision locale | `Notice` de `@alfred/kit`, dans le bloc concerné |
| Résultat d’une action qui ne se voit pas | `shell.notify({ title, tone: "success" })` |
| Échec d’une action | `onActionError={notifyActionError}` |

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
import { DetailPanel, useOpenForm } from "socle-ui";
import { CHAMPS, ETATS, enregistrer, lire } from "../lib/taches";

export default function Detail() {
  const id = useSelection<string>();
  const tache = useAsync(() => (id ? lire(id) : Promise.resolve(null)), [id]);
  const openForm = useOpenForm();
  const t = tache.data;

  return (
    <DetailPanel
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
import { Page, PageSection, Select, Switch } from "socle-ui";

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
          <Switch isSelected={valeur("weekend") === "1"} onChange={(v) => enregistrer("weekend", v ? "1" : "0")}
            description="Les rappels du samedi passent au lundi.">
            Pas de rappel le week-end
          </Switch>
        </Stack>
      </PageSection>
    </Page>
  );
}
```

### 14.4 Page composée : `modules/suivi/pages/semaine.tsx`

```tsx
import { useAsync, useTopBarSummary } from "@alfred/sdk";
import { Text } from "@alfred/kit";
import { List, Page, PageSection, Tabs } from "socle-ui";
import { useState } from "react";
import { ETATS, lister } from "../lib/taches";

export default function Semaine() {
  const taches = useAsync(lister, []);
  const [vue, setVue] = useState("retard");
  const aujourdhui = new Date().toISOString().slice(0, 10);
  const enRetard = (taches.data ?? []).filter((t) => t.echeance && t.echeance < aujourdhui && t.etat !== "terminee");
  const bloquees = (taches.data ?? []).filter((t) => t.etat === "bloquee");
  useTopBarSummary(taches.data ? `${enRetard.length} en retard · ${bloquees.length} bloquées` : null);
  const montrees = vue === "retard" ? enRetard : bloquees;

  return (
    <Page state={taches.error ? "error" : !taches.data ? "loading" : "ready"} onRetry={taches.reload}
      toolbar={<Tabs items={[{ id: "retard", label: "En retard" }, { id: "bloquees", label: "Bloquées" }]} selectedId={vue} onSelectionChange={setVue} />}>
      <PageSection title={vue === "retard" ? "Tâches en retard" : "Tâches bloquées"}
        empty={montrees.length ? undefined : { title: "Rien à rattraper", description: "Toutes les tâches sont à jour." }}>
        <List selectionMode="none" items={montrees.map((t) => ({ id: t.id, title: t.titre, subtitle: t.responsable ?? undefined,
          meta: t.echeance ?? undefined, status: ETATS[t.etat] }))} />
      </PageSection>
      <PageSection title="À savoir">
        <Text tone="muted">Une tâche bloquée attend une réponse d’un autre service.</Text>
      </PageSection>
    </Page>
  );
}
```

(Vérifier la forme de `status` d’un élément de `List` dans la spec ; à défaut, la mettre dans `meta`.)

## 15. Correspondance avec l’ancienne `@alfred/ui`

Une page écrite avant socle-ui compile encore : `@alfred/ui` reste servie en transition (depuis le 2026-11-23), et `check` la signale « à migrer vers socle-ui ». Toute page qu’on touche se réécrit ainsi :

| `@alfred/ui` | socle-ui |
|---|---|
| `CollectionPage` | `ListPage` : `columns` en `{ id, label, type }`, `emptyTitle` → `empty.title`, `load` → `rows` + `useAsync` |
| `DetailPanel` (`load`, `sections`) | `DetailPanel` déclaratif : `header`, `sections`, `isLoading`, `hasError` ; la page charge avec `useSelection` et `useAsync` |
| `SettingsPage` | `Page` + `PageSection` + `Switch`, `Select`, `TextField` (section 7) |
| `openForm` | `useOpenForm()` ; champs `{ name, label, type, isRequired }` (`optional` disparaît : le champ est facultatif sans `isRequired`) |
| `openModal` | `Dialog` |
| `openSubpage` | `DetailPage` avec `back`, rendue à la place de la liste |
| `confirmAction`, `ConfirmDialog` | `useConfirm()`, ou `Action` `danger` |
| `Action` (`onClick`, `icon: Pencil`, `disabled`, `hidden`) | `Action` (`id`, `onPress`, `icon: <Pencil size={16} />`, `isDisabled`, `isHidden`) ; `success` → `shell.notify` dans `onPress` |
| `Page` (`search`, `bar`, `actions`, `header`) | `Page` (`toolbar`, `actions`) ; recherche : `ListPage` ou `SearchField` dans `toolbar` |
| `Section`, `Surface`, `Heading`, `Grid` | `PageSection` |
| `Stack`, `Row`, `Text` | `@alfred/kit` |
| `FeedbackBanner` | `Notice` de `@alfred/kit`, ou une notification |
| `DataTable`, `DataGrid` | `Table`, ou `ListPage` |
| `List`, `ListItem` | `List` (`items`) |
| `KeyValueList` | `fields` d’un `DetailPanel` |
| `TextInput`, `SelectControl`, `CheckboxControl`, `SwitchControl`, `RadioControl`, `FormField` | `TextField`, `Select`, `Checkbox`, `Switch`, `RadioGroup` (libellé porté par le champ) |
| `Combobox`, `MultiSelectCombobox` | `ComboBox` (`selectionMode`) |
| `ChoiceGroup`, bascule de vue (`group`, `selected`) | `Tabs`, ou `RadioGroup orientation="horizontal"` |
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

- [ ] Le gabarit correspond à ce que la page montre (section 2) ; `Page` seulement si aucun ne convient.
- [ ] `check` rend `"ok": true`, sans remarque `design`.
- [ ] Toutes les actions sont des `Action` avec `id` et `onPress` ; une seule `primary` par zone ; une icône pour chaque action courante ; `danger` avec un `confirm` qui nomme l’objet.
- [ ] `onActionError={notifyActionError}` sur chaque gabarit qui porte des actions.
- [ ] Les colonnes et les champs ont le bon `type` ; les états ont un `StatusMap` partagé.
- [ ] Le panneau lit `useSelection()` ; la page publie sa sélection ; une écriture appelle `announceChange()`.
- [ ] Aucun `style`, `className`, balise HTML ni couleur en dur.
- [ ] Textes : `empty.title` nomme l’absence, libellés à l’infinitif, typographie française.
- [ ] `page_snapshot` et `page_screenshot` montrent la page attendue, en clair et en sombre, panneau ouvert et fermé.

## 17. Accueil au premier démarrage

Cette partie décrit un écran de la coquille, que les pages ne reproduisent pas : elle fixe ce que l’accueil promet à quelqu’un qui découvre Alfred (`src/shell/welcome/`).

- **Quand.** Au premier démarrage, quand aucun espace n’est connu (aucun espace récent, aucun ouvert). Quelqu’un qui a déjà un espace ne le voit jamais d’office. Il se relance depuis Réglages › Général (« Revoir l’accueil ») ; il propose alors de garder l’espace ouvert et se ferme par sa croix. Quand le dernier espace est fermé, la version courte (« Quel espace ouvrir ? ») montre les espaces récents, chacun avec « Ouvrir », puis le choix créer ou ouvrir.
- **Le parcours.** Bienvenue (une phrase, « Commencer ») ; Votre espace de travail (étape 1 sur 3) ; Vos modules (2) ; Quelques réglages (3) ; C’est prêt (résumé, « Ouvrir Alfred »). « Retour » sur chaque étape ; « Plus tard » sur toutes sauf l’espace, sans lequel rien ne peut s’écrire. Le parcours reste affiché une fois l’espace ouvert, jusqu’à « Ouvrir Alfred ».
- **L’espace.** Deux grandes cartes, « Créer un nouvel espace » (un nom, et le dossier `~/Alfred/<nom>` proposé, modifiable, avec « Parcourir… ») et « Ouvrir un espace existant » (un dossier). Un dossier qui n’est pas un espace se dit en une phrase sous le champ, sans créer d’espace vide. Il n’y a pas de carte « Récupérer depuis git » : Alfred ne sait pas encore cloner un espace.
- **Les modules.** Sans marketplace branché, un champ « Adresse git du marketplace », prérempli par une suggestion (le marketplace public d’Alfred) que l’aide présente comme telle et qui se remplace librement. Avec un marketplace, son catalogue en une liste à cocher : le nom, ce que fait le module, ce qu’il demande en une ligne (« Demande : comptes Jira et Bitbucket · 7 actions pour l’agent · 5 relevés planifiés »). Un module déjà là est coché et grisé, un module bloqué grisé avec sa raison. Le bouton principal dit ce qu’il fera (« Importer 2 modules », « Continuer » sans rien coché). « Ouvrir Alfred » enchaîne sur la configuration du premier module importé ; les autres attendent dans Réglages › Modules.
- **Les réglages.** Un seul écran, chaque réglage déjà à une valeur raisonnable et appliqué tout de suite : Apparence (thème et accent, la section des Réglages), Agent (seuls les harnais installés, avec leur état ; sans aucun, deux lignes et « Comment l’installer », sans rien lancer), Réseau d’entreprise replié (la source des modèles), Voix (une phrase : à activer plus tard, rien n’est téléchargé).
- **Rien à part.** Chaque étape relit l’état réel : espaces récents, marketplaces branchés et leur catalogue, réglages, harnais. Seul le parcours en cours (étape, modules importés pendant le parcours) est gardé en mémoire.
- **Forme.** Une fenêtre centrée de 600 px (au plus la largeur disponible) sur le fond de la coquille, bordure et rayon de 8 px. En haut « Étape n sur 3 » ; un titre de 18 px ; une phrase en gris ; le contenu ; en bas, les boutons secondaires discrets à gauche et le seul bouton principal à droite. Alfred y parle à la première personne et vouvoie. Ni bandeau, ni pastille jaune : un échec se dit sous le champ ou la ligne qu’il concerne.
