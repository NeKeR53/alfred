# Plan de migration de OneApp dans Alfred

Livrable 4 sur 4. S’appuie sur [fonctions-oneapp.md](fonctions-oneapp.md), [correspondance.md](correspondance.md) et [manques-alfred.md](manques-alfred.md).

Principe retenu par l’utilisateur : d’abord mettre Alfred à jour (étape 1), puis créer chaque élément de OneApp comme module, **en parlant à l’agent d’Alfred dans un espace** (étape 2). Les modules sont construits dans un espace de développement, validés, puis publiés dans un marketplace ; l’équipe les importe ensuite chez elle.

---

## Étape 1 · Mettre Alfred à jour

Chaque chantier se livre seul, avec ses tests, SDK.md et AGENTS.md à jour, et se vérifie dans l’interface Vite branchée sur Alfred debug. Il peut partir dans sa propre session, qui commite et pousse elle-même. Les tailles sont celles de [manques-alfred.md](manques-alfred.md) (S ≤ 2 j, M 3 à 5 j, L 1 à 2 sem., XL > 2 sem.).

| # | Chantier | Taille | Attend | Livré quand |
|---|---|---|---|---|
| 1 | **C1 · Secrets scellés et jetons émis par les services** : méthode `session`, réponses scellées et références, `secrets.reveal`, `secrets.writeEnvFile`, `secrets.copy`, méthode `secretUrl` | L | — | un faux Portainer et un faux OpenBao passent sans qu’aucune fonction voie un jeton ni une valeur |
| 2 | **C2 · Paramètres de compte et comptes partagés** : `methods[].params`, `{param}` dans les adresses, `client().params()`, partage de la définition d’un compte | M | — | un compte Keycloak à royaume se connecte par PKCE ; un compte partagé arrive chez un second espace « Mot de passe manquant » |
| 3 | **C3 · Transport** : `download`, réponse base64, multipart, canaux (flux et WebSocket), proxy vérifié | L | — | un artefact de 200 Mo téléchargé dans les fichiers du module ; une console WebSocket d’écho fonctionne d’une page |
| 4 | **C4 · Dossiers du poste et Git** : `folders.*`, `commands.run` avec `cwd`, `git.*`, `terminal.open` | M | — | une page choisit un dossier, lit un `CHANGELOG.md`, fait un commit et un push ; refus hors du dossier |
| 5 | **C5a · Entrées du menu fournies par un module** | M | — | un module d’essai montre une entrée par ligne d’une table, avec pastille d’état |
| 6 | **C5b · Notifications à actions, fenêtres paramétrées, sondes rapides** | S | — | une notification « Journal » ouvre la fenêtre d’un build précis ; une planification à 10 s |
| 7 | **C6 · Composants `@alfred/ui`** (cartes d’état, `Board`, `Timeline`, `TreeView`, `LogViewer`, `Terminal`, `MarkdownEditor`, `DiffView`, `Matrix`) | L | — | chaque composant dans DESIGN.md, `check` le connaît, essais en clair, en sombre et au clavier |
| 8 | **C8 · Moteur d’agents natif** (OpenCode `serve`, Codex `app-server`, Claude `stream-json`, jeton MCP hors argument) | L | décision sur `agents-kit` | les trois harnais passent les parcours de la page Agent, plus aucun protocole parlé dans l’interface |
| 9 | **C5c · Agents dans la barre de gauche et fenêtre Agents** | M | 5, 8 | section Agents sous les entrées, fenêtre détachée |
| 10 | **C9 · Agents de travail** (`agents.start` sur un dossier, outils limités à l’entrée, autonomie « dossier », confidentialité, propositions, références `#`) | L | 4, 8 | un agent lancé sur le dossier d’un produit d’essai ne voit que les fonctions de ce produit |
| 11 | **C10 · Suivis et automatisations d’agents** | M | 6, 10 | un agent est relancé par l’événement de fin d’une exécution simulée, même après redémarrage |
| 12 | **C7 · Synchronisation d’équipe étendue** (sources multiples, documents, colonnes personnelles, identité, conflits à trancher ; disposition `.oneapp/` si retenue) | XL | 2 | deux espaces partagent un catalogue depuis deux dépôts, avec un conflit tranché |
| — | **C12 · Parité Windows** | M | chacun | chaque chantier vérifié sur Windows (échelle 125 et 150 %, contraste élevé, PowerShell 5.1, Git Bash) |
| option | **C11 · Délégation** | L | 10 | sur décision |
| option | **C13 · MCP externe** | S | — | sur décision |

Les chantiers 1, 3, 4, 7 et 8 ne touchent pas les mêmes fichiers et peuvent avancer en parallèle. Les lots 1 à 6 de `docs/parite-agent-oneapp.md` (parité de la conversation) restent à faire à part ; ils précèdent utilement C9.

---

## Étape 2 · Les modules à créer dans le fil de l’agent d’Alfred

### Comment s’en servir

