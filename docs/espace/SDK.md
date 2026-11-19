# Référence du pont `@alfred/sdk`

Une page, un panneau ou une fonction n’a ni réseau ni disque. Tout ce qui sort du cadre passe par `@alfred/sdk` : la base du module, ses fichiers, les clients, les fonctions, l’IA et la coquille. L’apparence relève de `DESIGN.md`, la marche à suivre de `AGENTS.md`.

Chaque appel est asynchrone. Un échec rejette la promesse avec une `AlfredSdkError` (`message` en français, `detail` facultatif) : montre `error.message` à l’utilisateur.

## 1. Le cadre isolé

| À ne pas faire | Pourquoi | À la place |
|---|---|---|
| `fetch`, `XMLHttpRequest`, `WebSocket` | aucune connexion sortante | une fonction du connecteur (`functions.call`) ; `client(id)` dans les fonctions seulement |
| `localStorage`, `sessionStorage`, `indexedDB` | le cadre n’a pas d’origine : l’accès lève une erreur | une table du module |
| `<a href>`, `window.open`, `location` | ni navigation ni fenêtre | `shell.navigate`, `shell.openExternal` |
| `alert`, `confirm`, `prompt` | bloqués | Une `Action` avec `danger` et `confirm`, `confirmAction` (une confirmation), `openForm` (une saisie), `openModal` (un contenu) de `@alfred/ui` |
| `<img src="https://…">` | images extérieures bloquées | un lien `shell.openExternal` ; une image du module : `files.dataUrl` |
| `<input type="file">`, glisser un fichier | pas de disque | `files.pick` |
| `dangerouslySetInnerHTML`, `innerHTML` (le HTML d’un courriel) | du HTML venu de l’extérieur peut exécuter du code avec les droits de la page | `HtmlContent` de `@alfred/ui` (DESIGN.md, section 5) |
| un paquet npm non installé, un `.css`, un `.json` | imports limités (AGENTS.md, règle 3) | `set_libraries` pour le paquet (AGENTS.md), du code dans `lib/` sinon |

Le cadre d’une page est recréé quand l’utilisateur change d’onglet et chaque fois que l’espace de travail change : un état React ne dure pas. Ce qui doit durer va en base.

## 2. Contrat d’une page et d’une fonction

Une page (`pages/<id>.tsx`) exporte par défaut un composant sans props, qui rend `Page` à la racine. Une erreur de compilation la remplace par « Cette page ne compile pas », une exception au rendu par « Cette page a rencontré une erreur » ; l’agent les retrouve dans `check`, comme une promesse rejetée que personne n’attrape : erreur de compilation avec son message, erreur d’exécution par son emplacement ; le message, la pile et toute la console de la page (`console.log`…) sont dans l’outil `page_logs`.

Une fonction (`functions/<id>.ts`) exporte par défaut une fonction asynchrone qui reçoit l’entrée et renvoie une valeur sérialisable en JSON (`undefined` devient `null`). Une exception devient une erreur pour l’appelant, avec son message.

```ts
export default async function (input: { texte?: string }) {
  const texte = (input.texte ?? "").trim();
  if (!texte) throw new Error("Le texte est vide.");
  return { mots: texte.split(/\s+/).length };
}
```

Une fonction utilise le même pont qu’une page (`db`, `commands`, `documents`, `events`, `history`, `jobs`, `search`, `semantic`, `files` sauf `pick`, `export` et `open`, `client`, `functions`, `ai`, `voice.speak`, `shell.notify`, `badge`), sans les hooks React ni le micro. Elle répond en moins de 120 secondes (au-delà, une tâche de fond : section 11), ne tourne que pendant qu’Alfred est ouvert, et au-delà de 40 appels simultanés les suivants sont refusés.

### Fonction en script (bash, PowerShell, Python)

Déclarée avec `runtime` (`bash`, `pwsh` ou `python`), la fonction est un fichier `functions/<id>.sh`, `.ps1` ou `.py` qu’Alfred lance comme un processus, avec les droits de l’utilisateur. Elle s’appelle exactement comme une autre (`functions.call`, outil d’agent, webhook, planification) et garde ses schémas `input` et `output`.

- **Entrée** : le JSON de l’entrée sur stdin.
- **Sortie** : stdout. S’il contient du JSON, c’est la valeur rendue ; sinon, le texte sans ses blancs finaux ; vide, `null`. Au plus 1 Mo.
- **Erreur** : un code de sortie non nul. Le message est la fin de stderr (ou le code de sortie) ; stderr entier va au journal.
- **Cadre** : dossier courant = dossier du module ; environnement réduit (PATH, dossier de l’utilisateur, langue) plus `ALFRED_MODULE`, `ALFRED_FUNCTION`, `ALFRED_CALLER`, `ALFRED_SPACE`, et le pont du SDK (`ALFRED_SDK_URL`, `ALFRED_SDK_TOKEN`, ci-dessous). Jamais de secret : un service passe par `clients.request`. 120 secondes au plus, après quoi le script et tout ce qu’il a lancé sont arrêtés ; 40 appels simultanés au plus.
- **Pont du SDK** : `POST $ALFRED_SDK_URL/<méthode>` avec l’en-tête `Authorization: Bearer $ALFRED_SDK_TOKEN` et les paramètres en JSON (ceux de la méthode TypeScript, nommés : `{"sql": …, "params": […]}`). Réponse `{"ok": valeur}` (statut 200) ou `{"error": {"message": …}}` (400). Méthodes : `db.query`, `db.execute`, `files.save`, `files.list`, `files.get`, `files.read`, `files.readText`, `files.remove`, `documents.pdf`, `documents.csv`, `documents.xlsx`, `documents.extractText`, `search.query`, `semantic.search`, `semantic.status`, `ai.decide`, `history.list`, `history.revert`, `events.publish`, `jobs.start`, `jobs.get`, `jobs.list`, `jobs.cancel`, `jobs.resume`, `clients.request` (`client`, `path`…), `clients.instances`, `clients.clearCache`, `functions.call` (`function`, `input`). Mêmes règles que pour une fonction TypeScript du module (ses tables, ses fichiers, accords). Le jeton ne vaut que pendant cet appel du script.
- **Interpréteur** : cherché dans le PATH du shell de connexion. `bash` (sous Windows, Git Bash, jamais le bash de WSL) ; `pwsh` (sous Windows, à défaut `powershell.exe`, lancé avec `-NoProfile -ExecutionPolicy Bypass`) ; `python3`, puis `python` (sous Windows, à défaut `py -3`). Absent, l’appel échoue et `check` le signale.

```bash
# functions/saluer.sh
nom=$(python3 -c 'import json,sys; print(json.load(sys.stdin)["nom"])')
printf '{"message": "Bonjour %s"}\n' "$nom"
```

```powershell
# functions/doubler.ps1
$entree = [Console]::In.ReadToEnd() | ConvertFrom-Json
@{ double = $entree.valeur * 2 } | ConvertTo-Json -Compress
```

```python
# functions/somme.py
import json, sys
entree = json.load(sys.stdin)
if not entree.get("nombres"):
    sys.exit("Aucun nombre fourni.")  # message d’erreur, code 1
print(json.dumps({"somme": sum(entree["nombres"])}))
```

```python
# functions/importer.py : lit un CSV du module et remplit sa table par le pont du SDK.
import csv, io, json, os, sys, urllib.error, urllib.request

def alfred(methode, **parametres):
    requete = urllib.request.Request(
        f"{os.environ['ALFRED_SDK_URL']}/{methode}",
        data=json.dumps(parametres).encode(),
        headers={"Authorization": f"Bearer {os.environ['ALFRED_SDK_TOKEN']}", "Content-Type": "application/json"},
    )
    try:
        return json.load(urllib.request.urlopen(requete))["ok"]
    except urllib.error.HTTPError as erreur:
        sys.exit(json.load(erreur)["error"]["message"])

entree = json.load(sys.stdin)
texte = alfred("files.readText", id=entree["fichier"])
for ligne in csv.DictReader(io.StringIO(texte), delimiter=";"):
    alfred("db.execute", sql="INSERT INTO compta_lignes (libelle, montant) VALUES (?, ?)", params=[ligne["libelle"], float(ligne["montant"])])
print(json.dumps({"ok": True}))
```

```bash
# Le même pont en bash, avec curl.
alfred() { curl -s -X POST "$ALFRED_SDK_URL/$1" -H "Authorization: Bearer $ALFRED_SDK_TOKEN" -H 'Content-Type: application/json' -d "$2"; }
alfred db.query '{"sql":"SELECT count(*) AS n FROM compta_lignes"}'
```

Sans `jq` ni Python, un script bash peut lire un champ simple avec `sed`. Sous Windows PowerShell 5.1, écrire d’abord `[Console]::InputEncoding = [Console]::OutputEncoding = [Text.Encoding]::UTF8` pour les accents.

## 3. Charger des données : les gabarits, ou `useAsync`

