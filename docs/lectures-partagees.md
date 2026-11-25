# Lectures partagées entre les pages et les modules

Date : 2026-11-25. État : en place (code, tests, guide de l’agent). À relire par Alexandre.

## Le besoin

Deux modules montrent les mêmes données d’un service. Exemple : « mes tickets attribués » dans Jira, ou l’état
d’un CI dans Jenkins. Un seul module déclare le client. Quand une page lit la donnée, toutes les pages qui la
montrent se mettent à jour, sans nouvelle requête, que la donnée soit en cache ou non.

## Comment ça marche

1. Une page lit avec `useQuery("jira/lister-tickets", { jql })`.
2. La coquille d’Alfred tient un magasin en mémoire. La clé : la fonction, son entrée, les comptes, le mode exemple.
3. Si la donnée est dans le magasin, la page la reçoit tout de suite.
4. Sinon, Alfred appelle la fonction une seule fois, même si dix pages la demandent.
5. La réponse part à toutes les pages abonnées. Leurs contrôles se mettent à jour d’eux-mêmes.
6. Une écriture du même connecteur (« commenter un ticket ») rend la lecture caduque. Les pages abonnées la
   relisent, une seule fois pour toutes.

## Décisions

### D1. Le partage se fait au niveau des fonctions de lecture du connecteur, pas des requêtes HTTP

Une page n’appelle jamais un client (règle existante). Elle appelle une fonction du connecteur, qui appelle le
client. La donnée qu’une page montre est donc la sortie d’une fonction, déjà mise en forme. C’est elle qu’on partage.

- Les fonctions déclarent déjà `effect: "read"` ou `"write"`. Le magasin s’appuie sur cet effet.
- Partager au niveau HTTP n’aurait pas suffi : la page attend la sortie de la fonction, pas la réponse brute. Et deux
  pages qui lisent la même fonction font bien la même requête.
- Le cache HTTP existant (`client(...).get(path, query, { cache })`, `client_cache.rs`) reste inchangé. Il est
  durable, propre au module, et sert à ménager les quotas. Le magasin partagé est en mémoire et sert à la fraîcheur.

### D2. La règle est systématique pour les lectures

Tout appel d’une fonction `effect: "read"` passe par le magasin, quel que soit l’appelant : `useQuery`,
`functions.call` d’une page, agent, webhook, planification, palette. Le module n’a rien à faire.

- Deux appels identiques en cours n’en font qu’un (dédoublonnage en vol).
- Chaque réponse est publiée à tous les abonnés.
- `functions.call` exécute toujours la fonction (ou rejoint l’appel identique en cours). Il ne sert jamais une valeur
  gardée : l’appelant explicite veut une donnée fraîche. Seul `useQuery` sert la valeur gardée.

### D3. La clé

`module/fonction` + entrée normalisée (ordre des champs indifférent, champs `undefined` ignorés) + comptes de l’appel
(par besoin du module de la fonction, comme `accountsFor` les calcule) + mode « données d’exemple ».

- Deux comptes différents (deux instances Jira) ont deux clés. Ils ne partagent jamais une réponse.
- Les données d’exemple ne se mêlent jamais aux vraies.
- Le module qui appelle n’est pas dans la clé : c’est ce qui permet le partage entre modules (« sprint » et « suivi »
  lisent tous deux `jira/lister-tickets`). La sortie d’une fonction ne dépend que de son entrée et de ses comptes.
- Limite acceptée : une page sans compte choisi (compte par défaut) et une page qui nomme ce même compte ont deux
  clés. Les deux restent justes ; elles ne partagent pas la requête.

### D4. Durée de vie

- `staleAfter` : 30 s par défaut. Une page qui s’ouvre sur une valeur plus jeune ne relit pas. Plus vieille, la page
  l’affiche tout de suite et la relit en fond (`refreshing`).
- `refreshEvery` (option) : relecture périodique, 5 s au moins, une seule par clé pour toutes les pages. Elle s’arrête
  quand plus aucune page n’est abonnée. Pour l’état d’un CI, une file d’attente.
