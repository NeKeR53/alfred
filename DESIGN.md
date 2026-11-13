# Système de design d’Alfred

Ce document s’adresse à l’agent qui écrit une page, un panneau de droite ou un onglet de Réglages. Il dit quoi utiliser et quoi ne jamais faire pour que toutes les pages se ressemblent, quel que soit l’agent qui les écrit. Il décrit Alfred, pas un espace en particulier, et il est recopié en lecture seule dans chaque espace.

Alfred est précis, calme et fiable ; son ton est direct et opérationnel. Une page montre d’abord ce qui demande une action, puis la preuve et le détail. Ce qu’Alfred n’est pas : un tableau de bord décoratif, un mur de cartes identiques, des métriques sans action, des dégradés, des effets de verre, des icônes d’ornement.

Il ne décrit que les composants et les props de `@alfred/ui`. Le transpileur ne vérifie pas les types : une prop inventée est ignorée en silence, un composant inexistant fait échouer la page.

## 1. Règles non négociables

1. **Imports.** Une page n’importe que `react`, `lucide-react`, `@alfred/ui`, `@alfred/sdk` et les fichiers de son module par chemin relatif (`./…`). Tout autre import est refusé.
2. **Racine.** Le fichier exporte son composant par défaut (`export default function …`), et ce composant rend `Page` à la racine dans chacun de ses états.
3. **Aucun style propre.** Ni attribut `style`, ni balise `<style>`, ni `className`, même sur les composants qui acceptent ces props. Une page ne fixe ni couleur, ni taille de police, ni rayon, ni ombre, ni marge : elle compose les composants de `@alfred/ui` et règle leurs props (`gap`, `tone`, `variant`, `size`, `width`).
4. **Aucun doublon de la coquille.** Le titre de la section, les onglets, le bouton du panneau, la navigation et les notifications sont dessinés par Alfred.
5. **Le sens passe par les props et par le texte.** Un état s’exprime par `tone` ou `variant` et par un libellé, jamais par une couleur seule.
6. **Tous les états sont couverts.** Chargement, absence de données, erreur et succès ont chacun un rendu prévu (section 9).
7. **Une action principale par groupe.** Un seul `Button variant="primary"` par barre d’outils, formulaire ou état vide. Toute action destructrice est confirmée.
8. **Français.** Les textes affichés sont en français ; les noms du code restent en anglais ou suivent le vocabulaire du module.
9. **Un manque se signale.** Si aucun composant ne convient, composer ceux qui existent ou le dire à l’utilisateur. Ne jamais contourner par du HTML stylé.

La règle 3 est absolue : l’utilisateur règle le mode clair ou sombre, l’accent, l’icône et la couleur des entrées du menu, et les composants suivent ces réglages. Une couleur écrite dans une page est illisible dans l’un des thèmes, une marge locale rompt l’alignement, et une classe inventée ne correspond à aucune règle de la seule feuille chargée par le cadre.

Les seules balises HTML admises sont celles qui n’ont ni apparence propre ni composant équivalent : `<form>` (section 7), `<option>` et `<optgroup>` dans un `SelectControl`, et les fragments. Tout texte passe par `Text` ou `Heading`.

## 2. La coquille et les trois gabarits

```
┌───────────┬──────────────────────────────────────────────────────┐
│ Espace    │ Titre de la section    [Onglet 1|Onglet 2] cloche  ▯ │ barre du haut : 44 px
│ Rechercher├───────────────────────────────────┬──────────────────┤
│ Section A │                                   │                  │
│ Section B │  page de l’onglet actif           │ panneau de droite│
│ …         │                                   │ 280 à 900 px     │
│ Agent     │                                   │ (380 par défaut) │
│ Réglages  │                                   │                  │
└───────────┴───────────────────────────────────┴──────────────────┘
  240 px, ou 52 px replié
```

- Une entrée du menu de gauche ouvre une **section**, dont les pages sont les **onglets** de la barre du haut (aucun pour une seule page) : un groupe segmenté calé à droite, comme les rubriques des Réglages de OneApp.
- Chaque page peut déclarer **un** panneau de droite. Le bouton en bout de barre du haut l’affiche ou le masque ; l’utilisateur le redimensionne de 280 à 900 px, sans dépasser 70 % de la largeur.
- L’**Agent** et les **Réglages** sont ancrés en bas du menu, l’Agent juste au-dessus ; une page peut s’ajouter aux onglets des Réglages.
- Le placement d’une page, son titre et l’icône de son entrée de menu se déclarent hors du fichier de la page : voir le guide de l’espace.

Une page est un fichier TSX affiché dans un cadre isolé, sans réseau ni disque : ses données passent par `@alfred/sdk`. Conséquences pour le design :

- Le titre de la section est déjà dans la barre du haut : la page ne commence pas par un titre qui le répète.
- Une modale, un menu ou une infobulle ouverts par la page restent à l’intérieur de son cadre.
- `window.alert`, `window.confirm` et `<a href>` ne fonctionnent pas. Utiliser `useConfirm`, et `Link` (dans une phrase) ou `Button` (une action) qui appelle `shell.navigate("module/page")` pour ouvrir une autre page ou `shell.openExternal(url)` pour une adresse web.
- Une page et son panneau de droite communiquent par la sélection publiée (section 8) et, pour le reste, par `shell.send(message)` d’un côté et `usePeerMessage(handler)` de l’autre (`@alfred/sdk`).
- La largeur disponible varie avec la fenêtre, le menu et le panneau : rien ne doit dépendre d’une largeur fixe.

| Gabarit | Racine | Largeur | Contenu et densité |
|---|---|---|---|
| Page (onglet d’une section) | `<Page>` pour un tableau ou une vue dense ; `<Page width="text">` pour de la lecture ou un formulaire | Toute la place restante ; `text` limite chaque bloc à 760 px | `PageToolbar` (40 px) en option, puis le contenu. Une liste se pose directement dans `Page`. |
| Panneau de droite | `<Page>` | 280 à 900 px : concevoir pour 280 px | Une seule colonne : `Heading`, `KeyValueList`, `Section`, `EmptyState size="compact"`, `StatusBadge size="compact"`. Ni `PageToolbar`, ni `Grid`, ni tableau à plus de deux colonnes. Il lit la sélection de sa page (section 8). |
| Onglet de Réglages | `<Page width="text">` | 760 px au plus | Une `Section` par sujet, un formulaire par section, `FormActions` en bas du formulaire ; les interrupteurs s’appliquent immédiatement (section 7). |

`Page` fixe la marge intérieure (16 px), l’espace entre ses enfants directs (24 px), le fond et le défilement.

## 3. Couleurs et thèmes

La palette est restreinte : des neutres chauds, un seul accent, et trois couleurs sémantiques réservées aux états. Alfred suit le thème du système ou le choix clair ou sombre de l’utilisateur, et applique lui-même l’accent choisi. Une page ne lit ni n’écrit aucun jeton.

Jetons, pour comprendre les composants : `--color-bg` (fond de page, de champ, de modale), `--color-surface` et `--color-surface-strong` (barre d’outils, en-tête de tableau, survol, élément enfoncé, badge neutre), `--color-ink` (texte et bouton principal), `--color-muted` (métadonnées, aides, icônes au repos), `--color-primary` et `--color-primary-strong` (l’accent : focus, sélection, choix actif, jamais une décoration), `--color-success`, `--color-warning`, `--color-danger` et leurs variantes `-ink` et `-bg` (états), `--line` et `--control-border` (séparateurs ; contour des champs à 3:1 au moins).

Le sens passe toujours par une prop, accompagnée d’un texte :

| Ce qu’il faut dire | Comment |
|---|---|
| État d’un objet | `<StatusBadge tone="neutral \| success \| warning \| danger">Libellé</StatusBadge>` |
| Pastille devant un libellé d’état | `<StatusDot tone="success \| warning \| danger \| neutral \| pending" />` |
| Texte secondaire ou d’état | `<Text tone="default \| muted \| success \| warning \| danger">` |
| Message persistant | `<FeedbackBanner tone="danger \| warning \| info">` |
| Notification | `shell.notify({ tone: "info" \| "success" \| "warning" \| "error" })` |
| Action principale, action destructrice | `<Button variant="primary">` ; `<Button variant="danger">` ou `<IconButton tone="danger">` |

