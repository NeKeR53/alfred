# Fonctions de OneApp : inventaire complet

Étude de migration de OneApp vers Alfred, livrable 1 sur 4. État de OneApp lu le 20 novembre 2026 sur `main` du dépôt `/Users/alexandre/Workspace/oneapp`, y compris le travail non commité des sessions sœurs décrit dans le dossier de notes partagé (vue produit v4, panneau de droite unique, agents dans la navigation, secrets en modale, suivi des CI de tags, bascule sur `opencode serve`).

Chaque fonction porte un identifiant (`PRD-03`, `CI-07`…) repris dans [correspondance.md](correspondance.md). Les chemins sont relatifs au dépôt OneApp. Le vocabulaire suit `CONTEXT.md` de OneApp : *produit logiciel*, *composant logiciel*, *liaison*, *connexion*, *environnement*, *exécution*, *artefact*, *source de configuration partagée*, *déclaration partagée*, *agent*, *automatisation*, *suivi*.

Ordre de grandeur du code : 168 700 lignes TypeScript (`src/`), 50 200 lignes Rust (`src-tauri/src/`), 63 outils MCP, 23 ADR.

## Navigation générale de OneApp

- **Barre de gauche** : une entrée par produit logiciel (glyphe, nom, pastille d’état), puis la section **Agents** (agents non archivés avec leur état), puis Projets, Usine, Secrets, Accès, Réglages (`src/components/shell/AppShell.tsx`, `SidebarNavigation.tsx`, `src/components/agents/AgentNavigationSection.tsx`).
- **Vues d’un produit** (onglets texte à gauche de la barre du haut) : Composants, Tickets, Exigences, Tests, Architecture, Confluence, Change log (`src/components/products/ProductViewTabs.tsx`, `src/pages/dashboard/Dashboard.tsx`).
- **Panneau de droite unique** (`src/components/shared/RightPanel.tsx`) : détail du composant, ticket ouvert, plan d’un livrable, édition d’un outil, d’un environnement ou d’une personne ; sections `InfoPanel` repliables et déplaçables.
- **Fenêtres secondaires** : journal CI, journaux et console de conteneur, ticket, spécifications, fenêtre Agents détachée (`src/lib/windowOpeners.ts`, `src-tauri/src/windows.rs`).

---

## 1. Produits logiciels, composants, liaisons et connexions

| Id | Fonction | Ce qu’elle fait pour l’utilisateur | Fournisseurs | Fichiers de référence |
|---|---|---|---|---|
| PRD-01 | Catalogue des produits logiciels | Liste, recherche, ordre et masquage des produits dans la barre de gauche ; corbeille avec restauration et purge. | — | `src/lib/productsRepository.ts`, `src/lib/productDirectory.ts`, `src-tauri/src/commands/catalog.rs`, `src/pages/settings/trash/TrashPage.tsx` |
| PRD-02 | Assistant de création d’un produit | Parcours en étapes : identité (nom, clé, glyphe), composants, liaisons, documentation, espace local, réglages des agents, résumé. | tous | `src/components/products/wizard/ProductWizard.tsx`, `src/lib/productWizard.ts`, `src/components/products/NewProductDialog.tsx` |
| PRD-03 | Composants logiciels et liaisons | Un composant relie dépôt et CI (obligatoires), artefact, tickets, qualité, conteneurs et secrets (facultatifs). Tableau des liaisons dont chaque case ouvre l’étape à compléter. | Bitbucket, GitLab, Jenkins, Jira, SonarQube, Artifactory, Portainer, OpenBao | `src/components/products/ComponentLiaisonTable.tsx`, `src/lib/componentLiaisonCells.ts`, `src/components/products/associations/*` |
| PRD-04 | Choix d’une ressource pour une liaison | Liste les dépôts, jobs, projets SonarQube, projets et composants Jira d’une connexion ; crée un dépôt Bitbucket ou un composant Jira manquant. | Bitbucket, GitLab, Jenkins, SonarQube, Jira | `src/components/products/associations/ResourcePicker.tsx`, `BitbucketRepositoryCreation.tsx`, `JiraComponentCreation.tsx`, `src/lib/mcp/mcpConnectionResources.ts` |
| PRD-05 | Import d’un composant depuis GitLab | Crée les composants d’un produit à partir des projets d’un groupe GitLab. | GitLab | `src/components/products/GitLabComponentImport.tsx`, `src/lib/gitlabComponentImport.ts` |
| PRD-06 | Espace local d’un produit | Dossier du produit (un sous-dossier Git par composant) ou dépôt unique ; découverte des clones existants, création des dossiers, clonage. | Git local | `src/lib/localWorkspace.ts`, `src/lib/localProductDiscovery.ts`, `src/components/products/LocalWorkspaceView.tsx`, `src-tauri/src/commands/local_files.rs` |
| PRD-07 | Lecture distante d’un dépôt | Sans clone, documentation, branches et CI lus en lecture seule sur Bitbucket (ADR 0013). | Bitbucket | `src/lib/remoteRepository.ts`, `docs/adr/0013-depot-distant-en-lecture-seule.md` |
| PRD-08 | Endpoint principal et URL ouvrable | Compose l’URL d’un composant avec l’URL de base de l’environnement ; menu « Ouvrir » par environnement. | — | `src/components/dashboard/PrimaryEndpointMenu.tsx`, `src/lib/deploymentEndpoints.ts` |
| PRD-09 | Connexions (outils connectés) | Collage d’une adresse qui reconnaît l’outil, formulaire manuel, mode d’authentification propre au poste, TLS non vérifié, intervalle d’actualisation ; état réel « Connectée / Hors ligne / À vérifier », « Reconnecter », « Vérifier toutes les connexions ». | 12 types | `src/pages/settings/connections/ConnectionsPage.tsx`, `src/components/connections/*`, `src/lib/connectionsRepository.ts`, `src/lib/connectionHealth.ts`, `src/lib/toolAddress.ts` |
| PRD-10 | Environnements | Cible de déploiement (nom, type intégration / préproduction / production, ordre, connexion Portainer et endpoint, URL de base) reliée à OpenBao, Keycloak et Grafana ; boutons Secrets, Groupes, Clients. | Portainer, OpenBao, Keycloak, Grafana | `src/pages/settings/environments/EnvironmentsPage.tsx`, `src/lib/environmentsRepository.ts` |
| PRD-11 | Portabilité d’un produit | Export d’un fichier de configuration d’un produit et import avec aperçu. | — | `src/lib/productConfigurationExport.ts`, `src/lib/productConfigurationImport.ts`, `src-tauri/src/commands/portability.rs` |
| PRD-12 | Annulation et historique du catalogue | Annuler la dernière modification du catalogue ; historique des changements. | — | `src/lib/catalogUndo.ts`, `src/lib/catalogHistory.ts` |
| PRD-13 | Commandes locales d’un composant | Commandes nommées (icône, commande, dossier) lancées dans un terminal du poste, avec un environnement construit à partir des secrets OpenBao (`.env` écrit nativement). | shell local, OpenBao | `src/components/products/LocalCommandGlyph.tsx`, `src/components/products/workspace/CommandEnvironmentDialog.tsx`, `src-tauri/src/services/local_shell.rs`, `src-tauri/src/commands/secret_values.rs` (`save_environment_file`) |
| PRD-14 | Incohérences de configuration | `get_product` signale liaisons cassées, connexions absentes, dossiers introuvables. | — | `src/lib/settingsRelations.ts`, `src/lib/productCapabilities.ts` |

