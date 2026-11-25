# Automatisations — décisions d’architecture

Décidé le 2026-11-25, sans questions à Alexandre (délégation). Chaque décision donne la raison. Code : `src-tauri/src/automations.rs` (cœur), `src/features/automations/AutomationsSettings.tsx` (page), SDK : `automations.trigger`.

## Ce qu’est une automatisation

Une automatisation exécute une **fonction d’un module** sans que l’utilisateur la lance lui-même. Elle a :

- un **nom** et un identifiant (tiré du nom) ;
- une **fonction cible** (`module/fonction`), de n’importe quel module ;
- une **entrée** fixe (objet JSON) et, au besoin, un **compte** d’un client (`input.instance`) ;
- un **déclencheur** : planning cron, appel HTTP local, ou script ;
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
1. l’utilisateur l’a **validée** dans son état actuel ; l’empreinte couvre la fonction, l’entrée, le compte et le déclencheur (pas le nom) ;
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

## Suites possibles (non faites)

- Les planifications déclarées par un module tournent dès leur déclaration, sans accord de l’utilisateur. Les faire passer par le même accord qu’une automatisation.
- Réveil d’Alfred par le système (launchd, Planificateur de tâches) pour un planning quand l’app est fermée.
- Accord étendu au code de la fonction (empreinte du fichier).