L’échec s’écrit `danger` dans tout `@alfred/ui` (`FeedbackBanner` accepte aussi `error`, son synonyme) ; seul `shell.notify` l’écrit `error`. Choisir le ton selon la gravité, jamais selon la couleur souhaitée. Les huit teintes (`steel`, `blue`, `violet`, `pink`, `red`, `orange`, `green`, `teal`) servent à la couleur de chaque entrée du menu, qui ne teinte que son icône, et à l’accent choisi par l’utilisateur, qu’Alfred applique aux jetons primaires avec un contraste d’au moins 4,5:1 : une page ne les nomme jamais.

## 4. Typographie, espacement, densité

Alfred est une application de bureau dense, utilisée à la souris et au clavier. La police et les tailles sont fixées par les composants.

Tailles : 12 px pour les métadonnées, aides et en-têtes de tableau (`<Text size="meta">`) ; 13 px pour le texte courant, les cellules, champs et boutons (`<Text>`, `<Heading level={3}>` en gras) ; 14 px pour un titre de section ou de panneau (`<Section title>`, `<Heading level={2}>`, `<Text size="panel">`) ; 18 px pour le nom de l’objet auquel une page entière est consacrée (`<Heading level={1}>`, une fois par page au plus).

Graisses de `Text` : `normal` (400), `medium` (500), `strong` (600). Un texte long se lit sur 65 à 75 caractères par ligne : c’est le rôle de `Page width="text"`.

Échelle d’espacement, commune à `Stack`, `Row` et `Grid` :

| `gap` | Pixels | Usage |
|---|---|---|
| `none` | 0 | Lignes déjà séparées par leur hauteur (cases à cocher) |
| `xs` | 4 | Icône et texte, pastille et libellé, titre et sous-titre |
| `sm` | 8 | Boutons voisins, éléments d’une même ligne (défaut de `Row`) |
| `md` | 12 | Champs d’un formulaire, blocs d’une section (défaut de `Stack` et `Grid`) |
| `lg` | 24 | Entre deux groupes distincts |

Hauteurs fixées par les composants : bouton, champ et liste déroulante 32 px ; zone de texte 72 px au moins ; bouton icône 28 px (24 px en `small`) ; barre d’outils 40 px ; en-tête de tableau 32 px, ligne 36 px environ ; icônes 16 px. Rayons : 6 px pour les contrôles, 8 px pour les surfaces. Les nombres d’une colonne s’alignent à droite.

## 5. Catalogue des composants

Tout s’importe de `@alfred/ui`. Les composants qui prolongent un élément natif en acceptent les attributs (`onClick`, `disabled`, `value`, `onChange`, `aria-*`…) ; `className` et `style` restent interdits même là. Types exportés : `DataTableColumn`, `ButtonProps`, `ButtonVariant`, `IconButtonProps`, `ChoiceButtonProps`, `MenuItemProps`, `FeedbackBannerTone`, `ConfirmOptions`, `StatusDotTone`, `TabItem`.

### 5.1 Mise en page

| Composant | Rôle | Props (défaut) |
|---|---|---|
| `Page` | Racine obligatoire | `children`, `toolbar?: ReactNode` (un `PageToolbar`, fixe au-dessus du contenu), `width`: `"full" \| "text"` (`"full"`) |
| `PageToolbar` | Barre d’actions d’une page. Pas dans un panneau, pas sur une page sans données | `start?: ReactNode` (à gauche : recherche, filtres), `children?: ReactNode` (à droite : actions, la principale en dernier) ; accepte les attributs d’un `div` (`aria-*`) |
| `Section` | Bloc titré ; pas un titre de page | `title: string`, `description?: string`, `actions?: ReactNode` (à droite du titre), `children` |
| `Stack` | Empile verticalement | `gap` (`"md"`) |
| `Row` | Aligne horizontalement | `gap` (`"sm"`), `align`: `"start" \| "center" \| "end" \| "stretch" \| "baseline"` (`"center"`), `justify`: `"start" \| "center" \| "end" \| "between"` (`"start"`), `wrap` (`false`) |
| `Grid` | Colonnes fluides d’au moins `minColumnWidth` pixels | `minColumnWidth` (`240`), `gap` (`"md"`) |
| `Surface` | Cadre bordé pour un contenu autonome (synthèse, formulaire isolé) | `title?: string`, `children` |
| `Divider` | Filet entre deux groupes d’une même section, quand un écart `gap="lg"` ne suffit pas | aucune |

`Surface` n’est pas un décor : ne pas emballer chaque bloc dans une surface, ne pas en imbriquer deux, ne pas aligner une grille de surfaces identiques qui ne contiennent qu’un chiffre. `Page`, `PageToolbar` et `Section` sont illustrés en 12.1 et 12.3.

### 5.2 Texte

| Composant | Rôle | Props (défaut) |
|---|---|---|
| `Heading` | Titre ; niveaux 1, 2, 3 sans saut | `level`: `1 \| 2 \| 3` (`2`) |
| `Text` | Tout texte | `tone` (`"default"`), `size`: `"meta" \| "body" \| "panel"` (`"body"`), `weight`: `"normal" \| "medium" \| "strong"` (`"normal"`), `as`: `"p" \| "span" \| "div"` (`"p"`) |
| `KeyValueList` | Fiche « libellé : valeur » d’un objet (exemple en 12.2) ; pas pour des données tabulaires | `items: { id?: string \| number; label: string; value: ReactNode }[]` |
| `Code` | Texte à chasse fixe et chiffres tabulaires : identifiant, chemin, valeur technique ; `block` pour un extrait de plusieurs lignes, qui défile et se joint au clavier | `children`, `block` (`false`), `label` (`"Extrait de code"`, nom du bloc) |
| `Link` | Lien texte souligné dans une phrase ou une cellule | Avec `href: string` et `onNavigate: (href) => void` : un lien, dont l’adresse web ou `mailto:` porte l’icône « hors d’Alfred ». Sans `href` : `onClick`, bouton d’apparence lien |
| `Image` | Image venue des données (`data:` ou `blob:` ; une adresse distante affiche son texte de remplacement) | `src`, `alt: string` (obligatoire ; `""` si décorative), `size`: `"sm" \| "md" \| "lg" \| "full"` (`"md"` : 120, 240, 480 px, toute la largeur), `fit`: `"contain" \| "cover"` (`"contain"` ; `cover` : vignette carrée) |
| `Markdown` | Affiche un texte Markdown venu des données (note, réponse d’un agent) : titres, listes, tableaux, code. Pas pour composer la page elle-même | `children: string`, `onLink?: (href: string) => void` |

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

### 5.3 Actions

**`Button`** — action textuelle. Le libellé est visible ; une icône n’y figure que si elle ajoute une information (ouverture hors d’Alfred), jamais pour répéter le verbe.

Props : `variant`: `"primary" \| "secondary" \| "danger"` (`"secondary"` ; `primary` : plein, une fois par groupe ; `danger` : suppression ou révocation seulement, Annuler restant `secondary`), `loading` (`false` ; indicateur, bouton désactivé), `loadingLabel` (libellé pendant l’opération, « Enregistrement… »), `interaction`: `"press" \| "stable"` (`stable` supprime le retour d’appui), `type` (`"button"` ; `"submit"` dans un `<form>`).

```tsx
<Row justify="end">
  <Button onClick={annuler}>Annuler</Button>
  <Button variant="primary" loading={enCours} loadingLabel="Enregistrement…" onClick={enregistrer}>
    Enregistrer
  </Button>
</Row>
```

**`IconButton`** — action secondaire courante en icône seule (modifier, copier, supprimer, ouvrir). Garder un `Button` pour l’action principale et pour une action rare ou ambiguë.