## 2. Vue produit

| Id | Fonction | Ce qu’elle fait pour l’utilisateur | Fournisseurs | Fichiers de référence |
|---|---|---|---|---|
| VUE-01 | Cartes d’état des composants | Une carte par composant (340–412 px) avec 4 pastilles sans texte : CI (point bleu si une exécution tourne), dernier tag, Qualité, Déploiement (pire état) ; écarts Git en pastilles ; carte grisée si non cloné. | tous | `src/components/products/ComponentCard.tsx`, `src/components/products/workspace/WorkspaceCardsView.tsx`, `src/lib/workspaceComponentStatus.ts` |
| VUE-02 | Vue tableau des composants | Même contenu en table, tri, colonnes, menu contextuel. | tous | `src/components/products/workspace/WorkspaceTableView.tsx`, `WorkspaceContextMenu.tsx` |
| VUE-03 | Panneau de détail d’un composant | Sections `InfoPanel` repliables et déplaçables (Alt+↑/↓) : Git, Pull requests, CI, Artefact, Déploiement, Qualité, Secrets ; un clic sur une pastille fait défiler jusqu’à sa section ; dernier composant mémorisé. | tous | `src/components/products/ComponentDetailPanel.tsx`, `ComponentDetailSections.tsx`, `src/components/products/workspace/WorkspaceComponentDetail.tsx`, `src/lib/infoPanelLayout.ts` |
| VUE-04 | Section Git | État de la branche, dernier tag d’`origin/HEAD` et commits depuis ; fetch, pull, commit, push, clone ; sélecteur de branche (locales, distantes, alerte si fichiers modifiés). Actions groupées sur tous les composants dans la barre du haut. | Git local | `src/components/products/ProductGitSection.tsx`, `src/lib/localGitBatch.ts`, `src-tauri/src/git_main_release.rs`, commandes `*_local_git_*` de `src-tauri/src/lib.rs` |
| VUE-05 | Section Pull requests | PR ouvertes (source → cible, auteur, approbations, conflits, CI) ; filtres ; détail avec commentaires ; modifier titre et description ; commenter. | Bitbucket, GitLab | `src/components/dashboard/PullRequestsView.tsx`, `src/lib/pullRequestProvider.ts`, `src/lib/pullRequestFilters.ts`, `src/lib/gitlabMergeRequests.ts` |
| VUE-06 | Section CI | Filtre Branche / Tags / Toutes, une ligne par exécution (référence, numéro, âge, barre de progression), Journal et Relancer/Arrêter au survol. | Jenkins, GitLab | voir CI-01 à CI-09 |
| VUE-07 | Section Tag et release | Dernier tag, commits de `main` depuis, exécutions par tag (en cours, en file, réussie, échec, jamais exécutée + lancer). | Git local, Jenkins, GitLab | `src/lib/ciLaunchedRuns.ts`, ADR 0020 |
| VUE-08 | Section Artefact | Dernier artefact livré, copie du SHA, téléchargement ; liste de tous les artefacts. | Artifactory, GitLab | `src/lib/artifactoryClient.ts`, `src/lib/gitlabArtifacts.ts`, `src/components/dashboard/ArtifactsTable.tsx`, `src/lib/artifactFiles.ts` |
| VUE-09 | Section Déploiement | Conteneurs surveillés groupés par environnement : à jour, autre version (1.7.4 → 1.8.2), arrêté, non déployé, indisponible ; journaux, console, URL au survol. Version attendue vérifiée en production seulement. | Portainer | `src/components/products/DeploymentMatrix.tsx`, `src/lib/deploymentStatus.ts` |
| VUE-10 | Section Qualité | Quality gate, mesures, recommandations. | SonarQube | `src/components/products/ComponentQualitySection.tsx`, `src/lib/sonarAdvice.ts` |
| VUE-11 | Section Secrets | Présence des secrets du composant ; ouvre la modale des secrets (SEC-03). | OpenBao | `src/components/secrets/SecretPresence.tsx` |
| VUE-12 | Usine | Tous les produits dans une table, une colonne par environnement : version, note et ancienneté de chaque conteneur. | Portainer | `src/pages/factory/FactoryPage.tsx` |
| VUE-13 | Activité et historique | Activité récente d’un produit (CI, artefacts, tickets) en frise. | tous | `src/components/dashboard/ActivityPage.tsx`, `HistoryTimeline.tsx`, `src/lib/dashboardActivity.ts` |
| VUE-14 | Affichage immédiat et cache | Chaque vue s’affiche aussitôt depuis le cache de session puis le cache local (SQLite), relit en arrière-plan ; F5 force la relecture. | — | `src/lib/sharedResource.ts`, `src/lib/providerCache.ts`, `src-tauri/src/commands/provider_cache.rs` |

## 3. CI (GitLab, Jenkins, suivi des tags, progression)

