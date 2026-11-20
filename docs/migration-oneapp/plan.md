# Plan : le socle d’Alfred avant OneApp

Livrable 4 sur 4, réécrit le 20 novembre 2026 après les décisions de l’utilisateur. Le plan ne porte plus que sur le **socle d’Alfred** : les fonctions de base de la plateforme qui manquent pour que OneApp puisse y exister. Les modules seront conçus plus tard, un par un, dans le fil de l’agent d’Alfred ; l’annexe dit seulement lesquels dépendront de quel manque.

Détail de chaque manque : [manques-alfred.md](manques-alfred.md). Fonctions de OneApp et leur statut : [fonctions-oneapp.md](fonctions-oneapp.md), [correspondance.md](correspondance.md).

## Étape 1 · Le socle, dans l’ordre

Chaque manque se livre seul, avec ses tests, `docs/espace/SDK.md` et `docs/espace/AGENTS.md` à jour, et se vérifie dans l’interface Vite branchée sur Alfred debug. Il peut partir dans sa propre session, qui commite et pousse elle-même.

Tailles : S ≤ 2 jours, M 3 à 5 jours, L 1 à 2 semaines.

| # | Manque de base | Taille | Dépend de | Livré quand |
|---|---|---|---|---|
| 0 | **Correctif** : jeton du serveur local passé à Claude Code par variable d’environnement, plus en argument (partie de S9) | S | — | `ps` ne montre plus le jeton ; les trois harnais joignent leurs fonctions |
| 1 | **S1 · Entrées du menu créées par une page** : zone sous un séparateur, titre, ordre, « Afficher plus », état et compteur par entrée, actions au survol, `usePageContext().entry` ; la page Agent y range ses conversations | M | — | une page d’essai crée une entrée par ligne d’une table, avec pastille d’état ; les conversations d’agent apparaissent dans leur zone |
| 2 | **S2 · Dossiers du poste et Git local** : `folders.*`, `git.*`, `terminal.open`, `cwd` de `commands.run`, accord visible et révocable | M | — | une page choisit un dossier, lit et écrit un fichier `.oneapp/…`, fait `pull`, `commit` et `push` ; refus hors du dossier |
| 3 | **S3 · Agents lancés par une page** : dossier imposé, mode imposé (`strict`, `lecture`, `ecriture`, `dossier`, `complet`), fonctions à entrées imposées, consignes, skills, modèle habilité, propositions | L | S2 | un agent lancé en mode `dossier` sur un dépôt d’essai modifie et lance des commandes sans demande, est arrêté hors du dossier, et ne voit que les fonctions de son périmètre ; en mode `complet`, aucune demande |
| 4 | **S4 · Secrets scellés et jetons émis par les services** : méthode `session`, réponses scellées, `secrets.reveal`, `secrets.writeEnvFile`, `secrets.copy`, méthode `secretUrl` | L | (S2 pour le `.env`) | un faux Portainer et un faux OpenBao passent sans qu’aucune fonction voie un jeton ni une valeur |
| 5 | **S5 · Paramètres non secrets d’un compte** (`{realm}`, `{mount}`, `{endpoint}`) | S | — | un compte Keycloak à royaume se connecte par PKCE ; une fonction lit le montage d’un compte OpenBao |
| 6 | **S6 · Transport** : téléchargement en flux, réponse base64, multipart, canaux de flux et de WebSocket, proxy vérifié | L | — | un artefact de 200 Mo arrive dans les fichiers du module ; une console WebSocket d’écho marche depuis une page |
| 7 | **S7 · Notifications à actions, fenêtres paramétrées, relevés rapides**, fenêtre Agents détachée | M | — | une notification « Journal » ouvre la fenêtre d’un élément précis ; une planification toutes les 10 s ; la page Agent seule dans sa fenêtre |
| 8 | **S8 · Composants `@alfred/ui`** : `StatusCardGrid`, `Board`, `Timeline`, `TreeView`, `LogViewer`, `Terminal`, `MarkdownEditor`, `DiffView`, `Matrix` | L | — | chaque composant décrit dans `DESIGN.md`, connu de `check`, essayé en clair, en sombre et au clavier |
| 9 | **S10 · Suivis** : `ai.watch`, `ai.cancelWatch`, occurrences dédoublonnées | M | S3, S7 | un agent est relancé par l’événement d’un module d’essai, même après un redémarrage |
| 10 | **S11 · Délégation entre agents** : conversation coordinatrice, `deleguer` de 1 à 50 tâches, contrat de retour, rapports, délégués dans la zone Agents | L | S3, S10 | une coordinatrice répartit trois tâches dépendantes sur deux dossiers et rend leur bilan |
| 11 | **S9 · Pilotage des agents depuis Rust** (`opencode serve`, Codex `app-server`, Claude `stream-json`) | L | (après S3) | les trois harnais passent les parcours de la page Agent sans protocole parlé dans l’interface |
| — | **S12 · Parité Windows** | M, au fil des autres | chacun | chaque manque vérifié sur Windows : échelle 125 et 150 %, contraste élevé, PowerShell 5.1, Git Bash, chemins UNC |