Props : `label: string` (obligatoire, nom accessible contextualisé), `tooltip`: `string \| false` (`label` ; infobulle courte au survol et au focus), `tone`: `"default" \| "primary" \| "danger"`, `size`: `"default" \| "small"` (28 px ; `small` : 24 px dans une ligne dense ; `compact`, ancien alias, vaut `default`), `appearance`: `"default" \| "table"` (`table` dans une cellule), `loading`, `loadingLabel`, `buttonRef?` (référence au bouton, pour y ancrer un volet), `tooltipPlacement`: `"auto" \| "right"` (`"auto"` ; `right` dans une colonne verticale), `tooltipAppearance`: `"default" \| "preview"` (`preview` : infobulle plus large, pour un aperçu de quelques lignes).

```tsx
<IconButton label="Supprimer la tâche « Relancer le client »" tooltip="Supprimer" tone="danger" onClick={supprimer}>
  <Trash2 size={16} aria-hidden="true" />
</IconButton>
```

**`RefreshButton`** — la seule action « Actualiser ». Props : `label` (`"Actualiser"`), `shortcut?: string` (annoncé dans l’infobulle), et celles d’`IconButton` (`loading`, `onClick`, `disabled`).

```tsx
<RefreshButton loading={charge} onClick={recharger} />
```

**`OverflowMenu`**, **`MenuButton`**, **`MenuItem`**, **`MenuGroup`** — menus d’actions ancrés à leur bouton. Le composant place le menu (dessous, ou dessus si la place manque), l’ouvre au clic, le ferme sur Échap, Tab, un clic à côté ou après l’action de l’entrée choisie, et rend le focus au bouton. Ne jamais positionner un menu soi-même ; ne pas y cacher l’action principale.

- `OverflowMenu` : bouton « ⋯ » des actions secondaires d’une barre ou d’une ligne. Props : `label: string` (obligatoire, nom du bouton et du menu), `children`, `placement`: `"below" \| "above"` (`"below"`), `align`: `"start" \| "end"` (`"end"`), `icon` (« ⋯ »), `tooltip` (`"Plus"`), `size`: `"default" \| "small"` (`compact`, ancien alias, vaut `default`), `disabled`.
- `MenuButton` : bouton texte suivi d’un chevron, pour un choix d’actions de même nature (« Exporter », « Nouveau »). Les flèches l’ouvrent aussi. Props : `label: string` (obligatoire, texte du bouton), `menuLabel?` (nom du menu s’il diffère), `variant` (`"secondary"`), `placement` (`"below"`), `align` (`"start"`), `disabled`, `children`.
- `MenuItem` : bouton natif (`onClick`, `disabled`) ; `tone`: `"default" \| "danger"` pour une entrée destructrice, toujours confirmée. Une icône en tête est affichée à 16 px. `MenuGroup label` regroupe les entrées au-delà de trois.

```tsx
<OverflowMenu label="Autres actions des tâches">
  <MenuGroup label="Tâches terminées">
    <MenuItem onClick={archiver}>
      <Archive size={16} aria-hidden="true" />
      Archiver
    </MenuItem>
    <MenuItem tone="danger" onClick={vider}>
      <Trash2 size={16} aria-hidden="true" />
      Supprimer
    </MenuItem>
  </MenuGroup>
</OverflowMenu>
<MenuButton label="Exporter" menuLabel="Formats d’export">
  <MenuItem onClick={exporterCsv}>CSV</MenuItem>
  <MenuItem onClick={exporterJson}>JSON</MenuItem>
</MenuButton>
```

**`ChoiceGroup`**, **`ChoiceButton`** — deux à quatre choix exclusifs visibles côte à côte (filtre, mode d’affichage) ; au-delà, `SelectControl`. Le groupe aligne ses boutons et leur transmet son mode : ils deviennent des boutons radio, que les flèches parcourent (le choix suit le focus). Hors d’un groupe, un `ChoiceButton` est une bascule (`aria-pressed`).

Props de `ChoiceGroup` : `label: string` (obligatoire), `appearance`: `"default" \| "segmented"` (`segmented` : choix réunis dans un même cadre, l’actif en relief), `selectionMode`: `"radio" \| "tab"` (`"radio"` ; pour des rubriques, préférer `Tabs`). Props de `ChoiceButton` : `label: string` (obligatoire, identique au texte visible), `selected: boolean` (obligatoire), `variant`: `"icon" \| "label"` (`"icon"`, qui reçoit une infobulle ; `label` pour un texte), `size`: `"default" \| "compact"` (32 ou 28 px), `selectionMode` (celui du groupe, sinon `"toggle"` ; à ne fixer que pour s’en écarter), `loading`.

```tsx
// filtres = { toutes: "Toutes", ouvertes: "Ouvertes", terminees: "Terminées" }
<ChoiceGroup label="Filtrer par état" appearance="segmented">
  {(Object.keys(filtres) as Filtre[]).map((valeur) => (
    <ChoiceButton
      key={valeur}
      variant="label"
      label={filtres[valeur]}
      selected={filtre === valeur}
      onClick={() => setFiltre(valeur)}
    >
      {filtres[valeur]}
    </ChoiceButton>
  ))}
</ChoiceGroup>
```

**`Tabs`** — rubriques d’une même page, quand chacune remplace tout le contenu qui suit (Résumé, Historique). L’onglet actif est souligné (les onglets de la barre du haut, dessinés par Alfred, sont un groupe segmenté) ; flèches gauche et droite, Origine et Fin. Pour une nouvelle vue autonome, créer plutôt une page dans la section. Props : `label: string` (obligatoire), `items: TabItem[]` (`{ id; label; title?; content? }` : `content` remplace le libellé affiché, par exemple une icône, et `title` devient alors obligatoire), `activeId`, `onChange(id)`, `idPrefix?` et `panelId?` (identifiants qui relient l’onglet actif au contenu qu’il affiche, `aria-controls`). Le contenu de la rubrique active suit directement les onglets.

```tsx
<Tabs
  label="Rubriques de la tâche"
  activeId={rubrique}
  onChange={setRubrique}
  items={[
    { id: "resume", label: "Résumé" },
    { id: "historique", label: "Historique" },
  ]}
/>
```

### 5.4 Formulaires

**`FormField`** — porte le libellé, l’aide et l’erreur d’un champ, et les relie au contrôle. Ne pas y placer `CheckboxControl`, `RadioControl` ni `SwitchControl`, qui ont leur propre libellé : un groupe d’options va dans un `Fieldset`.

Props : `label: ReactNode` (obligatoire, visible), `hint?` (aide sous le champ, que l’erreur remplace), `error?` (message d’erreur ; marque le champ invalide), `layout`: `"stacked" \| "inline"` (`inline` : libellé à gauche, dans une barre d’outils), `children` (un `TextInput`, `TextArea`, `SelectControl` ou une combobox), `htmlFor?` (`id` du contrôle quand ce n’est pas l’enfant direct), `compound` (`false` ; champ qui réunit plusieurs commandes, par exemple une liste et son bouton : passer alors `htmlFor`), `messageId?` (identifiant imposé du message d’aide ou d’erreur). Les autres attributs vont au `label`.

**`TextInput`**, **`TextArea`**, **`SelectControl`** — champs natifs habillés ; ils acceptent les attributs de `<input>`, `<textarea>` et `<select>`. `TextArea` a une prop `variant` (`"default"`, `"composer"`, `"inline"`) : garder `default` dans un formulaire. Exemple en 12.3.

**`FormControlGroup`** — aligne un champ et l’action qui lui est liée. `children` : un `FormField` puis un `Button`.

```tsx
<FormControlGroup>
  <FormField label="Adresse du calendrier">
    <TextInput
      value={adresse}
      placeholder="Ex. https://exemple.fr/agenda.ics"
      onChange={(event) => setAdresse(event.target.value)}
    />
  </FormField>
  <Button onClick={tester}>Tester</Button>
</FormControlGroup>
```