| Id | Fonction | Ce qu’elle fait pour l’utilisateur | Fournisseurs | Fichiers de référence |
|---|---|---|---|---|
| CI-01 | Dernière exécution et historique | Pipeline de la branche du poste, puis historique du plus récent au plus ancien. | Jenkins, GitLab | `src/hooks/usePipelines.ts`, `src/lib/gitlabPipelines.ts`, `src/lib/jenkinsClient.ts` |
| CI-02 | Arbre des pipelines Jenkins | Job et jobs lancés en cascade, sous-pipeline actif, étape en cours, builds en file (`inQueue`). | Jenkins | `src/lib/jenkinsPipelineTree.ts`, `src/lib/ciPipelineView.ts` |
| CI-03 | Lancer, relancer, arrêter | Une seule exécution démarrée ; elle remonte en tête ; arrêt d’une exécution en cours ; lancement sur un tag. | Jenkins, GitLab | `src/hooks/usePipelines.ts` (`startExecution`), `src/lib/ciExecutions.ts` |
| CI-04 | Suivi des exécutions lancées | Une exécution lancée depuis OneApp est suivie par son identifiant jusqu’à sa fin, quelle que soit sa référence (ADR 0020) ; notification de fin (succès 5 s, échec persistant, action « Journal »). | Jenkins, GitLab | `src/lib/ciLaunchedRuns.ts`, `useLaunchedCiRunWatcher` (`src/App.tsx`), `docs/adr/0020-*.md` |
| CI-05 | Sonde d’activité | Toutes les 10 s au repos, 3 s pendant une exécution ; relevé complet seulement sur changement ; point bleu pour une exécution lancée hors de OneApp. | Jenkins, GitLab | `src/hooks/usePipelines.ts`, `src/lib/gitlabClient.ts` (`listRunningGitLabPipelines`) |
| CI-06 | Progression et durée | Étape · job, barre de 2 px, durée estimée d’après les exécutions précédentes. | Jenkins, GitLab | `src/lib/ciRunTiming.ts` |
| CI-07 | Fenêtre de journal CI | Journal de ce build précis, étapes et pipelines appelés, recherche, filtre Tout / Erreurs, suivi en direct, copie. | Jenkins, GitLab | `src/pages/dashboard/CiLogWindowPage.tsx`, `src/lib/ciLogWindow.ts`, `src/lib/jenkinsLogBundle.ts`, `src/components/logs/*` |
| CI-08 | Diagnostic d’un journal | Repère erreurs et avertissements, propose « Analyser » par un appel unique au modèle. | — | `src/lib/ciLogDiagnostics.ts`, `src/lib/logAnalysis.ts`, `src/components/logs/LogAnalysisAction.tsx` |
| CI-09 | Préférences de vue CI | Filtre, colonnes, repli mémorisés. | — | `src/lib/ciViewPreferences.ts` |
| CI-10 | Releases GitLab | Lecture des releases d’un projet. | GitLab | `src/lib/gitlabReleases.ts` |

## 4. Sonar

| Id | Fonction | Ce qu’elle fait pour l’utilisateur | Fournisseurs | Fichiers de référence |
|---|---|---|---|---|
| SON-01 | Qualité d’un composant | Quality gate, conditions en échec, mesures, dernière analyse, recommandations ; problèmes ouverts, les plus graves d’abord. | SonarQube | `src/lib/sonarQubeClient.ts`, `src/components/products/componentQualitySummary.ts`, outil MCP `get_component_quality` |
| SON-02 | Configurer le projet SonarQube | Crée le projet s’il manque, choisit la quality gate et les profils par langage, relie le dépôt Bitbucket. | SonarQube, Bitbucket | `src/components/products/SonarProjectDialog.tsx` |
| SON-03 | Plugin Bitbucket « Include Code Quality » | N’écrit que ce qui manque, respecte l’héritage du projet Bitbucket, conserve une association existante. | Bitbucket | `src/lib/bitbucketSonarPlugin.ts` |

## 5. Bitbucket

| Id | Fonction | Ce qu’elle fait pour l’utilisateur | Fournisseurs | Fichiers de référence |
|---|---|---|---|---|
| BIT-01 | Dépôts, branches, tags | Liste des dépôts d’un projet, branches, tags, commits ; création d’un dépôt. | Bitbucket Server/DC | `src/lib/bitbucketClient.ts` |
| BIT-02 | Pull requests | Liste, détail, commentaires, modification (avec `expectedVersion`), commentaire. | Bitbucket | `src/lib/bitbucketClient.ts`, `src/lib/mcp/mcpPullRequests.ts` |
| BIT-03 | Fichiers à distance | Lecture de `docs/index.md`, `CHANGELOG.md`, `.oneapp/` sans clone. | Bitbucket | `src/lib/remoteRepository.ts` |

## 6. OpenBao (secrets, modale, environnements)

| Id | Fonction | Ce qu’elle fait pour l’utilisateur | Fournisseurs | Fichiers de référence |
|---|---|---|---|---|
| SEC-01 | Connexion OpenBao | Jeton, ou `bao login -method=oidc` lancé nativement : le jeton émis ne parvient jamais au webview. Montage KV et rôle propres au poste. | OpenBao | `src-tauri/src/commands/openbao_login.rs`, `src/lib/baoCli.ts`, `src/lib/openBaoClient.ts` |
| SEC-02 | Inventaire des secrets | Dossiers de composant découverts dans OpenBao et complétés par `Product.components` ; portées racine, `shared`, produit, composant ; nom de variable d’environnement associé. | OpenBao | `src/lib/secretInventory.ts`, `src/lib/secretInventoryTree.ts`, `src/lib/secretMatrix.ts` |
| SEC-03 | Modale des secrets d’un composant | Matrice clés × environnements ; clic sur une case : panneau de détail de cet environnement ; clic sur un nom : tous les environnements ; afficher/masquer une valeur ; ajouter, modifier, supprimer ; copier une clé vers un autre environnement (référence native, n’écrase jamais). | OpenBao | `src/components/secrets/ComponentSecretsDialog.tsx`, `OpenBaoSecretEditorDialog.tsx`, `OpenBaoSecretValueField.tsx`, `src-tauri/src/commands/secret_values.rs` |
| SEC-04 | Page Secrets globale | Vue d’ensemble par environnement : tableau ou arborescence, recherche. | OpenBao | `src/pages/secrets/SecretsPage.tsx`, `src/components/secrets/SecretsOverview.tsx`, `OpenBaoSecretTree.tsx` |
| SEC-05 | Secrets d’un environnement | Panneau large depuis Réglages › Environnements ; diagnostic de configuration OpenBao. | OpenBao | `src/pages/settings/environments/EnvironmentSecretsPanel.tsx`, `openBaoEnvironmentDiagnostics.ts` |
| SEC-06 | Valeurs scellées | Les valeurs lues arrivent comme références ; montrées seulement par `reveal_secret_value`, écrites dans un `.env` par `save_environment_file`. | OpenBao | `src-tauri/src/commands/secret_values.rs`, `src/lib/openBaoSecretReferenceCache.ts`, `src/lib/environmentFile.ts` |