- Une valeur sans abonné est oubliée après 10 minutes ; 500 valeurs au plus.
- En cas d’erreur, la dernière valeur reste montrée, avec l’erreur.

### D5. Portée

- Le magasin vit en mémoire dans la coquille, par espace : il se vide quand l’espace change
  (`resetFunctionHosts`). Rien n’est écrit sur le disque.
- Chaque fenêtre d’Alfred (fenêtre principale, fenêtres de page) a son magasin. Les fenêtres s’échangent les
  réponses par l’événement `functions:result` du cœur (`functions.shareResult`, `function_results.rs`). Une réponse
  de plus de 1 Mio n’est pas diffusée : l’autre fenêtre la relira elle-même.
- Quand le code d’un module change (révision), toutes les valeurs deviennent caduques.

### D6. Invalidation après une écriture

Une fonction `effect: "write"` (ou sans `effect`, qui compte comme une écriture) rend caduques, à la fin de son
appel, réussi ou non :

- les lectures de son module et des modules qui en dépendent (`requires`, de proche en proche) ;
- pour les mêmes comptes seulement : une lecture d’un autre compte du même besoin reste valable ;
- si l’écriture nomme une instance dans son entrée (`{ instance: "acme" }`), pas les lectures d’une autre instance ;
- dans le même mode (exemple ou réel).

Les lectures caduques qui ont des abonnés se relisent tout de suite, une fois chacune. Les autres se relisent au
prochain abonnement. Une réponse partie avant l’écriture n’est pas montrée comme à jour : la lecture repart.

Choix : l’invalidation se fait par module, pas par ressource (méthode + chemin). La coquille ne voit pas les requêtes
HTTP d’un script, et deviner la ressource d’une fonction serait fragile. Relire toutes les lectures affichées d’un
module après une écriture coûte peu : seules celles qui ont des abonnés partent.

### D7. Accord de l’utilisateur et isolement

- `useQuery` demande l’accord pour la fonction comme `functions.call` (`frame.functions.authorize`) : accordé d’office
  dans le même module ou pour une dépendance (`requires`), demandé sinon. Le magasin ne sert jamais une valeur à une
  page avant cet accord.
- Une page ne voit que les valeurs de ses propres comptes (D3).
- `useQuery` refuse une fonction qui n’est pas `effect: "read"`.
- Une page suit au plus 200 lectures ; ses abonnements se ferment avec son cadre (`releaseFrame`).
- `functions.shareResult` n’est pas accessible aux cadres : le pont ne le transmet pas.

### D8. API

- Pages : `useQuery(reference, input?, { staleAfter?, refreshEvery? })` rend `{ data, error, loading, refreshing,
  updatedAt, refresh }`. `reference` à `null` : rien n’est lu. Il se relit aussi sur `dataChanged` et
  `announceChange()`, comme `useAsync`.
- Scripts : pas d’API nouvelle. Une fonction en script appelée par Alfred passe par le même magasin. Un script n’a
  pas d’abonnés à servir.
- Guide de l’agent : SDK.md (section 3, « useQuery »), AGENTS.md (connecteur, 2 bis), PLACEMENT.md (11.1). L’agent lit
  toute fonction de lecture d’un connecteur avec `useQuery`.

### D9. La règle est obligatoire, et l’outillage la garantit (précision d’Alexandre, 2026-11-25)

Quand l’agent développe un module, chaque lecture d’un client passe par le magasin partagé. Aucune page et aucune
fonction ne lit un client par un autre chemin. Trois verrous :

1. **Le cœur (impossible à éviter).** `client()` n’a qu’un chemin vers le service, dans tous les langages :
   `clients::frame_request`. Le cadre d’une fonction n’a pas de réseau (`sealNetwork`), un script n’a pas le secret
   (il reste chez Alfred). Chaque `GET` ou `HEAD` y passe par `client_reads.rs` : deux lectures identiques en cours
   (même compte, même requête), de n’importe quelles fonctions et de n’importe quels modules, ne font qu’une requête.
   Chaque autre méthode y est vue comme une écriture : les coquilles font relire les lectures affichées du module
   (`clients:changed`).