Les gabarits de `@alfred/ui` chargent eux-mêmes : `CollectionPage` et `SettingsPage` prennent `load`, `DetailPanel` prend `load(id)`. Ils affichent chargement, erreur et absence, rechargent après chaque `Action` et après une écriture faite dans l’autre cadre (page ou panneau). C’est le cas général :

```tsx
import { Pencil } from "lucide-react";
import { db } from "@alfred/sdk";
import { CollectionPage, openForm } from "@alfred/ui";

interface Note {
  id: number;
  texte: string;
  creee: string;
}

const formulaire = (note?: Note) => ({
  title: note ? "Modifier la note" : "Nouvelle note",
  fields: [{ name: "texte", label: "Texte", type: "textarea" as const }],
  initial: note,
  submitLabel: note ? "Enregistrer" : "Créer",
  onSubmit: (v: Record<string, string>) =>
    note
      ? db.execute("UPDATE carnet_notes SET texte = ? WHERE id = ?", [v.texte, note.id])
      : db.execute("INSERT INTO carnet_notes (texte) VALUES (?)", [v.texte]),
});

export default function NotesPage() {
  return (
    <CollectionPage<Note>
      label="Notes"
      load={() => db.query<Note>("SELECT id, texte, creee FROM carnet_notes ORDER BY id DESC LIMIT 200")}
      rowKey={(note) => note.id}
      columns={[
        { key: "texte", header: "Note" },
        { key: "creee", header: "Créée", type: "relative" },
      ]}
      emptyTitle="Aucune note"
      emptyDescription="Les notes ajoutées ici restent dans l’espace."
      search={{ label: "Rechercher une note" }}
      actions={[{ label: "Nouvelle note", primary: true, onClick: () => openForm(formulaire()) }]}
      rowActions={(note) => [{ label: "Modifier", icon: Pencil, onClick: () => openForm(formulaire(note)) }]}
    />
  );
}
```

Une page composée (DESIGN.md, section 5) charge avec `useAsync` :

```ts
function useAsync<Data>(load: () => Promise<Data>, deps: ReadonlyArray<unknown>): {
  data: Data | undefined;
  error: Error | undefined;
  loading: boolean;
  reload: () => void;
};
```

`load` s’exécute au montage, à chaque changement de `deps` et à chaque `reload()`. `data` reste `undefined` jusqu’au premier succès, puis garde sa valeur pendant un rechargement. Trois états à couvrir : erreur, premier chargement, données (liste vide comprise). Après une écriture, appelle `reload()`. Exemple complet : DESIGN.md, section 12.4.

## 4. Base de données : `db`

```ts
type SqlValue = string | number | boolean | null;
db.query<Row = Record<string, SqlValue>>(sql: string, params?: SqlValue[]): Promise<Row[]>;
db.execute(sql: string, params?: SqlValue[]): Promise<{ changes: number; lastInsertId: number }>;
```

- `query` lit ; `execute` écrit (`INSERT`, `UPDATE`, `DELETE`). Une écriture passée à `query` est refusée (« utiliser `db.execute` »).
- Une instruction par appel, paramètres positionnels (`?` ou `?1`, `?2`…). Ne colle jamais une valeur dans le texte SQL.
- Un booléen devient `0` ou `1`, un `BLOB` revient en base64. Plus de 5 000 lignes lues : erreur ; filtre ou ajoute `LIMIT`.
- Seules les tables du module sont accessibles (sinon « Requête refusée… ») : leur nom commence par l’identifiant du module, tirets remplacés par des soulignés, suivi de `_`. Un module `x-ajouts` lit aussi celles de `x` (et pas celles d’un autre module `x-…`), sans y écrire ; l’écran d’installation l’annonce comme un accès. Les clés étrangères sont actives, et ne visent que des tables du module. Le catalogue (`sqlite_master`) n’est pas lisible : la structure se lit avec `db_schema`.
- Ni `CREATE`, `ALTER`, `DROP`, `PRAGMA`, `ATTACH` ni vue hors migration. Chaque appel est indépendant : aucune transaction ne couvre deux appels.

Sauvegardes : la base et les fichiers des modules sont hors de l’historique git. Alfred les copie chaque jour et juste avant d’appliquer une migration d’un module qui a déjà des tables ; l’utilisateur restaure tout l’espace ou un seul module, et exporte ou importe les données d’un module (JSON), dans Réglages → Général. Une migration qui transforme des données n’a donc pas besoin de garder elle-même une copie des anciennes tables.

Migrations (`modules/<module>/migrations/NNNN_nom.sql`) : appliquées dans l’ordre des noms, dès qu’elles apparaissent et à chaque `check`. Un fichier est une transaction ouverte et close par Alfred : `BEGIN`, `COMMIT` ou `ROLLBACK` y sont refusés. Une clé étrangère vers la table d’un autre module est refusée. Une erreur annule le fichier et bloque les suivants du module. Un fichier appliqué ne repasse jamais.

```sql
CREATE TABLE carnet_notes (
  id INTEGER PRIMARY KEY,
  texte TEXT NOT NULL,
  cree_le TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX carnet_notes_cree_le ON carnet_notes (cree_le);
```

## 5. Fonctions : `functions.call`

```ts
functions.call<Output = unknown>(reference: string, input?: unknown): Promise<Output>;
```

`reference` vaut `"fonction"` dans le même module, `"module/fonction"` sinon. La première fois qu’une page appelle la fonction d’un autre module, l’utilisateur doit l’accepter, sauf si ce module figure dans `requires` du `module.json` (AGENTS.md) : la fonction d’une dépendance est accordée d’office. Rejets possibles : fonction non déclarée ou « pas encore écrite », accès refusé, pas de réponse en 120 s, exception levée par la fonction (son message).

`functions/compter.ts`, puis son appel depuis une page du module :

```ts
import { db } from "@alfred/sdk";

export default async function (input: { depuis?: string }) {
  const lignes = await db.query<{ total: number }>("SELECT count(*) AS total FROM carnet_notes WHERE cree_le >= ?", [
    input.depuis ?? "1970-01-01",
  ]);
  return { total: lignes[0]?.total ?? 0 };
}
```

```tsx
import { functions, shell } from "@alfred/sdk";

export async function compter() {
  try {
    const { total } = await functions.call<{ total: number }>("compter", { depuis: "2026-01-01" });
    void shell.notify({ title: `${total} notes depuis janvier`, tone: "info" });
  } catch (error) {
    void shell.notify({ title: "Le comptage a échoué", description: (error as Error).message, tone: "error" });
  }
}
```

### Passer par le connecteur d’un service

Une page ou une fonction qui a besoin d’un service externe appelle les fonctions du **connecteur** de ce service (le module qui détient son client, déclaré dans `requires` s’il en est un autre), jamais `client()` directement. **Une page ne peut pas appeler un client** : Alfred refuse la requête, même accordée, et `check` signale l’import de `client` dans une page. Le connecteur renvoie des données déjà mises en forme (`{ tickets: [{ cle, titre, statut }] }`), décrites par son schéma `output` : la page n’a pas à connaître l’API.

```tsx
import { functions, useAsync } from "@alfred/sdk";

// Module « sprint », avec `"requires": [{ "module": "jira" }]`.
const tickets = useAsync(
  () => functions.call<{ tickets: Array<{ cle: string; titre: string }> }>("jira/lister-tickets", { projet: "ALF" }),
  [],
);
```

Seules les fonctions du connecteur écrivent `client("jira")`. Un module qui utilise plusieurs services déclare plusieurs clients dans `clients`, chacun avec ses fonctions. **Une fonction, une responsabilité** : chacune touche un seul service et y fait une seule opération (`lister-tickets`, `lire-ticket`, `commenter-ticket`), et son entrée en porte les données (`projet`, `ticket`, `texte`). Jamais de fonction relais qui reçoit un chemin, une méthode ou une adresse et transmet n’importe quel appel (`requete({ path, method })`) : `check` la signale. Une opération qui manque (commenter, changer d’état) s’ajoute au connecteur, avec `effect`, ses tests (AGENTS.md, « Tests d’une fonction ») et ses données d’exemple, puis la page l’appelle.

**Données d’exemple.** Chaque fonction du connecteur déclare, dès son écriture, deux ou trois `examples` (`name`, `input`, `output`) : des sorties réalistes, au format exact du service, cohérentes d’une fonction à l’autre (mêmes identifiants, pour qu’une liste et son détail s’enchaînent). Quand l’utilisateur règle le module en mode « données d’exemple » (page d’attente ou fiche du module), `functions.call` vers une fonction de connecteur rend l’exemple dont l’`input` correspond le mieux à l’appel (entrée identique, sinon le plus de champs fournis égaux, sinon le premier), sans lancer la fonction ; sans exemple, la promesse est rejetée (« Cette fonction n’a pas encore de données d’exemple »). La page n’a rien à faire de particulier : elle reçoit la même forme de données. Une fonction sans service s’exécute normalement, et ses propres appels de fonctions restent en mode exemple ; `client(id)` y est rejeté (aucune requête ne part vers un service), dépendances comprises. `db` reste réelle : ce que la page enregistre dans la base du module y reste. Une fonction en script reçoit `ALFRED_EXAMPLES=1` dans ce mode. Détails : AGENTS.md, « Données d’exemple ».

