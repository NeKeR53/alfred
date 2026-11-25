# Automatisations — décisions d’architecture

Décidé le 2026-11-25, sans questions à Alexandre (délégation). Chaque décision donne la raison. Code : `src-tauri/src/automations.rs` (cœur), `src/features/automations/AutomationsSettings.tsx` (page), `src/features/automations/agentRuns.ts` (passages agentiques), SDK : `automations.trigger`. Les actions (A-12 à A-17) ont été ajoutées le même jour, à la demande d’Alexandre.

## Ce qu’est une automatisation

Une automatisation exécute une **action** sans que l’utilisateur la lance lui-même. Elle a :

- un **nom** et un identifiant (tiré du nom) ;
- un **déclencheur** : planning cron, appel HTTP local, script, ou **un état qui change** (A-19) ;
- une **action**, parmi trois :
  - **déterministe** : une ou plusieurs fonctions de n’importe quel module, dans l’ordre, chacune avec son entrée fixe, son compte (`input.instance`) et ses conditions ;
  - **script** : une fonction de module qui enchaîne les autres avec sa propre logique ;
  - **agentique** : une conversation avec l’agent d’Alfred ;
- un état : **à valider**, **active**, **en pause**, ou **invalide** (fonction absente, planning illisible) ;
- un **historique** : chaque passage au Journal (type « Automatisation »).

## Décisions

### A-1. Un objet de l’utilisateur, à côté des planifications et webhooks des modules

Les planifications et webhooks déclarés par un module (`schedules.rs`, `webhooks.rs`) restent tels quels : ils font partie du module. L’automatisation est un objet **de l’utilisateur**, qui vise une fonction de n’importe quel module.

Raison : l’utilisateur veut faire tourner « ses » actions, pas modifier les modules ; un module installé depuis un marketplace est en lecture seule.

### A-2. Rangée dans la base d’Alfred, propre au poste

La définition, l’accord, le secret et l’état vivent dans la base d’Alfred (table `automations`, par espace), jamais dans le dossier de l’espace.

Raisons :
- le dossier de l’espace est versionné par git et écrit par l’agent : l’accord et le secret doivent rester hors de sa portée (comme `client_trust` et `webhook_secrets`) ;
- un espace partagé en équipe n’active rien chez un collègue : ce qui tourne sans personne se décide poste par poste.

Limite : une automatisation ne suit pas l’espace sur un autre ordinateur. Elle n’entre pas dans l’historique git (pas d’annulation par l’historique de l’espace).

### A-3. Accord : validée dans son état actuel, puis activée

Une automatisation ne part d’elle-même que si :
1. l’utilisateur l’a **validée** dans son état actuel ; l’empreinte couvre l’action (fonctions, entrées, comptes, conditions ; consigne et durée d’un agent ; code d’un script, A-13) et le déclencheur, pas le nom ;
2. elle est **active**.

- Créée ou modifiée par l’utilisateur dans la page : son geste vaut validation ; elle est active d’office à la création (interrupteur « Active » dans le formulaire).
- Créée ou modifiée par l’agent (`create_automation`) : « à valider » et en pause. L’utilisateur clique « Valider et activer ». Si l’agent renvoie la même définition, rien ne change.
- L’agent n’a aucun outil pour valider, activer, lire le secret, ni supprimer une automatisation de l’utilisateur.
- « Exécuter maintenant » marche aussi en pause (geste de l’utilisateur), jamais sans validation.

Raison : même logique que les clients (empreinte, revalidation à chaque modification). Différence voulue : pour un client, l’agent peut valider ; ici non, car une automatisation exécute du code sans personne devant l’écran.

Limite : l’accord porte sur la cible, pas sur le **code** de la fonction. Si l’agent modifie la fonction ensuite, l’automatisation reste active (comme un client validé reste valide quand une page change).

### A-4. Planning : cron à cinq champs, heure locale, sans rattrapage

- Format : `minute heure jour-du-mois mois jour-de-la-semaine` ; `*`, `n`, `a-b`, `*/pas`, `a-b/pas`, listes ; 0 et 7 = dimanche ; raccourcis `@hourly`, `@daily`, `@weekly`, `@monthly`, `@yearly`. Pas de noms (`MON`, `JAN`). Quand le jour du mois et le jour de la semaine sont tous deux restreints, l’un ou l’autre suffit (règle classique de cron).
- Résolution : la minute. La boucle se réveille toutes les 15 secondes ; une minute ne part qu’une fois.
- **Pas de rattrapage** : une minute passée Alfred fermé, ordinateur en veille ou autre espace ouvert est perdue. Le prochain passage est affiché.

