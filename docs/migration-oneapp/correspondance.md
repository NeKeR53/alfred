# Correspondance OneApp → Alfred

Livrable 2 sur 4. Pour chaque fonction de [fonctions-oneapp.md](fonctions-oneapp.md) : où elle vivrait dans Alfred et ce qu’il faut pour l’y faire vivre. État d’Alfred lu le 20 novembre 2026 sur `main` (`6f479a1`), avec `docs/espace/SDK.md`, `docs/espace/AGENTS.md`, `src-tauri/src/` et les modules `atlassian`, `jenkins`, `outlook`, `prefect` de `alfred.place`.

Mise à jour du 20 novembre 2026, après les décisions de l’utilisateur : le partage d’équipe reste fondé sur des fichiers dans des dossiers (plus de synchronisation propre à porter) ; une page peut créer des entrées du menu de gauche ; les jetons sont ressaisis dans le trousseau ; les anciennes conversations de OneApp ne sont pas gardées ; la délégation entre agents est à porter ; aucun MCP n’est ajouté, les fonctions d’Alfred en tiennent lieu ; un agent lancé par une page peut recevoir un dossier et un mode imposés.

## Lecture

**Où** :
- **Module `x`** : un module de l’espace, créé plus tard dans le fil de l’agent d’Alfred. Les noms de modules sont indicatifs : leur découpage sera décidé module par module. *(existant)* signale un module déjà publié, à étendre.
- **SDK** : une capacité de `@alfred/sdk` ou du `module.json`.
- **Cœur** : la coque, les Réglages, la page Agent ou le natif d’Alfred, hors de tout module.

**Statut** :
- ✅ **déjà possible** : un module peut le faire aujourd’hui avec le SDK tel qu’il est.
- ➕ **Sn** : possible après le manque de base *n* de [manques-alfred.md](manques-alfred.md).

**Manques de base** (détail dans [manques-alfred.md](manques-alfred.md)) :

| Code | Manque de base |
|---|---|
| S1 | Entrées du menu de gauche créées par une page |
| S2 | Dossiers du poste et Git local |
| S3 | Agents lancés par une page : dossier, mode et outils imposés |
| S4 | Secrets scellés et jetons émis par les services |
| S5 | Paramètres non secrets d’un compte |
| S6 | Transport des clients : binaire, multipart, flux, WebSocket |
| S7 | Notifications à actions, fenêtres paramétrées, relevés rapides |
| S8 | Composants `@alfred/ui` manquants |
| S9 | Pilotage des agents depuis Rust |
| S10 | Suivis : relancer un agent sur un événement |
| S11 | Délégation entre agents |
| S12 | Parité Windows |

## Synthèse

| Statut | Fonctions |
|---|---|
| ✅ déjà possible | 65 |
| ➕ après un manque de base | 67 |
| **Total** | **132** |

Deux comportements de OneApp restent **impossibles en l’état**, parce qu’ils contredisent une règle d’Alfred ; leur fonction a une voie de remplacement, comptée ci-dessus (voir la fin du document).

Manques les plus souvent requis (nombre de fonctions) : S2 dossiers et Git (23), S8 composants (13), S4 secrets (9), S7 notifications et fenêtres (8), S3 agents de page (8), S1 menu (5), S6 transport (5), S5 paramètres de compte (4), S10 suivis (2), S9 pilotage natif (1), S11 délégation (1), S12 Windows (1).

---

## 1. Produits logiciels, composants, liaisons et connexions