**`CheckboxControl`**, **`RadioControl`**, **`SwitchControl`** — props : `label: ReactNode` (obligatoire) et les attributs natifs `checked`, `onChange`, `name`, `value`, `disabled`. Case à cocher : option d’un formulaire, validée avec lui. Interrupteur : réglage appliqué immédiatement (exemple en 12.3). Radios : choix exclusif aux libellés longs, avec le même `name` ; pour deux à quatre choix courts, préférer `ChoiceGroup`.

**`Fieldset`** — groupe titré de cases, de radios ou d’interrupteurs : la légende nomme le groupe, l’aide ou l’erreur lui sont reliées. Props : `legend: ReactNode` (obligatoire), `hint?`, `error?`, `layout`: `"stack" \| "row"` (`"stack"` ; `row` pour des options courtes côte à côte), `disabled`, `children`.

```tsx
<Fieldset legend="Affichage des tâches" error={erreurAffichage}>
  <CheckboxControl
    label="Inclure les tâches terminées"
    checked={inclure}
    onChange={(event) => setInclure(event.target.checked)}
  />
  <RadioControl
    name="tri"
    label="Trier par échéance"
    checked={tri === "echeance"}
    onChange={() => setTri("echeance")}
  />
  <RadioControl
    name="tri"
    label="Trier par priorité"
    checked={tri === "priorite"}
    onChange={() => setTri("priorite")}
  />
</Fieldset>
```

**`Combobox`**, **`MultiSelectCombobox`**, **`SearchCombobox`** — listes ancrées au champ. Pour une valeur unique dans une liste fermée, utiliser `SelectControl`.

| Composant | Quand | Props propres (défaut) |
|---|---|---|
| `Combobox` | Saisie libre avec suggestions : reprendre une valeur existante sans interdire une nouvelle | `value: string`, `options: string[]`, `onChange(value)`, `normalize?(value)` |
| `MultiSelectCombobox` | Plusieurs valeurs d’une liste (filtre, étiquettes) | `label`, `values`, `options`, `onChange(values)`, `formatOption?`, `placeholder` (`"Toutes les valeurs"`), `valueMode`: `"options" \| "custom"` (`"options"`), `normalizeCustomValue?`, `display`: `"compact" \| "all"` (`"compact"` ; `all` dans un formulaire), `searchPlaceholder?` |
| `SearchCombobox` | Chercher puis choisir une entité ; la page fournit les résultats | `label`, `value` (texte saisi), `options`, `onChange(texte)`, `onSelect(option)`, `getOptionKey`, `getOptionLabel`, `renderOption?`, `isOptionDisabled?`, `closeOnSelect` (`true`), `minQueryLength` (`1`), `loading`, `loadingMessage`, `emptyMessage` |

Dans un `FormField`, une combobox est reliée comme un `TextInput` au libellé, à l’aide et à l’erreur, sans `id` ; le `label` de `MultiSelectCombobox` et de `SearchCombobox` ne nomme alors que leurs boutons (« Effacer… »). Hors d’un `FormField`, elles portent leur nom par `label`.

```tsx
<FormField label="Ville">
  <Combobox value={ville} options={["Lyon", "Marseille", "Paris"]} onChange={setVille} />
</FormField>
<SearchCombobox
  label="Rechercher un contact"
  value={requete}
  options={contacts.data ?? []}
  loading={contacts.loading}
  onChange={setRequete}
  onSelect={(choisi) => {
    setContact(choisi);
    setRequete(choisi.nom);
  }}
  getOptionKey={(option) => String(option.id)}
  getOptionLabel={(option) => option.nom}
/>
```

**`FormActions`** — actions d’un formulaire, alignées à droite : Annuler puis l’action principale, qui porte l’état d’enregistrement. Exemple en 12.3.

Props : `submitLabel` (sans lui, pas d’action principale), `form` (`id` du `<form>` : le bouton devient `type="submit"`), `onSubmit` (clic, sans `<form>`), `onCancel` (sans lui, pas d’Annuler), `cancelLabel` (`"Annuler"`), `pending` et `pendingLabel` (enregistrement en cours), `disabled`, `cancelDisabled` (`pending`), `submitIcon`, `submitKeyShortcuts`, `children` (actions supplémentaires, avant Annuler).

### 5.5 Données

**`DataTable`** — tableau dense : en-tête fixe, tri au clic sur l’en-tête des colonnes triables (croissant, décroissant, puis ordre d’origine), ligne activable à la souris et au clavier, état vide intégré. Exemple en 12.1.

Props : `columns: DataTableColumn<Row>[]`, `rows: Row[]`, `rowKey: (row) => string \| number` (identifiant stable), `label: string` (nom accessible), toutes obligatoires ; `onRowClick?(row)` (ligne activable au clic, à Entrée et à Espace), `selectedKey?` (ligne mise en évidence), `emptyTitle` (`"Aucune donnée"`), `emptyDescription?` et `emptyAction?` (affichés quand `rows` est vide), `loading` (`false` ; tableau occupé pendant un rechargement).

`DataTableColumn<Row>` : `key: string` (identifiant, et clé lue dans la ligne par défaut), `header: ReactNode` (un texte, ou une icône accompagnée de `headerLabel: string`, son nom pour les lecteurs d’écran), `render?: (row) => ReactNode`, `sortValue?: (row) => string | number | null | undefined`, `sortable?: boolean`, `align?: "start" | "end"`, `width?: string` (`"140px"`, `"30%"`).

Tri : une colonne est triable si elle a un `sortValue` ou si `row[key]` est une valeur simple (texte, nombre, booléen) et renseignée sur au moins une ligne ; sinon son en-tête est un simple texte. Fournir `sortValue` dès que `render` affiche autre chose que `row[key]`, et `sortable: false` pour une colonne qu’il n’a pas de sens de trier. Une ligne activable par `onRowClick` laisse leurs clics et leurs touches aux boutons, liens et champs de ses cellules : une action de ligne y a sa place (`IconButton appearance="table"`, `OverflowMenu size="small"`).

**`StatusBadge`** — état textuel compact. Props : `children` (le libellé), `tone` (`"neutral"`), `size`: `"default" \| "compact"` (`compact` dans une cellule, une fiche ou une liste), `title?`. Ni étiquette décorative, ni compteur.

**`StatusDot`** — pastille de couleur, décorative : elle est toujours suivie du texte de l’état. Prop : `tone` (obligatoire) ; `pending` est une pastille creuse pour ce qui n’a pas commencé.

**`SearchField`** — champ de recherche d’une barre d’outils, avec sa croix d’effacement (exemple en 12.1). Props : `label: string` (obligatoire, nom accessible), `value`, `onChange`, `placeholder`, `onClear?`, `inputRef?`. Le filtrage s’applique pendant la saisie, sans bouton « Rechercher ».

**`List`**, **`ListItem`** — liste simple et dense d’éléments courts ou hétérogènes (pièces jointes, derniers événements, comptes liés). Dès que les éléments partagent des attributs à comparer ou à trier, `DataTable`. `List` : `label?` (nom de la liste), `children`. `ListItem` : `title` (obligatoire), `description?`, `leading?` (icône ou `StatusDot`), `trailing?` (badge, date, `IconButton`), `onClick?` (le titre et la description deviennent un bouton ; l’élément de fin reste à part), `selected`, `disabled`.

```tsx
<List label="Pièces jointes">
  {pieces.map((piece) => (
    <ListItem
      key={piece.id}
      title={piece.nom}
      description={piece.taille}
      onClick={() => ouvrirPiece(piece.id)}
      trailing={
        <IconButton label={`Retirer ${piece.nom}`} tooltip="Retirer" onClick={() => retirerPiece(piece.id)}>
          <X size={16} aria-hidden="true" />
        </IconButton>
      }
    />
  ))}
</List>
```