Appelée par un webhook, une fonction reçoit `{ method, query, headers, body }` (corps JSON décodé, sinon texte ; en-têtes d’authentification retirés). Sa valeur de retour part en JSON à l’émetteur si elle arrive en moins de 25 secondes ; sinon l’émetteur reçoit `202` et la fonction continue. Planifiée, elle reçoit le `input` de sa planification. Webhooks et planifications se déclarent avec les outils `declare_webhook` et `declare_schedule` (AGENTS.md).

## 6. Clients : `client(id)`

`client()` s’écrit **uniquement dans les fonctions** du module connecteur du service (voir § 5) : une requête venue d’une page ou d’un panneau est refusée. Les pages, et les autres modules, passent par ces fonctions.

```ts
client(id: string, options?: { instance?: string }): {
  request<Body>(options: ClientRequest): Promise<ClientResponse<Body>>;
  get<Body>(path: string, query?: Record<string, string | number | boolean>, options?: { cache?: number }): Promise<ClientResponse<Body>>;
  post<Body>(path: string, body?: unknown): Promise<ClientResponse<Body>>;
  put<Body>(path: string, body?: unknown): Promise<ClientResponse<Body>>;
  patch<Body>(path: string, body?: unknown): Promise<ClientResponse<Body>>;
  delete<Body>(path: string): Promise<ClientResponse<Body>>;
  instances(): Promise<{ id: string; label: string; default: boolean }[]>;
  clearCache(): Promise<{ cleared: number }>;
};
interface ClientRequest {
  method?: "GET" | "POST" | "PUT" | "PATCH" | "DELETE" | "HEAD";
  path: string;
  query?: Record<string, string | number | boolean>;
  headers?: Record<string, string>;
  body?: unknown;
  cache?: number; // secondes : voir « Cache des lectures »
}
interface ClientResponse<Body> { status: number; ok: boolean; headers: Record<string, string>; body: Body; cached?: boolean; cacheAge?: number }
```

Alfred exécute la requête et ajoute l’authentification : la page ne voit jamais le secret. `path` commence par `/` et reste sous l’adresse de base (ni adresse complète, ni `//`, `..` ou `@`). Un `body` objet part en JSON, une chaîne telle quelle. `Authorization`, `Cookie`, `Host`, `Range`, `If-Range` et l’en-tête de la clé sont fixés par Alfred. `body` est décodé si la réponse est du JSON, sinon c’est le texte ; 20 Mo et 60 secondes au plus.

**Un statut HTTP d’erreur ne rejette pas la promesse** : teste `ok` ou `status`. Le rejet signifie que la requête n’a pas abouti : client inconnu ou à valider, secret manquant, accès refusé, chemin refusé, erreur réseau. La première requête d’une page vers un client (et, séparément, de son panneau, ou des fonctions d’un module) demande l’accord de l’utilisateur.

**Cache des lectures** : `cache: 300` (secondes, un jour au plus) sur un `GET` ou un `HEAD` fait garder la réponse réussie (statut 2xx) et la resservir sans rappeler le service, avec `cached: true` et `cacheAge`. Pour tout le module, donne `cache` au besoin dans `module.json` (`"clients": [{ "id": "jira", "label": "Jira", "cache": 300 }]`) ; la requête peut le changer (`cache: 0` pour relire). Le cache est propre au module et à la requête exacte (chemin, paramètres, en-têtes, instance) ; une modification du client le rend caduc ; `clearCache()` l’oublie après une écriture. Réserve-le aux lectures qui changent peu (projets, profils, référentiels) pour ménager les quotas du service, jamais à une donnée que l’utilisateur attend à jour.

Un client peut avoir **plusieurs instances** : plusieurs comptes ou installations du même service (deux sites Jira, deux boîtes mail), chacune avec son adresse, sa méthode d’authentification et son secret. `client("jira", { instance: "acme" })` appelle l’instance `acme` ; sans `instance`, c’est l’instance par défaut (la première). `client("jira").instances()` liste les instances (identifiant, nom, `default`) pour proposer un choix à l’utilisateur : ni adresse ni secret. L’accord de l’utilisateur vaut pour le client et toutes ses instances. Rejet si l’instance nommée n’existe pas, ou si le client n’en a aucune.

Dans une page pour chaque compte (`perInstance` de la page ou de sa section, AGENTS.md), chaque page connaît son instance (`usePageContext().instance`) et la passe aux fonctions dans leur `input` (`functions.call("lister-tickets", { instance, projet })`) ; la fonction appelle `client(id, { instance: input.instance })`. Le même fichier de page sert à toutes les instances ; l’utilisateur ajoute, compte par compte, les pages qui existent pour lui, et une page ne suppose donc pas qu’une autre page du module existe pour le même compte. Une page peut lister les instances (`client(id).instances()`, ni adresse ni secret) pour proposer un choix. Que les comptes s’affichent en entrées du menu ou en onglets d’une seule entrée (`instancesAs: "tabs"` sur la section), la page et son panneau reçoivent l’instance de la même façon.

`client("crm/hubspot")` désigne le client du besoin `hubspot` déclaré par le module `crm`, dont ce module dépend (`requires`) : il suit la liaison choisie pour `crm`, sans besoin à déclarer ni accord à demander. Rejet si le module ne dépend pas de `crm`, ou si `crm` ne déclare pas ce besoin.

```tsx
// functions/lister-tickets.ts : une opération, une fonction.
import { client } from "@alfred/sdk";

export default async function listerTickets({ projet, instance }: { projet: string; instance?: string }) {
  const reponse = await client("jira", { instance }).get<{ issues: { key: string }[] }>("/rest/api/3/search", {
    jql: `project = ${projet} AND statusCategory != Done`,
    maxResults: 50,
  });
  if (!reponse.ok) throw new Error(`Jira a répondu ${reponse.status}.`);
  return { tickets: reponse.body.issues.map((issue) => ({ cle: issue.key })) };
}
```

Un client se déclare avec l’outil `declare_client`, qui écrit `clients/jira.json` sans aucun secret. Pour un service à une seule adresse, son argument `client` a la forme du fichier :

```json
{
  "id": "jira",
  "label": "Jira",
  "baseUrl": "https://exemple.atlassian.net",
  "auth": { "type": "basic" },
  "headers": { "Accept": "application/json" },
  "testPath": "/rest/api/3/myself"
}
```

- `baseUrl` : `https://` (`http://` admis vers `localhost` et `127.0.0.1`), sans identifiants, paramètres ni ancre ; son chemin préfixe toutes les requêtes.
- `auth.type` : `none` ; `bearer` ; `basic` ; `apiKey` avec `header` (et `prefix` facultatif) **ou** `queryParam` ; `oauth2` avec `authorizationUrl`, `tokenUrl`, `scopes` ; `clientCredentials` avec `tokenUrl`, `scopes`.
- `auth.secret` : l’entrée du coffre renvoyée par `vault_store` ; omis, `declare_client` garde celle déjà reliée. `headers` : en-têtes fixes, jamais d’authentification.
- `testPath` : chemin que lit le bouton Tester des Réglages (`GET`), pour chaque instance. Choisis une lecture légère qui demande l’authentification (`/me`, `/labels`…) : beaucoup d’API n’ont rien à la racine, qui est lue sans lui.

Pour un service à plusieurs instances, `methods` remplace `auth` : la liste des façons de s’authentifier, et `instances` les comptes (adresse libre, méthode, entrée du coffre). `declare_client` crée ou met à jour les instances qu’il reçoit et garde les autres ; l’utilisateur peut aussi en ajouter dans la fiche du module (Réglages → Modules).

```json
{
  "id": "jira",
  "label": "Jira",
  "methods": [
    { "id": "cloud", "label": "Jira Cloud (jeton d’API)", "type": "basic" },
    { "id": "pat", "label": "Data Center (jeton personnel)", "type": "bearer" },
    { "id": "oauth", "label": "OAuth", "type": "oauth2", "authorizationUrl": "{url}/rest/oauth2/latest/authorize", "tokenUrl": "{url}/rest/oauth2/latest/token", "scopes": ["WRITE"] }
  ],
  "instances": [
    { "id": "acme", "label": "Acme", "url": "https://acme.atlassian.net", "method": "cloud", "secret": "jira-acme" },
    { "id": "interne", "label": "Interne", "url": "https://jira.interne.exemple", "method": "pat", "secret": "jira-interne" }
  ],
  "headers": { "Accept": "application/json" }
}
```