## 7. Keycloak

| Id | Fonction | Ce qu’elle fait pour l’utilisateur | Fournisseurs | Fichiers de référence |
|---|---|---|---|---|
| KC-01 | Connexion PKCE | Connexion au navigateur (code PKCE, accès hors ligne) capturée nativement ; jetons, vérificateur et code ne parviennent au webview que comme références. Royaume (realm) propre à la connexion. | Keycloak | `src-tauri/src/services/keycloak_auth.rs`, `src-tauri/src/commands/keycloak.rs`, `src/lib/keycloakTokenClient.ts`, `docs/keycloak-offline-access.txt` |
| KC-02 | Groupes | Arborescence des groupes, membres, édition d’un groupe, recherche de personnes. | Keycloak | `src/components/keycloak/KeycloakGroupsPanel.tsx`, `KeycloakGroupTreePane.tsx`, `KeycloakMembersPane.tsx`, `src/lib/keycloakGroupsClient.ts` |
| KC-03 | Clients applicatifs | Liste et détail des clients d’un royaume. | Keycloak | `src/components/keycloak/KeycloakClientsPanel.tsx`, `src/lib/keycloakAppClientsClient.ts` |
| KC-04 | Personnes | Recherche d’utilisateurs et comptes de service ; attribut `oneapp-profils`. | Keycloak | `src/lib/keycloakUsersClient.ts`, `src/lib/keycloakAccessClient.ts` |
| KC-05 | Synchronisation Keycloak → Grafana | Équipes Grafana déduites des groupes. | Keycloak, Grafana | `src/lib/keycloakGrafanaSync.ts` |

## 8. Portainer

| Id | Fonction | Ce qu’elle fait pour l’utilisateur | Fournisseurs | Fichiers de référence |
|---|---|---|---|---|
| PTN-01 | Conteneurs d’un environnement | Conteneurs déclarés d’un composant, image et tag, état, version attendue. | Portainer | `src/lib/portainerClient.ts`, `src/components/products/ComponentContainersField.tsx` |
| PTN-02 | Fenêtre des journaux de conteneur | Nombre de lignes, niveaux Tous / Alertes / Erreurs avec compteurs, recherche (Ctrl+F), suivi en direct, retour à la ligne, horodatage, copie, téléchargement. | Portainer | `src/pages/dashboard/ContainerLogsView.tsx`, `src/lib/containerLogs.ts`, `src/lib/logLevels.ts` |
| PTN-03 | Console de conteneur | Shell et utilisateur, WebSocket d’exec ouvert nativement, historique ↑/↓, Ctrl+L, copie de session. | Portainer | `src/pages/dashboard/ContainerConsoleView.tsx`, `src/components/terminal/TerminalEmulator.tsx`, `src-tauri/src/services/container_console.rs` |
| PTN-04 | Fichier compose local | Lecture du `docker-compose` du dépôt pour proposer les conteneurs. | — | `read_local_compose_file` (`src-tauri/src/lib.rs`) |
| PTN-05 | Fenêtre de déploiement | Fenêtre dédiée à un conteneur (journaux et console). | Portainer | `src/pages/dashboard/DeploymentWindowPage.tsx`, `src/lib/deploymentWindow.ts` |

## 9. Jira et Confluence (tickets, documentation, spécifications, livrables)

### 9.1 Tickets

| Id | Fonction | Ce qu’elle fait pour l’utilisateur | Fournisseurs | Fichiers de référence |
|---|---|---|---|---|
| TIC-01 | Liste des tickets d’un produit | Tickets Jira et GitLab, filtres (type, état, responsable, période), table ou liste, préférences mémorisées. | Jira, GitLab | `src/components/dashboard/TicketsView.tsx`, `TicketTable.tsx`, `src/lib/ticketProvider.ts`, `src/lib/ticketFilters.ts` |
| TIC-02 | Types et états communs | Tâche, Bug, Évolution ; À faire, En cours, Suspendu, Résolu, Clôturé, traduits par fournisseur. | Jira, GitLab | `src/lib/ticketTypes.ts`, `src/lib/jiraTicketTypeMapping.ts`, `src/lib/gitlabTicketTypeMapping.ts`, `src/lib/projectTicketState.ts` |
| TIC-03 | Détail d’un ticket | Panneau ou fenêtre : description riche, champs modifiables en place, versions affectée et cible (versions d’élément Jira), pièces jointes, commentaires avec mentions, exigences liées. | Jira, GitLab | `src/components/tickets/*`, `src/lib/ticketDetail.ts`, `src/lib/jiraElementVersions.ts`, `src/lib/ticketWindow.ts` |
| TIC-04 | Workflow et transitions | Transitions autorisées avec prérequis (assignation avant démarrage, résolution et résumé pour résoudre, champs obligatoires du formulaire Jira), justification ajoutée en commentaire. | Jira, GitLab | `src/components/tickets/TicketWorkflow.tsx`, `src/lib/ticketWorkflow.ts`, `src/lib/jiraTransitions.ts`, `src/lib/jiraTransitionProfiles.ts` |
| TIC-05 | Création d’un ticket | Page de création par type, profils de création Jira, rédaction assistée par un appel unique. | Jira, GitLab | `src/pages/tickets/TicketCreatePage.tsx`, `src/lib/jiraCreationProfiles.ts`, `src/lib/ticketDrafting.ts` |
| TIC-06 | Pièces jointes | Lecture (512 Kio), envoi (1 Mio), téléchargement qui n’envoie les identifiants qu’au serveur de la connexion. | Jira, GitLab | `src/lib/ticketFileTransfer.ts`, `src/lib/ticketFilePermissions.ts` |
| TIC-07 | Envoyer à un agent | Depuis un ticket, demande à un agent avec le détail, les commentaires et les fichiers exportés dans un fichier de contexte. | — | `src/lib/ticketOrchestrator.ts`, `src/components/chat/OrchestratorAction.tsx` |