- Un message par module, dans un espace de développement (par exemple une copie de `taff`), dans l’ordre ci-dessous ; le module suivant se lance quand le précédent est livré et vérifié par l’agent (`check`, `page_snapshot`, `page_screenshot`).
- Chaque message dit ce que faisait OneApp, ce qu’on veut et les comptes ; l’agent d’Alfred peut lire le code de OneApp pour s’en inspirer (chemins donnés), sans le recopier : les appels passent par les fonctions du connecteur.
- Une fois validé, le module est publié par l’utilisateur dans le marketplace (menu « … » du module).
- Colonne **Étape 1** : chantiers qui doivent être livrés avant le message.

### Vue d’ensemble

| # | Module | Nouveau ou existant | Comptes | Dépend de | Étape 1 |
|---|---|---|---|---|---|
| 1 | `atlassian` | existant, à étendre | Jira, Bitbucket, Confluence | — | C3 |
| 2 | `jenkins` | existant, à étendre | Jenkins | — | — |
| 3 | `gitlab` | nouveau | GitLab | — | C3 |
| 4 | `sonarqube` | nouveau | SonarQube | — | — |
| 5 | `artifactory` | nouveau | Artifactory | — | C3 |
| 6 | `portainer` | nouveau | Portainer (un par environnement) | — | C1, C2, C3 |
| 7 | `openbao` | nouveau | OpenBao (un par environnement) | — | C1, C2 |
| 8 | `keycloak` | nouveau | Keycloak (un par environnement) | — | C2 |
| 9 | `grafana` | nouveau | Grafana (un par environnement) | — | — |
| 10 | `outlook` | existant, à étendre | aucun (Outlook du poste) ; agenda publié facultatif | — | C1 (ICS) |
| 11 | `depots` | nouveau | aucun (git du poste) | — | C4 |
| 12 | `produits` | nouveau | aucun (reprend les comptes des connecteurs) | 1 à 9, 11 | C5a |
| 13 | `reprise-oneapp` | nouveau | aucun | 12 | C2, C4 |
| 14 | `ci` | nouveau | via `jenkins`, `gitlab` | 2, 3, 11, 12 | C5a, C5b, C6 |
| 15 | `deploiements` | nouveau | via `portainer` | 6, 12 | C3, C5a, C5b, C6 |
| 16 | `secrets` | nouveau | via `openbao` | 7, 12 | C1, C4, C6 |
| 17 | `cockpit` | nouveau | via les connecteurs | 1, 4, 5, 11, 12, 14, 15, 16 | C5a, C6 |
| 18 | `tickets` | nouveau | via `atlassian`, `gitlab` | 1, 3, 12 | C3, C5a |
| 19 | `documentation` | nouveau | via `atlassian` | 1, 11, 12 | C3, C4, C6 |
| 20 | `specifications` | nouveau | aucun | 11, 12, 18 | C4, C5a, C6 |
| 21 | `architecture` | nouveau | aucun | 11, 12 | C4, C6 |
| 22 | `projets` | nouveau | via `atlassian`, `gitlab`, `keycloak`, `outlook` | 8, 10, 18 | C6 |
| 23 | `acces` | nouveau | via `keycloak`, `grafana` | 8, 9, 12 | C6 |
| 24 | `agents-produits` | nouveau | aucun | 11, 12 | C9 |
| 25 | `automatisations` | nouveau | aucun | 14, 16, 18, 24 | C10 |

**25 modules : 22 nouveaux et 3 existants à étendre.**

### Messages de départ

#### 1 · `atlassian` (à étendre)

> Le module Atlassian doit couvrir tout ce dont mon cockpit de produits logiciels a besoin chez Jira, Bitbucket et Confluence. Ajoute au connecteur : pour Bitbucket, les branches, les tags, la création d’un dépôt dans un projet, la lecture et l’écriture des réglages « Include Code Quality » du plugin SonarQube (n’écrire que ce qui manque, garder l’héritage du projet), et le téléchargement d’un fichier binaire ; pour Jira, les versions d’élément (Affected et Target Element Version), les versions de projet, le changelog d’un ticket (statuts et responsables, pour un planning), le rang (Rank) pour réordonner, les profils de création et les transitions avec leurs champs obligatoires, la lecture et l’envoi d’une pièce jointe ; pour Confluence, la publication d’une page à partir de Markdown et la lecture des images d’une page. Chaque fonction avec ses tests et ses données d’exemple. Tu peux t’inspirer de `/Users/alexandre/Workspace/oneapp/src/lib/bitbucketClient.ts`, `jira*.ts`, `confluenceClient.ts` et `bitbucketSonarPlugin.ts`.

Comptes : Jira, Bitbucket, Confluence (déjà ceux du module). Dépendances : aucune.

#### 2 · `jenkins` (à étendre)