- `methods[].id` et `label` : identifiant et nom montré à l’utilisateur ; les autres champs sont ceux de `auth`, sans `secret`. `{url}` au début de `authorizationUrl` ou `tokenUrl` devient l’adresse de l’instance.
- `instances[]` : `id` (celui que les pages passent à `client(id, { instance })`), `label`, `url` (omise : `baseUrl`), `method`, `secret` (omis : l’entrée déjà reliée est gardée). La première est celle par défaut.
- `baseUrl` (facultatif) : adresse proposée aux instances qui n’ont pas la leur.

Un client déclaré ou modifié par l’agent est « à valider » : l’agent range son secret avec `vault_store`, le relie (`auth.secret`, ou le `secret` de chaque instance), le valide avec `validate_client`, puis accorde l’accès à la page avec `grant_access` (voir AGENTS.md). Chaque instance se valide séparément : modifier une méthode ne remet « à valider » que les instances qui l’utilisent.

## 7. IA

`ai.oneShot` et `ai.startAgent` utilisent le modèle que l’utilisateur a réglé pour les pages dans Réglages → Agent, section « Dans les pages » (harnais, modèle et raisonnement) ; par défaut, « Comme l’agent », celui des conversations. Si ce harnais n’est plus installé, ou si `ai.oneShot` n’obtient pas de réponse de ce modèle, Alfred se sert de celui de l’agent et le note au journal des appels IA (`read_journal`), qui dit pour chaque appel quel harnais et quel modèle ont répondu. `ai.decide` n’est pas concerné : il tourne toujours sur l’ordinateur.

### `ai.oneShot` : une réponse structurée

```ts
ai.oneShot<Output>(options: { instruction: string; context?: unknown; schema: Record<string, unknown> }): Promise<Output>;
```

Un tour, sans outil, avec le modèle réglé pour les pages ; `context` (objet ou texte, 120 000 caractères au plus) accompagne la consigne. Alfred valide la réponse contre `schema` et relance une fois avec les écarts ; si elle reste invalide, rejet (« La réponse du modèle ne respecte pas le schéma demandé. », écarts dans `detail`). L’appel prend plusieurs secondes : affiche un état en cours.

Schéma bien formé : un objet à la racine, toutes ses propriétés dans `required`, `additionalProperties: false`, et seulement `type`, `properties`, `required`, `items`, `enum`. Une valeur facultative s’écrit `type: ["string", "null"]`.

```tsx
import { ai } from "@alfred/sdk";

export function analyser(ticket: { titre: string; description: string }) {
  return ai.oneShot<{ resume: string; priorite: "basse" | "normale" | "haute"; actions: string[] }>({
    instruction: "Résume ce ticket en deux phrases, estime sa priorité et propose au plus trois actions.",
    context: ticket,
    schema: {
      type: "object",
      properties: {
        resume: { type: "string" },
        priorite: { type: "string", enum: ["basse", "normale", "haute"] },
        actions: { type: "array", items: { type: "string" } },
      },
      required: ["resume", "priorite", "actions"],
      additionalProperties: false,
    },
  });
}
```

### `ai.decide` : une décision locale, rapide et gratuite

```ts
ai.decide(options: { text: string | object | unknown[]; question: string; choices: Choice[] | Record<string, string> }):
  Promise<{ choice: string; confidence: number; probabilities: Record<string, number>; truncated: boolean }>;
ai.decide(options: { text: string | object | unknown[]; questions?: Record<string, DecisionQuestion>; preset?: DecisionPreset }):
  Promise<{ answers: Record<string, DecisionAnswer>; truncated: boolean }>;
// Choice : "libellé" ou { label, description? } ; un objet { libellé: description } garde l’ordre de ses clés.
// DecisionQuestion : { type?: "choice"; question; choices } | { type: "score"; question; choices: niveaux }
//                  | { type: "yesno"; question; choices?: { yes?, no? } }
```

Un modèle de décision (Laya multilingue) lit `text` et répond à une question fermée : un choix parmi des options, un niveau sur une échelle (`score`), ou oui ou non (`yesno`). Il ne rédige rien ; il rend la réponse et sa probabilité. Le calcul se fait sur l’ordinateur de l’utilisateur, sans service ni coût : moins d’un dixième de seconde par question pour un texte court, environ une seconde pour un texte long (sur un Mac, la carte graphique s’en charge : quelques centièmes de seconde, une demi-seconde pour un texte long). Le modèle se charge dès qu’une page qui l’utilise s’ouvre, puis reste en mémoire. Les appels simultanés passent l’un après l’autre sans rien bloquer : une page peut lancer une décision par ligne avec `Promise.all`.

- **Réponses.** `choice` rend `choice`, `confidence` (la probabilité du choix retenu, entre 0 et 1) et `probabilities` (celle de chaque choix). `score` rend `score` (le niveau espéré, 0 pour le premier), `level` (le plus probable), `confidence` et `probabilities` (une par niveau). `yesno` rend `answer`, `probability` (celle du oui) et `confidence`. Avec `question` et `choices`, la promesse rend directement la réponse ; avec `questions` (plusieurs questions, chacune sous son identifiant) ou `preset`, elle rend `answers`.
- **Présets.** `preset` pose un jeu de questions tout prêt, en anglais (le texte peut être en français) : `triage` (ticket de support : `intent`, `is_urgent`, `frustration`, `refund_requested`, `churn_risk`), `email` (courriel entrant : `category`, `is_spam`, `is_phishing`, `urgency`, `needs_reply`), `guard` (consigne envoyée à une IA : `jailbreak`, `prompt_injection`, `sensitive_data`, `harm_severity`, `topic`), `moderation` (message publié : `toxic`, `harassment`, `threat`, `spam`, `severity`), `router` (demande à confier à un modèle : `difficulty`, `domain`, `needs_tools`, `is_sensitive`).
- **Bien poser la question.** Une question courte et fermée, des choix qui s’excluent, chacun avec une description quand le libellé seul est ambigu (« facturation : factures, paiements, remboursements »). Moins de 20 choix ; prévoir un choix « autre ». Un objet en `text` est lu champ par champ (`{ objet, corps }`) ; une liste est lue comme une conversation.
- **Limites.** Le modèle lit environ 1 000 jetons (à peu près 4 000 caractères), question et choix compris : au-delà, le texte est coupé (la fin, ou le début d’une conversation) et `truncated` vaut `true` ; pour un long document, passe-lui l’extrait utile. Plus de 100 langues, le français et l’anglais en tête ; il est plus faible sur les langues rares et sur les échelles (`score`). Ses probabilités ne sont pas calibrées : il est souvent trop sûr de lui. `confidence` sert à ordonner et à écarter les cas douteux (par exemple, sous 0,8, demander à l’utilisateur), pas à prouver qu’une réponse est juste.
- **Modèle à installer.** Tant que l’utilisateur n’a pas téléchargé le modèle (Réglages → Général, rubrique « Décisions locales », 647 Mo une seule fois, depuis Hugging Face ou le miroir de l’entreprise réglé dans « Source des modèles »), la promesse est rejetée (« Les décisions locales ne sont pas encore installées… ») : attrape ce rejet et dis-lui où l’installer, au lieu d’afficher l’erreur brute. Une fonction en script l’appelle par le pont (`ai.decide`, mêmes champs).

```tsx
import { ai } from "@alfred/sdk";

// Trier un ticket de support vers la bonne équipe.
export async function router(ticket: { titre: string; description: string }) {
  const { choice, confidence } = await ai.decide({
    text: ticket,
    question: "Quelle équipe doit traiter ce ticket ?",
    choices: {
      facturation: "factures, paiements, remboursements",
      technique: "pannes, bogues, intégrations",
      commercial: "tarifs, devis, nouveaux achats",
      autre: "rien de tout cela",
    },
  });
  return confidence >= 0.8 ? choice : "à trier"; // sous 0,8, un humain tranche
}

// Lire un courriel entrant avec le préset `email`.
export async function lireCourriel(corps: string) {
  const { answers } = await ai.decide({ text: corps, preset: "email" });
  const phishing = answers.is_phishing.type === "yesno" && answers.is_phishing.probability > 0.5;
  return { categorie: answers.category.type === "choice" ? answers.category.choice : null, phishing };
}
```

### `ai.startAgent` : une conversation d’agent

```ts
ai.startAgent<Result>(options: {
  instruction: string;
  context?: unknown;
  title?: string;
  functions?: string[];
  resultSchema?: Record<string, unknown>;
}): Promise<{ conversationId: string; message: string; result?: Result }>;
```