### 9.2 Documentation et livrables

| Id | Fonction | Ce qu’elle fait pour l’utilisateur | Fournisseurs | Fichiers de référence |
|---|---|---|---|---|
| DOC-01 | Confluence : Aperçu | Page publiée affichée dès que le brouillon local ou la dernière page connue est disponible ; images converties localement, visibles hors ligne ; arbre des pages. | Confluence | `src/components/documentation/ConfluenceReader.tsx`, `ConfluencePageTree.tsx`, `src/lib/confluenceRendering.ts`, `src-tauri/src/confluence_documents.rs` |
| DOC-02 | Confluence : Modification | Édition Markdown enregistrée dans `docs/index.md` du dépôt ; Enregistrer = commit ; Publier = conversion et envoi dans Confluence. | Confluence, Git local | `src/components/documentation/DocumentationView.tsx`, `src/lib/confluenceMarkdown.ts`, `src/lib/confluenceDocuments.ts` |
| DOC-03 | Change log | Versions de `CHANGELOG.md` (numéro, date, Markdown) ; nouvelle version, modification, suppression ; « Mettre à jour depuis Git » propose une section par tag absent, rédigée depuis ses commits, validée par aperçu ; commit. Lecture seule sur Bitbucket sans clone. | Git local, Bitbucket | `src/components/documentation/ChangelogView.tsx`, `src/lib/changelog.ts`, `src/lib/releaseNotesDrafting.ts`, `commands/specifications.rs` (`read/write_product_changelog`) |
| DOC-04 | Dossier d’architecture | Cartouche, sections Markdown, schéma C4 (contexte, conteneurs, composants) éditable et réorganisable, conception détaillée, contrats d’interface, complétude, export Markdown et PDF. | Git local | `src/components/documentation/Architecture*.tsx`, `src/lib/architecture*.ts`, `src-tauri/src/architecture_documents.rs` |
| DOC-05 | Approbations et cartouche | Signatures, approbateurs, champs de page d’un livrable. | — | `src/components/documentation/DocumentApprovals.tsx`, `src/lib/pdfSignatures.ts`, `src/lib/documentPageFields.ts` |
| DOC-06 | PDF des livrables | Gabarit d’entreprise (polices, cartouche), Markdown, tableaux, images, diagrammes de séquence mermaid. | — | `src/lib/thalesPdf.ts`, `src/lib/pdfGeneration.ts`, `src/lib/pdfMarkdown.ts`, `src/lib/pdfSequenceDiagram.ts`, `src/lib/pdf.worker.ts` |
| DOC-07 | Brouillon de courriel d’un livrable | Ouvre un brouillon Outlook avec le PDF en pièce jointe. | Outlook | `src/lib/documentMailDraft.ts`, `src-tauri/src/services/outlook.rs` |
| DOC-08 | Images de documents | Enregistrement et lecture des images d’un document dans le dépôt. | Git local | `src-tauri/src/commands/document_images.rs`, `src/lib/documentImages.ts` |

### 9.3 Spécifications

| Id | Fonction | Ce qu’elle fait pour l’utilisateur | Fournisseurs | Fichiers de référence |
|---|---|---|---|---|
| SPE-01 | Exigences | Clé stable, critères d’acceptation, révisions, tickets traités ; table, éditeur, extraction depuis un document, rédaction assistée. | Git local | `src/components/specifications/Requirement*.tsx`, `src/lib/specifications.ts`, `src/lib/requirementDrafting.ts`, `src/lib/requirementExtraction.ts` |
| SPE-02 | Fiches de test | Préconditions, étapes, résultats attendus, exigences couvertes ; génération assistée. | Git local | `src/components/specifications/TestEditor.tsx`, `TestCasesTable.tsx`, `src/lib/testCaseGeneration.ts` |
| SPE-03 | Exécutions de test | Résultat immuable par étape, exécutant, contexte ; obsolète à la révision suivante. | Git local | `src/components/specifications/TestRunEditor.tsx` |
| SPE-04 | Couverture et vérification | Matrice de traçabilité, état calculé de chaque exigence. | — | `src/components/specifications/TraceabilityMatrix.tsx`, `SpecificationStatus.tsx` |
| SPE-05 | Cahier d’exigences (SRS) | Chapitres de contexte, périmètre et vérification ; validation ; PDF. | Git local | `src/components/specifications/SrsEditor.tsx`, `src/lib/srs*.ts` |
| SPE-06 | Plan / cahier de tests | Chapitres, fiches détaillées, traçabilité ; PDF. | Git local | `src/components/specifications/TestPlanDocumentView.tsx`, `src/lib/testPlan*.ts` |
| SPE-07 | Versions Git des spécifications | Historique, diff, contenus de versions, commit par artefact, dossier porteur (`.oneapp/specifications/`). | Git local | `src-tauri/src/specification_git.rs`, `src/lib/specificationGitVersions.ts`, `src/components/specifications/SpecificationGitDiffDialog.tsx`, `SpecificationCommitDialog.tsx` |
| SPE-08 | Fenêtre des spécifications | Spécifications dans une fenêtre dédiée, demandes à l’agent transmises à la fenêtre principale. | — | `src/pages/specifications/SpecificationsWindowPage.tsx`, `src/lib/specificationWindow.ts` |

## 10. Projets, équipes et absences (Outlook)