> Le module Jenkins doit savoir suivre une exécution comme dans OneApp. Ajoute au connecteur : l’arbre d’une exécution (le job, les jobs qu’il a lancés en cascade, le sous-pipeline actif, l’étape en cours), les builds en file d’attente sans numéro, le lancement d’un job avec paramètres et sur un tag en rendant l’identifiant à suivre, l’arrêt d’un build, la lecture d’un journal par morceaux à partir d’une position (pour un suivi en direct) et le journal regroupé d’un build et de ses jobs enfants. Les pages existantes restent. Inspire-toi de `/Users/alexandre/Workspace/oneapp/src/lib/jenkinsClient.ts`, `jenkinsPipelineTree.ts` et `jenkinsLogBundle.ts`.

Comptes : Jenkins. Dépendances : aucune.

#### 3 · `gitlab`

> Crée un connecteur GitLab, à plusieurs comptes (gitlab.com et serveurs d’entreprise, jeton personnel), sans page pour l’instant. Fonctions : projets d’un groupe, pipelines d’un projet (dernier par branche, les pipelines en cours triés par mise à jour, détail avec ses jobs), lancement d’un pipeline sur une branche ou un tag en rendant son identifiant, arrêt, journal d’un job, artefacts d’un job et leur téléchargement, releases, merge requests (liste, détail avec commentaires, modifier, commenter), issues (liste, détail, création, modification, labels `workflow::`, milestone, commentaires, téléversements). Chaque fonction avec ses tests et ses données d’exemple. Inspire-toi de `/Users/alexandre/Workspace/oneapp/src/lib/gitlab*.ts`.

Comptes : GitLab. Dépendances : aucune.

#### 4 · `sonarqube`

> Crée un module SonarQube, à plusieurs comptes (jeton). Connecteur : quality gate d’un projet avec ses conditions en échec, mesures, date de la dernière analyse, problèmes ouverts du plus grave au moins grave, liste des quality gates et des profils par langage, création d’un projet, association d’une gate et des profils. Une page « Qualité » qui liste mes projets avec leur gate, et un panneau de détail avec les mesures, les problèmes et des recommandations. Publie un événement quand une gate passe en échec après une nouvelle analyse (relevé toutes les cinq minutes). Inspire-toi de `/Users/alexandre/Workspace/oneapp/src/lib/sonarQubeClient.ts`, `sonarAdvice.ts` et `src/components/products/SonarProjectDialog.tsx`.

Comptes : SonarQube. Dépendances : aucune.

#### 5 · `artifactory`

> Crée un connecteur Artifactory, à plusieurs comptes (jeton ou clé d’API), sans page : chercher les artefacts d’un dépôt et d’un chemin, lire leur version, leur date et leur SHA-256, et télécharger un artefact dans les fichiers du module pour que je puisse l’enregistrer où je veux. Inspire-toi de `/Users/alexandre/Workspace/oneapp/src/lib/artifactoryClient.ts`.

Comptes : Artifactory. Dépendances : aucune.

#### 6 · `portainer`

> Crée un connecteur Portainer, avec un compte par environnement (clé d’API, ou identifiant et mot de passe) et l’endpoint de chaque compte. Fonctions : conteneurs d’un endpoint avec image, tag et état, détail d’un conteneur, ses N dernières lignes de journal (et la suite depuis un instant donné), l’ouverture d’une console d’exec (shell et utilisateur au choix), la lecture d’une stack compose. Inspire-toi de `/Users/alexandre/Workspace/oneapp/src/lib/portainerClient.ts` et `src-tauri/src/services/container_console.rs`.

Comptes : Portainer (un par environnement). Dépendances : aucune.

#### 7 · `openbao`

> Crée un connecteur OpenBao, avec un compte par environnement (jeton, identifiant et mot de passe, ou OIDC) et, pour chaque compte, le montage KV et le rôle. Fonctions : parcourir les dossiers et les clés d’un chemin, lire un secret dont les valeurs restent scellées, écrire une clé (créer, modifier, supprimer), copier une clé vers un autre environnement sans écraser une valeur existante. Aucune valeur ne doit jamais apparaître dans une fonction ni dans une page autrement que par l’affichage demandé par l’utilisateur. Inspire-toi de `/Users/alexandre/Workspace/oneapp/src/lib/openBaoClient.ts` et `src-tauri/src/commands/secret_values.rs`.

Comptes : OpenBao (un par environnement). Dépendances : aucune.

#### 8 · `keycloak`

> Crée un connecteur Keycloak, avec un compte par environnement : adresse et royaume, connexion par le navigateur (PKCE, accès hors ligne). Fonctions : arborescence des groupes, membres d’un groupe, ajout et retrait d’un membre, recherche de personnes et de comptes de service, lecture et écriture d’un attribut d’une personne (`oneapp-profils`), clients applicatifs d’un royaume. Inspire-toi de `/Users/alexandre/Workspace/oneapp/src/lib/keycloak*.ts` et `src-tauri/src/services/keycloak_auth.rs`.

Comptes : Keycloak (un par environnement). Dépendances : aucune.

#### 9 · `grafana`

> Crée un connecteur Grafana, avec un compte par environnement (jeton de compte de service). Fonctions : équipes, membres d’une équipe, ajout et retrait d’un membre, dossiers de dashboards et droits d’une équipe sur un dossier, recherche d’un utilisateur. Inspire-toi de `/Users/alexandre/Workspace/oneapp/src/lib/grafana*.ts`.