| Id | Fonction | Où dans Alfred | Statut | Remarque |
|---|---|---|---|---|
| PRD-01 | Catalogue des produits | Module `produits` (tables `produits_produits`, `produits_composants`) ; une entrée du menu par produit | ➕ S1 | Les tables, l’ordre, le masquage et la corbeille (colonne `supprime_le` + `history`) sont possibles ; une entrée du menu **par produit** demande qu’une page crée ses entrées dans le menu (S1). |
| PRD-02 | Assistant de création | Module `produits`, `openForm` en étapes ou `openSubpage` | ✅ | `StepList` existe ; le choix des ressources passe par les fonctions des connecteurs. |
| PRD-03 | Composants et liaisons | Module `produits` (table `produits_liaisons` : composant, type, compte `client/instance`, ressource) | ✅ | Une liaison vise un **compte** Alfred (`client/instance`) au lieu d’une connexion ; les fonctions des connecteurs reçoivent `instance` dans leur `input` (SDK § 6). La matrice des liaisons est un `DataTable`. |
| PRD-04 | Choix d’une ressource | Fonctions `lister-…` de chaque connecteur, appelées par `produits` (`requires`) | ✅ | `atlassian` a déjà `lister-depots` ; création de dépôt et de composant Jira à ajouter au connecteur. |
| PRD-05 | Import depuis GitLab | Module `gitlab` (fonction `lister-projets-groupe`) + `produits` | ✅ | — |
| PRD-06 | Espace local | Module `depots` + `produits` | ➕ S2 | Choisir un dossier, le parcourir, créer des sous-dossiers, cloner : aujourd’hui seulement par une fonction en script, sans dossier accordé ni sélecteur de dossier. |
| PRD-07 | Lecture distante | Module `atlassian` (`lire-fichier`, `lister-fichiers` existent) | ✅ | — |
| PRD-08 | Endpoint principal | Module `deploiements` ; `shell.openExternal` | ✅ | — |
| PRD-09 | Connexions | Cœur : comptes (Réglages › Modules, fiche du module, onboarding) | ➕ S5 | Ajout, méthode, TLS non vérifié, test et état existent ; manquent les paramètres non secrets d’un compte (realm, montage KV, endpoint). Les adresses des connexions partagées par l’équipe se lisent dans les fichiers `.oneapp/` ; chacun ressaisit son jeton dans le trousseau. La reconnaissance d’un outil à partir d’une adresse collée n’existe pas (onboarding guidé à la place). |
| PRD-10 | Environnements | Module `produits` (table `produits_environnements`, comptes Portainer, OpenBao, Keycloak, Grafana par environnement) | ✅ | Les comptes sont désignés par `client/instance` ; les boutons Secrets, Groupes, Clients naviguent vers les pages des modules `secrets` et `acces`. |
| PRD-11 | Portabilité d’un produit | Module `produits` (`documents`, `files.pick`, `files.export`) | ✅ | Export et import JSON ; Alfred exporte aussi les données d’un module (Réglages › Général). |
| PRD-12 | Annulation et historique | SDK `history` sur les tables de `produits` | ✅ | `history.revert` après confirmation. |
| PRD-13 | Commandes locales d’un composant | Module `depots` | ➕ S2, S4 | Lancer un terminal du poste dans le dossier du composant, avec un `.env` construit à partir des secrets sans que la page les lise : il faut un dossier accordé (S2) et l’écriture native d’un fichier d’environnement depuis des références (S4). |
| PRD-14 | Incohérences | Module `produits` (fonction `verifier-produit`) | ✅ | — |

## 2. Vue produit