Raison : cron est le format que l’on connaît et que l’agent écrit sans erreur ; rattraper des passages manqués peut doubler une action (envoi, paiement). Les planifications des modules gardent leur règle (une heure fixe manquée part au réveil, le jour même).

### A-5. Appel HTTP local : webhook ou autre processus

- Adresse : `http://127.0.0.1:<port>/automations/<id>`, `POST` (et `GET`), **uniquement sur 127.0.0.1**. Pour un service sur Internet, l’utilisateur branche le tunnel de son choix.
- Un **secret par automatisation** (64 caractères hexadécimaux), créé par Alfred, régénérable. Preuves acceptées, comme les webhooks des modules : en-tête `X-Alfred-Secret`, `Authorization: Bearer`, paramètre `?secret=`, ou signature HMAC-SHA256 du corps (`X-Hub-Signature-256`, `X-Alfred-Signature`).
- Réponses : 200 avec la sortie ; 202 si la fonction dure plus de 25 s (elle continue) ; 401 sans preuve ; 403 si elle est à valider ou en pause ; 404 si elle n’existe pas ou ne se lance pas par HTTP ; 409 si le passage précédent tourne encore ; 500 si la fonction échoue (sans son message).
- La fonction reçoit l’appel dans `input.event` : `method`, `query`, `headers` (sans les en-têtes de preuve ni les cookies), `body`.
- Un **autre processus** du poste utilise la même adresse : la page donne une commande `curl` prête à copier.
- Port : fixe dans l’application publiée (**14732**, 14731 en développement), pour que l’adresse reste la même d’un lancement à l’autre. Si le port est pris, Alfred en prend un libre et la page montre la nouvelle adresse.

Raison : une seule voie d’entrée, déjà éprouvée par les webhooks des modules ; pas de nouvelle commande en ligne à installer.

### A-6. Script : par le SDK

Une automatisation au déclencheur « Script » se lance depuis une page, une fonction ou un script de l’espace : `automations.trigger(id, data)` (TypeScript), `alfred.automations.trigger(id, data)` (Python), `POST $ALFRED_SDK_URL/automations.trigger` (bash, PowerShell). L’appel attend la sortie. La fonction reçoit `input.event = { from: "module/fonction", data }`.

Raison : un script qui décide lui-même quand agir garde le cadre d’accord : il ne lance que ce que l’utilisateur a validé et activé.

### A-7. Entrée de la fonction

`input` = l’entrée fixe, plus `instance` (si un compte est choisi), plus `event` (ce qu’apporte le déclencheur). La clé `event` est réservée : une entrée fixe qui la contient est refusée.

Raison : le déclencheur ne peut jamais remplacer une valeur fixée par l’utilisateur (par exemple le compte visé).

### A-8. Un passage à la fois, tout au Journal

- Une automatisation ne tourne jamais deux fois en même temps ; un déclenchement pendant un passage est refusé et noté.
- Chaque passage écrit une ligne au Journal (type `automation`, sujet = identifiant) : déclencheur, fonction, durée, réussite ou échec, sortie (4 000 caractères au plus) ou message d’erreur. Les refus aussi (secret absent, à valider, en pause).
- La ligne de la page montre le dernier passage ; la section « Historique » lit le Journal.

### A-9. Ce qui marche quand Alfred est fermé

**Rien.** Ni planning, ni appel HTTP (connexion refusée), ni script. Les passages manqués ne sont pas rattrapés. Seules les automatisations de l’**espace ouvert** tournent.

Raison : Alfred n’installe aucun service système. Un service macOS (launchd) ou une tâche Windows pourrait réveiller Alfred plus tard ; ce n’est pas fait.

### A-10. Agent

Outils MCP : `create_automation` (créer ou modifier ; naît à valider), `list_automations`, `remove_automation` (seulement celles qu’il a créées). Une création affiche une notification « Automatisation … à valider ». `read_journal` accepte `kind: "automation"`. Instructions : `docs/espace/AGENTS.md` (section 2).

### A-11. Interface