Comptes : Grafana (un par environnement). Dépendances : aucune.

#### 10 · `outlook` (à étendre)

> Ajoute au module Outlook : la lecture des disponibilités d’une personne sur une période, par son e-mail, en libre, provisoire, occupé, absent ou ailleurs seulement, jamais le contenu des rendez-vous ; la lecture d’un agenda publié (lien ICS) comme autre source, pour un poste sans Outlook ; et la création d’un brouillon avec un PDF en pièce jointe. Inspire-toi de `/Users/alexandre/Workspace/oneapp/src-tauri/src/services/outlook_free_busy.rs`, `calendar_feed.rs` et `outlook.rs`.

Comptes : aucun (Outlook classique du poste) ; un agenda publié facultatif. Dépendances : aucune.

#### 11 · `depots`

> Crée un module « Dépôts » qui travaille sur les dépôts Git de mon poste. Je choisis un dossier ; le module en connaît les dépôts. Fonctions : état d’un dépôt (branche, en avance, en retard, fichiers modifiés), dernier tag de la branche principale distante et commits depuis, branches locales et distantes, changer de branche (avec alerte si des fichiers sont modifiés), fetch, pull, commit, push, clone dans un dossier, historique et diff d’un fichier, lecture et écriture d’un fichier texte du dépôt, lecture d’un compose, ouverture d’un terminal dans un dossier. Une page « Dépôts » qui liste mes dépôts avec leur état et ces actions. Inspire-toi des commandes `*_local_git_*` de `/Users/alexandre/Workspace/oneapp/src-tauri/src/lib.rs`, de `git_main_release.rs` et de `src/lib/localGitBatch.ts`.

Comptes : aucun. Dépendances : aucune.

#### 12 · `produits`

> Crée le module « Produits », cœur de mon cockpit. Un produit logiciel a un nom, une clé, un glyphe, une description et des composants logiciels ; chaque composant a des liaisons vers ses outils : dépôt et CI obligatoires, artefact, tickets, qualité, conteneurs et secrets facultatifs. Une liaison vise un de mes comptes (Bitbucket, GitLab, Jenkins, Jira, SonarQube, Artifactory) et une ressource de ce compte, choisie dans la liste que donne le connecteur. Les environnements (nom, type intégration, préproduction ou production, ordre, comptes Portainer, OpenBao, Keycloak et Grafana, URL de base) sont communs à tous les produits. Chaque produit a son espace local (un dossier, un sous-dossier par composant). Je veux une entrée du menu par produit, un assistant de création en étapes, le tableau des liaisons dont chaque case ouvre ce qu’il faut compléter, une page des environnements, la corbeille, l’historique, l’export et l’import d’un produit, et la vérification des incohérences. Partage les produits et les environnements avec mon équipe. Inspire-toi de `CONTEXT.md` de OneApp, de `/Users/alexandre/Workspace/oneapp/src/components/products/` et de `src/lib/productsRepository.ts`.

Comptes : aucun en propre ; liaisons vers ceux des connecteurs. Dépendances : 1 à 9, 11.

#### 13 · `reprise-oneapp`

> Crée un module de reprise de OneApp. Il lit les dépôts de configuration partagée de OneApp (dossier `.oneapp/` : produits, connexions, environnements, accès, réglages des agents) que je lui indique, ainsi que le fichier d’export d’un poste OneApp, et propose un aperçu : produits, composants et liaisons, environnements, comptes à créer (adresse et méthode, sans secret), profils d’accès, consignes et skills des agents. Sur ma validation, il remplit les modules Produits et Accès et crée les comptes manquants, rapprochés par type et adresse avec ceux que j’ai déjà ; je n’aurai plus qu’à donner mes jetons dans la configuration des modules. Rien n’est écrit dans les dépôts de OneApp. Inspire-toi de `/Users/alexandre/Workspace/oneapp/src-tauri/src/services/synchronization/` et `docs/matrice-synchronisation-configurations-partagees.md`.

Comptes : aucun. Dépendances : 12 (et 23 pour les profils d’accès, importés quand il existe).

#### 14 · `ci`

> Crée le module « CI » sur mes produits : pour chaque composant, la dernière exécution de la branche du poste et l’historique, filtrable par branche, tags ou toutes ; une ligne par exécution avec sa référence, son numéro, son âge et une barre de progression (étape, job, durée estimée) ; relancer, arrêter, lancer la CI d’un tag ; les exécutions par tag. Une exécution que je lance est suivie jusqu’à sa fin, quelle que soit sa branche ; sa fin me prévient (réussite brève, échec qui reste, avec « Journal ») et publie un événement « exécution terminée ». Une sonde regarde toutes les 10 secondes, toutes les 3 pendant une exécution, et un point bleu signale une exécution lancée ailleurs. Le journal d’un build s’ouvre dans sa fenêtre, avec étapes, recherche, filtre des erreurs et suivi en direct, et « Analyser » par l’IA. Inspire-toi de `/Users/alexandre/Workspace/oneapp/src/hooks/usePipelines.ts`, `src/lib/ciLaunchedRuns.ts`, `ciRunTiming.ts`, `ciLogDiagnostics.ts`, `src/pages/dashboard/CiLogWindowPage.tsx` et de l’ADR 0020.

