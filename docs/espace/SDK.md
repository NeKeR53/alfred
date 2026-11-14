# Référence du pont `@alfred/sdk`

Une page, un panneau ou une fonction n’a ni réseau ni disque. Tout ce qui sort du cadre passe par `@alfred/sdk` : la base du module, les clients, les fonctions, l’IA et la coquille. L’apparence relève de `DESIGN.md`, la marche à suivre de `AGENTS.md`.

Chaque appel est asynchrone. Un échec rejette la promesse avec une `AlfredSdkError` (`message` en français, `detail` facultatif) : montre `error.message` à l’utilisateur.

## 1. Le cadre isolé

| À ne pas faire | Pourquoi | À la place |
|---|---|---|
| `fetch`, `XMLHttpRequest`, `WebSocket` | aucune connexion sortante | `client(id)` |
| `localStorage`, `sessionStorage`, `indexedDB` | le cadre n’a pas d’origine : l’accès lève une erreur | une table du module |
| `<a href>`, `window.open`, `location` | ni navigation ni fenêtre | `shell.navigate`, `shell.openExternal` |
| `alert`, `confirm`, `prompt` | bloqués | `useConfirm`, `Dialog` de `@alfred/ui` |
| `<img src="https://…">` | images extérieures bloquées | un lien `shell.openExternal` |
| un paquet npm, un `.css`, un `.json` | imports limités (AGENTS.md, règle 3) | du code dans `lib/` du module |

Le cadre d’une page est recréé quand l’utilisateur change d’onglet et chaque fois que l’espace change : un état React ne dure pas. Ce qui doit durer va en base.

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

Une fonction utilise le même pont qu’une page (`db`, `client`, `functions`, `ai`, `shell.notify`), sans les hooks React. Elle répond en moins de 120 secondes, ne tourne que pendant qu’Alfred est ouvert, et au-delà de 40 appels simultanés les suivants sont refusés.

## 3. Charger des données : `useAsync`

```ts
function useAsync<Data>(load: () => Promise<Data>, deps: ReadonlyArray<unknown>): {
  data: Data | undefined;
  error: Error | undefined;
  loading: boolean;
  reload: () => void;
};
```

`load` s’exécute au montage, à chaque changement de `deps` et à chaque `reload()`. `data` reste `undefined` jusqu’au premier succès, puis garde sa valeur pendant un rechargement. Trois états à couvrir : erreur, premier chargement, données (liste vide comprise). Après une écriture, appelle `reload()` : rien ne se recharge seul.

```tsx
import { db, shell, useAsync } from "@alfred/sdk";
import { Button, EmptyState, FeedbackBanner, LoadingSkeleton, Page, Stack, Text } from "@alfred/ui";

export default function NotesPage() {
  const notes = useAsync(
    () => db.query<{ id: number; texte: string }>("SELECT id, texte FROM carnet_notes ORDER BY id DESC LIMIT 200"),
    [],
  );

  const ajouter = async () => {
    try {
      await db.execute("INSERT INTO carnet_notes (texte) VALUES (?)", ["Nouvelle note"]);
      notes.reload();
    } catch (error) {
      void shell.notify({
        title: "La note n’a pas été ajoutée",
        description: error instanceof Error ? error.message : undefined,
        tone: "error",
      });
    }
  };
  const nouvelle = (
    <Button variant="primary" onClick={ajouter}>
      Nouvelle note
    </Button>
  );

  if (notes.error) {
    return (
      <Page>
        <FeedbackBanner tone="error" appearance="contained" action={<Button onClick={notes.reload}>Réessayer</Button>}>
          Les notes n’ont pas pu être chargées : {notes.error.message}
        </FeedbackBanner>
      </Page>
    );
  }
  if (notes.data === undefined) {
    return (
      <Page>
        <LoadingSkeleton rows={4} label="Chargement des notes…" />
      </Page>
    );
  }
  if (notes.data.length === 0) {
    return (
      <Page>
        <EmptyState title="Aucune note" description="Les notes ajoutées ici restent dans l’espace.">
          {nouvelle}
        </EmptyState>
      </Page>
    );
  }
  return (
    <Page>
      {nouvelle}
      <Stack gap="sm">
        {notes.data.map((note) => (
          <Text key={note.id}>{note.texte}</Text>
        ))}
      </Stack>
    </Page>
  );
}
```

Liste complète (barre d’outils, tableau, recherche) : DESIGN.md, section 12.1.

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

Appelée par un webhook, une fonction reçoit `{ method, query, headers, body }` (corps JSON décodé, sinon texte ; en-têtes d’authentification retirés). Sa valeur de retour part en JSON à l’émetteur si elle arrive en moins de 25 secondes ; sinon l’émetteur reçoit `202` et la fonction continue. Planifiée, elle reçoit le `input` de sa planification. Webhooks et planifications se déclarent avec les outils `declare_webhook` et `declare_schedule` (AGENTS.md).

## 6. Clients : `client(id)`