Réglages → **Automatisations** (groupe Espace de travail, avant Journal). Rubrique en sections, composants socle-ui seulement (`SettingsPage`, `Modal`, `TextInput`, `Select`, `RadioButtonGroup`, `TextArea`, `Checkbox`, `LogViewer`, `Alert`). `/design check` : tout est prévu par socle-ui 1.19.1 (le corps d’une `Modal` espace ses champs ; « Active » est une `Checkbox`, car elle fait partie d’un formulaire qu’on envoie) ; aucune pièce ajoutée à socle-ui.
0. **À valider** (seulement s’il y en a) : celles que l’agent a préparées ou modifiées, avec « Valider et activer » (confirmation qui redit la fonction, le déclencheur, l’entrée et le compte). Elles n’ont pas « Exécuter maintenant ».
1. **Automatisations** : une ligne par automatisation (nom, déclencheur, fonction, dernier et prochain passage ; état en étiquette) ; actions : Valider et activer, Mettre en pause ou Activer, Exécuter maintenant, Modifier, Copier l’adresse, Copier la commande curl, Copier le secret, Régénérer le secret, Supprimer. Bouton de section « Nouvelle automatisation ».
2. **Historique** : le Journal des passages, filtré par automatisation.

Le formulaire (modale) : nom, fonction (groupée par module), compte (si la fonction utilise un client à plusieurs comptes), déclencheur, planning cron, entrée JSON, « Active dès l’enregistrement ».

### A-12. Action déterministe : des étapes, des références, une comparaison par condition

- Une action déterministe est une liste de 1 à 20 **étapes**. Chaque étape a une fonction, une entrée fixe (objet JSON), un compte facultatif, et trois réglages facultatifs.
- **Références** : dans l’entrée, un texte qui **est entièrement** une référence est remplacé par la valeur lue : `$prev` (sortie de l’étape précédente lancée), `$steps.N` (sortie de l’étape N, à partir de 1, déjà passée), `$event` (données du déclencheur), suivis d’un chemin `.cle.0.autre`. Une valeur absente vaut `null`. `$$…` garde un `$`. Pas d’interpolation dans un texte plus long.
- **`when`** (« Lancer seulement si ») : l’étape ne part que si la condition est vraie ; sinon elle est **passée** (sa sortie vaut `null`, `$prev` ne change pas).
- **`stopIf`** (« Arrêter ensuite si ») : après l’étape, le passage s’arrête, en réussite, si la condition est vraie. Elle peut lire la sortie de l’étape (`$prev`).
- **`onError: "continue"`** (« Continuer si elle échoue ») : l’étape suivante part ; `$prev` vaut `{ "error": "<message>" }`. Par défaut, un échec arrête le passage en échec.
- **Condition** : **une seule comparaison**, `<référence> <opérateur> [valeur]`. Opérateurs : `==` (ou `=`), `!=`, `>`, `>=`, `<`, `<=`, `contient` (texte, liste, clé d’un objet), `existe`, `vide`, `non-vide`. La valeur est du JSON (`3`, `"paiement"`, `true`), ou un mot nu lu comme texte. Un nombre et un texte numérique se comparent en nombres.
- Pas de `et`, `ou`, `sinon` ni de branche : deux étapes avec deux conditions suffisent. Au-delà, c’est un script.
- Tout est vérifié à l’enregistrement (fonction déclarée, référence vers une étape déjà passée, condition lisible), pas au passage.

Raison : Alexandre veut « pas de if/else/switch case, mais pas loin ». Une comparaison par étape couvre « ne relancer que s’il y a des impayés » et « s’arrêter quand il n’y a plus rien », sans langage à apprendre ni à sécuriser.

### A-13. Action script : une fonction de module, son code dans l’accord

- Le script est une **fonction de module** ordinaire (TypeScript, Python avec `import alfred`, bash, PowerShell). Il reçoit `input.event` et appelle les autres fonctions par `functions.call`, avec la logique qu’il veut.
- « Nouveau script Python » et « Nouveau script TypeScript » créent un fichier modèle dans le module local **`automatisations`** (créé au besoin, sans page), sans jamais écraser un fichier. L’agent écrit ses scripts au même endroit (`declare_function`).
- L’empreinte validée contient le **code** du script : le fichier et sa déclaration (SHA-256). Toute modification, par l’utilisateur ou l’agent, remet l’automatisation « à valider » ; aucun passage ne part, même manuel.
- Les appels à des fonctions d’**autres modules** suivent l’accord habituel des modules : il est demandé au premier appel. Faites un passage manuel (« Exécuter maintenant ») juste après la validation, pour le donner devant l’écran.