Comptes : via `jenkins` et `gitlab`. Dépendances : 2, 3, 11, 12.

#### 15 · `deploiements`

> Crée le module « Déploiements » : pour chaque composant, ses conteneurs déclarés suivis dans chaque environnement, avec leur état (à jour, autre version, arrêté, non déployé, indisponible) ; la version attendue est le dernier tag du dépôt, vérifiée en production seulement. Une page « Usine » : tous les produits dans une table, une colonne par environnement, avec version, note et ancienneté. Les journaux d’un conteneur s’ouvrent dans leur fenêtre (nombre de lignes, niveaux avec compteurs, recherche, suivi en direct, horodatage, copie, téléchargement) ; la console aussi (shell, utilisateur, historique, effacer). Ouvrir l’URL du composant dans un environnement. Publie un événement « nouveau déploiement » et « conteneur arrêté ». Inspire-toi de `/Users/alexandre/Workspace/oneapp/src/components/products/DeploymentMatrix.tsx`, `src/lib/deploymentStatus.ts`, `src/pages/factory/FactoryPage.tsx` et `src/pages/dashboard/Container*.tsx`.

Comptes : via `portainer`. Dépendances : 6, 12.

#### 16 · `secrets`

> Crée le module « Secrets » sur mes produits : l’inventaire des secrets d’un composant dans chaque environnement, aux portées racine, partagée, produit et composant, avec le nom de variable d’environnement de chaque clé ; une fenêtre en matrice clés × environnements où un clic sur une case ouvre le détail de cet environnement et un clic sur un nom tous les environnements ; afficher une valeur seulement à ma demande ; ajouter, modifier, supprimer, copier une clé vers un autre environnement sans écraser ; écrire un fichier `.env` dans le dossier d’un composant sans que la valeur passe par la page ; une page Secrets globale en tableau ou en arborescence. Inspire-toi de `/Users/alexandre/Workspace/oneapp/src/components/secrets/ComponentSecretsDialog.tsx`, `src/lib/secretInventory.ts` et de la définition « Portée de secret » de `CONTEXT.md`.

Comptes : via `openbao`. Dépendances : 7, 12.

#### 17 · `cockpit`

> Crée la vue produit de mon cockpit : sur l’entrée de chaque produit, un onglet « Composants » avec une carte d’état par composant (pastilles CI avec point bleu pendant une exécution, dernier tag, Qualité, Déploiement ; écarts Git ; carte grisée si le dépôt n’est pas cloné), ou la même chose en tableau. Le panneau de droite du composant a des sections repliables et déplaçables : Git (état, dernier tag, PR, fetch, pull, commit, push, changement de branche), Pull requests, CI, Artefact (dernier livré, copier le SHA, télécharger), Déploiement, Qualité, Secrets ; un clic sur une pastille de carte va à sa section ; le dernier composant ouvert est retenu. Les actions Git sur tous les composants sont dans la barre du haut. L’entrée du produit montre l’état le plus grave de ses composants. Reprends les modules CI, Déploiements, Secrets, SonarQube, Artifactory, Atlassian et Dépôts, sans refaire leurs fonctions. Inspire-toi de `/Users/alexandre/Workspace/oneapp/src/components/products/ComponentCard.tsx`, `ComponentDetailSections.tsx` et de la note « Vue produit » de la maquette.

Comptes : via les connecteurs. Dépendances : 1, 4, 5, 11, 12, 14, 15, 16.

#### 18 · `tickets`

> Crée le module « Tickets » sur mes produits, pour Jira et GitLab avec un vocabulaire commun : types Tâche, Bug, Évolution ; états À faire, En cours, Suspendu, Résolu, Clôturé. Un onglet « Tickets » sur l’entrée de chaque produit : liste filtrable (type, état, responsable, période) en table ou en liste ; détail dans le panneau ou dans sa fenêtre, avec champs modifiables, versions affectée et cible, pièces jointes, commentaires avec mentions, exigences liées ; transitions avec leurs prérequis et une justification ajoutée en commentaire ; création par type avec une rédaction proposée par l’IA. Publie un événement quand un ticket est créé ou change d’état. Inspire-toi de `/Users/alexandre/Workspace/oneapp/src/components/tickets/`, `src/lib/ticketProvider.ts`, `ticketWorkflow.ts` et des outils `get_ticket` et `update_ticket` de `docs/mcp.md`.

Comptes : via `atlassian` et `gitlab`. Dépendances : 1, 3, 12.

#### 19 · `documentation`

