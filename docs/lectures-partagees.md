# États partagés : la seule source de vérité des données d’un service

Date : 2026-11-25. État : en place (cœur, coquille, SDK, guide de l’agent, `check`). À relire par Alexandre.

Ce document remplace les pistes précédentes du même jour (lectures partagées par fonction avec `useQuery`, puis
cache des `GET` dans le cœur avec relance des fonctions). Elles sont retirées (voir « Historique »).

## Ce qui tourne, et quand

| Quoi | Quand ça tourne | Quand ça s’arrête |
|---|---|---|
| Rafraîchissement d’un état par son fournisseur (`refresh`, mode `subscribed`) | Dans le cœur, tant qu’Alfred est ouvert **et** que l’état (avec ce jeu de paramètres et ce compte) a au moins un abonné : une page ouverte, une fonction ou un script abonné (`states.subscribe`, pour sa durée), une automatisation active déclenchée par cet état. Avec ou sans page affichée. | Quand le dernier abonné part (page fermée, abonnement expiré, automatisation en pause ou supprimée). |
| Rafraîchissement en mode `always` | Dans le cœur, dès que le module est dans l’espace, tant qu’Alfred est ouvert. | Quand le module disparaît, ou qu’Alfred se ferme. |
| État sans politique | Une lecture au premier abonnement (s’il est vide), puis à chaque « Actualiser » ou écriture du module. | — |
| Automatisation « un état change » | Quand une nouvelle valeur de l’état est rangée (un vrai changement). | En pause, supprimée. |
| **Alfred fermé** | **Rien.** Aucun rafraîchissement, aucune automatisation ; le magasin (en mémoire) est vide au lancement suivant, et chaque état est relu par son premier abonné. | |

Un seul rafraîchissement par état et par jeu de paramètres, quel que soit le nombre d’abonnés. Les fenêtres ne
relisent jamais le service elles-mêmes. Réglages → États montre ce qui tourne.

## Ce qui est garanti, et ce qui ne l’est pas

**Garanti.** Dès qu’une lecture met à jour un état ou une entité, toutes les pages abonnées qui en dépendent
(dans toutes les fenêtres, tous les modules, sur le même compte) reçoivent la nouvelle valeur au même moment, sans
requête au service. Un objet relu seul (un ticket) met à jour toutes les listes qui le montrent.

**Pas garanti.**
1. **Sans lecture, un état ne change pas.** Un changement chez le service (un mail arrivé) n’est vu qu’à la
   prochaine lecture : le rafraîchissement du fournisseur s’il en déclare un (avec sa période), une page qui s’ouvre
   sur un état vide, `refresh()`, une action, une automatisation. La politique de rafraîchissement (`refresh`) ou un
   webhook du service reste un choix explicite par état.
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

Remplacé par F1 à F6 : le fournisseur tient l’état à jour, dans le cœur. Un état sans politique est lu une fois au
premier abonnement ; ensuite par « Actualiser » ou une écriture du module. Les coquilles ne relisent plus jamais.

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

## Le fournisseur (2026-11-25, suite d’Alexandre)

### F1. Le module qui déclare un état en est le fournisseur

Lui seul sait le mieux le tenir à jour, avec le moins de requêtes. Il déclare, par état, sa politique `refresh` :
`function` (une lecture du module), `every` (secondes, 10 au moins), `incremental`, `mode` (`subscribed` par défaut,
`always`). Les autres modules, les pages, les fonctions et les automatisations s’abonnent seulement ; ils ne joignent
jamais le service pour ces états. Règle de l’agent : un module de service est fournisseur (AGENTS.md 2 ter).

### F2. États à paramètres

`params: ["jql"]` sur l’état. La sous-clé est l’objet des seuls paramètres déclarés, non nuls, en JSON aux clés triées :
deux abonnés avec les mêmes valeurs, dans n’importe quel ordre, partagent le même état et un seul rafraîchissement. Une
entité (`jira/ticket` + `42`) reste désignée par sa clé. `key` reste accepté pour un état à un seul paramètre. Chaque paramètre est décrit (`{ id, description, example }`) ; `check` refuse un paramètre sans description.
`space_overview` rend `states` et `entities` : fournisseur, description, paramètres décrits, entité, politique, et l’appel
à écrire (`subscribe`). C’est la chaîne d’un module consommateur : il trouve l’état par sa description, choisit les
valeurs d’après la description et l’exemple, déclare `requires` sur le fournisseur et écrit l’appel.

### F3. Dans le cœur, une cible par état et par jeu de paramètres