Lance une vraie conversation, affichée dans le panneau de droite de la page (lancée par une fonction, elle n’apparaît que dans la page Agent) ; l’utilisateur la suit et peut répondre. La première fois, l’utilisateur accorde à la page (ou aux fonctions du module) le droit de lancer un agent ; un refus rejette la promesse. L’agent est en autonomie stricte (chaque action lui est demandée à l’utilisateur) et n’agit que sur le module : `check`, `db_schema`, `db_query` et `call_function` sur ce module, rien qui change la structure de l’espace de travail. Les `functions` (`"fonction"` ou `"module/fonction"`) deviennent des outils de cet agent ; celle d’un autre module demande l’accord de l’utilisateur, comme `functions.call`. La promesse se résout à la fin du premier tour avec le dernier message ; avec `resultSchema`, l’agent finit par un bloc JSON validé, rendu dans `result` (sinon rejet). Pour une simple réponse structurée, préfère `ai.oneShot` ; pour un choix fermé, `ai.decide`.

```tsx
import { ai } from "@alfred/sdk";

export async function trier(ticket: { id: number; titre: string }) {
  const { result } = await ai.startAgent<{ categorie: string }>({
    instruction: "Classe ce ticket avec l’outil de classement, puis donne la catégorie retenue.",
    context: ticket,
    title: `Tri du ticket ${ticket.id}`,
    functions: ["classer-ticket"],
    resultSchema: {
      type: "object",
      properties: { categorie: { type: "string" } },
      required: ["categorie"],
      additionalProperties: false,
    },
  });
  return result?.categorie;
}
```

### `voice` : lire à voix haute et dicter

```ts
voice.speak(text: string): Promise<{ interrupted: boolean }>; // lit avec la voix d’Alfred, se résout à la fin
voice.stopSpeaking(): Promise<void>;                          // coupe la lecture en cours
voice.startListening(): Promise<void>;                        // page ou panneau : ouvre le micro
voice.stopListening(): Promise<{ text: string }>;             // ferme le micro, rend la transcription
voice.cancelListening(): Promise<void>;                       // ferme le micro sans transcrire
```

Tout tourne sur l’ordinateur : la transcription par whisper.cpp, la lecture par la voix d’Alfred (un majordome âgé, Qwen3-TTS), la voix du système ou Kokoro, réglées dans Réglages › Voix. La voix d’Alfred commence à parler en moins d’une seconde. L’utilisateur peut couper la voix : chaque appel est alors rejeté (« La voix est désactivée »), à montrer tel quel. Une seule lecture à la fois : `speak` coupe la précédente (`interrupted: true` pour celle-ci), comme l’ouverture du micro. 20 000 caractères lus au plus ; donne du texte, pas du Markdown.

Le micro est unique et réservé aux pages et panneaux. La première fois, l’utilisateur l’accorde à la page. `startListening` se résout quand l’écoute a commencé : au premier usage, après le chargement du modèle (quelques secondes), donc affiche un état en cours. Rejet si la dictée n’est pas réglée, si l’utilisateur refuse ou si le micro sert déjà ailleurs (la page Agent, une autre page) : montre `error.message`. Une transcription vide signifie que rien de net n’a été entendu. Le micro se ferme seul quand le cadre disparaît.

```tsx
import { Button, FeedbackBanner, Page, Text } from "@alfred/ui";
import { voice } from "@alfred/sdk";
import { useState } from "react";

export default function Dicter() {
  const [etat, setEtat] = useState<"pret" | "ouverture" | "ecoute" | "transcription">("pret");
  const [texte, setTexte] = useState("");
  const [erreur, setErreur] = useState<string>();

  const basculer = async () => {
    setErreur(undefined);
    try {
      if (etat === "pret") {
        setEtat("ouverture");
        await voice.startListening();
        setEtat("ecoute");
      } else if (etat === "ecoute") {
        setEtat("transcription");
        const { text } = await voice.stopListening();
        setTexte(text);
        setEtat("pret");
        if (text) await voice.speak(`Vous avez dit : ${text}`);
      }
    } catch (error) {
      setErreur((error as Error).message);
      setEtat("pret");
    }
  };

  return (
    <Page width="text">
      <Button onClick={basculer} disabled={etat === "ouverture" || etat === "transcription"}>
        {etat === "ecoute" ? "Terminer" : etat === "pret" ? "Dicter" : "Patientez…"}
      </Button>
      {erreur ? <FeedbackBanner tone="error">{erreur}</FeedbackBanner> : <Text>{texte}</Text>}
    </Page>
  );
}
```

## 8. Coquille : `shell`, `usePageContext`, `usePeerMessage`, `useTopBarSearch`, `badge`

```ts
shell.notify(options: { title: string; description?: string; tone?: "info" | "success" | "warning" | "error" }): Promise<void>;
shell.navigate(reference: string): Promise<void>;       // ouvre la page « module/page » (« module/page@instance » pour la page d’un compte)
shell.openWindow(reference?: string): Promise<void>;    // ouvre la page (sans argument : celle-ci) seule dans sa fenêtre
shell.setPanelVisible(visible: boolean): Promise<void>; // panneau de droite de la page
shell.publish(selection: unknown): Promise<void>;       // sélection transmise au panneau
shell.send(message: unknown): Promise<void>;            // page vers panneau, ou panneau vers page
shell.openExternal(url: string): Promise<void>;         // http(s), navigateur du système, hôte accordé par l’utilisateur
usePageContext(): PageContext | undefined;              // undefined le temps de la première réponse
usePeerMessage(handler: (message: unknown) => void): void;

interface PageContext {
  reference: string; // « module/page »
  module: string;
  page: string;
  kind: "page" | "panel";
  surface: "section" | "settings"; // « settings » : page placée dans les Réglages, qui prend leur style (DESIGN.md)
  theme: "light" | "dark"; // appliqué par Alfred, rien à faire
  selection: unknown; // panneau : dernière valeur publiée par sa page ; sinon null
  instance: string | null; // page pour chaque compte (`perInstance`) : l’instance du client que montre la page ; sinon null
}
```

Page et panneau : `CollectionPage` avec `panel` publie `{ id }` de la ligne choisie et ouvre le panneau ; `DetailPanel` lit cette sélection, charge l’objet et, après une action, prévient la page, qui recharge sa liste (DESIGN.md, sections 4.1 et 4.2). Ces appels ne servent donc qu’à une page composée : `shell.publish({ id })` et `shell.setPanelVisible(true)` côté page, `usePageContext()?.selection` côté panneau, `shell.send(message)` et `usePeerMessage(handler)` pour se prévenir d’une écriture.

Blocs du panneau : ceux de `DetailPanel` (`sections`) et de `PanelSections` (panneau composé) se replient et se déplacent ; Alfred retient leur ordre et leur repli pour la page, sur le poste, sous une clé `usePageState` réservée (`alfred.sections.<name>`). Les clés `alfred.*` ne sont pas pour la page ; les autres ne durent que tant qu’Alfred est ouvert. La largeur du panneau (340 px, 460 px, large) est réglée par l’utilisateur.

Un lien vers le web s’ouvre par `shell.openExternal(url)` (une `Action`, ou une valeur de type `url` ou `email`, qui le fait seule). La première ouverture vers un hôte demande l’accord de l’utilisateur (mémorisé pour la page) ; l’adresse fait au plus 2 048 caractères et ne contient pas d’identifiants. Ouvre un lien sur un clic, jamais au chargement.

### Recherche de la barre du haut : `useTopBarSearch`, `matchesSearch`

La recherche d’une page est dans la barre du haut d’Alfred, pas dans la page (DESIGN.md, section 2). La page la déclare ; Alfred affiche le champ (240 px, ⌘F ou Ctrl+F y mène, Échap l’efface) et lui renvoie chaque frappe. Le texte est retenu tant qu’Alfred est ouvert : en revenant sur la page, il est là.

```ts
useTopBarSearch(options?: { label?: string; placeholder?: string }): {
  query: string;                        // texte tapé, tel quel
  terms: string[];                      // ses mots, sans casse ni accents
  matches(...fields: unknown[]): boolean; // chaque mot apparaît dans un des champs (textes, nombres, listes ; null ignoré)
  setQuery(query: string): void;
  clear(): void;                        // « Effacer la recherche » d’un état « Aucun résultat »
};
searchTerms(query: string): string[];
matchesSearch(search: string | string[], fields: unknown[]): boolean; // la même règle, hors d’une page
```

```tsx
import { useAsync, useTopBarSearch } from "@alfred/sdk";

const tickets = useAsync(() => db.query<Ticket>("SELECT * FROM support_tickets"), []);
const recherche = useTopBarSearch({ label: "Rechercher un ticket", placeholder: "Titre, client, numéro…" });
const visibles = (tickets.data ?? []).filter((ticket) => recherche.matches(ticket.titre, ticket.client, ticket.numero));
```

