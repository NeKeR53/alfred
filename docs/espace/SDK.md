# Référence du pont `@alfred/sdk`

Une page, un panneau ou une fonction n’a ni réseau ni disque. Tout ce qui sort du cadre passe par `@alfred/sdk` : la base du module, ses fichiers, les clients, les fonctions, l’IA et la coquille. L’apparence relève de `DESIGN.md`, la marche à suivre de `AGENTS.md`.

Chaque appel est asynchrone. Un échec rejette la promesse avec une `AlfredSdkError` (`message` en français, `detail` facultatif) : montre `error.message` à l’utilisateur.

## 1. Le cadre isolé

| À ne pas faire | Pourquoi | À la place |
|---|---|---|
| `fetch`, `XMLHttpRequest`, `WebSocket` | aucune connexion sortante | `client(id)` |
| `localStorage`, `sessionStorage`, `indexedDB` | le cadre n’a pas d’origine : l’accès lève une erreur | une table du module |
| `<a href>`, `window.open`, `location` | ni navigation ni fenêtre | `shell.navigate`, `shell.openExternal` |
| `alert`, `confirm`, `prompt` | bloqués | Une `Action` avec `danger` et `confirm`, `confirmAction` (une confirmation), `openForm` (une saisie) de `@alfred/ui` |
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
- **Pont du SDK** : `POST $ALFRED_SDK_URL/<méthode>` avec l’en-tête `Authorization: Bearer $ALFRED_SDK_TOKEN` et les paramètres en JSON (ceux de la méthode TypeScript, nommés : `{"sql": …, "params": […]}`). Réponse `{"ok": valeur}` (statut 200) ou `{"error": {"message": …}}` (400). Méthodes : `db.query`, `db.execute`, `files.save`, `files.list`, `files.get`, `files.read`, `files.readText`, `files.remove`, `documents.pdf`, `documents.csv`, `documents.xlsx`, `documents.extractText`, `search.query`, `semantic.search`, `semantic.status`, `history.list`, `history.revert`, `events.publish`, `jobs.start`, `jobs.get`, `jobs.list`, `jobs.cancel`, `jobs.resume`, `clients.request` (`client`, `path`…), `clients.instances`, `clients.clearCache`, `functions.call` (`function`, `input`). Mêmes règles que pour une fonction TypeScript du module (ses tables, ses fichiers, accords). Le jeton ne vaut que pendant cet appel du script.
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

Une page ou une fonction qui a besoin d’un service externe appelle les fonctions du **connecteur** de ce service (le module qui détient son client, déclaré dans `requires`), jamais `client()` directement. Le connecteur renvoie des données déjà mises en forme (`{ tickets: [{ cle, titre, statut }] }`), décrites par son schéma `output` : la page n’a pas à connaître l’API.

```tsx
import { functions, useAsync } from "@alfred/sdk";

// Module « sprint », avec `"requires": [{ "module": "jira" }]`.
const tickets = useAsync(
  () => functions.call<{ tickets: Array<{ cle: string; titre: string }> }>("jira/lister-tickets", { projet: "ALF" }),
  [],
);
```

Seules les fonctions du connecteur écrivent `client("jira")`. Une opération qui manque (commenter, changer d’état) s’ajoute au connecteur, avec `effect` et ses tests (AGENTS.md, « Tests d’une fonction »), puis la page l’appelle.

Appelée par un webhook, une fonction reçoit `{ method, query, headers, body }` (corps JSON décodé, sinon texte ; en-têtes d’authentification retirés). Sa valeur de retour part en JSON à l’émetteur si elle arrive en moins de 25 secondes ; sinon l’émetteur reçoit `202` et la fonction continue. Planifiée, elle reçoit le `input` de sa planification. Webhooks et planifications se déclarent avec les outils `declare_webhook` et `declare_schedule` (AGENTS.md).

## 6. Clients : `client(id)`

`client()` s’écrit dans les fonctions du module connecteur du service (voir § 5) ; les autres modules passent par ces fonctions.

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

Dans une section par instance (`perInstance` du module, AGENTS.md), chaque page connaît son instance (`usePageContext().instance`) et `client(id)` l’appelle d’office ; `client(id, { instance })` en vise une autre. Le même fichier de page sert à toutes les instances.

`client("crm/hubspot")` désigne le client du besoin `hubspot` déclaré par le module `crm`, dont ce module dépend (`requires`) : il suit la liaison choisie pour `crm`, sans besoin à déclarer ni accord à demander. Rejet si le module ne dépend pas de `crm`, ou si `crm` ne déclare pas ce besoin.