> Crée le module « Documentation » sur mes produits, avec deux onglets sur l’entrée de chaque produit. « Confluence » : Aperçu de la page publiée, avec ses images gardées pour une lecture hors ligne, et Modification en Markdown enregistrée dans `docs/index.md` du dépôt ; Enregistrer fait un commit, Publier convertit et envoie dans Confluence. « Change log » : les versions de `CHANGELOG.md` (numéro, date, texte), ajouter, modifier, supprimer ; « Mettre à jour depuis Git » propose une section par tag absent, rédigée par l’IA depuis ses commits, que je valide avant écriture ; Enregistrer fait un commit ; sans clone, lecture seule depuis Bitbucket. Inspire-toi de `/Users/alexandre/Workspace/oneapp/src/components/documentation/DocumentationView.tsx`, `ChangelogView.tsx` et `src/lib/changelog.ts`.

Comptes : via `atlassian`. Dépendances : 1, 11, 12.

#### 20 · `specifications`

> Crée le module « Spécifications » sur mes produits, versionné dans le dépôt porteur du produit (`.oneapp/specifications/`, même format que OneApp pour qu’il reste lisible des deux côtés) : exigences à clé stable avec critères d’acceptation et révisions, tickets traités ; fiches de test (préconditions, étapes, résultats attendus, critères couverts) ; exécutions de test immuables ; couverture et vérification calculées ; matrice de traçabilité ; cahier d’exigences et cahier de tests en chapitres, exportés en PDF avec notre gabarit ; historique et diff Git de chaque élément, commit par élément. Rédaction, extraction depuis un document et génération de fiches proposées par l’IA, jamais écrites sans ma validation. Onglets « Exigences » et « Tests » sur l’entrée du produit. Inspire-toi de `/Users/alexandre/Workspace/oneapp/docs/specifications-format.md`, `src/components/specifications/` et `src/lib/specifications.ts`.

Comptes : aucun. Dépendances : 11, 12, 18.

#### 21 · `architecture`

> Crée le module « Architecture » : le dossier d’architecture de chaque produit, versionné dans son dépôt, avec cartouche, sections en Markdown, schéma C4 (contexte, conteneurs, composants) que je peux éditer et réorganiser, conception détaillée des composants, contrats des interfaces, approbations et signatures, état de complétude, export Markdown et PDF avec notre gabarit. Un onglet « Architecture » sur l’entrée du produit. Inspire-toi de `/Users/alexandre/Workspace/oneapp/src/components/documentation/Architecture*.tsx`, `src/lib/architecture*.ts` et des outils `*_architecture_*` de `docs/mcp.md`.

Comptes : aucun. Dépendances : 11, 12.

#### 22 · `projets`

> Crée le module « Projets », partagé avec mon équipe : les équipes et leurs personnes, ajoutées depuis Keycloak ; un kanban (À faire, En cours, Suspendu, Terminé) avec les tickets disponibles et la raison (sans responsable, sans durée, responsable non relié), filtres équipe, produits, personne et recherche, une justification à chaque déplacement, l’ordre de chaque personne lu et écrit dans le rang Jira ou la position GitLab ; un planning qui planifie le futur depuis la durée restante et les disponibilités, et montre le passé réel lu dans l’historique des tickets ; les absences importées depuis Outlook ou un agenda publié, les absences saisies à la main n’étant jamais retirées. Un responsable se reconnaît par son compte relié, puis son identifiant Keycloak, son e-mail, son nom. Inspire-toi de `/Users/alexandre/Workspace/oneapp/src/components/projects/` et `src/lib/projectManagement.ts`, `projectTimeline.ts`, `memberAbsences.ts`.

Comptes : via `atlassian`, `gitlab`, `keycloak`, `outlook`. Dépendances : 8, 10, 18.

#### 23 · `acces`

> Crée le module « Accès », partagé avec mon équipe : des profils d’accès (nom, description, groupes Keycloak, équipes Grafana), une matrice avec une ligne par personne et une colonne par environnement (conforme, écart, sans accès) ; une case ouvre l’action utile : réaligner après un aperçu des changements, modifier, ajouter la personne. Le profil d’une personne est écrit dans son attribut Keycloak `oneapp-profils` puis relu pour vérification. Export de l’audit en CSV. Inspire-toi de `/Users/alexandre/Workspace/oneapp/src/pages/access/AccessPage.tsx`, `src/components/access/`, `src/lib/access*.ts` et des ADR 0006 et 0007.

Comptes : via `keycloak` et `grafana`. Dépendances : 8, 9, 12.

#### 24 · `agents-produits`

> Crée le module « Agents des produits » : pour chaque produit et pour chaque source partagée, les consignes et la sélection de skills que reçoivent ses agents (celles de la source avant celles du produit ; la sélection du produit remplace celle de la source ; un composant hérite de son produit) ; « Lancer un agent » sur un produit ou un composant, dans son dossier, avec ses consignes, ses skills et les outils de mes modules limités à ce produit ; « Envoyer à un agent » depuis un ticket, une exigence ou un journal, avec le contexte de la page ; le choix confidentiel. Offre à l’agent les opérations de mes modules qui servent sur un produit (tickets, CI avec relance à la fin, journaux, qualité, déploiements, secrets sans valeur, spécifications, architecture). Inspire-toi de l’ADR 0019 et du catalogue de `docs/mcp.md` de OneApp.