- « eleve paris » trouve « Élève inscrit à Paris » : casse et accents ignorés, chaque mot exigé, dans n’importe quel champ. Une recherche vide trouve tout.
- `search` de `CollectionPage` et de `Page` passe déjà par là : ne déclare `useTopBarSearch` que pour une page composée qui filtre elle-même, et une seule par page. Une sous-page qui a la sienne prend la barre tant qu’elle est ouverte.
- Elle filtre ce qui est chargé. Pour chercher dans toute une table (milliers de lignes, texte long), passe `recherche.query` à `search.query` (section 12) dans un `useAsync`.
- Réservée à une page : dans un panneau de droite, `useTopBarSearch` est refusé (erreur de la page) ; un panneau garde un `SearchField` ou `Page search`.
- Jamais de `SearchField` en tête d’une page ni de barre de filtres à part pour chercher : un `SearchField` ne sert que dans un bloc, pour une liste secondaire.

### Notifications et compteur : `shell.notify`, `badge`

```ts
shell.notify(options: { title: string; description?: string; tone?: "info" | "success" | "warning" | "error" }): Promise<void>;
badge.set(count: number, options?: { page?: string }): Promise<{ count: number }>;      // 0 efface la pastille
badge.increment(by?: number, options?: { page?: string }): Promise<{ count: number }>; // 1 par défaut, négatif pour retirer
badge.clear(options?: { page?: string }): Promise<{ count: number }>;                  // remise à zéro
```

`shell.notify` affiche toujours la notification dans Alfred : une surimpression en bas à droite, puis le centre de notifications (la cloche). Quand aucune fenêtre d’Alfred n’est au premier plan, elle part aussi au centre de notifications du système (titre et description, sans `tone`), si l’utilisateur l’a permis au système. Si l’utilisateur l’a choisi (Réglages › Voix), le titre et la description sont aussi lus à voix haute : écris-les comme une phrase courte qui se comprend à l’oral. Notifie ce qui demande son attention (un message reçu, une tâche planifiée terminée ou en échec) ; jamais pour confirmer une action qu’il vient de faire à l’écran (le changement visible suffit), jamais en boucle.

`badge` règle le compteur de la page : une pastille avec ce nombre apparaît sur l’entrée de sa section dans le menu de gauche (la somme des onglets de la section) et sur son onglet, tant qu’il est supérieur à zéro. Le compteur dit combien d’éléments attendent l’utilisateur : messages non lus, demandes à traiter. Il est conservé d’un lancement à l’autre, et Alfred ne le remet jamais à zéro de lui-même : c’est la page qui le fait, quand l’utilisateur a vu ou traité les éléments.

- Sans `page`, le compteur est celui de la page qui appelle ; un panneau règle celui de sa page.
- `page` nomme une autre page du même module (« boite », ou « boite@instance ») ; jamais celle d’un autre module. Dans une section par instance, une page sans instance nommée est celle de la même instance.
- Une fonction (planifiée, webhook) nomme toujours la page : c’est ainsi qu’un relevé fait en arrière-plan prévient l’utilisateur alors que la page est fermée.
- Pour un nombre que la page sait recompter, préfère `badge.set` (le total exact) à `badge.increment`.

```ts
// functions/relever.ts : planifiée toutes les 10 minutes.
import { badge, client, db, shell } from "@alfred/sdk";

export default async function () {
  const { body } = await client("messagerie").get<{ id: string; sujet: string }[]>("/messages", { nonLus: true });
  const connus = await db.query<{ id: string }>("SELECT id FROM courrier_messages");
  const nouveaux = body.filter((message) => !connus.some((ligne) => ligne.id === message.id));
  for (const message of nouveaux)
    await db.execute("INSERT INTO courrier_messages (id, sujet, lu) VALUES (?, ?, 0)", [message.id, message.sujet]);
  const [{ total }] = await db.query<{ total: number }>("SELECT COUNT(*) AS total FROM courrier_messages WHERE lu = 0");
  await badge.set(total, { page: "boite" });
  if (nouveaux.length > 0)
    await shell.notify({ title: `${nouveaux.length} nouveau${nouveaux.length > 1 ? "x" : ""} message${nouveaux.length > 1 ? "s" : ""}`, description: nouveaux[0].sujet });
  return { nouveaux: nouveaux.length };
}
```

```tsx
// pages/boite.tsx : ouvrir un message le marque lu et recompte.
import { badge, db } from "@alfred/sdk";

export async function marquerLu(id: string) {
  await db.execute("UPDATE courrier_messages SET lu = 1 WHERE id = ?", [id]);
  const [{ total }] = await db.query<{ total: number }>("SELECT COUNT(*) AS total FROM courrier_messages WHERE lu = 0");
  await badge.set(total);
}
```

## 9. Fichiers : `files`

```ts
interface FileInfo { id: string; name: string; mime: string; size: number; sha256: string; createdAt: string }
files.save(options: { name: string; data?: string; text?: string; mime?: string }): Promise<FileInfo>; // data : base64
files.list(options?: { prefix?: string; limit?: number }): Promise<FileInfo[]>; // plus récent d’abord, 500 par défaut
files.get(id: string): Promise<FileInfo>;
files.read(id: string): Promise<{ info: FileInfo; data: string }>; // data : base64
files.readText(id: string): Promise<string>;
files.remove(id: string): Promise<void>;
files.dataUrl(id: string): Promise<string>;  // image de 5 Mo au plus, pour <Image src>
// Page ou panneau seulement (un geste de l’utilisateur) :
files.pick(options?: { accept?: string[]; multiple?: boolean }): Promise<FileInfo[]>; // accept : ["pdf", "png"] ; [] s’il annule
files.export(id: string): Promise<boolean>; // « Enregistrer sous… » ; false s’il annule
files.open(id: string): Promise<void>;      // application du système
```

Alfred range les fichiers du module hors de l’espace versionné (`.alfred/files/<module>/`), les copie avec les sauvegardes et les supprime avec le module. Chaque module ne voit que les siens. 50 Mo par fichier ; `mime` se déduit de l’extension du nom. Garde l’`id` dans une table du module pour relier le fichier à une ligne (une facture, un ticket). `files.open` montre dans le Finder, au lieu de l’ouvrir, un fichier qui s’exécuterait (script, application).

Pour afficher un fichier du module dans une page (PDF, image, texte, Markdown), `<DocumentViewer file={fichier.id} label="…" />` de `@alfred/ui` le lit et l’affiche, avec page, zoom et ouverture dans l’application du système (DESIGN.md, section 5).

```tsx
import { db, files, shell } from "@alfred/sdk";

export async function joindreFacture(ticket: number) {
  const [fichier] = await files.pick({ accept: ["pdf"] });
  if (!fichier) return;
  await db.execute("INSERT INTO support_pieces (ticket, fichier, nom) VALUES (?, ?, ?)", [ticket, fichier.id, fichier.name]);
  void shell.notify({ title: "Facture jointe", description: fichier.name, tone: "success" });
}
```

## 10. Documents : `documents`

```ts
type CellValue = string | number | boolean | null;
type DocumentBlock =
  | { type: "heading"; text: string; level?: 1 | 2 | 3 }
  | { type: "paragraph"; text: string }           // "\n" force un retour à la ligne
  | { type: "list"; items: string[]; ordered?: boolean }
  | { type: "table"; columns: string[]; rows: CellValue[][]; widths?: number[] } // widths : relatives
  | { type: "pageBreak" };
documents.pdf(options: { name: string; title?: string; blocks: DocumentBlock[] }): Promise<FileInfo>;
documents.csv(options: { name: string; columns?: string[]; rows: CellValue[][]; separator?: string }): Promise<FileInfo>;
documents.xlsx(options: { name: string; sheets: { name?: string; columns?: string[]; rows: CellValue[][] }[] }): Promise<FileInfo>;
documents.extractText(id: string): Promise<{ text: string; pages: number | null; truncated: boolean }>;
```

- Chaque document produit devient un fichier du module (section 9) : propose ensuite `files.open(id)` ou `files.export(id)` à l’utilisateur. L’extension est ajoutée au nom si elle manque.
- PDF : A4, police Helvetica, pages numérotées dès la deuxième, en-tête d’un tableau répété sur chaque page. Pas d’image ni de couleur. Les caractères hors de l’alphabet latin (emoji, idéogrammes) deviennent « ? ». Formate toi-même les nombres et les dates (`toLocaleString("fr-FR")`) : une cellule s’imprime telle qu’elle est donnée.
- CSV : UTF-8 avec BOM, `;` par défaut (Excel en français) ; `separator: ","` pour un autre outil.
- Excel : un nombre ou un booléen reste une valeur de cellule, le reste est du texte ; en-têtes en gras et figés, colonnes ajustées.
- `extractText` lit un PDF (pages séparées par `\f`, `pages` leur nombre ; un PDF scanné, fait d’images, rend un texte vide), un Word `.docx` (pas l’ancien `.doc`) ou un fichier texte. Au-delà de 2 millions de caractères, le texte est coupé (`truncated`). Pour un résumé ou une extraction de champs, passe ce texte à `ai.oneShot`.