**`StepList`** — étapes numérotées d’un parcours guidé ; les étapes passées sont cochées. Pas une navigation entre vues. Props : `label`, `steps: { id; title; hint? }[]`, `current`, `onSelect?(id)` (rend les étapes cliquables), `isAvailable?(id)`.

### 5.6 Retour et états

Les règles d’emploi sont en section 9 ; `EmptyState`, `FeedbackBanner` et `LoadingSkeleton` sont illustrés en 12.1 et 12.2.

| Composant | Rôle | Props (défaut) |
|---|---|---|
| `EmptyState` | Ce qui manque et, si elle existe, l’action suivante | `title: string`, `description?: string`, `children?` (actions), `size`: `"default" \| "compact"` (`compact` dans un panneau, une section, une liste imbriquée) |
| `FeedbackBanner` | Message persistant, visible tant que l’état décrit dure. Pas de ton succès : un succès est une notification | `children`, `tone`: `"danger" \| "warning" \| "info"` (`"error"`, synonyme de `danger`, par défaut : toujours écrire le ton), `action?: ReactNode`. Son cadre convient à une page ; `appearance="bar"` est réservé à la coquille |
| `LoadingSkeleton` | Premier chargement, dans `Page` ; n’apparaît qu’après 200 ms pour ne pas clignoter | `rows` (`3`), `label` (`"Chargement…"`), `variant`: `"form" \| "page"` (`"form"` ; `page` : blocs plus hauts, pour une page entière) |
| `Spinner` | Indicateur en ligne de 14 px, à côté d’un texte ; jamais seul au centre d’une vue | `label` (`"Chargement"`) |

**`useConfirm`**, **`ConfirmDialog`** — confirmation modale, à la place de `window.confirm`. Le focus initial est sur Annuler, Échap annule, le focus revient au déclencheur. `useConfirm()` renvoie `{ confirm, confirmDialog }` : `await confirm(options)` vaut `true` ou `false`, et `{confirmDialog}` doit être rendu dans la page.

Options de `confirm` : `title: ReactNode` (obligatoire, la question, qui nomme l’objet), `message?` (la conséquence), `confirmLabel: string` (obligatoire, le verbe de l’action, jamais « OK » ni « Oui »), `cancelLabel` (`"Annuler"`), `tone`: `"danger" \| "default"` (`danger` pour une suppression, un arrêt, une révocation).

`ConfirmDialog` est la forme contrôlée, avec en plus `open`, `busy`, `onConfirm` et `onCancel` , seulement pour garder la modale ouverte pendant l’opération (`busy`).

```tsx
const { confirm, confirmDialog } = useConfirm();
const supprimer = async () => {
  const accepte = await confirm({
    title: `Supprimer la tâche « ${titre} » ?`,
    message: "Cette action est définitive.",
    confirmLabel: "Supprimer",
    tone: "danger",
  });
  if (accepte) await supprimerTache(id);
};
return (
  <>
    <Button variant="danger" onClick={supprimer}>
      Supprimer
    </Button>
    {confirmDialog}
  </>
);
```

**`AnchoredPanel`** — volet flottant ouvert contre un bouton, sans voile : la page reste visible. Pour quelques réglages contextuels (filtres), pas pour un formulaire long. Il n’a pas de marge intérieure : y placer une seule `Surface`. Props : `anchor: HTMLElement` (obligatoire, le bouton d’ouverture), `label: string` (obligatoire), `onClose` (obligatoire ; Échap, ou clic à côté tant que rien n’a été saisi dans le volet : après une saisie, le clic à côté est refusé d’un court rebond), `placement`: `"below" \| "right"` (`"below"`), `width` en pixels (`440`), `canClose?: () => boolean` (`false` pendant une opération en cours).

```tsx
const [anchor, setAnchor] = useState<HTMLElement | null>(null);
const [terminees, setTerminees] = useState(false);
return (
  <>
    <Button aria-expanded={anchor !== null} onClick={(event) => setAnchor(anchor ? null : event.currentTarget)}>
      Filtrer
    </Button>
    {anchor ? (
      <AnchoredPanel anchor={anchor} label="Filtres des tâches" width={320} onClose={() => setAnchor(null)}>
        <Surface title="Filtres">
          <CheckboxControl label="Inclure les terminées" checked={terminees} onChange={() => setTerminees(!terminees)} />
        </Surface>
      </AnchoredPanel>
    ) : null}
  </>
);
```

**`Modal`** — modale d’une page, pour une saisie courte ou une décision qui demande plus qu’une confirmation (renommer, choisir une destination). Une confirmation passe par `useConfirm`, un formulaire long par la page ou le panneau de droite. Elle est pilotée par `open` et `onClose` : Échap, le bouton Fermer et un clic sur le fond appellent `onClose`, sauf ce dernier une fois une saisie commencée. Le focus va au premier champ (ou à l’élément `autoFocus`), puis revient au déclencheur ; le contenu n’est rendu que modale ouverte. Props : `open`, `onClose`, `title: ReactNode` (obligatoire), `description?`, `children` (le corps, avec ses marges, qui défile s’il est long), `actions?` (pied aligné à droite : `FormActions` ou des `Button`), `size`: `"default" \| "wide"` (480 ou 720 px), `dismissOnOutside` (`true`).

```tsx
const [ouverte, setOuverte] = useState(false);
const [nom, setNom] = useState("");
return (
  <>
    <Button onClick={() => setOuverte(true)}>Renommer</Button>
    <Modal
      open={ouverte}
      onClose={() => setOuverte(false)}
      title="Renommer la liste"
      actions={<FormActions form="renommer" submitLabel="Enregistrer" onCancel={() => setOuverte(false)} />}
    >
      <form
        id="renommer"
        noValidate
        onSubmit={(event) => {
          event.preventDefault();
          void renommer(nom).then(() => setOuverte(false));
        }}
      >
        <FormField label="Nom">
          <TextInput value={nom} onChange={(event) => setNom(event.target.value)} />
        </FormField>
      </form>
    </Modal>
  </>
);
```

**`Disclosure`** — contenu secondaire replié (options avancées, détail technique). Ne pas y cacher une information nécessaire à la décision. Props : `label: ReactNode`, `children`, `appearance`: `"default" \| "subtle"` (`subtle` : ligne pleine largeur), `lazy` (`false` ; contenu rendu à la première ouverture), `open` et `onToggle` natifs.

**`InlineEdit`** — valeur modifiable sur place : un clic, F2 ou Entrée ouvre la saisie, Entrée ou un clic à côté enregistre, Échap annule. Pour un titre ou une valeur isolée, pas pour un formulaire. Props : `value` (obligatoire), `label: string` (obligatoire, nom du champ), `onSave(value)` (obligatoire ; peut renvoyer une promesse), `renderEditor(editor)` (obligatoire ; `editor` expose `value`, `setValue`, `commit`, `pending`, `label`), `children` (l’affichage au repos), `mode`: `"line" \| "multiline"` (`"line"` ; en `line`, Maj+Entrée n’enregistre pas ; en `multiline`, Ctrl+Entrée ou Cmd+Entrée enregistre), `disabled`, `editing` et `onEditingChange` (ouverture pilotée). Si `onSave` rejette sa promesse, la saisie reste ouverte : notifier l’échec, puis relancer l’erreur. `renderEditor` rend en général `<TextInput autoFocus aria-label={editor.label} value={editor.value} disabled={editor.pending} onChange={…} />`.

### 5.7 Exports réservés à la coquille

Ces exports existent dans `@alfred/ui` mais ne s’utilisent pas dans une page :

- `PageTopBar`, `PanelToggleButton` : la barre du haut et le bouton du panneau, déjà rendus par Alfred.
- `PanelHeader` : en-tête de panneau de la coquille. Dans un panneau de droite, le nom de l’objet se donne par `Heading`.
- `Dialog` : modale native nue de la coquille ; une page utilise `Modal`.
- `Menu` : liste d’entrées de `MenuButton` et d’`OverflowMenu`, qui ne se positionne pas seule.
- Les props `className`, `tabClassName` de `Tabs`, `appearance="bar"` de `FeedbackBanner`, et `appearance="navigation" \| "marker"` d’`IconButton`.