Comptes : aucun. Dépendances : 11, 12 (et les modules dont il offre les fonctions).

#### 25 · `automatisations`

> Crée le module « Automatisations » : une règle a un déclencheur (CI en échec ou réussie, erreur repérée dans un journal de CI, quality gate en échec, ticket créé ou changé d’état, pull request ouverte ou fusionnée, nouveau déploiement ou conteneur arrêté, planification cron, script qui émet de nouveaux éléments), un périmètre (tous les produits, ou une sélection de produits et de composants), une consigne pour l’agent, la confidentialité, et lance un nouvel agent ou parle à un agent existant ; elle peut demander une confirmation avant de lancer. Seules les occurrences observées pendant que je suis là comptent, une fois chacune ; une planification manquée est rattrapée une fois. Un journal des 200 derniers déclenchements avec « Ouvrir ». Un agent peut me proposer une automatisation, inactive tant que je ne l’active pas. Inspire-toi de `/Users/alexandre/Workspace/oneapp/src/lib/automations.ts`, `automationRunner.ts`, `src/components/automations/` et des ADR 0009 et 0011.

Comptes : aucun. Dépendances : 14, 16, 18, 24.

---

## Migration des données et des utilisateurs

### Ce qui migre, et comment

| Donnée de OneApp | Où elle est | Destination dans Alfred | Comment |
|---|---|---|---|
| Produits, composants, liaisons | `.oneapp/products/*.json` des sources partagées | tables de `produits` | module `reprise-oneapp`, aperçu puis import ; liaisons réécrites vers les comptes Alfred (`client/instance`) |
| Environnements | `.oneapp/environments/*.json` | `produits_environnements` | idem |
| Connexions | `.oneapp/connections/*.json` (sans secret) | comptes Alfred des connecteurs | idem ; rapprochées par type et adresse avec les comptes existants (C2) ; chaque personne redonne son jeton dans l’onboarding |
| Définition des accès | `.oneapp/settings/access.json` | tables de `acces` | idem |
| Réglages des agents d’une source et des produits | `.oneapp/settings/agents.json`, champ `agents` des produits | tables de `agents-produits` | idem |
| Spécifications, change log, architecture, `docs/index.md` | dépôts Git des produits (`.oneapp/specifications/`, `CHANGELOG.md`, …) | inchangé | les modules lisent les mêmes fichiers au même format : rien à migrer, OneApp et Alfred les lisent tous deux pendant la transition |
| Réglages personnels du poste (mode d’authentification, chemins locaux, ordre, produits masqués, intervalles, TLS) | base SQLite de OneApp | comptes et tables locales (non partagées) | export « Portabilité » de OneApp lu par `reprise-oneapp`, ou lecture seule de la base par une fonction en script |
| Identifiants (jetons, mots de passe) | coffre du système (Windows, Trousseau) | coffre d’Alfred | **non migrés par défaut** : redonnés dans l’onboarding. Option : `vault_store` avec `fromCommand` qui lit l’entrée de OneApp dans le coffre du système, sans que l’agent voie la valeur (question 4) |
| Automatisations et leur journal | base SQLite de OneApp, locales au poste | tables de `automatisations` | reprises par `reprise-oneapp` depuis l’export, inactives, à réactiver une à une |
| Conversations d’agents | une ligne par agent dans SQLite ; déroulé dans l’historique des CLI (ADR 0017) | page Agent | **non reprises comme conversations actives** ; option : un index en lecture seule (titre, produit, date, dernier message) (question 5) |
| Sauvegardes, brouillons, cache | SQLite, stockage protégé | — | non migrés |

### Ordre de bascule pour une équipe

1. Les modules sont publiés dans le marketplace de l’équipe (ou `alfred.place`), avec leurs dépendances.
2. Une personne de l’équipe installe Alfred, crée un espace, importe le module `cockpit` (qui tire les autres) et `reprise-oneapp`, pointe la reprise vers les dépôts `.oneapp/` de l’équipe, valide l’aperçu, relie les modules partagés (`produits`, `acces`, `projets`, `agents-produits`) au **nouveau** dépôt de partage d’Alfred.
3. Les autres personnes importent les mêmes modules et relient le même dépôt : produits, environnements, accès et définitions de comptes arrivent ; l’onboarding leur demande seulement leurs jetons.
4. Pendant la transition, OneApp reste installé ; ses dépôts `.oneapp/` ne reçoivent plus de modification (sauf si la compatibilité de C7 est retenue). Les spécifications et la documentation dans les dépôts des produits restent communes aux deux.
5. Fin de transition : retrait de OneApp, archivage des dépôts `.oneapp/` de configuration.

---

## Risques