| Id | Fonction | Où dans Alfred | Statut | Remarque |
|---|---|---|---|---|
| VUE-01 | Cartes d’état | Module `cockpit`, page « Composants » du produit | ➕ S1, S8 | Il faut la page d’un produit (S1) et une grille de cartes d’état avec pastilles (S8) : `@alfred/ui` n’a ni carte ni grille. |
| VUE-02 | Vue tableau | Module `cockpit`, `CollectionPage` | ➕ S1 | Le tableau est possible ; il dépend de la page par produit. |
| VUE-03 | Panneau de détail | Module `cockpit`, panneau `PanelSections` | ✅ | Le panneau unique, ses blocs repliables et déplaçables et leur disposition mémorisée existent (SDK § 8, DESIGN.md § 4.2). Faire défiler jusqu’à une section depuis la page : `shell.send`. |
| VUE-04 | Section Git | Module `depots` (fonctions) + `cockpit` | ➕ S2 | `commands.run("git", ["-C", dossier, …])` marche déjà, mais le dossier d’un produit est hors de l’espace et n’est pas accordé ; aucun garde-fou sur le dossier visé. |
| VUE-05 | Pull requests | Modules `atlassian` *(existant)*, `gitlab`, `cockpit` | ✅ | `lister-prs`, `lire-pr`, `commenter-pr`, `modifier-pr` existent pour Bitbucket. |
| VUE-06 | Section CI | Modules `ci`, `jenkins` *(existant)*, `gitlab` | ✅ | — |
| VUE-07 | Tag et release | Modules `ci`, `depots` | ➕ S2 | Dernier tag et commits depuis : Git local. |
| VUE-08 | Section Artefact | Module `artifactory`, `gitlab` | ➕ S6 | La liste et la copie du SHA sont possibles ; **télécharger** un binaire non : `client` décode la réponse en texte (UTF-8 avec pertes), 20 Mo au plus. |
| VUE-09 | Section Déploiement | Modules `portainer`, `deploiements` | ✅ | Lecture des conteneurs, comparaison à la version attendue. |
| VUE-10 | Section Qualité | Module `sonarqube` | ✅ | — |
| VUE-11 | Section Secrets | Module `secrets` | ➕ S4 | La présence des clés peut se lire sans valeur, mais l’API KV v2 renvoie toujours les valeurs avec les clés : sans réponse scellée, elles arrivent dans la fonction. |
| VUE-12 | Usine | Module `deploiements`, page « Usine » | ✅ | — |
| VUE-13 | Activité | Module `cockpit` | ➕ S8 | Frise d’activité absente de `@alfred/ui`. |
| VUE-14 | Affichage immédiat et cache | SDK : tables du module comme cache, `cache` des clients | ✅ | Les gabarits rechargent après écriture ; F5 = `reload()`. |

## 3. CI

| Id | Fonction | Où dans Alfred | Statut | Remarque |
|---|---|---|---|---|
| CI-01 | Dernière exécution et historique | Modules `jenkins` *(existant)*, `gitlab`, `ci` | ✅ | `jenkins` lit déjà les états et les logs. |
| CI-02 | Arbre des pipelines Jenkins | Module `jenkins` (à étendre) | ✅ | À reprendre de `jenkinsPipelineTree.ts`. |
| CI-03 | Lancer, relancer, arrêter | Modules `jenkins`, `gitlab` | ✅ | `relancer-job` existe ; ajouter lancement avec paramètres et sur un tag, et arrêt. |
| CI-04 | Suivi des exécutions lancées | Module `ci` : table des exécutions suivies, planification `everyMinutes: 1`, `shell.notify`, `events.publish("execution-terminee")` | ➕ S7 | Le suivi est possible (planification + table). La notification « Journal » qui ouvre la fenêtre sur ce build précis demande des notifications à actions et des fenêtres paramétrées (S7). |
| CI-05 | Sonde d’activité (10 s / 3 s) | Module `ci`, planification | ➕ S7 | La plus petite planification est d’une minute, et une page n’a pas de minuterie d’arrière-plan quand elle est fermée. Il faut une planification à la seconde ou des sondes gardées par la coque. Rangé dans S7 (« sondes rapides »). |
| CI-06 | Progression et durée | Module `ci` | ✅ | — |
| CI-07 | Fenêtre de journal CI | Module `ci`, page ouverte par `shell.openWindow` | ➕ S7, S8 | `openWindow` n’ouvre qu’une page, sans paramètre (quel build) ; visionneuse de journal (recherche, niveaux, suivi) absente de `@alfred/ui`. Suivi en direct : relectures périodiques suffisent (`consoleText` progressif), pas besoin de flux. |
| CI-08 | Diagnostic d’un journal | Module `ci`, `ai.oneShot` | ✅ | — |
| CI-09 | Préférences de vue | Table non partagée du module | ✅ | — |
| CI-10 | Releases GitLab | Module `gitlab` | ✅ | — |

## 4. Sonar