```ts
import { db, documents, files } from "@alfred/sdk";

export async function exporterFactures() {
  const lignes = await db.query<{ client: string; montant: number }>("SELECT client, montant FROM compta_factures");
  const pdf = await documents.pdf({
    name: "Factures",
    title: "Factures de novembre",
    blocks: [
      { type: "paragraph", text: `${lignes.length} factures.` },
      {
        type: "table",
        columns: ["Client", "Montant"],
        rows: lignes.map((l) => [l.client, l.montant.toLocaleString("fr-FR", { style: "currency", currency: "EUR" })]),
        widths: [3, 1],
      },
    ],
  });
  await files.export(pdf.id);
}
```

## 11. Tâches de fond : `jobs`

Pour un travail plus long que les 120 secondes d’une fonction (importer des milliers de lignes, relever tout un service page par page), découpe-le en **étapes** : Alfred rappelle la fonction du module tant qu’elle ne rend pas `done: true`, en lui passant l’état que l’étape précédente a rendu. L’état est gardé : si Alfred se ferme, la tâche reprend à la même étape à la réouverture. L’utilisateur la suit, l’annule ou la reprend dans la fiche du module (Réglages → Modules), et il est notifié quand elle se termine ou échoue.

```ts
jobs.start(fonction: string, input?: unknown, options?: { title?: string }): Promise<Job>; // fonction du module
jobs.get(id: string): Promise<Job>;
jobs.list(options?: { status?: JobStatus; limit?: number }): Promise<Job[]>; // tâches du module, plus récentes d’abord
jobs.cancel(id: string): Promise<Job>;  // tout de suite si elle attend, après l’étape en cours sinon
jobs.resume(id: string): Promise<Job>;  // une tâche en échec ou annulée repart de son étape
type JobStatus = "queued" | "running" | "done" | "failed" | "cancelled";
interface Job { id; title; status: JobStatus; step: number; progress: number | null; message: string | null; result: unknown; error: string | null; createdAt; finishedAt; … }

// Chaque étape, la fonction reçoit :
interface JobStep<Input, State> { input: Input; state: State | null; step: number; job: { id: string; title: string } }
// et rend :
{ state?: unknown; progress?: number /* 0 à 1 */; message?: string; done?: boolean; result?: unknown }
```

- Une étape qui rend un `state` (sans `done: true`) ou `done: false` est suivie d’une autre ; sinon la tâche est terminée, avec `result` (ou la sortie entière si la fonction ne rend aucun de ces champs).
- Une étape tient en moins de 120 secondes : traite un lot (une page d’API, 500 lignes) et rends où tu en es. Une étape qui échoue est retentée deux fois ; au troisième échec, la tâche passe en échec avec le message de l’erreur.
- Une seule tâche avance à la fois par module (trois en tout) ; les autres attendent. Une étape doit pouvoir être rejouée sans dégât (après une fermeture d’Alfred, la dernière peut repasser) : écris avec `INSERT OR REPLACE` ou vérifie avant d’insérer.
- La fonction se déclare comme toute autre (`declare_function`) ; elle peut être en script. `read_journal` (`kind: "job"`) montre les fins et les échecs.

```ts
// functions/importer-contacts.ts
import { client, db, type JobStep } from "@alfred/sdk";

export default async function ({ state }: JobStep<{}, { page: number }>) {
  const page = state?.page ?? 1;
  const { body } = await client("crm").get<{ contacts: { id: string; nom: string }[]; pages: number }>("/contacts", { page });
  for (const contact of body.contacts)
    await db.execute("INSERT OR REPLACE INTO annuaire_contacts (id, nom) VALUES (?, ?)", [contact.id, contact.nom]);
  if (page >= body.pages) return { done: true, result: { pages: body.pages } };
  return { state: { page: page + 1 }, progress: page / body.pages, message: `Page ${page} sur ${body.pages}` };
}
```

```tsx
// Dans une page : lancer, puis suivre (rien ne se recharge seul : relis avec `reload()`, par exemple chaque seconde).
const tache = await jobs.start("importer-contacts", {}, { title: "Import des contacts du CRM" });
const suivi = useAsync(() => jobs.get(tache.id), [tache.id]);
useEffect(() => {
  const minuterie = setInterval(suivi.reload, 1000);
  return () => clearInterval(minuterie);
}, [suivi.reload]);
```

## 12. Recherche plein texte : `search`

Déclare l’index dans `module.json`, sur une table du module : Alfred crée l’index, le tient à jour à chaque écriture (pages, fonctions, migrations) et le reconstruit quand la déclaration ou la table change. Pas de table FTS ni de déclencheur à écrire dans une migration.

```json
"search": [{ "id": "notes", "table": "carnet_notes", "key": "id", "columns": ["titre", "texte"] }]
```

```ts
search.query(index: string, text: string, options?: { limit?: number; offset?: number; prefix?: boolean; raw?: boolean }):
  Promise<{ total: number; results: { key: string | number; score: number; snippet: string; parts: { text: string; match: boolean }[] }[] }>;
```

- `key` (`id` par défaut) : colonne rendue avec chaque résultat, pour relire la ligne avec `db.query`. `columns` : colonnes de texte cherchées. La table ne doit pas être `WITHOUT ROWID`.
- Sans accents ni casse (« ete » trouve « Été ») ; chaque mot doit apparaître, dans n’importe quel ordre, et peut n’être qu’un début de mot (« budg ete » trouve « budget de l’été » ; `prefix: false` pour exiger des mots entiers). La ponctuation saisie est ignorée.
- `raw: true` : le texte est une requête FTS5 (`"expression exacte"`, `OR`, `NOT`, `NEAR(a b)`, `titre: mot`) ; une erreur de syntaxe rejette la promesse (« Recherche mal formée… »).
- Résultats du plus pertinent au moins pertinent (`score`, plus grand = meilleur), `total` pour paginer avec `offset`. `parts` découpe l’extrait pour mettre les mots trouvés en gras.
- Une déclaration fausse (table ou colonne absente) apparaît dans `check` (`migrations`, fichier « module.json (search …) »).

```tsx
import { db, search, useAsync } from "@alfred/sdk";
import { SearchField, Stack, Text } from "@alfred/ui";
import { useState } from "react";

export function Recherche() {
  const [texte, setTexte] = useState("");
  const trouves = useAsync(() => search.query<number>("notes", texte, { limit: 20 }), [texte]);
  return (
    <Stack gap="sm">
      <SearchField label="Chercher dans les notes" value={texte} onChange={(event) => setTexte(event.target.value)} />
      {trouves.data?.results.map((resultat) => (
        <Text key={resultat.key}>
          {resultat.parts.map((part, i) => (part.match ? <strong key={i}>{part.text}</strong> : part.text))}
        </Text>
      ))}
    </Stack>
  );
}
```

## 13. Événements entre modules : `events`

Un module signale ce qui lui arrive (« un ticket est créé ») ; d’autres modules y réagissent avec une de leurs fonctions. Celui qui publie ne connaît pas ses abonnés : préfère un événement à l’appel direct de la fonction d’un autre module dès que plusieurs modules peuvent être intéressés, ou que le module qui publie ne doit pas dépendre d’eux.

```json
// modules/support/module.json
"events": { "publishes": [{ "id": "ticket-cree", "description": "Un ticket vient d’être créé.",
  "schema": { "type": "object", "properties": { "id": { "type": "integer" }, "titre": { "type": "string" } } } }] }

// modules/taches/module.json
"requires": [{ "module": "support" }],
"events": { "subscribes": [{ "event": "support/ticket-cree", "function": "creer-tache" }] }
```

```ts
events.publish(event: string, payload?: unknown): Promise<{ event: string; subscribers: number }>;
// La fonction abonnée reçoit :
interface ModuleEvent<Payload> { event: string; from: string; payload: Payload; publishedAt: string }
```