Raison : réutiliser les fonctions évite un second moteur d’exécution (le cadre des fonctions TypeScript, le pont des scripts, l’environnement Python par module) ; l’accord porte enfin sur le code lui-même, ce que A-3 ne fait pas pour une simple fonction.

### A-14. Action agentique : une conversation neuve, lancée par la coquille

- Rust prépare le passage : un identifiant de conversation neuf (`auto-…`), son **périmètre**, son dossier de travail (`.alfred/automations/<id>/` dans l’espace, hors git). Il demande ensuite à la coquille de la lancer (`automation:agent`) et attend son issue.
- Par défaut, la coquille crée une conversation neuve (pour une conversation existante choisie par l’utilisateur, voir A-18), titrée « <nom> · automatisation », avec l’origine « Depuis l’automatisation « <nom> » » en tête du relevé. Elle apparaît dans la liste des conversations de la page Agent.
- Message : la consigne fixe, suivie des règles du passage sans surveillance (A-15) ; les données du déclencheur partent en contexte (« Données du déclencheur »).
- Sa sortie : `{ conversation, message }` (le dernier message de l’agent).
- Une interface ouverte plus tard retrouve une demande en attente (`ui.waiting`). Seule la fenêtre principale lance ces conversations.
- Le harnais et le modèle sont ceux réglés par défaut pour l’agent.

### A-15. Ce que l’agent fait sans demander, quand personne ne regarde

- **Il peut** : appeler toutes les fonctions de l’espace (`call_function` et leurs outils `fn__…`), attendre un événement (`wait_for_event`), lire et écrire dans son dossier de travail.
- **Il ne peut pas** : changer la structure de l’espace (pages, modules, clients, accords, automatisations), lire la base des modules, écrire ou lancer quoi que ce soit hors de son dossier. Le périmètre MCP le refuse (module `automatisation:<id>` qui ne correspond à aucun module), et le mode « espace de travail » du harnais refuse sans demander ce qui sort du dossier.
- **Il ne pose pas de question** : la consigne le lui dit. Une question ou une demande d’accord restée sans réponse finit à la durée maximale.
- **Durée maximale** : 15 minutes par défaut, de 1 à 120. Au-delà, la coquille arrête la conversation ; le passage compte comme un échec.
- **Un passage à la fois** par automatisation (A-8) : chaque passage a sa propre conversation.

Raison : une fonction est le seul moyen d’agir que l’utilisateur a déjà jugé utile ; tout le reste demande sa présence.

### A-16. Journal : chaque étape, et le lien vers la conversation

- Une action à plusieurs étapes écrit une ligne par étape (« étape 2/3 module/fonction : réussie », « passée (« … » est faux) », « échec »), une ligne d’arrêt si `stopIf` est vrai, puis la ligne du passage (« planning → 3 étapes : … »). Une seule étape : la ligne du passage suffit.
- Un passage agentique porte l’identifiant de sa conversation (`detail.conversation`), même en échec. La ligne de l’automatisation garde la dernière conversation : l’action « Ouvrir la dernière conversation » l’ouvre dans la page Agent.

### A-17. Formulaire

Le formulaire choisit l’action (`RadioButtonGroup`) : les étapes en `Fieldset` (« Étape N » : fonction, compte, entrée JSON, « Lancer seulement si », « Arrêter ensuite si », « Continuer si elle échoue »), avec « Ajouter une étape » et « Retirer l’étape N » ; le script (choix de la fonction, « Nouveau script Python », « Nouveau script TypeScript », « Ouvrir le script ») ; l’agent (consigne en `TextArea`, durée maximale en `NumberField`). La modale passe en taille `lg`. `/design check` : tout est prévu par socle-ui 1.19.1. Limite connue : avec beaucoup d’étapes, le formulaire devient long pour une modale (la spec de `Modal` conseille une page pour un long formulaire) ; il reste dans la modale, comme la rubrique des Réglages.

### A-18. Action agentique dans une conversation existante

Une action agentique vise soit **une nouvelle conversation à chaque passage** (A-14, par défaut), soit **une conversation existante**, choisie par l’utilisateur dans le formulaire (`action.conversation`).