| Id | Fonction | Où dans Alfred | Statut | Remarque |
|---|---|---|---|---|
| SON-01 | Qualité d’un composant | Module `sonarqube` (connecteur + pages) | ✅ | Jeton SonarQube : `bearer` ou `basic`. |
| SON-02 | Configurer le projet | Module `sonarqube` (fonctions d’écriture) + `atlassian` | ✅ | — |
| SON-03 | Plugin Bitbucket Include Code Quality | Module `atlassian` (fonctions `lire-reglages-qualite`, `associer-sonar`) | ✅ | — |

## 5. Bitbucket

| Id | Fonction | Où dans Alfred | Statut | Remarque |
|---|---|---|---|---|
| BIT-01 | Dépôts, branches, tags | Module `atlassian` *(existant)* | ✅ | `lister-depots`, `lister-commits` existent ; ajouter branches, tags, création de dépôt. |
| BIT-02 | Pull requests | Module `atlassian` *(existant)* | ✅ | Déjà couvert. |
| BIT-03 | Fichiers à distance | Module `atlassian` *(existant)* | ✅ | `lire-fichier`. |

## 6. OpenBao

| Id | Fonction | Où dans Alfred | Statut | Remarque |
|---|---|---|---|---|
| SEC-01 | Connexion OpenBao | Cœur (comptes) + module `openbao` | ➕ S4, S5 | Un jeton fixe passe déjà (`apiKey`, en-tête `X-Vault-Token`). OIDC par `bao login`, userpass ou LDAP renvoient un jeton dans la réponse : il faut une méthode « session » capturée nativement (S4). Montage KV et rôle : paramètres du compte (S5). |
| SEC-02 | Inventaire des secrets | Module `openbao` + `secrets` | ➕ S4 | Lister les dossiers et les clés est possible (`GET …/metadata/…?list=true`, sans valeur) ; mais connaître les clés d’un secret oblige à lire `…/data/…`, qui rend aussi les valeurs : réponse scellée (S4). |
| SEC-03 | Modale des secrets | Module `secrets` (page composée + `openModal` + panneau) | ➕ S4, S8 | Lecture scellée, « Afficher » sur un geste, écriture d’une valeur saisie, copie d’une clé d’un environnement à l’autre sans que la valeur passe par la page : S4. Matrice clés × environnements : `DataTable` suffit ; panneau imbriqué dans une modale : à vérifier (S8). |
| SEC-04 | Page Secrets globale | Module `secrets` | ➕ S4, S8 | Arborescence absente de `@alfred/ui` (S8). |
| SEC-05 | Secrets d’un environnement | Module `secrets` | ➕ S4 | — |
| SEC-06 | Valeurs scellées, `.env` | SDK (S4) | ➕ S4 | Cœur du chantier S4. |

## 7. Keycloak

| Id | Fonction | Où dans Alfred | Statut | Remarque |
|---|---|---|---|---|
| KC-01 | Connexion PKCE | Cœur (comptes, `oauth2` avec `clientId`, PKCE depuis `88b78e8`) + module `keycloak` | ➕ S5 | PKCE dans le navigateur existe ; l’adresse dépend du royaume (`{url}/realms/{realm}/protocol/openid-connect/auth`) : il faut un paramètre de compte `{realm}` (S5). Accès hors ligne : `scopes: ["offline_access"]`, à vérifier sur le renouvellement. |
| KC-02 | Groupes | Module `keycloak` (connecteur) + `acces` | ➕ S8 | API d’administration : possible ; arborescence des groupes : S8. |
| KC-03 | Clients applicatifs | Module `keycloak` | ✅ | — |
| KC-04 | Personnes | Module `keycloak` | ✅ | — |
| KC-05 | Keycloak → Grafana | Module `acces` | ✅ | Fonction qui appelle `keycloak/…` et `grafana/…`. |

## 8. Portainer