| Risque | Effet | Parade |
|---|---|---|
| Modules créés avant leurs chantiers | refaits quand le SDK change ; ou pire, `openbao` sans C1 ferait lire des valeurs de secrets | respecter la colonne « Étape 1 » ; `check` signale déjà les écarts aux règles |
| Taille du travail confié à l’agent d’Alfred | 25 modules, plusieurs centaines de fonctions avec tests et exemples ; qualité inégale d’un module à l’autre | un message par module, vérification visuelle à chaque livraison, revue des connecteurs avant publication |
| Tests contre de vrais services | les tests de lecture tournent sur les comptes de l’utilisateur ; les services d’entreprise ne sont joignables que du réseau de l’entreprise | données d’exemple pour développer hors réseau ; tests d’écriture lancés à la main sur des cibles de test |
| Limites des fonctions | 120 s par appel, 5 000 lignes par requête, 20 Mo par réponse, 40 appels simultanés | tâches de fond pour les relevés complets ; pagination ; `download` (C3) |
| Cadres recréés à chaque changement d’onglet | l’état React des pages se perd (filtres, sélection) | tables locales du module pour ce qui doit durer ; `usePageState` |
| Performances avec beaucoup de produits | une entrée de menu par produit et des sondes par composant multiplient les appels | entrées et sondes portées par la coque (C5), cache des clients |
| Cohabitation OneApp / Alfred dans une équipe | sans C7 « compatibilité », les deux ne partagent plus le catalogue | bascule par équipe entière, ou compatibilité `.oneapp/` (question 1) |
| Chantier desktop-kit en pause | C8 écrit dans Alfred puis à extraire, ou attendu dans `agents-kit` | décider avant C8 (question 3) |
| Windows | COM d’Outlook, PowerShell 5.1, Git Bash, échelle et contraste à vérifier pour chaque nouveau composant | C12 en continu, validation sur un poste Windows à chaque chantier |
| Vocabulaire | OneApp évite « module » pour un composant ; Alfred appelle « module » ses briques | l’agent d’Alfred ne dit jamais « module » à l’utilisateur ; les pages gardent « composant logiciel » |

## Ce que l’utilisateur perd ou voit changer

- **Connexion par adresse collée** : OneApp reconnaît l’outil depuis une adresse ; Alfred guide par l’onboarding de chaque module.
- **« Connexion » devient « compte »**, réglé dans la fiche du module ou son onboarding ; un compte sert à toutes les pages qui en ont besoin.
- **Assistant global** : OneApp l’a déjà remplacé par des agents autonomes ; l’historique de l’ancien assistant n’est pas repris.
- **Autorisations des agents** : Codex tournait en accès complet sans approbation chez OneApp ; Alfred demande selon le niveau d’autonomie (niveau « dossier du produit » prévu par C9).
- **Partage d’équipe** : nouveau dépôt de partage, nouvelles règles tant que C7 n’est pas livré (la version de l’équipe l’emporte, pas d’aperçu ni de choix).
- **Conversations d’agents et automatisations** : les conversations ne reprennent pas ; les automatisations reviennent inactives.
- **Jetons** à redonner une fois, sauf reprise depuis le coffre du système (question 4).
- **MCP externe** et **rapports de plantage anonymisés** : absents tant que C13 et un équivalent ne sont pas faits.
- **Gains** : chaque élément devient modifiable en parlant à l’agent ; annulation d’un tour par commit de l’espace ; voix ; décisions locales ; données d’exemple ; historique et sauvegardes par module ; Claude Code comme troisième harnais.

## Questions pour l’utilisateur

1. **Partage d’équipe** : migration ponctuelle des dépôts `.oneapp/` vers le partage d’Alfred (recommandé, C7 réduit à L), ou compatibilité pour que des postes OneApp et Alfred partagent le même catalogue pendant la transition (C7 en XL) ?
2. **Navigation** : une entrée du menu par produit, fournie par le module (C5a, recommandé), ou des pages que l’utilisateur crée lui-même par produit à partir d’un modèle, sans chantier ?
3. **Moteur des agents** : écrire C8 directement dans Alfred, ou d’abord la bibliothèque commune `agents-kit` (ADR 0023 de OneApp, chantier desktop-kit en pause) pour la partager pendant la transition ?
4. **Jetons** : faut-il reprendre les identifiants de OneApp depuis le coffre du système (sans qu’ils passent par l’agent), ou les faire redonner à chacun ?
5. **Conversations d’agents** : un index en lecture seule des agents de OneApp suffit-il, ou rien du tout ?
6. **Délégation (C11) et MCP externe (C13)** : à porter, ou à abandonner avec l’assistant global ?
7. **Autonomie des agents de produit** : le niveau « dossier du produit » (modifications et commandes dans le dossier sans demande) convient-il comme défaut, à la place de l’accès complet de OneApp ?
8. **Marketplace** : les modules du cockpit vont-ils dans `alfred.place` (public) ou dans un marketplace privé de l’équipe ? Plusieurs décrivent des outils internes (Thales, gabarits PDF).
9. **Gabarit PDF d’entreprise** (polices, cartouche de `thalesPdf.ts`) : peut-il être rangé dans un module publié, ou doit-il rester hors du marketplace ?