- **Le message** : chaque passage ajoute à la conversation la consigne, les règles du passage sans surveillance et les données du déclencheur (en contexte). Il commence par « Depuis l’automatisation « <nom> » : », qui le distingue d’un message de l’utilisateur.
- **Son tour** : si l’agent y travaille, le message entre dans la **file de messages** et part à la fin du tour en cours, sans le couper. Il n’est **pas** glissé dans le tour en cours par le pilotage de Claude Code (steer) : ce tour est celui de l’utilisateur, sans les limites A-15, et un message glissé y serait traité avec ses droits. La file garde chaque tour à un seul demandeur. Comme pour tout message en file, il ne part qu’après un tour fini normalement ; après une erreur ou un arrêt, il attend l’utilisateur.
- **Durée maximale** : elle compte l’attente du tour. Dépassée, le message sort de la file s’il y est encore, ou le tour de l’automatisation est arrêté ; le tour de l’utilisateur n’est jamais touché.
- **Limites A-15** : le périmètre (appeler les fonctions, rien d’autre) est posé au début du tour de l’automatisation et rendu à sa fin (`automations.agentScope`) : le périmètre d’avant revient, et l’utilisateur retrouve sa conversation telle qu’il l’avait. Un tour interrompu par la fermeture d’Alfred ne le laisse pas : il est retiré au démarrage. Le harnais garde le mode de la conversation : seule une conversation en mode **« Seulement dans son dossier »** peut être visée (le formulaire grise les autres) ; dans un autre mode, le passage échoue. Son dossier est alors celui de la conversation.
- **Échecs clairs** : conversation supprimée, archivée ou passée dans un autre mode : le passage n’envoie rien et échoue ; le Journal dit pourquoi (« Passage impossible : la conversation « … » est archivée. ») et porte l’identifiant de la conversation. La ligne de l’automatisation le montre aussi, avant tout passage.
- **Accord** : la conversation visée fait partie de l’empreinte validée (elle est dans l’action). En changer remet l’automatisation « à valider ». Sans conversation visée, l’empreinte reste celle d’avant : les automatisations déjà validées le restent.
- **Agent** : `create_automation` prend `action.conversation` ; l’agent ne vise une conversation existante que si l’utilisateur le demande.

Raison : l’utilisateur peut vouloir suivre au même endroit le fil d’une tâche récurrente (un suivi quotidien, une conversation de veille), sans qu’une automatisation n’écrive jamais dans une conversation qu’il n’a pas choisie.

### A-19. Déclencheur « un état change »

Quatrième déclencheur : `{ "kind": "state", "state": "jira/tickets-du-filtre", "params": { "jql": "…" }, "instance": "acme" }` (`params` et `instance` facultatifs). Les états partagés sont décrits dans `docs/lectures-partagees.md`.

- **Départ** : quand le cœur range une nouvelle valeur de cet état, avec les mêmes paramètres normalisés (ordre indifférent) et le même compte (tout compte si `instance` est omis), l’automatisation part avec `event` = `{ state, params, instance }`. Une valeur identique ne change rien, donc ne déclenche rien. Les données d’exemple ne déclenchent jamais.
- **Abonnée** : active (validée et non en pause), elle compte comme abonnée de l’état. Le module fournisseur le rafraîchit donc selon sa politique, dans le cœur, même sans aucune page ouverte. En pause ou supprimée, elle ne l’est plus : si c’était le dernier abonné, le rafraîchissement s’arrête.
- **Un passage à la fois** (A-8) : un changement qui arrive pendant un passage ne relance pas l’automatisation ; le changement suivant la relancera.
- **Accord** : l’état, ses paramètres et le compte font partie de l’empreinte validée (ils sont dans le déclencheur). `check` refuse un état non déclaré, ou un paramètre que l’état n’a pas.
- Rien ne tourne quand Alfred est fermé (A-9) : le fournisseur ne rafraîchit pas, et l’automatisation ne part pas.

Raison : réagir à une donnée d’un service (un nouveau ticket dans un filtre, un CI qui passe au rouge) sans planning qui relit le service de son côté : la lecture est faite une fois, par le fournisseur, pour tous ses abonnés.

## Suites possibles (non faites)

- Les planifications déclarées par un module tournent dès leur déclaration, sans accord de l’utilisateur. Les faire passer par le même accord qu’une automatisation.
- Réveil d’Alfred par le système (launchd, Planificateur de tâches) pour un planning quand l’app est fermée.
- Accord étendu au code des fonctions d’une action déterministe (c’est fait pour un script, A-13).
- Choisir le harnais et le modèle d’un passage agentique.