| Id | Fonction | Où dans Alfred | Statut | Remarque |
|---|---|---|---|---|
| PTN-01 | Conteneurs | Module `portainer` | ➕ S5 | Clé d’API Portainer (`X-API-Key`) : ✅. Identifiant + mot de passe (`/api/auth` renvoie un JWT) : S4. Endpoint Portainer par compte : S5. |
| PTN-02 | Journaux de conteneur | Module `deploiements`, fenêtre | ➕ S6, S7, S8 | Lecture des N dernières lignes : ✅ (la réponse Docker est multiplexée en binaire : il faut l’option binaire de S6). Suivi en direct : relecture `since` ou flux (S6). Fenêtre paramétrée (S7), visionneuse (S8). |
| PTN-03 | Console de conteneur | Module `deploiements` | ➕ S6, S8 | WebSocket d’exec ouvert nativement et relayé par un canal (S6) ; terminal (`@xterm/xterm` par `set_libraries`, ou composant S8). |
| PTN-04 | Fichier compose local | Module `depots` | ➕ S2 | — |
| PTN-05 | Fenêtre de déploiement | Module `deploiements` | ➕ S7 | Fenêtre paramétrée. |

## 9. Jira et Confluence

### 9.1 Tickets

| Id | Fonction | Où dans Alfred | Statut | Remarque |
|---|---|---|---|---|
| TIC-01 | Liste des tickets | Module `tickets` (pages), connecteurs `atlassian` *(existant)* et `gitlab` | ➕ S1 | La liste est un `CollectionPage` ; elle est un onglet de la page du produit (S1). |
| TIC-02 | Types et états communs | Module `tickets` (`lib/`) | ✅ | — |
| TIC-03 | Détail d’un ticket | Module `tickets`, panneau ; `atlassian` a `lire-ticket`, `modifier-champ`, `commenter-ticket` | ✅ | Versions d’élément Jira à ajouter au connecteur. Contenu riche : `HtmlContent` / `Markdown`. |
| TIC-04 | Workflow et transitions | `atlassian` (`transitionner-ticket` existe) + `tickets` | ✅ | — |
| TIC-05 | Création | `atlassian` (`creer-ticket` existe), `gitlab`, `tickets` ; rédaction par `ai.oneShot` | ✅ | — |
| TIC-06 | Pièces jointes | Connecteurs | ➕ S6 | Envoi multipart (`X-Atlassian-Token`, `multipart/form-data`) et lecture binaire : S6. |
| TIC-07 | Envoyer à un agent | Module `tickets` + `ai.startAgent` / agents de travail | ➕ S3 | `ai.startAgent` ouvre une conversation limitée au module ; un agent qui travaille dans le dépôt du produit demande S3. |

### 9.2 Documentation et livrables

| Id | Fonction | Où dans Alfred | Statut | Remarque |
|---|---|---|---|---|
| DOC-01 | Confluence : Aperçu | Module `documentation` ; `atlassian` (`lire-page`) | ➕ S6 | Le HTML passe par `HtmlContent` ; les images de Confluence demandent une lecture binaire authentifiée puis `files.save` (S6). |
| DOC-02 | Confluence : Modification | Module `documentation` + `depots` | ➕ S2, S8 | Lire et écrire `docs/index.md` du dépôt, commit (S2) ; éditeur Markdown (S8, ou Tiptap par `set_libraries`). Conversion Markdown → stockage Confluence : `lib/` du module. |
| DOC-03 | Change log | Module `documentation` + `depots` ; notes par `ai.oneShot` | ➕ S2 | Lecture distante par `atlassian/lire-fichier` : ✅. |
| DOC-04 | Dossier d’architecture | Module `architecture` | ➕ S2, S8 | Fichiers dans le dépôt (S2) ; schéma S2 éditable : librairie de diagramme par `set_libraries` (règle 4 : contenu dessiné par la librairie), ou composant S8. |
| DOC-05 | Approbations et cartouche | Module `architecture` / `specifications` | ✅ | Tables et formulaires. |
| DOC-06 | PDF des livrables | Modules `specifications`, `architecture` | ✅ | `documents.pdf` est trop pauvre (ni image, ni couleur, Helvetica) ; une librairie PDF (`pdfmake`, `pdf-lib`) par `set_libraries` dans une fonction, puis `files.save`, suffit. Les polices d’entreprise se rangent dans les fichiers du module. |
| DOC-07 | Brouillon de courriel | Module `outlook` *(existant)* : `creer-brouillon` | ✅ | Pièce jointe depuis un fichier d’un autre module : l’appelant passe le contenu (base64) ou l’`id` ; à vérifier, les fichiers sont cloisonnés par module. |
| DOC-08 | Images de documents | Module `depots` | ➕ S2 | — |

