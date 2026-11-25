# États partagés : la seule source de vérité des données d’un service

Date : 2026-11-25. État : en place (cœur, coquille, SDK, guide de l’agent, `check`). À relire par Alexandre.

Ce document remplace les pistes précédentes du même jour (lectures partagées par fonction avec `useQuery`, puis
cache des `GET` dans le cœur avec relance des fonctions). Elles sont retirées (voir « Historique »).

## Ce qui est garanti, et ce qui ne l’est pas

**Garanti.** Dès qu’une lecture met à jour un état ou une entité, toutes les pages abonnées qui en dépendent
(dans toutes les fenêtres, tous les modules, sur le même compte) reçoivent la nouvelle valeur au même moment, sans
requête au service. Un objet relu seul (un ticket) met à jour toutes les listes qui le montrent.

**Pas garanti.**
1. **Sans lecture, un état ne change pas.** Un changement chez le service (un mail arrivé) n’est vu qu’à la
   prochaine lecture : une page qui s’ouvre sur un état vide, `refresh()`, une action, une automatisation. La
   relecture périodique (`refreshEvery`) ou un webhook du service reste un choix explicite par état.
2. **Le nom et la forme d’un état sont un contrat entre modules.** Un module qui change la forme d’une entité sans
   monter sa `version` casse les pages des autres modules.

Autres limites : le magasin vit en mémoire (il se vide quand Alfred redémarre ; la première page qui s’ouvre relit) ;
deux requêtes différentes sur la même donnée (`limit=20` et `limit=50`) alimentent ce que leurs fonctions déclarent,
rien de plus.

## Comment ça marche

1. Le module qui détient le client déclare ses **entités** (ticket : champ `cle`, forme, version) et ses **états**
   (`mes-tickets` : une liste de tickets) dans `module.json`.
2. Ses fonctions de lecture déclarent ce qu’elles alimentent : `lister-tickets` → état `mes-tickets` ;
   `lire-ticket` → entité `ticket`, identifiant dans l’entrée `cle` (`param`).
3. Une page s’abonne : `useAlfredState("jira/mes-tickets")`. Elle reçoit la valeur courante tout de suite (la liste
   avec ses objets). Si l’état est vide, Alfred le lit une fois.
4. Quand une lecture rend sa sortie, le cœur la range : chaque ticket une seule fois sous `jira/ticket/<cle>`, la liste
   comme une suite de clés. Il annonce les clés qui ont changé (`states:changed`).
5. Chaque coquille relit seulement les abonnements qui dépendent de ces clés, localement. Avec `select`, la page ne se
   redessine que si sa partie a changé.

## Décisions

### E1. Le cœur tient le magasin

Le magasin (`src-tauri/src/states.rs`) est dans le cœur, en mémoire : il est le même pour toutes les fenêtres, les
scripts et les automatisations. Une coquille ne garde pas de copie : à chaque annonce, elle relit l’abonnement concerné
(un appel local). Raison : une seule source de vérité, sans synchroniser des copies.

### E2. Normalisation

- **Entité** : clé `module/entité` + identifiant (champ `key` de la déclaration, `id` par défaut), dans la portée
  du compte. Un objet est rangé une seule fois. Une nouvelle version d’un objet est **fusionnée champ par champ**
  avec l’ancienne : une liste qui rend moins de champs que le détail n’efface pas la description lue par le détail.
- **État de liste** (`entity` sur l’état) : il garde les identifiants, dans l’ordre rendu par la lecture. La lecture
  le rend avec ses objets ; un objet absent du magasin est sauté. `items` : le champ de la liste quand la fonction
  rend un objet (`{ "issues": [...] }`).
- **État valeur** (sans `entity`) : la valeur telle quelle (l’état d’un CI).
- **Sous-clé** : `param` sur la fonction nomme le champ de l’entrée qui porte la sous-clé (`jenkins/ci` + `<job>`)
  ou l’identifiant d’une entité lue seule.
- Une écriture peut déclarer `entity` : elle rend l’objet modifié, qui met à jour l’entité, donc toutes les listes.

### E3. Alimentation sans rien à faire pour le module

- Une fonction lancée par le cœur (script, automatisation, webhook, planification, agent) : `functions::call_in`
  range sa sortie selon sa déclaration (`states::feed`).
- Une fonction TypeScript lancée par la coquille (une page) : la coquille envoie la sortie au cœur (`states.feed`).
  Une fonction TypeScript demandée par le cœur n’est rangée qu’une fois (indicateur `fed`).
- Publication directe : `states.publish(name, value, { key, instance })` en TypeScript, `alfred.states.publish` en
  Python, par une page, une fonction ou un script **du module déclarant seulement**.
- Une valeur identique à la valeur rangée ne change rien et n’annonce rien.

### E4. Abonnement

- Page : `useAlfredState(name, { key, instance, select })` rend `{ data, loading, refreshing, error, updatedAt,
  refresh }`. `select` : comparaison structurelle de la partie choisie ; la page n’est redessinée que si elle change
  (ni son chargement ni son erreur n’ont changé, et un `refreshing` seul ne redessine pas).