## 6. Vocabulaire des actions et libellés

Un libellé d’action est un verbe à l’infinitif, suivi de son objet quand le contexte ne le donne pas, avec une seule majuscule et sans point final. Le même verbe désigne la même action partout.

| Libellé | Sens | Règle |
|---|---|---|
| « Nouveau… », « Nouvelle… » (« Nouvelle tâche ») | Ouvre la création d’un objet de premier niveau | Action principale de la barre d’outils et de l’état vide |
| « Ajouter… » (« Ajouter un membre ») | Insère un élément dans un ensemble qui existe déjà | |
| « Créer » | Valide un formulaire de création | Action principale du formulaire |
| « Enregistrer » | Valide les modifications d’un objet existant | Pendant l’opération : « Enregistrement… » |
| « Modifier » | Ouvre l’édition | Souvent un `IconButton` |
| « Supprimer » | Efface définitivement | `danger`, toujours après confirmation |
| « Retirer » | Enlève une appartenance sans effacer l’objet | Confirmé si l’effet est difficile à défaire |
| « Archiver » | Masque sans effacer | Sans confirmation |
| « Annuler » | Abandonne la saisie ou ferme sans effet | `secondary`, avant l’action principale |
| « Actualiser » | Recharge les données | `RefreshButton` |
| « Réessayer » | Relance ce qui a échoué | Dans `FeedbackBanner` |

- Une confirmation pose une question qui nomme l’objet (« Supprimer la tâche « Relancer le client » ? »), décrit la conséquence dans `message` et reprend le verbe dans `confirmLabel`.
- Une notification constate un fait : « Tâche supprimée », « La tâche n’a pas été supprimée ». La cause va dans `description`.
- Les points de suspension marquent une opération en cours (« Enregistrement… »), un texte d’exemple (« Rechercher… ») ou une action qui demandera un choix avant de s’exécuter (« Importer un fichier… »).
- Typographie française : apostrophe « ’ », guillemets « », espace avant « : », « ? » et « ! ». Dates et nombres passent par `Intl.DateTimeFormat("fr-FR", …)` et `Intl.NumberFormat("fr-FR")`.
- Nommer les choses comme l’utilisateur les nomme : pas d’identifiant technique, de nom de table ni de message d’erreur brut à la place d’une phrase.

## 7. Formulaires

- **Composition.** Un `<form>` avec `noValidate` et un `onSubmit` qui appelle `event.preventDefault()` (le cadre interdit l’envoi natif), une `Stack gap="md"` de `FormField`, puis `FormActions` reliée par `form`. Entrée dans un champ valide ainsi le formulaire.
- **Libellés.** Chaque champ a un libellé visible ; le texte d’exemple ne le remplace pas et commence par « Ex. ». Dans un formulaire court, tous les champs sont obligatoires sauf ceux marqués « (facultatif) » dans leur libellé ; un champ obligatoire porte `aria-required="true"`.
- **Validation.** Elle a lieu à la soumission et s’affiche sous le champ par `FormField.error`, jusqu’à la correction. Elle ne devient ni une notification ni un bandeau. Le message dit quoi faire : « Saisissez le nom de l’équipe. », pas « Champ invalide ».
- **Actions.** `FormActions` en bas du formulaire, à droite : Annuler, s’il y a quelque chose à abandonner, puis l’action principale. Pendant l’enregistrement, `pending` les désactive et affiche le libellé d’attente. Ne pas répéter ces actions ailleurs.
- **Résultat.** Un succès est une notification `success` ; un échec est une notification `error` qui laisse la saisie intacte.
- **Réglages immédiats.** Un interrupteur ou un choix fini s’applique dès qu’il change, sans bouton Enregistrer : il réussit en silence, et un échec remet la valeur précédente et notifie. Une saisie libre garde une validation explicite.
- **Longueur.** Un formulaire long va dans une page ou dans le panneau de droite ; une `Modal` ne porte qu’une saisie courte (trois champs au plus).

## 8. Listes, tableaux et panneau de droite

- **Tableau** (`DataTable`) dès que les éléments partagent les mêmes attributs, qu’il faut les comparer ou les trier, ou qu’une ligne ouvre un détail. C’est le cas général d’une collection.
- **Fiche** (`KeyValueList`) pour les attributs d’un seul objet.
- **Liste** (`List`) pour quelques éléments courts ou hétérogènes, avec au plus une action chacun ; un simple `Stack` de `Text` s’ils n’ont ni action ni détail.
- **Grille de surfaces** seulement pour des contenus hétérogènes et autonomes, jamais pour répéter le même gabarit.

Règles d’une liste :

- Le tableau se pose directement dans `Page`, sous un `PageToolbar` : recherche à gauche ; à droite `RefreshButton`, les actions secondaires (`OverflowMenu` au-delà de deux) et l’action principale en dernier.
- Le tri appartient au tableau ; la recherche et les filtres appartiennent à la page, qui passe à `rows` les lignes déjà filtrées. Distinguer « aucune donnée » (`EmptyState` de la page, avec l’action de création) de « aucun résultat » (`emptyTitle` du tableau).
- Une page sans données n’affiche ni barre d’outils, ni filtres, ni compteurs à zéro.
- Colonnes : l’identité de l’objet en premier, sans largeur ; les colonnes courtes (état, date, nombre) avec une `width` ; nombres et dates alignés à droite. Un état est un `StatusBadge size="compact"`.
- Au-delà de quelques centaines de lignes, limiter la requête (`LIMIT`, filtre côté données) plutôt que tout afficher.

Lien avec le panneau de droite :

1. La ligne cliquée devient la sélection : la page garde sa clé pour `selectedKey`, publie un identifiant avec `shell.publish({ id })` et affiche le panneau avec `shell.setPanelVisible(true)`.
2. Le panneau lit `usePageContext()?.selection`, charge lui-même le détail et couvre quatre états : aucune sélection, chargement, erreur, objet introuvable.
3. Publier un identifiant, pas l’objet entier : le panneau affiche ainsi des données à jour.
4. La page n’est pas avertie de ce que fait le panneau : après une écriture faite depuis le panneau, sa liste ne se recharge pas seule. Elle garde donc un `RefreshButton`.

## 9. États : chargement, vide, erreur, notification

`useAsync(charger, deps)` de `@alfred/sdk` renvoie `{ data, error, loading, reload }` : `data` vaut `undefined` jusqu’au premier succès, `error` est renseigné après un échec, `loading` est vrai pendant chaque chargement, rechargement compris.

| Situation | Rendu obligatoire |
|---|---|
| Premier chargement (`data === undefined`, sans erreur) | `LoadingSkeleton` dans `Page` |
| Rechargement (`loading` avec des données) | Les données restent affichées ; `loading` sur `DataTable` et `RefreshButton` |
| Action en cours | `Button loading` ou `FormActions pending` |
| Opération de fond en cours | `Spinner` à côté d’un `Text` |
| Collection vide | `EmptyState` : le titre nomme l’absence (« Aucune tâche », jamais « Pas encore de… »), la description dit à quoi sert la page, une seule action `primary`, pas d’icône décorative |
| Vide dans un panneau, une section, une liste imbriquée | `EmptyState size="compact"` |
| Échec de chargement | `FeedbackBanner tone="danger"` qui dit ce qui n’a pas été chargé, avec « Réessayer » (`reload`) |
| Prérequis absent, données dégradées | `FeedbackBanner tone="warning"` ou `"info"`, tant que l’état dure |
| Champ invalide | `FormField.error` |
| Résultat d’une action (créé, enregistré, supprimé, copié) | `shell.notify({ title, tone: "success" })` |
| Échec d’une action | `shell.notify({ title, description, tone: "error" })` |