### 9.3 Spécifications

| Id | Fonction | Où dans Alfred | Statut | Remarque |
|---|---|---|---|---|
| SPE-01 | Exigences | Module `specifications` | ➕ S2 | Les fichiers vivent dans `.oneapp/specifications/` du dépôt porteur : S2. Rédaction et extraction : `ai.oneShot`, `documents.extractText`. |
| SPE-02 | Fiches de test | Module `specifications` | ➕ S2 | — |
| SPE-03 | Exécutions de test | Module `specifications` | ➕ S2 | — |
| SPE-04 | Couverture | Module `specifications` | ✅ | Calcul dans `lib/` ; matrice en `DataTable`. |
| SPE-05 | SRS | Module `specifications` | ➕ S2 | PDF : voir DOC-06. |
| SPE-06 | Plan de tests | Module `specifications` | ➕ S2 | — |
| SPE-07 | Versions Git | Module `depots` + `specifications` | ➕ S2, S8 | Historique et diff (S2), affichage d’un diff (S8). |
| SPE-08 | Fenêtre des spécifications | Module `specifications`, `shell.openWindow` | ➕ S7 | Fenêtre paramétrée (quel produit). |

## 10. Projets, équipes et absences

| Id | Fonction | Où dans Alfred | Statut | Remarque |
|---|---|---|---|---|
| PRJ-01 | Kanban | Module `projets` | ➕ S8 | Glisser-déposer entre colonnes : composant tableau (S8). Justification : `openForm`. |
| PRJ-02 | Ordre partagé | `atlassian` (rang Jira, `PUT /rest/agile/1.0/issue/rank`), `gitlab` | ✅ | Fonction à ajouter au connecteur. |
| PRJ-03 | Reconnaissance du responsable | Module `projets` | ✅ | — |
| PRJ-04 | Planning | Module `projets` | ➕ S8 | Frise par personne absente de `@alfred/ui`. Historique : changelog Jira par le connecteur. |
| PRJ-05 | Équipes | Module `projets` (tables partagées en équipe, SDK § 17) | ✅ | Clé texte générée. |
| PRJ-06 | Absences | Module `outlook` *(existant)* : fonction `lire-disponibilites` en PowerShell (COM, Windows) ; agenda ICS par un client | ➕ S4 | COM : ✅ (le module `outlook` le fait déjà en `pwsh`). Une adresse ICS publiée porte son jeton dans l’URL : il faut une méthode « adresse secrète » (S4). |

## 11. Accès

| Id | Fonction | Où dans Alfred | Statut | Remarque |
|---|---|---|---|---|
| ACC-01 | Profils d’accès | Module `acces` (table partagée en équipe) | ✅ | — |
| ACC-02 | Matrice des accès | Module `acces` | ✅ | `DataTable` avec cases d’état. |
| ACC-03 | Attribution et réalignement | Module `acces` + `keycloak`, `grafana` | ✅ | Aperçu puis `confirmAction`. Depuis un agent : la fonction est `effect: "write"`, l’accord passe par la carte d’accord d’Alfred. |
| ACC-04 | Audit CSV | Module `acces`, `documents.csv` | ✅ | — |
| ACC-05 | Groupes d’alerte | Module `acces` | ✅ | — |

## 12. Synchronisation d’équipe