| Id | Fonction | Ce qu’elle fait pour l’utilisateur | Fournisseurs | Fichiers de référence |
|---|---|---|---|---|
| PRJ-01 | Kanban | Colonnes À faire, En cours, Suspendu, Terminé ; tickets disponibles (sans responsable, sans durée, responsable non relié) avec la raison ; filtres équipe, produits, personne, recherche ; justification à chaque déplacement. | Jira, GitLab | `src/components/projects/ProjectKanban.tsx`, `ProjectTicketCard.tsx`, `src/lib/projectManagement.ts`, `src/lib/projectBoardCache.ts` |
| PRJ-02 | Ordre partagé par personne | Lu dans le Rank Jira ou la position GitLab ; réordonner n’écrit que les déplacements nécessaires. | Jira, GitLab | `src/lib/projectAssignment.ts` |
| PRJ-03 | Reconnaissance du responsable | Compte relié, puis identifiant Keycloak égal au login, puis e-mail, puis nom. | Keycloak, Jira, GitLab | `src/components/projects/projectMemberAccounts.ts`, `src/lib/teamDirectory.ts` |
| PRJ-04 | Planning | Futur planifié depuis la durée restante et les disponibilités ; passé réel lu dans l’historique (changelog Jira, labels `workflow::` GitLab) ; jours non travaillés et absences exclus. | Jira, GitLab | `src/components/projects/ProjectPlanning.tsx`, `src/lib/projectTimeline.ts`, `src/lib/projectExecutionHistory.ts` |
| PRJ-05 | Équipes | Personnes ajoutées depuis Keycloak (identifiant et e-mail en lecture seule). | Keycloak | `src/components/projects/ProjectTeams.tsx`, `src/lib/teamDirectory.ts` |
| PRJ-06 | Absences | « Importer les absences » lit l’Outlook classique du poste (libre/occupé par COM) ou un agenda publié (ICS) ; absences « agenda » retirées quand elles disparaissent, saisies manuelles jamais retirées ; calendrier par personne. | Outlook (COM, ICS) | `src-tauri/src/services/outlook_free_busy.rs`, `src-tauri/src/services/calendar_feed.rs`, `src/lib/memberAbsences.ts`, `src/lib/projectAbsences.ts`, `src/components/projects/ProjectMemberCalendar.tsx` |

## 11. Accès

| Id | Fonction | Ce qu’elle fait pour l’utilisateur | Fournisseurs | Fichiers de référence |
|---|---|---|---|---|
| ACC-01 | Profils d’accès | Nom, description, groupes Keycloak, équipes Grafana ; renommage ; partagés en équipe (`.oneapp/settings/access.json`). | Keycloak, Grafana | `src/components/access/AccessProfileEditor.tsx`, `AccessProfileList.tsx`, `src/lib/accessProfiles.ts`, `src/lib/accessProfileRename.ts`, ADR 0006 et 0007 |
| ACC-02 | Matrice des accès | Une ligne par personne, une colonne par environnement relié : conforme, écart, sans accès. | Keycloak, Grafana | `src/pages/access/AccessPage.tsx`, `src/components/access/AccessOverviewTable.tsx`, `src/lib/accessSnapshotLoader.ts` |
| ACC-03 | Attribution et réalignement | Profil écrit dans l’attribut `oneapp-profils`, relecture de vérification ; aperçu des changements avant d’aligner ; confirmation humaine même depuis un agent. | Keycloak, Grafana | `src/components/access/AccessChangesDialog.tsx`, `AccessPersonPanel.tsx`, `src/lib/accessAlignment.ts`, `src/lib/accessApply.ts`, `src/lib/mcp/mcpUserAccess.ts` |
| ACC-04 | Audit CSV | Chaque personne dans chaque environnement avec tous ses groupes. | Keycloak, Grafana | `src/lib/accessAudit.ts`, `src/lib/accessAuditFile.ts` |
| ACC-05 | Groupes d’alerte | Groupes Keycloak d’alerte et leur usage. | Keycloak | `src/lib/keycloakAlertGroups.ts` (via tests), `src/lib/keycloakGroupPurpose.ts` |

## 12. Synchronisation d’équipe

| Id | Fonction | Ce qu’elle fait pour l’utilisateur | Fournisseurs | Fichiers de référence |
|---|---|---|---|---|
| SYN-01 | Sources de configuration partagée | Plusieurs dépôts Git actifs à la fois (« Équipe et partage »), leur union forme la vue locale ; un identifiant dans deux sources est un conflit. | Git | `src/pages/settings/synchronization/ConfigurationSyncSettings.tsx`, `src-tauri/src/configuration_git.rs`, ADR 0004 |
| SYN-02 | Déclarations partagées | Un fichier JSON autonome par produit, connexion, environnement, définition des accès, réglages des agents d’une source, sous `.oneapp/`. | Git | `src-tauri/src/services/synchronization/export.rs`, `apply.rs`, `docs/matrice-synchronisation-configurations-partagees.md` |
| SYN-03 | Réglages personnels du poste | Mode d’authentification, intervalle, TLS ignoré, montage et rôle OpenBao, ordre, identifiants et chemins locaux : jamais publiés ni écrasés. | — | `src-tauri/src/services/synchronization/personal.rs` |
| SYN-04 | Rapprochement par identité métier | Type + URL d’une connexion (endpoint Portainer, realm Keycloak), URL de base d’un environnement, dépôts Bitbucket d’un produit (ADR 0012). | — | `src-tauri/src/services/synchronization/identity.rs` |
| SYN-05 | Choix de ce qui est récupéré ou publié | Aperçu par élément (À publier, À récupérer, Choix nécessaire, À retirer, À conserver) ; Récupérer et Publier n’agissent que dans leur sens ; dépendances qui suivent leur produit (case verrouillée) ; conflits « Ma version / La version de l’équipe » ; suppressions locales confirmées ; « Local uniquement ». | — | `src-tauri/src/services/synchronization/selection.rs`, `src/lib/configurationSyncSelection.ts`, `src/pages/settings/synchronization/ConfigurationSyncChanges.tsx` |
| SYN-06 | Synchronisation automatique | À l’ouverture, échange sans examen de ce qui n’est pas à trancher ; ensuite publication automatique des seules modifications locales ; bilan en notification. | — | `src/lib/configurationSyncTask.ts`, `ConfigurationAutoSyncSettings.tsx` |
| SYN-07 | Dépendances partagées | Une connexion ou un environnement référencé par un produit partagé rejoint sa source, et redevient local sinon. | — | `src-tauri/src/services/synchronization.rs` |
| SYN-08 | Déplacer un produit entre équipes | Publication dans la source cible, puis retrait de l’ancienne, rejouable. | Git | `catalog_move_product`, `catalog_replay_product_move` |
| SYN-09 | Spécifications versionnées dans le produit | `.oneapp/specifications/` du dépôt porteur (pas une source de configuration : le dépôt du produit lui-même). | Git | `src-tauri/src/services/specifications.rs`, `docs/specifications-format.md` |