- Fonction, script, cœur : par le bus d’événements, `events.subscribes` avec `"event": "jira/etat.mes-tickets"` (ou
  `"jira/entite.ticket"`) ; la fonction reçoit `{ state | entity, key | id, instance, examples }` et lit la valeur
  avec `states.get`. `check` accepte ces événements quand l’état ou l’entité est déclaré.

### E5. Quand une donnée se met à jour

- Un état **vide** est lu une fois par la page qui s’ouvre (la fonction de lecture qui l’alimente ; une seule
  lecture à la fois par état et par compte, pour toutes les pages).
- Un état **plein** ne se relit pas à l’ouverture : la page montre la valeur courante. Choix : pas de revalidation en
  fond (demande d’Alexandre). `refresh()` (bouton « Actualiser ») le relit.
- Une **écriture** du module (fonction `write` sans `entity`, ou script qui écrit, vu par le cœur : `clients:changed`)
  fait relire les états affichés du module, une lecture par état : c’est une action, donc une lecture.
- **Relecture périodique** : seulement si l’état déclare `refreshEvery` (5 s au moins). Une seule pour toutes les
  fenêtres : le cœur la confie à une coquille par un bail renouvelé (`states.lease`). Elle s’arrête quand plus aucune
  page ne montre l’état.

### E6. Portée et isolement

- Portée de chaque donnée : espace, mode « données d’exemple », compte (instance réelle du client, résolue par le cœur :
  celle nommée, sinon celle choisie pour la page, sinon celle par défaut). Deux comptes ne partagent rien ; les données
  d’exemple ne se mêlent jamais aux vraies.
- Un module lit les états de son module et de ses dépendances (`requires`) seulement : ailleurs, refus. Une
  dépendance est accordée d’office (comme ses fonctions) ; l’accord pour le client reste vérifié à chaque lecture du
  service.
- Seul le module déclarant publie.

### E7. La règle est obligatoire, et `check` la contrôle

- Une page ou un panneau qui lit une fonction de lecture par `functions.call` est refusé (`sharedReads`) : une page
  s’abonne à un état.
- Une fonction de lecture d’un service sans `state` ni `entity` est refusée : toute lecture d’un service alimente un
  état nommé. Un `state` ou une `entity` non déclaré aussi.
- Un état qu’aucune lecture n’alimente, une liste d’un type absent, une entité sans `version`, un `refreshEvery` sous
  5 s sont signalés.
- Toujours en place : une fonction de connecteur sans `effect`, un script qui appelle le réseau lui-même (`curl`,
  `requests`…). Dans le cœur, deux `GET` identiques en cours ne font qu’une requête (`client_reads.rs`).
- Ouvrir un canal (journal, console) est une action : `effect: "write"`, appelée par `functions.call`.

### E8. Guide de l’agent

SDK.md (section 3, « Les données d’un service »), AGENTS.md (connecteur, 2, 2 bis, 2 ter), PLACEMENT.md (11.1). Une
seule fonction de lecture par donnée, dans le module qui déclare le client ; les autres modules s’abonnent à son état
par `requires`.

## Point d’entrée pour les automatisations

Rien à faire : une automatisation qui lance une fonction passe par `functions::call_in`, qui range la sortie. Pour
publier autre chose, le cœur appelle `states::feed` (sortie d’une fonction) ; un script appelle
`alfred.states.publish`.

## Historique (retiré)

- `useQuery` et le magasin des sorties de fonctions dans la coquille (`sharedQueries.ts`, `functions.watch`,
  `functions:result`, `function_results::publish`).
- Les réponses `GET` gardées dans le cœur, servies aux relances (`reuse`, `clients:read`, champ `resource`).
- Gardé : le dédoublonnage des `GET` en vol (`client_reads.rs`), `clients:changed`, les contrôles de `check`.

## Fichiers

- `src-tauri/src/states.rs` : le magasin (entités, états, portée, fusion, annonces, bail de relecture).
- `src-tauri/src/space.rs` : `entities`, `states` du manifeste ; `state`, `entity`, `param` des fonctions.
- `src-tauri/src/functions.rs` : `call_in` range la sortie ; `declare_function` reçoit `state`, `entity`, `param`.
- `src-tauri/src/module_events.rs` : `publish_internal`, événements `etat.` et `entite.`.
- `src-tauri/src/function_results.rs` : `clients:changed` et les contrôles de `check`.
- `src-tauri/python/alfred/__init__.py` : `alfred.states`.
- `src/shell/sharedStates.ts` : le hub des abonnements ; `src/shell/functionHost.ts` : lecture d’un état vide,
  `states.feed`, écritures ; `src/shell/frameBridge.ts` : `states.watch`, `states.refresh`, `states.unwatch`,
  `states.get`, `states.publish`.
- `src/sdk/index.ts` : `useAlfredState`, `states`, `sameValue`.
- Tests : `states.rs` (un ticket dans deux listes de deux modules, fusion, sous-clé, exemple, isolement,
  publication), `sharedStates.test.ts` (deux modules de mail : la page A lit, la page B suit sans requête ; un ticket
  relu seul met à jour les deux listes), `useAlfredState.test.tsx` (`select` : pas de redessin quand un autre champ
  change).