| Id | Fonction | Où dans Alfred | Statut | Remarque |
|---|---|---|---|---|
| SYN-01 | Plusieurs sources | Module `produits`, dossiers accordés (un clone par source) | ➕ S2 | Chaque source est un dossier Git du poste ; le module lit les déclarations de toutes les sources et en fait l’union. Le partage reste fondé sur les fichiers, comme dans OneApp. |
| SYN-02 | Déclarations partagées | Module `produits` (lecture et écriture des fichiers `.oneapp/`) | ➕ S2 | Même format qu’aujourd’hui : les dépôts existants restent lisibles par OneApp pendant la transition. |
| SYN-03 | Réglages personnels | Module `produits` (tables locales) | ✅ | Les réglages du poste restent dans les tables du module, jamais écrits dans les fichiers partagés. |
| SYN-04 | Identité métier | Module `produits` (`lib/`) | ✅ | Règle de rapprochement écrite dans le module, sur les fichiers lus. |
| SYN-05 | Choix récupérer / publier, conflits | Module `produits` + Git du dossier | ➕ S2 | `git pull`, `git status`, `git commit`, `git push` par dossier accordé ; l’aperçu et les choix sont des pages du module. |
| SYN-06 | Synchronisation automatique | Module `produits`, planification + Git du dossier | ➕ S2 | Relevé périodique (`git fetch`, `git pull`) puis publication des modifications locales. |
| SYN-07 | Dépendances partagées | Module `produits` | ➕ S2 | Règle du module : une connexion ou un environnement suit le produit qui l’emploie dans sa source. |
| SYN-08 | Déplacer un produit | Module `produits` + Git des deux dossiers | ➕ S2 | Écrire dans la source cible, retirer de l’ancienne, deux commits. |
| SYN-09 | Spécifications dans le dépôt du produit | Module `specifications` + Git du dossier | ➕ S2 | Ce n’est pas une synchronisation : c’est le dépôt Git du produit. |

## 13. Agents

| Id | Fonction | Où dans Alfred | Statut | Remarque |
|---|---|---|---|---|
| AGT-01 | Agents sur un produit ou un composant | SDK `ai.startAgent` avec dossier et mode imposés + module `agents-produits` | ➕ S3 | L’agent lancé par une page est aujourd’hui borné au module, en autonomie stricte. Il faut pouvoir lui imposer le dossier du produit et un mode (complet sans demande, écriture seule…). |
| AGT-02 | Pilotage des CLI | Cœur | ➕ S9 | Alfred parle les protocoles côté interface (`agents.rs` ne fait que lancer `codex app-server`, `opencode acp`, `claude`) ; OneApp a basculé OpenCode sur `opencode serve` piloté par Rust (ADR 0022), dont les jetons restent dans Rust. |
| AGT-03 | Conversation | Cœur (page Agent) | ✅ | 94 lignes identiques, 43 partielles, 79 absentes selon `docs/parite-agent-oneapp.md` ; les lots 1 à 6 de ce document sont le plan. Les références `#` (ticket, produit, composant) : S3. |
| AGT-04 | Orchestrateur global (délégation) | Cœur | ➕ S11 | À porter (décision de l’utilisateur) : un agent coordinateur répartit des tâches entre agents. |
| AGT-05 | Demandes confidentielles | Cœur (modèles habilités) + `ai.startAgent` | ➕ S3 | Le mode imposé d’un agent peut exiger un modèle habilité ; cadenas dans la saisie. |
| AGT-06 | Réglages par produit et par source | Module `agents-produits` (consignes, skills) + Cœur (application au lancement) | ➕ S3 | — |
| AGT-07 | Outils de OneApp pour les agents | Fonctions `tool: true` des modules | ➕ S3 | Les fonctions d’Alfred remplacent le MCP de OneApp (décision de l’utilisateur) ; il manque seulement de les offrir à un agent lancé par une page avec des entrées imposées (le produit), pour qu’il ne voie que son périmètre. Aucune association externe. |
| AGT-08 | Relances de fin d’exécution | Cœur + module `ci` (événement `execution-terminee`) | ➕ S10 | — |
| AGT-09 | Automatisations | Module `automatisations` + Cœur | ➕ S10 | Les déclencheurs se branchent sur les événements des modules (`ci/execution-terminee`, `sonarqube/gate-echouee`, `tickets/ticket-change`…) et les planifications ; il manque « lancer un agent » comme action, la confirmation et le journal. Déclencheur par script : fonction en script planifiée, ✅. |
| AGT-10 | Scripts d’action | Fonctions en script `tool: true` | ✅ | C’est exactement une fonction en script offerte aux agents, relue par l’utilisateur dans la fiche du module. |
| AGT-11 | Propositions d’agent | Cœur | ➕ S3 | — |
| AGT-12 | Agents dans la barre de gauche | Cœur (page Agent), par la même zone d’entrées que les pages | ➕ S1 | La page Agent crée une entrée par conversation dans sa zone du menu, sous un séparateur, comme toute page (S1). |
| AGT-13 | Fenêtre Agents détachée | Cœur | ➕ S7 | `shell.openWindow` ouvre une page de module, pas la page Agent. |
| AGT-14 | Appel unique | SDK `ai.oneShot` | ✅ | — |
| AGT-15 | Demandes depuis les pages | SDK `ai.startAgent` / agents de travail | ➕ S3 | Contexte de page transmis à l’agent ciblé seulement. |
| AGT-16 | Modifications des agents | Cœur (lot 4 de la parité : pastille Git) | ➕ S2, S3 | Dans le dossier imposé à l’agent, pas dans l’espace. |
| AGT-17 | Réglages Orchestrateur | Cœur (Réglages › Agent) | ✅ | Détection, modèles, raisonnement, nommage existent ou sont dans la parité ; simultanéité et plafond : S3. |