- `publish` n’accepte que les événements déclarés dans `events.publishes` du module ; `id` en minuscules et tirets ; `schema` (facultatif) décrit le contenu pour les abonnés. Le contenu fait 256 Ko au plus : envoie un identifiant et l’essentiel, pas un fichier.
- `subscribes[].event` : « module/événement » (« événement » seul pour un événement du module lui-même) ; `function` : fonction du module abonné, sans préfixe.
- Livraison après coup, dans l’ordre de publication pour chaque abonné, même si Alfred a été fermé entre-temps ; `publish` n’attend pas les abonnés. Une fonction qui échoue est rappelée deux fois, puis la livraison reste en échec (journal, `kind: "event"`).
- Un module abonné à un module dont il ne dépend pas (`requires`) doit en avoir l’accord : l’utilisateur le donne à la première livraison, ou toi d’avance avec `grant_access` (`to` : « taches/* », `event` : « support/ticket-cree »).
- `check` signale (`events`) un abonnement à un événement que personne ne déclare et une fonction abonnée absente.

```ts
// modules/support : après l’insertion du ticket.
await events.publish("ticket-cree", { id: lastInsertId, titre });

// modules/taches/functions/creer-tache.ts
import { db, type ModuleEvent } from "@alfred/sdk";
export default async function ({ payload }: ModuleEvent<{ id: number; titre: string }>) {
  await db.execute("INSERT OR IGNORE INTO taches_taches (ticket, titre) VALUES (?, ?)", [payload.id, payload.titre]);
}
```

## 14. Historique des données : `history`

Pour une table dont l’utilisateur doit pouvoir savoir qui a changé quoi, et revenir en arrière (fiches clients, contrats, réglages partagés), nomme-la dans `history` du `module.json` : Alfred garde chaque insertion, modification et suppression, avec la ligne avant et après, l’auteur et l’heure.

```json
"history": ["crm_contacts", "crm_contrats"]
```

```ts
history.list(options?: { table?: string; key?: string | number; limit?: number }): Promise<Change[]>; // plus récents d’abord, 100 par défaut
history.revert(id: number): Promise<Change>;
interface Change { id: number; table: string; key: string | null; op: "insert" | "update" | "delete";
  before: Record<string, unknown> | null; after: Record<string, unknown> | null; actor: string; at: string }
```

- `key` : la clé primaire de la ligne (en texte : `key: 12` et `key: "12"` se valent), ou son `rowid` si la clé porte sur plusieurs colonnes.
- `actor` : `page:module/page` (le panneau compte pour sa page), `function:module/fonction`, `agent` (requête de l’agent), `alfred` (import, restauration), suivi de « (annulation) » pour une remise en arrière.
- `revert` remet **toute la ligne** dans son état d’avant ce changement : une insertion est retirée, une modification annulée, une suppression rétablie. La remise est un changement à son tour, qu’on peut annuler. Des modifications faites après celle qu’on annule sont écrasées : montre la ligne `before` et demande confirmation (`confirmAction` de `@alfred/ui`).
- Alfred garde 90 jours et 10 000 changements par table. Les colonnes ajoutées par une migration sont suivies dès qu’elle passe. Une table absente apparaît dans `check` (`migrations`, « module.json (history …) »).

```tsx
import { history, useAsync } from "@alfred/sdk";

export function useHistoriqueContact(id: number) {
  return useAsync(() => history.list<{ nom: string; email: string }>({ table: "crm_contacts", key: id, limit: 50 }), [id]);
}
```

## 15. Recherche par le sens : `semantic`

Pour retrouver des lignes par leur sens et non par leurs mots (« dépenses d’énergie » trouve « Facture EDF de mars »), déclare un index sémantique. Alfred calcule pour chaque ligne un vecteur avec un modèle de langue local (multilingual-e5-small, français compris) : rien ne quitte l’ordinateur. Le modèle (470 Mo) se télécharge une fois, quand l’utilisateur l’accepte dans Réglages → Général → Recherche par le sens.

```json
"semantic": [{ "id": "notes", "table": "carnet_notes", "key": "id", "columns": ["titre", "texte"] }]
```

```ts
semantic.search(index: string, text: string, options?: { limit?: number }): // 10 par défaut, 100 au plus
  Promise<{ pending: number; results: { key: string | number; score: number }[] }>;
semantic.status(index: string): Promise<{ indexed: number; pending: number; model: "ready" | "missing" | "downloading" }>;
```

- Même déclaration que `search` (section 12) : `key` (`id` par défaut) revient avec chaque résultat, `columns` sont réunies en un texte (4 000 caractères au plus par ligne). Chaque écriture met la ligne en file ; Alfred calcule les vecteurs en arrière-plan (quelques dizaines de lignes par seconde). `pending` dit combien attendent encore.
- `score` : similarité de -1 à 1, résultats du plus proche au moins proche. Il y a toujours des résultats, même lointains, et ce modèle donne des scores serrés (souvent entre 0,75 et 0,9) : montre les premiers, compare les scores entre eux plutôt qu’à un seuil fixe. Pour des mots précis (un nom, une référence), préfère `search.query` ; les deux se combinent.
- Sans modèle installé, `search` rejette la promesse (« La recherche par le sens n’est pas encore installée… ») : vérifie d’abord `semantic.status(index).model` et, s’il vaut `missing`, dis à l’utilisateur où l’installer au lieu d’afficher une erreur. Les lignes écrites avant restent en file et sont calculées dès l’installation.
- Recherche exhaustive sur les vecteurs du module : rapide jusqu’à quelques dizaines de milliers de lignes par index.

```tsx
import { db, semantic, useAsync } from "@alfred/sdk";

export function useNotesProches(question: string) {
  return useAsync(async () => {
    if (!question.trim()) return [];
    const { results } = await semantic.search<number>("notes", question, { limit: 5 });
    if (results.length === 0) return [];
    const ids = results.map((resultat) => resultat.key);
    const lignes = await db.query<{ id: number; titre: string }>(
      `SELECT id, titre FROM carnet_notes WHERE id IN (${ids.map(() => "?").join(", ")})`,
      ids,
    );
    return results.map((resultat) => ({ ...lignes.find((ligne) => ligne.id === resultat.key), score: resultat.score }));
  }, [question]);
}
```

## 16. Commandes du poste : `commands`

Une page ou une fonction TypeScript lance un programme installé sur l’ordinateur et lit sa sortie : convertir une vidéo (`ffmpeg`), un document (`pandoc`), lire l’état d’un dépôt (`git`).

```ts
commands.run(program: string, args?: string[], options?: { input?: string; timeout?: number }):
  Promise<{ code: number | null; ok: boolean; stdout: string; stderr: string; truncated: boolean }>;
```

- `program` : le nom seul (« git », « ffmpeg »), cherché dans le PATH ; ni chemin, ni ligne de shell. `args` passent tels quels, sans shell : ni `|`, ni `>`, ni `$VAR`, ni jokers (`*.pdf`). Pour un enchaînement, écris une fonction en script (section 2).
- Lancé dans le dossier du module, avec l’environnement réduit des scripts ; `input` arrive sur stdin. `timeout` en secondes (60 par défaut, 120 au plus), après quoi le programme et ce qu’il a lancé sont arrêtés et la promesse rejetée.
- **Un code de sortie non nul ne rejette pas la promesse** : teste `ok`, `code` et lis `stderr`. Le rejet signifie que le programme n’a pas pu tourner : nom invalide, introuvable, accès refusé, délai dépassé. stdout est coupé au-delà de 1 Mo (`truncated`).
- La première fois, l’utilisateur accorde le programme à la page (ou aux fonctions du module) : la question montre son chemin. Accorde-le d’avance avec `grant_access` (`command` : « ffmpeg ») pour ce que tu construis. Les fichiers du module (section 9) sont hors du dossier du module : pour qu’un programme les traite, passe par une fonction en script et le pont du SDK.
- Chaque lancement va au journal (`kind: "command"`).

```ts
import { commands } from "@alfred/sdk";

export async function versionDePandoc() {
  const resultat = await commands.run("pandoc", ["--version"]);
  if (!resultat.ok) throw new Error(resultat.stderr || `pandoc a rendu le code ${resultat.code}.`);
  return resultat.stdout.split("\n")[0];
}
```

## 17. Données partagées en équipe : `sync`

Pour que les membres d’une équipe travaillent sur les mêmes lignes, chacun chez soi (un carnet de contacts, un suivi de commandes), nomme les tables à partager dans `module.json` :

```json
"sync": { "tables": ["carnet_contacts", "carnet_notes"] }
```

```sql
CREATE TABLE carnet_contacts (
  id TEXT PRIMARY KEY,          -- crypto.randomUUID() à l’insertion
  nom TEXT NOT NULL,
  email TEXT,
  modifie_le TEXT NOT NULL DEFAULT (datetime('now'))
);
```

```ts
import { db } from "@alfred/sdk";

await db.execute("INSERT INTO carnet_contacts (id, nom, email) VALUES (?1, ?2, ?3)", [crypto.randomUUID(), nom, email]);
```

- Chaque table partagée a une clé primaire sur une seule colonne, en **texte généré** : avec un entier auto-incrémenté, deux membres créeraient la même ligne. `check` signale une table absente ou une clé entière (`structure`).
- L’utilisateur relie le module au dépôt git de l’équipe (une adresse, la même pour tous) dans la fiche du module : Réglages → Modules → Partage en équipe. Alfred s’y connecte avec les accès git du poste, y range une ligne par fichier et synchronise toutes les deux minutes tant qu’il est ouvert, et à la demande.
- Ce qui change ici part dans le dépôt ; ce qui change dans le dépôt arrive dans la base, comme une écriture (déclencheurs de recherche et d’historique compris, auteur `partage`). Une même ligne modifiée des deux côtés : la version de l’équipe l’emporte, la version locale est notée au journal (`kind: "sync"`).
- Une page qui charge ses données avec un gabarit ou `useAsync` se recharge d’elle-même quand des données arrivent de l’équipe. Rien d’autre à écrire : pas d’appel de synchronisation dans la page.
- Ne partage que les données de l’équipe : un réglage personnel ou un brouillon reste dans une table non partagée.