2. **La coquille (impossible à éviter).** Chaque appel d’une fonction `effect: "read"` passe par le magasin des
   pages (D2), quel que soit l’appelant. Même un `functions.call` y passe.
3. **`check` (refuse ce qui priverait les pages des mises à jour).** `check` n’est pas `ok` si :
   - une page ou un panneau lit une fonction de lecture par `functions.call` au lieu de `useQuery` (`sharedReads`) ;
   - une fonction qui joint un service n’a pas d’`effect` (ses lectures ne seraient pas partagées) ;
   - un script appelle le réseau lui-même (`curl`, `wget`, `requests`, `httpx`, `urllib`, `aiohttp`,
     `Invoke-WebRequest`, `Invoke-RestMethod`).

Choix et limites :

- Une lecture ordinaire ne reçoit jamais une réponse gardée par le cœur. Une valeur gardée quelques secondes pour
  tous aurait changé ce que reçoit une fonction qui relit juste après un changement (une tâche qui suit un état, une
  relecture après une écriture). Depuis D10, le cœur garde les réponses, mais ne les sert qu’aux relances.
- `download`, `stream` et `socket` ne passent pas par le magasin : ce sont un fichier et des flux en direct, pas un
  état à partager.
- Une écriture faite par une fonction TypeScript est connue de la coquille, qui invalide elle-même à la fin de
  l’appel. Le cœur ne connaît que `module/*` pour ces fonctions : la coquille ignore donc leur `clients:changed`.
  Sinon, le `POST` d’une lecture (une recherche Jira en `POST`) relancerait les lectures sans fin. Pour un script, le
  cœur connaît la fonction et ne prévient jamais pour une lecture.
- Un script reste un vrai processus, sans bac à sable (décision antérieure). `check` repère les outils de réseau
  connus ; un script qui le cache autrement n’aurait de toute façon pas le secret du service.
- Une lecture qui ouvre un canal (journal en direct) se lit avec `useQuery(…, { staleAfter: 0 })` : chaque page qui
  s’ouvre reçoit un canal ouvert.

### D10. Même service, fonctions différentes : la garantie tient aussi (2026-11-25)

Besoin d’Alexandre : « je lis mes mails ; deux modules lisent les mails ; si le premier déclenche la lecture, les deux
se mettent à jour ». Avec D3 seul, deux fonctions différentes ne partageaient rien.

1. **Le cœur garde chaque réponse `GET` réussie** (`client_reads.rs`), avec la clé de la ressource : compte (espace,
   client, instance) + requête normalisée. 60 s au plus, 500 réponses, 2 Mio chacune au plus.
   - Toute écriture sur le compte l’efface aussitôt, et une lecture partie avant l’écriture n’est pas gardée : jamais
     de valeur d’avant une écriture (la raison de l’abandon des 2 s en D9).
   - **Elle ne sert qu’aux relances** demandées par la coquille. Une lecture ordinaire (« Actualiser », suivi d’un CI
     toutes les 5 s, une fonction qui relit après un changement) joint toujours le service. Ajustement de la piste
     proposée : servir la réponse gardée à tout le monde aurait rendu une valeur ancienne à ces lectures.
2. **Le cœur annonce chaque nouvelle réponse** (`clients:read` : ressource, module, et fonction pour un script).
3. **La coquille sait quelles lectures ont lu quelle ressource.**
   - Fonction TypeScript : le pont voit passer la réponse (`clients.request`), qui porte la ressource ; il la rattache
     aux lectures en cours dans ce cadre de fonctions, puis retire ce champ (la fonction ne le voit pas). Deux lectures
     en même temps dans le même cadre sont toutes deux rattachées : au pire, une relance de trop, servie par la
     réponse gardée.
   - Script : le cœur nomme la fonction ; la coquille rattache ses lectures en cours, ou finies il y a moins de 3 s.