## 14. Notifications, réglages, sauvegardes

| Id | Fonction | Où dans Alfred | Statut | Remarque |
|---|---|---|---|---|
| GEN-01 | Centre de notifications | Cœur, `shell.notify` | ➕ S7 | Centre, surimpression et système existent ; **actions** et notifications **persistantes** non. |
| GEN-02 | Palette et aide | Cœur (`src/features/palette`) | ✅ | — |
| GEN-03 | Préférences | Cœur (Apparence) | ✅ | Rapports de plantage anonymisés : absents, non indispensables. |
| GEN-04 | Sauvegardes | Cœur (Réglages › Général) | ✅ | Quotidiennes, avant migration, par module. |
| GEN-05 | Diagnostics | Cœur (`read_journal`, journaux) | ✅ | Export d’un diagnostic : à ajouter si besoin, hors périmètre. |
| GEN-06 | Accueil | Cœur (accueil au premier démarrage, `bcb7b3b`) | ✅ | — |
| GEN-07 | Glisser-déposer natif | Cœur | ✅ | Pièces jointes de la page Agent ; `files.pick` dans les pages. |
| GEN-08 | Brouillons protégés | Cœur (lot 1 de la parité) | ✅ | Prévu par la parité des agents. |
| GEN-09 | Fermeture | Cœur (`src/shell/windowClose.ts`) | ✅ | — |
| GEN-10 | Recherche dans les réglages | Cœur | ✅ | Hors périmètre de la migration. |
| GEN-11 | Fenêtres secondaires et droits | Cœur (`page_windows.rs`) | ✅ | Chaque cadre a déjà ses accords. |
| GEN-12 | Parité Windows | Cœur | ➕ S12 | — |

---

## Les deux comportements impossibles en l’état

Ils ne manquent pas d’API : ils contredisent une règle d’Alfred. La voie retenue est dans les tableaux.

1. **Valeur de secret envoyée dans le corps d’une requête depuis la page** (SEC-03, copier une clé vers un autre environnement). OneApp ne substitue une référence que dans les en-têtes d’authentification et le corps d’une connexion. Copier une clé sans que la valeur passe par le webview demande une commande native dédiée (`secrets.copy`), pas une substitution générale dans les corps, qu’un service pourrait renvoyer en écho. Prévu dans S4.
2. **Une page qui appelle un service** (le modèle `src/lib/*Client.ts` de OneApp, où l’interface construit les requêtes). Alfred l’interdit : tout passe par les fonctions du connecteur. Aucune fonction n’est perdue, mais aucun client de OneApp ne se recopie tel quel.

L’accès complet sans demande d’autorisation des agents Codex de OneApp n’est plus rangé ici : un mode imposé par la page (« complet, sans aucune demande ») le permet désormais par choix explicite (S3).
