# Conversations

Guide de l’espace de travail Alfred, partie à lire pour cette tâche. Le reste est dans `AGENTS.md`. Lis-le quand ta conversation a été lancée par une page, quand tu dois attendre un événement, ou avant de déléguer (plusieurs modules demandés, plusieurs parties indépendantes).

## Conversation lancée par une page

Une conversation lancée par `ai.startAgent` porte la consigne d’une page, pas celle de l’utilisateur. Elle travaille dans le dossier que la page a donné (un dossier accordé au module), ou dans celui du module, et dans le mode que la page a choisi :

- **espace de travail** (par défaut) : tu lis, écris et lances tes commandes dans ce dossier, sans demander ; tout ce qui en sortirait est refusé. N’insiste pas après un refus : dis dans ta réponse ce qu’il t’aurait fallu.
- **complet** : tu agis sans aucune demande d’autorisation. Reste quand même dans ce que la consigne demande.

Elle n’a que `check`, `db_schema`, `db_query`, `wait_for_event` et `cancel_wait`, limités au module de la page, et Code Mode (`alfred api`, `alfred run`) pour les lectures du module et les fonctions que la page t’offre. Certaines ont des **entrées imposées** par la page : elles n’apparaissent pas dans leur type et tu ne peux pas les changer. Si la consigne demande autre chose (toucher à un autre module, à la structure de l’espace), ne le fais pas et dis-le dans ta réponse.

## Attendre un événement

`wait_for_event` (`event` : « module/evenement », `match` facultatif, `timeoutMinutes` de 1 à 10 080, 60 par défaut, `label` montré à l’utilisateur) pose un **suivi** : quand l’événement arrive — fin d’une CI, d’une automatisation — ou à l’échéance, Alfred dépose son contenu dans ta conversation et te relance, même après un redémarrage. Pose-le puis termine ton tour ; ne fais pas de boucle d’attente. `cancel_wait` (`id`) l’annule. L’utilisateur voit chaque suivi au-dessus de la saisie (« Relance à la fin de … ») et peut l’annuler ; archiver la conversation les arrête tous.

## Délégation entre agents

Toute conversation ouverte par l’utilisateur peut répartir son travail entre des agents délégués : elle devient **coordinatrice** à son premier `delegate`, sans que l’utilisateur la marque (une conversation lancée par une page ne le peut que si la page l’a lancée avec `coordinator: true`).

**Quand déléguer :** l’utilisateur demande plusieurs modules (« crée-moi trois modules ») : délègue, un délégué par module, même petits ; plus généralement, plusieurs parties indépendantes qui ne touchent pas les mêmes fichiers. **Quand ne pas déléguer :** une seule tâche ; un petit travail (quelques commandes) ; des parties qui modifient les mêmes fichiers ou dépendent fortement l’une de l’autre ; une lecture de données (`alfred run` suffit). Chaque délégué coûte une conversation entière : en cas de doute, fais-le toi-même. **Un délégué ne délègue jamais.**

Une coordinatrice a sept commandes de plus. Elle n’agit que sur ses propres tâches :

- `delegate` : de 1 à 50 tâches, chacune avec `key` (unique), `goal` (complet : le délégué ne voit pas ta conversation), `path` (sous-dossier de ton dossier de travail) ou `folder` (`{ id, path? }`, dossier accordé au module, pour une coordinatrice de page), `mode` (`"espace-de-travail"` par défaut, ou `"complet"` si ta conversation est en « Autonomie totale »), `dependsOn` (clés du lot, sans boucle), `provider`, `model` et `effort` facultatifs (par défaut : le harnais, le modèle et l’effort de ta conversation). Tout le lot est vérifié avant le moindre lancement ; donne un `requestId` : répéter la même demande rend la même réponse sans rien relancer.
- `task_status` : statut, résumé, livrables et questions de chaque tâche ; `archived` dit si la conversation du délégué est archivée.
- `read_report` (`id`, `page`) : rapport complet d’une tâche, par pages de 4 000 caractères.
- `relaunch_task` (`id`, `instruction`, `fresh`) : relance un délégué qui ne travaille plus (tâche finie, même réussie, arrêtée, interrompue). Il reprend **dans sa conversation**, avec son contexte, et reçoit ta consigne ; `fresh: true` le relance dans une conversation neuve (seul choix si elle est archivée).
- `add_to_task` (`id`, `instruction`) : complète la tâche d’un délégué au travail ou pas encore parti. S’il travaille, la précision part aussi dans sa conversation, sans couper sa réponse ; il rend **un seul** rapport. Tâche finie : `relaunch_task`.
- `stop_task` (`id`) : arrête une tâche qui travaille ou attend. Elle passe `cancelled`, ses dépendantes aussi, et aucun rapport ne suit.
- `archive_task` (`id`) : arrête le délégué s’il travaille, puis archive sa conversation ; la tâche reste dans `task_status`.

Une consigne s’ajoute toujours à l’objectif de la tâche.

Une tâche part quand toutes ses dépendances ont réussi ; un échec annule celles qui en dépendent. Chaque délégué finit par un **contrat de retour** (bloc JSON : `status` parmi `success`, `partial`, `failed`, `needs_information`, `cancelled` ; `summary` de 600 caractères au plus ; `artifacts`, chemins relatifs à son dossier, vérifiés ; `questions`). Alfred te relance avec chaque rapport : après `delegate`, termine ton tour. Les délégués apparaissent dans la page Agent (« clé · délégué ») et dans les « Tâches en arrière-plan » de ta conversation ; l’utilisateur peut reprendre la main sur l’un d’eux ; archiver la coordinatrice arrête les autres. Un délégué n’a jamais les outils de délégation, et garde le périmètre et la confidentialité de la coordinatrice.

## Git de l’espace de travail

Alfred enregistre l’espace de travail avec git sans exécuter de crochet, et refuse un dépôt dont `.git/config` ferait lancer un programme (`core.fsmonitor`, `core.hooksPath`, filtres, pilotes de diff ou de fusion, `include.path`…). N’écris jamais dans `.git/`.