Environ 12 à 15 semaines de développement assisté. Le correctif 0, S1, S2, S4, S6 et S8 ne touchent pas les mêmes fichiers et peuvent avancer en parallèle. Les lots de `docs/parite-agent-oneapp.md` (parité de la conversation) restent à faire à part ; ils facilitent S3 et S11.

## Données et utilisateurs de OneApp

Conséquences des décisions de l’utilisateur :

- **Configuration partagée** (`.oneapp/` : produits, connexions, environnements, accès, réglages des agents) : elle reste dans ses dépôts Git, au même format. Les modules la liront et l’écriront comme des fichiers de dossiers accordés (S2). OneApp et Alfred peuvent la partager pendant la transition.
- **Spécifications, change log, architecture, documentation** dans les dépôts des produits : inchangées, lues au même endroit (S2).
- **Jetons et mots de passe** : ressaisis par chacun dans le trousseau d’Alfred, une fois les modules et les services en place. Aucune reprise automatique.
- **Conversations d’agents de OneApp** : non gardées.
- **Réglages personnels du poste** (chemins locaux, ordre, produits masqués) et **automatisations** : à refaire dans les modules qui les porteront ; leur reprise éventuelle se décidera avec ces modules.

## Risques

| Risque | Parade |
|---|---|
| Des modules écrits avant leur manque de base seront à refaire, ou contourneront la sécurité (OpenBao sans S4 lirait des valeurs) | respecter l’ordre ; ne pas commencer les modules qui touchent aux secrets avant S4 |
| Le mode `complet` donne à un agent un accès total au poste | accord explicite et révocable par page, refusé à `grant_access`, mode nommé sur la carte d’accord et dans la conversation |
| Écritures concurrentes dans les dépôts partagés (deux personnes, ou OneApp et Alfred) | Git les signale ; l’aperçu et le choix en cas de conflit seront à écrire dans le module qui lira `.oneapp/` |
| S9 écrit dans Alfred puis à extraire vers `agents-kit`, ou l’inverse | trancher avant S9 (question 3) |
| Windows : traduction des modes de S3 (bac à sable de Codex), COM d’Outlook, échelle et contraste des nouveaux composants | S12 vérifié à chaque livraison sur un poste Windows |

## Annexe · Modules qui en dépendront

Noms indicatifs ; le découpage sera décidé module par module.

| Manque | Modules futurs qui en dépendront |
|---|---|
| S1 menu | produits (une entrée par produit), vue produit, tickets, agents des produits |
| S2 dossiers et Git | produits (dépôts `.oneapp/`, espaces locaux), dépôts Git locaux, vue produit (section Git), CI (tags), documentation, change log, spécifications, architecture, déploiements (compose), secrets (`.env`) |
| S3 agents de page | agents des produits, tickets (« Envoyer à un agent »), spécifications, CI (analyse d’un journal), automatisations |
| S4 secrets | OpenBao, secrets, Portainer (identifiant et mot de passe), absences par agenda publié |
| S5 paramètres de compte | Keycloak, OpenBao, Portainer |
| S6 transport | Artifactory et artefacts GitLab, pièces jointes Jira et GitLab, Confluence (images), déploiements (journaux et console) |
| S7 notifications et fenêtres | CI (fin d’exécution, fenêtre de journal, sonde rapide), déploiements (fenêtres), spécifications (fenêtre), automatisations (confirmation) |
| S8 composants | vue produit (cartes), projets (kanban, planning), accès et secrets (matrices, arbres), CI et déploiements (journaux, console), documentation et spécifications (éditeur, diff) |
| S10 suivis | CI (relance de l’agent à la fin), automatisations |
| S11 délégation | agents des produits (travail réparti entre produits) |
| S9 pilotage natif | tous les modules qui lancent des agents, indirectement |

Connecteurs existants à étendre le moment venu : `atlassian`, `jenkins`, `outlook`.

## Questions restantes

1. **Modes des agents de page** : la liste proposée (`strict`, `lecture`, `ecriture`, `dossier`, `complet`) convient-elle ? « Écriture seule » veut-il dire écrire des fichiers sans lancer de commande (le mode `ecriture` proposé), ou autre chose ?
2. **Mode `complet`** : l’accord vaut-il une fois par page et par dossier (proposition), ou faut-il le redemander à chaque lancement ?
3. **Pilotage natif (S9)** : l’écrire directement dans Alfred, ou d’abord dans la bibliothèque commune `agents-kit` (ADR 0023 de OneApp, chantier desktop-kit en pause) ?
4. **Zone du menu** : une page placée en onglet d’une section peut-elle aussi créer des entrées (sa zone s’affiche alors sous la section), ou seulement une page qui est une entrée du menu ?
5. **Délégation** : la coordinatrice est-elle une conversation que l’utilisateur marque lui-même dans la page Agent, une conversation lancée par une page, ou les deux ?