```ts
client(id: string, options?: { instance?: string }): {
  request<Body>(options: ClientRequest): Promise<ClientResponse<Body>>;
  get<Body>(path: string, query?: Record<string, string | number | boolean>): Promise<ClientResponse<Body>>;
  post<Body>(path: string, body?: unknown): Promise<ClientResponse<Body>>;
  put<Body>(path: string, body?: unknown): Promise<ClientResponse<Body>>;
  patch<Body>(path: string, body?: unknown): Promise<ClientResponse<Body>>;
  delete<Body>(path: string): Promise<ClientResponse<Body>>;
  instances(): Promise<{ id: string; label: string; default: boolean }[]>;
};
interface ClientRequest {
  method?: "GET" | "POST" | "PUT" | "PATCH" | "DELETE" | "HEAD";
  path: string;
  query?: Record<string, string | number | boolean>;
  headers?: Record<string, string>;
  body?: unknown;
}
interface ClientResponse<Body> { status: number; ok: boolean; headers: Record<string, string>; body: Body }
```

Alfred exécute la requête et ajoute l’authentification : la page ne voit jamais le secret. `path` commence par `/` et reste sous l’adresse de base (ni adresse complète, ni `//`, `..` ou `@`). Un `body` objet part en JSON, une chaîne telle quelle. `Authorization`, `Cookie`, `Host`, `Range`, `If-Range` et l’en-tête de la clé sont fixés par Alfred. `body` est décodé si la réponse est du JSON, sinon c’est le texte ; 20 Mo et 60 secondes au plus.

**Un statut HTTP d’erreur ne rejette pas la promesse** : teste `ok` ou `status`. Le rejet signifie que la requête n’a pas abouti : client inconnu ou à valider, secret manquant, accès refusé, chemin refusé, erreur réseau. La première requête d’une page vers un client (et, séparément, de son panneau, ou des fonctions d’un module) demande l’accord de l’utilisateur.

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

Pour un service à plusieurs instances, `methods` remplace `auth` : la liste des façons de s’authentifier, et `instances` les comptes (adresse libre, méthode, entrée du coffre). `declare_client` crée ou met à jour les instances qu’il reçoit et garde les autres ; l’utilisateur peut aussi en ajouter dans Réglages, onglet Clients.

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

Lance une vraie conversation, affichée dans le panneau de droite de la page (lancée par une fonction, elle n’apparaît que dans la page Agent) ; l’utilisateur la suit et peut répondre. La première fois, l’utilisateur accorde à la page (ou aux fonctions du module) le droit de lancer un agent ; un refus rejette la promesse. L’agent est en autonomie stricte (chaque action lui est demandée à l’utilisateur) et n’agit que sur le module : `check`, `db_schema`, `db_query` et `call_function` sur ce module, rien qui change la structure de l’espace. Les `functions` (`"fonction"` ou `"module/fonction"`) deviennent des outils de cet agent ; celle d’un autre module demande l’accord de l’utilisateur, comme `functions.call`. La promesse se résout à la fin du premier tour avec le dernier message ; avec `resultSchema`, l’agent finit par un bloc JSON validé, rendu dans `result` (sinon rejet). Pour une simple réponse structurée, préfère `ai.oneShot`.

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

## 8. Coquille : `shell`, `usePageContext`, `usePeerMessage`

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
  theme: "light" | "dark"; // appliqué par Alfred, rien à faire
  selection: unknown; // panneau : dernière valeur publiée par sa page ; sinon null
  instance: string | null; // section par instance : l’instance du client que montre la page ; sinon null
}
```

Page et panneau : la page publie l’identifiant de la ligne choisie (pas l’objet) et ouvre son panneau ; le panneau lit la sélection et charge lui-même le détail. Pour qu’une écriture faite dans le panneau rafraîchisse la page, le panneau envoie un message que la page écoute. Un lien vers le web est un `Button` qui appelle `shell.openExternal(url)`. La première ouverture vers un hôte demande l’accord de l’utilisateur (mémorisé pour la page) ; l’adresse fait au plus 2 048 caractères et ne contient pas d’identifiants. Ouvre un lien sur un clic, jamais au chargement.

```tsx
import { db, shell, useAsync, usePageContext, usePeerMessage } from "@alfred/sdk";
import { Button, Page, Text } from "@alfred/ui";

// Côté page.
export function useNotesEtPanneau() {
  const notes = useAsync(() => db.query<{ id: number; texte: string }>("SELECT id, texte FROM carnet_notes"), []);
  usePeerMessage((message) => {
    if ((message as { type?: string } | null)?.type === "note-modifiee") notes.reload();
  });
  const ouvrir = (id: number) => {
    void shell.publish({ id });
    void shell.setPanelVisible(true);
  };
  return { notes, ouvrir };
}

// Côté panneau.
export default function NotePanneau() {
  const id = (usePageContext()?.selection as { id?: number } | null | undefined)?.id ?? null;
  const archiver = async () => {
    if (id === null) return;
    await db.execute("UPDATE carnet_notes SET texte = '[archivée] ' || texte WHERE id = ?", [id]);
    await shell.send({ type: "note-modifiee", id });
  };
  return (
    <Page>
      <Text>{id === null ? "Aucune note sélectionnée." : `Note n° ${id}`}</Text>
      <Button onClick={archiver} disabled={id === null}>
        Archiver
      </Button>
    </Page>
  );
}
```

Le panneau complet (aucune sélection, chargement, erreur, objet introuvable) est dans DESIGN.md, section 12.2.