`state_refresh.rs` tient les abonnements et une boucle (réveil chaque seconde). Une **cible** = état + paramètres +
compte + mode exemple. Elle a des abonnés : pages (abonnement renouvelé par la coquille toutes les 30 s, expiré après
90 s sans renouvellement : une fenêtre fermée ou plantée ne laisse rien tourner), fonctions et scripts
(`states.subscribe`, 10 minutes par défaut, un jour au plus), automatisations actives déclenchées par l’état, et `always`.
Le premier abonné lance la première lecture ; ensuite une lecture par période ; le dernier parti, la cible s’arrête
(son état reste dans le magasin, sans être tenu à jour). Une **entité suivie seule** (`useAlfredState("jira/ticket", { key })`) est une cible
aussi : sans politique, elle est lue au premier abonnement par la fonction qui déclare l’entité avec `param`, puis sur
« Actualiser » ; elle change aussi dès qu’une liste ou une écriture rend cet objet. Les coquilles ne relisent plus rien (le bail `states.lease` et
la lecture par la coquille sont retirés).

### F4. Lecture incrémentale

La fonction reçoit les paramètres, `instance`, `current` (la valeur courante, liste avec ses objets) et `since` (fin
de la dernière lecture réussie, ms, `null` la première fois). Première lecture : la sortie remplace l’état. Ensuite :
elle rend une liste d’objets changés, ou `{ changed, removed }`. Fusion : un objet changé met à jour son entité
(partout), un identifiant nouveau va en tête de la liste, un identifiant retiré en sort. Pour un état valeur, les
champs rendus remplacent les anciens.

### F5. Garde-fous

Période minimale 10 s ; quatre lectures à la fois au plus ; 250 ms au moins entre deux départs ; après un échec, recul
progressif (période × 2ⁿ, 30 minutes au plus), puis retour à la période après un succès. Chaque abonné lit l’état du
dernier rafraîchissement avec la valeur (`refresh` : heure, dernière réussite, erreur, échecs, prochain passage ;
`status` de `useAlfredState`). Un échec va au Journal. Réglages → États liste les cibles, leurs abonnés, leur politique
et leur dernier passage (lecture seule ; `/design check` : `SettingsPage` + `Table`, prévu par la spec).

### F6. Abonnés de toute sorte, et le déclencheur « un état change »

- Page : `useAlfredState(name, { params, key, instance, select })`.
- Fonction ou script : `states.subscribe(name, { params, seconds })` (TypeScript), `alfred.states.subscribe(...)`
  (Python), puis les changements par `events.subscribes` (`module/etat.<id>`, payload `{ state, params, instance }`).
- Automatisation : déclencheur `{ "kind": "state", "state", "params", "instance" }` (`docs/automatisations.md`, A-19).
  Active, elle compte comme abonnée ; elle part à chaque vrai changement, une fois à la fois.
- `check` : un état à rafraîchissement doit avoir sa fonction de lecture du module ; période sous 10 s refusée ;
  `always` réservé à un état sans paramètres ; un état sans politique doit être alimenté par une lecture.

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

- `src-tauri/src/states.rs` : le magasin (entités, états, paramètres, portée, fusion, annonces).
- `src-tauri/src/state_refresh.rs` : abonnés, boucle du fournisseur, garde-fous, `states.overview`.
- `src-tauri/src/automations.rs` : déclencheur `state`, `state_watchers`, `state_changed`.
- `src/features/states/StatesSettings.tsx` : Réglages → États.
- `src-tauri/src/space.rs` : `entities`, `states` du manifeste ; `state`, `entity`, `param` des fonctions.
- `src-tauri/src/functions.rs` : `call_in` range la sortie ; `declare_function` reçoit `state`, `entity`, `param`.
- `src-tauri/src/module_events.rs` : `publish_internal`, événements `etat.` et `entite.`.
- `src-tauri/src/function_results.rs` : `clients:changed` et les contrôles de `check`.
- `src-tauri/python/alfred/__init__.py` : `alfred.states`.
- `src/shell/sharedStates.ts` : le hub des abonnements ; `src/shell/functionHost.ts` : lecture d’un état vide,
  `states.feed`, écritures ; `src/shell/frameBridge.ts` : `states.watch`, `states.refresh`, `states.unwatch`,
  `states.get`, `states.publish`.
- `src/sdk/index.ts` : `useAlfredState`, `states`, `sameValue`.
- Tests du fournisseur : `state_refresh.rs` (deux abonnés au même filtre, un seul rafraîchissement ; fusion
  incrémentale ; le dernier abonné part, le rafraîchissement s’arrête ; sans page, une automatisation abonnée fait
  rafraîchir et part sur le changement), `StatesSettings.test.ts`, `stateTrigger.test.ts`.
- Tests : `states.rs` (un ticket dans deux listes de deux modules, fusion, sous-clé, exemple, isolement,
  publication), `sharedStates.test.ts` (deux modules de mail : la page A lit, la page B suit sans requête ; un ticket
  relu seul met à jour les deux listes), `useAlfredState.test.tsx` (`select` : pas de redessin quand un autre champ
  change).