## 13. Agents

| Id | Fonction | Ce qu’elle fait pour l’utilisateur | Fournisseurs | Fichiers de référence |
|---|---|---|---|---|
| AGT-01 | Agents sur un produit ou un composant | Lancés depuis la page Agents, une action de page ou une automatisation ; dossier = espace local du produit ou chemin du composant ; plusieurs en parallèle ; un agent sans produit lit sans modifier (ADR 0010). | Codex, OpenCode | `src/lib/agentLaunch.ts`, `src/lib/agentThreads.ts`, `src/components/agents/NewAgentDialog.tsx`, `AgentTargetPicker.tsx` |
| AGT-02 | Pilotage des CLI | Codex `app-server` (stdio) ; OpenCode `opencode serve` piloté par Rust (mot de passe, appairage et jeton MCP restent dans Rust, ADR 0022) ; catalogue de modèles, reprise, interruption, autorisations. | Codex, OpenCode | `src/lib/codexSession.ts`, `src-tauri/src/agents/opencode/*`, `src-tauri/src/commands/agent_cli.rs`, `src/lib/openCodeSession.ts` |
| AGT-03 | Conversation | File (réordonner, envoyer tout de suite), collages longs en pastille, pièces jointes (16 × 20 Mo), images, références `@`, `$`, `#` (ticket, produit, composant), tours repliés « A travaillé pendant… », index des demandes, questions numérotées, brouillons chiffrés. | — | `src/components/agents/AgentComposer.tsx`, `src/pages/chat/ChatTranscript.tsx`, `docs/chat-ia.md`, `docs/parite-agent-oneapp.md` d’Alfred |
| AGT-04 | Orchestrateur global (historique) | Assistant unique qui délègue (`oneapp_threads` : dispatch de 1 à 50 tâches, dépendances, profils autorisés, contrat de retour JSON, rapports par fichier, artefacts vérifiés) ; aujourd’hui consultable en lecture seule depuis l’ADR 0010. | — | `src/lib/globalOrchestrator.ts`, `src/lib/agentThreadsDelegation.ts`, `src/lib/agentResults.ts`, `src/lib/agentHandoffs.ts`, `src-tauri/src/agent_artifacts.rs`, `docs/orchestrateur-global.md` |
| AGT-05 | Demandes confidentielles | Cadenas par demande ; seuls les modèles marqués « Autorisé pour les actions secret » reçoivent une demande secrète ou son résultat. | — | `src/components/chat/SecretToggle.tsx`, `src/lib/agentSettings.ts`, `src/lib/agentPolicies.ts` |
| AGT-06 | Réglages des agents par produit et par source | Consignes et sélection de skills ; source puis produit ; un composant hérite de son produit ; voyagent avec la déclaration partagée (ADR 0019). | — | `src/components/products/wizard/ProductAgentSettings.tsx`, `src/pages/settings/synchronization/SourceAgentPolicyDialog.tsx`, `src/lib/skillCatalog.ts` |
| AGT-07 | Outils MCP de OneApp | Serveur MCP local (`127.0.0.1:31415`) : 63 outils métier (produits, tickets, livraison, journaux, qualité, déploiements, Keycloak, secrets sans valeur, spécifications, architecture, accès, automatisations, suivis), filtrés par rôle (`personal`, produit, composant) ; association externe révocable (Réglages › MCP). | — | `src-tauri/src/mcp.rs`, `src/lib/mcp/*`, `docs/mcp.md`, `src/pages/settings/mcp/McpSettingsPanel.tsx`, ADR 0015 |
| AGT-08 | Relances de fin d’exécution (suivis) | `start_pipeline` avec `watch: true`, `watch_completion` (CI ou automatisation), `cancel_watch` ; l’agent est relancé avec statut, lien et fin du journal ; les suivis survivent à la fermeture (ADR 0018). | Jenkins, GitLab | `src/lib/agentWaits.ts`, `src/lib/agentWaitWatcher.ts`, `src/lib/mcp/mcpWaits.ts`, `src/components/agents/AgentQueue.tsx` |
| AGT-09 | Automatisations | Déclencheurs : CI en échec ou réussie, erreur dans le log CI, quality gate en échec, ticket créé ou changé, PR ouverte ou fusionnée, déploiement ou conteneur arrêté, cron, script PowerShell externe ; périmètre (produits, composants) ; consigne ; confidentialité ; nouvel agent ou agent existant ; confirmation ; journal (200) ; propositions inactives de l’agent. | tous | `src/lib/automations.ts`, `src/lib/automationRunner.ts`, `src/lib/automationSources.ts`, `src/lib/automationCron.ts`, `src/components/automations/*`, `src-tauri/src/services/trigger_scripts.rs`, ADR 0009 et 0011 |
| AGT-10 | Scripts d’action | Scripts PowerShell relus par l’utilisateur qu’un agent peut lancer (`run_action_script`), par exemple marquer un courriel lu. | PowerShell | `src/lib/actionScripts.ts`, `src/lib/mcp/mcpActionScripts.ts` |
| AGT-11 | Propositions d’agent | Un agent propose un agent sur un autre produit lié ; carte « Lancer l’agent / Ignorer ». | — | `src/lib/agentProposals.ts`, `src/lib/mcp/mcpAgentProposals.ts` |
| AGT-12 | Agents dans la barre de gauche | Section Agents sous les produits : état (au travail, réponse attendue, en échec, à consulter, en veille), tri, renommer, fenêtre, archiver au survol ; notification qui ouvre l’agent. | — | `src/components/agents/AgentNavigationSection.tsx`, `src/hooks/useAgentNavigationActions.ts`, `src/lib/agentMonitor.ts` |
| AGT-13 | Fenêtre Agents détachée | Fenêtre unique, affichage et commandes ; le moteur reste dans la fenêtre principale (ADR 0021). | — | `src/pages/agents/AgentsWindowPage.tsx`, `src/lib/agentsWindowBridge.ts`, `src-tauri/src/windows.rs` |
| AGT-14 | Appel unique au modèle | Transformation bornée en un tour (rédiger un ticket, une exigence, des notes de version, un script de déclencheur, analyser un journal) ; résultat proposé, jamais écrit seul (ADR 0008). | Codex, OpenCode | `src/lib/oneShotBridge.ts`, `src/lib/oneShotCompletion.ts`, `src/components/oneshot/*` |
| AGT-15 | Demandes depuis les pages | Icône robot partagée (ticket, création, exigences, fiches, SRS, version, commit) : demande + cadenas, contexte de page exporté dans un fichier transmis au seul agent ciblé. | — | `src/components/chat/OrchestratorAction.tsx`, `src/lib/agentContextFiles.ts`, `src/lib/specificationPageContext.ts` |
| AGT-16 | Modifications des agents | Pastille « N fichiers modifiés +a −r », changements par tour, état Git du dossier. | Git local | `src/components/agents/AgentGitSummaryPill.tsx`, `src/lib/agentWorkspaceChanges.ts`, `src-tauri/src/commands/agent_workspace.rs` |
| AGT-17 | Réglages Orchestrateur | Détection de Codex et OpenCode, catalogues, modèles et niveaux autorisés, simultanéité (1 à 8), plafond par conversation, modèle de nommage, agents archivés. | Codex, OpenCode | `src/pages/settings/ai/AgentCliSettings.tsx`, `AgentModelsDialog.tsx`, `ArchivedAgentsSettings.tsx` |