4. **À l’annonce**, la coquille relance les lectures affichées (avec un abonné) qui dépendent de la ressource, sauf
   celle qui vient de lire et celles déjà en cours. La relance passe `reuse` (TypeScript, fixé par le pont seul) ou
   `reuse: true` à `functions.call` (script) : le cœur sert la réponse gardée. Aucune requête ne part ; la relance
   n’annonce rien (pas de boucle). Si la relance lit une autre ressource non gardée, elle la lit sur le réseau.
5. **Règle de l’agent** : une seule fonction de lecture par donnée, dans le module qui déclare le client ; les
   autres modules l’appellent par `requires` (AGENTS.md 2 ter, SDK.md section 3, PLACEMENT.md 11.1). Le point 4 est le
   filet pour les cas restants.

**Ce qui est garanti.** Toute lecture d’un service par une fonction de lecture, dans n’importe quel module, met à jour
toutes les pages affichées qui lisent la même ressource (même compte, même requête), sans requête de plus.

**Ce qui ne l’est pas.**
- Deux requêtes différentes sur la même donnée (`/messages?limit=20` et `/messages?limit=50`, ou deux API qui rendent
  les mêmes mails) sont deux ressources : rien ne les relie.
- Une lecture faite par une fonction appelée par une autre fonction (lecture imbriquée) met à jour les pages de la
  fonction intérieure, pas celles de la fonction extérieure.
- Une page fermée, ou une valeur sans abonné, n’est pas relancée : elle se relit à sa prochaine ouverture.
- Les écritures faites hors d’Alfred (un mail arrivé chez le service) ne sont vues qu’à la prochaine lecture.

## Point d’entrée pour les automatisations

Une fonction que le cœur lance lui-même (webhook, planification ou automatisation d’un script, sans passer par la
coquille) doit alimenter le magasin. Après l’exécution, appeler :

```rust
crate::function_results::publish(&state, &crate::function_results::FunctionResult {
    function: "jira/lister-tickets",
    input: &input,
    accounts: None,           // ou Some(&comptes) : { "jira": "acme" }
    examples: false,
    output: Some(&output),    // None pour une écriture ou un échec
    origin: None,
});
```

La coquille regarde l’effet déclaré : une lecture est publiée aux pages abonnées, une écriture rend caduques les
lectures qu’elle touche. Le cœur n’a pas à connaître l’effet. Les appels qui passent déjà par la coquille
(`function:call`, donc `callFunction`) sont couverts sans rien faire.

## Fichiers

- `src/shell/sharedQueries.ts` : le magasin (clé, dédoublonnage, abonnés, fraîcheur, relecture, invalidation).
- `src/shell/functionHost.ts` : `callFunction` passe les lectures par le magasin et invalide après une écriture ;
  `receiveSharedResult` reçoit les réponses venues d’ailleurs.
- `src/shell/frameBridge.ts` : `functions.watch`, `functions.refresh`, `functions.unwatch`.
- `src/sdk/index.ts` : `useQuery`.
- `src-tauri/src/function_results.rs` : `functions.shareResult`, `publish`, `client_changed` et les contrôles de
  `check` (`page_read_problems`, `function_problem`).
- `src-tauri/src/client_reads.rs` : lectures d’un client dans le cœur (en vol, gardées, relances), branché dans
  `clients::frame_request`.
- Tests : `sharedQueries.test.ts`, `sharedQueries.pages.test.ts` (deux pages, une requête), `useQuery.test.tsx`,
  `function_results.rs`, `client_reads.rs`, `clients.rs` (`identical_reads_in_flight_reach_the_service_once` : deux
  fonctions de deux modules, un vrai serveur, une seule requête reçue, relance servie par la réponse gardée, rien de
  gardé après une écriture), `sharedQueries.resources.test.ts` (deux modules, deux fonctions différentes sur la même
  ressource, deux pages : une lecture de la première met à jour la seconde, une seule requête au service).