```tsx
import { client, useAsync } from "@alfred/sdk";

export function useTicketsOuverts(projet: string, instance?: string) {
  return useAsync(async () => {
    const reponse = await client("jira", { instance }).get<{ issues: { key: string }[] }>("/rest/api/3/search", {
      jql: `project = ${projet} AND statusCategory != Done`,
      maxResults: 50,
    });
    if (!reponse.ok) throw new Error(`Jira a répondu ${reponse.status}.`);
    return reponse.body.issues;
  }, [projet, instance]);
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

### `ai.oneShot` : une réponse structurée

```ts
ai.oneShot<Output>(options: { instruction: string; context?: unknown; schema: Record<string, unknown> }): Promise<Output>;
```

Un tour, sans outil, avec le modèle réglé par défaut ; `context` (objet ou texte, 120 000 caractères au plus) accompagne la consigne. Alfred valide la réponse contre `schema` et relance une fois avec les écarts ; si elle reste invalide, rejet (« La réponse du modèle ne respecte pas le schéma demandé. », écarts dans `detail`). L’appel prend plusieurs secondes : affiche un état en cours.

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

Lance une vraie conversation, affichée dans le panneau de droite de la page (lancée par une fonction, elle n’apparaît que dans la page Agent) ; l’utilisateur la suit et peut répondre. La première fois, l’utilisateur accorde à la page (ou aux fonctions du module) le droit de lancer un agent ; un refus rejette la promesse. L’agent est en autonomie stricte (chaque action lui est demandée à l’utilisateur) et n’agit que sur le module : `check`, `db_schema`, `db_query` et `call_function` sur ce module, rien qui change la structure de l’espace de travail. Les `functions` (`"fonction"` ou `"module/fonction"`) deviennent des outils de cet agent ; celle d’un autre module demande l’accord de l’utilisateur, comme `functions.call`. La promesse se résout à la fin du premier tour avec le dernier message ; avec `resultSchema`, l’agent finit par un bloc JSON validé, rendu dans `result` (sinon rejet). Pour une simple réponse structurée, préfère `ai.oneShot`.

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

## 8. Coquille : `shell`, `usePageContext`, `usePeerMessage`, `badge`

```ts
shell.notify(options: { title: string; description?: string; tone?: "info" | "success" | "warning" | "error" }): Promise<void>;
shell.navigate(reference: string): Promise<void>;       // ouvre la page « module/page » (« module/page@instance » dans une section par instance)
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
  instance: string | null; // section par instance : l’instance du client que montre la page ; sinon null
}
```

Page et panneau : `CollectionPage` avec `panel` publie `{ id }` de la ligne choisie et ouvre le panneau ; `DetailPanel` lit cette sélection, charge l’objet et, après une action, prévient la page, qui recharge sa liste (DESIGN.md, sections 4.1 et 4.2). Ces appels ne servent donc qu’à une page composée : `shell.publish({ id })` et `shell.setPanelVisible(true)` côté page, `usePageContext()?.selection` côté panneau, `shell.send(message)` et `usePeerMessage(handler)` pour se prévenir d’une écriture.

Un lien vers le web s’ouvre par `shell.openExternal(url)` (une `Action`, ou une valeur de type `url` ou `email`, qui le fait seule). La première ouverture vers un hôte demande l’accord de l’utilisateur (mémorisé pour la page) ; l’adresse fait au plus 2 048 caractères et ne contient pas d’identifiants. Ouvre un lien sur un clic, jamais au chargement.

### Notifications et compteur : `shell.notify`, `badge`

```ts
shell.notify(options: { title: string; description?: string; tone?: "info" | "success" | "warning" | "error" }): Promise<void>;
badge.set(count: number, options?: { page?: string }): Promise<{ count: number }>;      // 0 efface la pastille
badge.increment(by?: number, options?: { page?: string }): Promise<{ count: number }>; // 1 par défaut, négatif pour retirer
badge.clear(options?: { page?: string }): Promise<{ count: number }>;                  // remise à zéro
```

`shell.notify` affiche toujours la notification dans Alfred : une surimpression en bas à droite, puis le centre de notifications (la cloche). Quand aucune fenêtre d’Alfred n’est au premier plan, elle part aussi au centre de notifications du système (titre et description, sans `tone`), si l’utilisateur l’a permis au système. Si l’utilisateur l’a choisi (Réglages › Voix), le titre et la description sont aussi lus à voix haute : écris-les comme une phrase courte qui se comprend à l’oral. Notifie ce qui demande son attention (un message reçu, une tâche planifiée terminée ou en échec) ; jamais pour confirmer une action qu’il vient de faire à l’écran (un `FeedbackBanner` suffit), jamais en boucle.

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

Pour un travail plus long que les 120 secondes d’une fonction (importer des milliers de lignes, relever tout un service page par page), découpe-le en **étapes** : Alfred rappelle la fonction du module tant qu’elle ne rend pas `done: true`, en lui passant l’état que l’étape précédente a rendu. L’état est gardé : si Alfred se ferme, la tâche reprend à la même étape à la réouverture. L’utilisateur la suit, l’annule ou la reprend dans Réglages → Tâches de fond, et il est notifié quand elle se termine ou échoue.

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