Une **notification** est transitoire : elle s’efface après 5 secondes (une erreur reste jusqu’à sa fermeture) et demeure consultable dans la cloche. Un **bandeau** est persistant : il décrit l’état de la page et disparaît avec lui. Pas de bandeau pour dire « enregistré », pas de notification pour un état qui dure. Un message d’erreur dit d’abord ce qui n’a pas fonctionné, puis la cause.

## 10. Icônes

- Les icônes viennent de `lucide-react`, importées par leur nom en PascalCase : `import { Trash2 } from "lucide-react"`.
- Toujours `size={16}` et `aria-hidden="true"` : le sens est donné par le texte voisin ou par le `label` du bouton.
- Une icône n’est jamais seule sans nom accessible : une action en icône seule est un `IconButton` avec un `label` contextualisé (« Supprimer la tâche « Relancer le client » ») et une infobulle courte (« Supprimer »).
- Une icône sert une action ou un état. Pas d’icône d’ornement devant un titre, dans un état vide ou pour remplir une surface ; pas d’émoji à la place d’une icône.
- La même action garde la même icône dans toutes les pages : `Trash2` supprimer, `Pencil` modifier, `Copy` copier, `Download` exporter, `ExternalLink` ouvrir à l’extérieur, `Archive` archiver. « Actualiser » est toujours `RefreshButton`, « Plus » toujours `OverflowMenu`. Même règle dans un `MenuItem`.
- L’icône d’une entrée du menu de gauche se désigne par son nom Lucide en minuscules et tirets : `list-checks` pour `ListChecks`, `calendar-days` pour `CalendarDays`. Un nom inconnu affiche un carré. La choisir pour ce qu’elle évoque du contenu, distincte de celles des autres entrées.

## 11. Accessibilité et mouvement

L’objectif est WCAG 2.2 AA. Les composants en portent l’essentiel ; la page ne doit pas le défaire.

- **Clavier.** Tout ce qui se fait à la souris se fait au clavier, dans un ordre logique. Ne jamais rendre cliquable un `Text` ou une `Surface` : une action est un `Button`, un `IconButton`, un `Link`, une entrée de menu, un `ListItem` ou une ligne de `DataTable`.
- **Focus.** Il est visible sur chaque contrôle et revient au déclencheur à la fermeture d’une modale, d’un menu ou d’un volet. Ne pas le déplacer à la main, sauf `autoFocus` sur le champ d’un `InlineEdit` ou d’une `Modal`.
- **Noms accessibles.** `label` sur `IconButton`, `DataTable`, `SearchField`, `ChoiceGroup`, `Tabs`, `OverflowMenu`, `MenuButton`, `AnchoredPanel` et `StepList` ; `title` sur `Modal`, `legend` sur `Fieldset`, `alt` sur `Image`, `headerLabel` sur une colonne à en-tête icône ; `FormField` pour chaque champ. Un nom décrit l’action et son objet.
- **Couleur.** Un état n’est jamais porté par la couleur seule : `StatusBadge` contient son libellé, `StatusDot` est suivie d’un texte, une erreur de champ est une phrase.
- **Titres.** `Heading` et `Section` se suivent sans saut de niveau : le contenu d’une `Section` (niveau 2) utilise `Heading level={3}` ou `Surface title`.
- **Annonces.** Les composants d’état annoncent déjà leur contenu ; ne pas doubler un message par un second canal.
- **Texte.** Un libellé long doit pouvoir passer à la ligne.
- **Mouvement.** Une page n’anime rien. Les transitions des composants sont brèves, expliquent un changement d’état et sont neutralisées quand le système demande un mouvement réduit.

## 12. Exemples complets

Les trois fichiers ci-dessous sont complets. Ils supposent un module `suivi` avec les tables `suivi_taches` et `suivi_reglages`.

### 12.1 Page liste : barre d’outils, tableau, état vide

```tsx
import { useMemo, useState } from "react";
import {
  Button,
  DataTable,
  type DataTableColumn,
  EmptyState,
  FeedbackBanner,
  LoadingSkeleton,
  Page,
  PageToolbar,
  RefreshButton,
  SearchField,
  StatusBadge,
} from "@alfred/ui";
import { db, shell, useAsync } from "@alfred/sdk";

interface Tache {
  id: number;
  titre: string;
  etat: "a_faire" | "en_cours" | "terminee";
  echeance: string | null;
}

const etats = {
  a_faire: { label: "À faire", tone: "neutral" },
  en_cours: { label: "En cours", tone: "warning" },
  terminee: { label: "Terminée", tone: "success" },
} as const;

const jour = new Intl.DateTimeFormat("fr-FR", { dateStyle: "medium" });

const columns: DataTableColumn<Tache>[] = [
  { key: "titre", header: "Titre" },
  {
    key: "etat",
    header: "État",
    width: "140px",
    render: (tache) => (
      <StatusBadge tone={etats[tache.etat].tone} size="compact">
        {etats[tache.etat].label}
      </StatusBadge>
    ),
    sortValue: (tache) => etats[tache.etat].label,
  },
  {
    key: "echeance",
    header: "Échéance",
    width: "140px",
    align: "end",
    render: (tache) => (tache.echeance ? jour.format(new Date(tache.echeance)) : "—"),
  },
];

export default function TachesPage() {
  const taches = useAsync(
    () => db.query<Tache>("SELECT id, titre, etat, echeance FROM suivi_taches ORDER BY echeance"),
    [],
  );
  const [recherche, setRecherche] = useState("");
  const [selection, setSelection] = useState<number | null>(null);

  const visibles = useMemo(() => {
    const requete = recherche.trim().toLocaleLowerCase("fr");
    return (taches.data ?? []).filter((tache) => tache.titre.toLocaleLowerCase("fr").includes(requete));
  }, [taches.data, recherche]);

  const ouvrir = (id: number) => {
    setSelection(id);
    void shell.publish({ id });
    void shell.setPanelVisible(true);
  };

  const creer = async () => {
    try {
      const { lastInsertId } = await db.execute("INSERT INTO suivi_taches (titre) VALUES ('Nouvelle tâche')");
      taches.reload();
      ouvrir(lastInsertId);
    } catch {
      void shell.notify({ title: "La tâche n’a pas été créée", tone: "error" });
    }
  };

  const total = taches.data?.length ?? 0;

  return (
    <Page
      toolbar={
        total > 0 ? (
          <PageToolbar
            start={
              <SearchField
                label="Rechercher une tâche"
                placeholder="Rechercher…"
                value={recherche}
                onChange={(event) => setRecherche(event.target.value)}
              />
            }
          >
            <RefreshButton loading={taches.loading} onClick={taches.reload} />
            <Button variant="primary" onClick={creer}>
              Nouvelle tâche
            </Button>
          </PageToolbar>
        ) : undefined
      }
    >
      {taches.error ? (
        <FeedbackBanner tone="danger" action={<Button onClick={taches.reload}>Réessayer</Button>}>
          Les tâches n’ont pas pu être chargées : {taches.error.message}
        </FeedbackBanner>
      ) : taches.data === undefined ? (
        <LoadingSkeleton rows={6} label="Chargement des tâches…" />
      ) : total === 0 ? (
        <EmptyState title="Aucune tâche" description="Les tâches créées ici apparaissent dans cette liste.">
          <Button variant="primary" onClick={creer}>
            Nouvelle tâche
          </Button>
        </EmptyState>
      ) : (
        <DataTable
          label="Tâches"
          columns={columns}
          rows={visibles}
          rowKey={(tache) => tache.id}
          selectedKey={selection}
          onRowClick={(tache) => ouvrir(tache.id)}
          loading={taches.loading}
          emptyTitle="Aucun résultat"
          emptyDescription="Aucune tâche ne correspond à cette recherche."
          emptyAction={<Button onClick={() => setRecherche("")}>Effacer la recherche</Button>}
        />
      )}
    </Page>
  );
}
```

### 12.2 Panneau de droite : détail de la sélection