## 14. Notifications, réglages, sauvegardes et le reste

| Id | Fonction | Ce qu’elle fait pour l’utilisateur | Fournisseurs | Fichiers de référence |
|---|---|---|---|---|
| GEN-01 | Centre de notifications | Toutes les notifications passagères, actions (« Journal », « Lancer », « Voir l’agent »), notifications persistantes (échec CI, confirmation d’automatisation). | — | `src/components/shell/NotificationCenter.tsx`, `src/lib/notificationCenter.ts`, `src/lib/notifications.ts` |
| GEN-02 | Palette de commandes et aide | Commandes, raccourcis, aide et support. | — | `src/components/commands/CommandSurface.tsx`, `HelpSupportActions.tsx`, `src/lib/shortcuts.ts` |
| GEN-03 | Préférences | Thème (système, clair, sombre), éditeur de texte, rapports de plantage anonymisés. | — | `src/lib/themePreferences.ts`, `src/lib/textEditorSettingsRepository.ts`, `src-tauri/src/commands/crash_reporting.rs` |
| GEN-04 | Sauvegardes de la base | Sauvegarde à la demande, liste, restauration. | — | `src/pages/settings/backups/DatabaseBackupSettings.tsx`, `src-tauri/src/configuration_database.rs`, `src-tauri/src/db/backups.rs` |
| GEN-05 | Diagnostics | Export d’un diagnostic, dossier des journaux, mesures de performance. | — | `src-tauri/src/diagnostics.rs`, `src/lib/diagnostics.ts`, `src/lib/performanceMetrics.ts` |
| GEN-06 | Accueil et nouveautés | Parcours d’accueil, « Quoi de neuf ». | — | `src/components/onboarding/*` |
| GEN-07 | Glisser-déposer natif | Fichiers déposés depuis l’Explorateur matérialisés nativement. | — | `src-tauri/src/commands/dropped_files.rs`, `src/lib/nativeDroppedFiles.ts` |
| GEN-08 | Brouillons protégés | Brouillons enregistrés chiffrés, récupération après arrêt anormal. | — | `src-tauri/src/commands/drafts.rs`, `src/lib/draftsRepository.ts` |
| GEN-09 | Fermeture de la fenêtre principale | Sauvegarde, arrêt des CLI, « Fermer quand même ? ». | — | `src/lib/mainWindowClose.ts`, `src-tauri/src/desktop_lifecycle.rs` |
| GEN-10 | Recherche dans les réglages | Champ de recherche transversal des Réglages. | — | `src/pages/settings/settingsSearch.ts` |
| GEN-11 | Fenêtres secondaires et droits | Fenêtres ticket, déploiement, spécifications avec des droits accordés puis révoqués (`grant_*_window`). | — | `src-tauri/src/windows.rs`, `catalog_grant_ticket_window` |
| GEN-12 | Parité Windows | Coffre Windows, PowerShell 5.1 STA, Git Bash, arbre de processus, échelle 125/150 %, contraste élevé, chemins UNC. | Windows | `src-tauri/src/windows_process_tree.rs`, `docs/windows-validation-environment.md`, ADR 0014 |

## Sources lues

- OneApp : `PRODUCT.md`, `CONTEXT.md`, `AGENTS.md`, `docs/guide-fonctionnalites.md`, `docs/chat-ia.md`, `docs/mcp.md`, `docs/matrice-synchronisation-configurations-partagees.md`, en-têtes des ADR 0001 à 0023, arborescence de `src/pages`, `src/components`, `src/lib`, `src-tauri/src`, commandes enregistrées dans `src-tauri/src/lib.rs`.
- Notes des sessions sœurs (dossier partagé) : vue produit, panneau unique, agents dans la navigation, secrets en modale, CI des tags, point bleu, relances, bascule `opencode serve`, protocoles natifs, bibliothèque des agents, compatibilité 8.0.0.
- `/Users/alexandre/Workspace/desktop-kit/docs/inventaire.md` n’existe pas (seuls `README.md` et `CONVENTIONS-crates.md`) : non utilisé.
- `DESIGN.md` de OneApp et le détail des 23 ADR n’ont été lus qu’en en-tête : les règles de présentation sont déjà reprises dans `DESIGN.md` d’Alfred.
