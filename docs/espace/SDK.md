# Référence du pont `@alfred/sdk`

Une page, un panneau ou une fonction n’a ni réseau ni disque. Tout ce qui sort du cadre passe par `@alfred/sdk` : la base du module, les clients, les fonctions, l’IA et la coquille. L’apparence relève de `DESIGN.md`, la marche à suivre de `AGENTS.md`.

Chaque appel est asynchrone. Un échec rejette la promesse avec une `AlfredSdkError` (`message` en français, `detail` facultatif) : montre `error.message` à l’utilisateur.

## 1. Le cadre isolé

| À ne pas faire | Pourquoi | À la place |
|---|---|---|
| `fetch`, `XMLHttpRequest`, `WebSocket` | aucune connexion sortante | `client(id)` |
| `localStorage`, `sessionStorage`, `indexedDB` | le cadre n’a pas d’origine : l’accès lève une erreur | une table du module |
| `<a href>`, `window.open`, `location` | ni navigation ni fenêtre | `shell.navigate`, `shell.openExternal` |
| `alert`, `confirm`, `prompt` | bloqués | Une `Action` avec `danger` et `confirm`, `confirmAction` (une confirmation), `openForm` (une saisie) de `@alfred/ui` |
| `<img src="https://…">` | images extérieures bloquées | un lien `shell.openExternal` |
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

Une fonction utilise le même pont qu’une page (`db`, `client`, `functions`, `ai`, `voice.speak`, `shell.notify`, `badge`), sans les hooks React ni le micro. Elle répond en moins de 120 secondes, ne tourne que pendant qu’Alfred est ouvert, et au-delà de 40 appels simultanés les suivants sont refusés.

### Fonction en script (bash, PowerShell, Python)

Déclarée avec `runtime` (`bash`, `pwsh` ou `python`), la fonction est un fichier `functions/<id>.sh`, `.ps1` ou `.py` qu’Alfred lance comme un processus, avec les droits de l’utilisateur. Elle s’appelle exactement comme une autre (`functions.call`, outil d’agent, webhook, planification) et garde ses schémas `input` et `output`.

- **Entrée** : le JSON de l’entrée sur stdin.
- **Sortie** : stdout. S’il contient du JSON, c’est la valeur rendue ; sinon, le texte sans ses blancs finaux ; vide, `null`. Au plus 1 Mo.
- **Erreur** : un code de sortie non nul. Le message est la fin de stderr (ou le code de sortie) ; stderr entier va au journal.
- **Cadre** : dossier courant = dossier du module ; environnement réduit (PATH, dossier de l’utilisateur, langue) plus `ALFRED_MODULE`, `ALFRED_FUNCTION`, `ALFRED_CALLER` et `ALFRED_SPACE`. Pas de `@alfred/sdk` : ni base, ni client, ni secret. 120 secondes au plus, après quoi le script et tout ce qu’il a lancé sont arrêtés ; 40 appels simultanés au plus.
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