```tsx
import {
  Button,
  EmptyState,
  FeedbackBanner,
  Heading,
  KeyValueList,
  LoadingSkeleton,
  Page,
  Section,
  Stack,
  StatusBadge,
  Text,
} from "@alfred/ui";
import { db, useAsync, usePageContext } from "@alfred/sdk";

interface TacheDetail {
  id: number;
  titre: string;
  etat: "a_faire" | "en_cours" | "terminee";
  echeance: string | null;
  responsable: string | null;
  description: string | null;
}

const etatsDetail = {
  a_faire: { label: "À faire", tone: "neutral" },
  en_cours: { label: "En cours", tone: "warning" },
  terminee: { label: "Terminée", tone: "success" },
} as const;

const jourLong = new Intl.DateTimeFormat("fr-FR", { dateStyle: "long" });

export default function TacheDetailPanel() {
  const context = usePageContext();
  const selection = context?.selection as { id?: number } | null | undefined;
  const id = selection?.id ?? null;

  const tache = useAsync(async () => {
    if (id === null) return null;
    const rows = await db.query<TacheDetail>(
      "SELECT id, titre, etat, echeance, responsable, description FROM suivi_taches WHERE id = ?",
      [id],
    );
    return rows[0] ?? null;
  }, [id]);

  const detail = tache.data;
  return (
    <Page>
      {id === null ? (
        <EmptyState
          size="compact"
          title="Aucune tâche sélectionnée"
          description="Sélectionner une ligne de la liste pour afficher son détail."
        />
      ) : tache.error ? (
        <FeedbackBanner tone="danger" action={<Button onClick={tache.reload}>Réessayer</Button>}>
          Le détail de la tâche n’a pas pu être chargé : {tache.error.message}
        </FeedbackBanner>
      ) : detail === undefined ? (
        <LoadingSkeleton rows={3} label="Chargement de la tâche…" />
      ) : detail === null ? (
        <EmptyState size="compact" title="Tâche introuvable" description="Elle a peut-être été supprimée." />
      ) : (
        <>
          <Stack gap="sm">
            <Heading level={2}>{detail.titre}</Heading>
            <KeyValueList
              items={[
                {
                  label: "État",
                  value: (
                    <StatusBadge tone={etatsDetail[detail.etat].tone} size="compact">
                      {etatsDetail[detail.etat].label}
                    </StatusBadge>
                  ),
                },
                {
                  label: "Échéance",
                  value: detail.echeance ? jourLong.format(new Date(detail.echeance)) : "Non définie",
                },
                { label: "Responsable", value: detail.responsable ?? "Non attribuée" },
              ]}
            />
          </Stack>
          <Section title="Description">
            {detail.description ? (
              <Text>{detail.description}</Text>
            ) : (
              <EmptyState size="compact" title="Aucune description" />
            )}
          </Section>
        </>
      )}
    </Page>
  );
}
```

### 12.3 Onglet de Réglages : formulaire et réglage immédiat

```tsx
import { type FormEvent, useState } from "react";
import {
  Button,
  FeedbackBanner,
  FormActions,
  FormField,
  LoadingSkeleton,
  Page,
  Section,
  Stack,
  SwitchControl,
  TextInput,
} from "@alfred/ui";
import { db, shell, useAsync } from "@alfred/sdk";

interface Reglages {
  equipe: string;
  notifierRetards: boolean;
}

const ECRIRE =
  "INSERT INTO suivi_reglages (cle, valeur) VALUES (?, ?) ON CONFLICT(cle) DO UPDATE SET valeur = excluded.valeur";

async function lireReglages(): Promise<Reglages> {
  const rows = await db.query<{ cle: string; valeur: string }>("SELECT cle, valeur FROM suivi_reglages");
  const valeurs = new Map(rows.map((row) => [row.cle, row.valeur]));
  return {
    equipe: valeurs.get("equipe") ?? "",
    notifierRetards: valeurs.get("notifier_retards") === "1",
  };
}

function ReglagesForm({ initial }: { initial: Reglages }) {
  const [saisie, setSaisie] = useState(initial);
  const [erreurs, setErreurs] = useState<{ equipe?: string }>({});
  const [enCours, setEnCours] = useState(false);
  const [notifier, setNotifier] = useState(initial.notifierRetards);

  const enregistrer = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const suivantes = { equipe: saisie.equipe.trim() ? undefined : "Saisissez le nom de l’équipe." };
    setErreurs(suivantes);
    if (suivantes.equipe) return;

    setEnCours(true);
    try {
      await db.execute(ECRIRE, ["equipe", saisie.equipe.trim()]);
      void shell.notify({ title: "Réglages enregistrés", tone: "success" });
    } catch (error) {
      void shell.notify({
        title: "Les réglages n’ont pas été enregistrés",
        description: error instanceof Error ? error.message : undefined,
        tone: "error",
      });
    } finally {
      setEnCours(false);
    }
  };

  const basculerNotification = async (actif: boolean) => {
    setNotifier(actif);
    try {
      await db.execute(ECRIRE, ["notifier_retards", actif ? "1" : "0"]);
    } catch (error) {
      setNotifier(!actif);
      void shell.notify({
        title: "Le réglage n’a pas été enregistré",
        description: error instanceof Error ? error.message : undefined,
        tone: "error",
      });
    }
  };

  return (
    <Page width="text">
      <Section title="Suivi des tâches" description="Valeurs appliquées aux nouvelles tâches.">
        <form id="reglages-suivi" noValidate onSubmit={enregistrer}>
          <Stack gap="md">
            <FormField label="Nom de l’équipe" error={erreurs.equipe}>
              <TextInput
                value={saisie.equipe}
                aria-required="true"
                onChange={(event) => setSaisie({ ...saisie, equipe: event.target.value })}
              />
            </FormField>
            <FormActions
              form="reglages-suivi"
              submitLabel="Enregistrer"
              pendingLabel="Enregistrement…"
              pending={enCours}
            />
          </Stack>
        </form>
      </Section>
      <Section title="Notifications" description="Ces réglages s’appliquent dès qu’ils sont modifiés.">
        <SwitchControl
          label="Notifier les tâches en retard"
          checked={notifier}
          onChange={(event) => void basculerNotification(event.target.checked)}
        />
      </Section>
    </Page>
  );
}

export default function ReglagesSuiviPage() {
  const reglages = useAsync(lireReglages, []);

  if (reglages.error) {
    return (
      <Page width="text">
        <FeedbackBanner tone="danger" action={<Button onClick={reglages.reload}>Réessayer</Button>}>
          Les réglages n’ont pas pu être chargés : {reglages.error.message}
        </FeedbackBanner>
      </Page>
    );
  }
  if (reglages.data === undefined) {
    return (
      <Page width="text">
        <LoadingSkeleton rows={4} label="Chargement des réglages…" />
      </Page>
    );
  }
  return <ReglagesForm initial={reglages.data} />;
}
```

## 13. Checklist avant de dire qu’une page est terminée

- [ ] Structure : export par défaut, `Page` à la racine dans tous les états, imports autorisés seulement (règles 1 et 2) ; aucun `style`, `<style>` ni `className` (règle 3) ; chaque composant et chaque prop figurent dans ce document ; rien ne répète la coquille ; le gabarit correspond à l’emplacement (section 2).
- [ ] Contenu : ce qui demande une action vient en premier, rien ne décore ; une seule action `primary` par groupe ; destruction en `danger`, confirmée par `useConfirm` ; libellés de la section 6 ; dates et nombres formatés en français.
- [ ] États : premier chargement, rechargement, vide, erreur de chargement et échec d’action ont leur rendu (section 9) ; une page sans données n’affiche ni barre d’outils ni filtres ; un panneau couvre aucune sélection, chargement, erreur, objet introuvable.
- [ ] Accessibilité : icônes en `size={16}` et `aria-hidden="true"` ; chaque champ, tableau, recherche, groupe, menu et modale est nommé (section 11) ; aucun état porté par la couleur seule ; tout le parcours se fait au clavier.
- [ ] Vérification : la page s’affiche sans erreur dans Alfred, en clair et en sombre, panneau ouvert et fermé, et a été relue contre la section 12.
