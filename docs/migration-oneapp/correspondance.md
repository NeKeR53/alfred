# Correspondance OneApp → Alfred

Livrable 2 sur 4. Pour chaque fonction de [fonctions-oneapp.md](fonctions-oneapp.md) : où elle vivrait dans Alfred et ce qu’il faut pour l’y faire vivre. État d’Alfred lu le 20 novembre 2026 sur `main` (`6f479a1`), avec `docs/espace/SDK.md`, `docs/espace/AGENTS.md`, `src-tauri/src/` et le marketplace `alfred.place` (modules `atlassian`, `jenkins`, `outlook`, `prefect`).

## Lecture

**Où** :
- **Module `x`** : un module de l’espace, créé dans le fil de l’agent d’Alfred (liste et messages de départ dans [plan.md](plan.md)). *(existant)* signale un module déjà publié dans `alfred.place`, à étendre.
- **SDK** : une capacité de `@alfred/sdk` ou du `module.json`.
- **Cœur** : la coque, les Réglages, la page Agent ou le natif d’Alfred, hors de tout module.

**Statut** :
- ✅ **déjà possible** : un module peut le faire aujourd’hui avec le SDK tel qu’il est.
- ➕ **Cn** : possible après le chantier *n* de [manques-alfred.md](manques-alfred.md).
- ⛔ **impossible en l’état** : contraire à un principe d’Alfred ou sans solution sûre sans décision de l’utilisateur (voir les questions de [plan.md](plan.md)).

**Chantiers** (détail dans [manques-alfred.md](manques-alfred.md)) :

| Code | Chantier |
|---|---|
| C1 | Secrets scellés et jetons émis par les services |
| C2 | Paramètres de compte et comptes partagés en équipe |
| C3 | Transport des clients : binaire, multipart, flux, WebSocket, proxy |
| C4 | Dossiers du poste et Git local |
| C5 | Coque : entrées de menu fournies par un module, agents dans la barre de gauche, notifications à actions, fenêtres paramétrées |
| C6 | Composants `@alfred/ui` manquants |
| C7 | Synchronisation d’équipe étendue |
| C8 | Moteur d’agents natif (Rust) |
| C9 | Agents de travail sur un dossier, outils limités, réglages, confidentialité |
| C10 | Suivis et automatisations d’agents |
| C11 | Délégation (orchestrateur) |
| C12 | Parité Windows |
| C13 | MCP ouvert aux clients externes |

## Synthèse

| Statut | Fonctions |
|---|---|
| ✅ déjà possible | 64 |
| ➕ après un chantier | 68 |
| **Total** | **132** |

Trois comportements de OneApp sont en plus **impossibles en l’état**, parce qu’ils contredisent une règle de sécurité d’Alfred ; leur fonction a une voie de remplacement, comptée ci-dessus (voir la fin du document).

Chantiers les plus souvent requis (nombre de fonctions) : C4 Git et dossiers (16), C5 navigation et coque (13), C6 composants (13), C1 secrets (9), C9 agents de travail (8), C7 synchronisation (7), C3 transport (5), C2 comptes (5).

---

## 1. Produits logiciels, composants, liaisons et connexions

| Id | Fonction | Où dans Alfred | Statut | Remarque |
|---|---|---|---|---|
| PRD-01 | Catalogue des produits | Module `produits` (tables `produits_produits`, `produits_composants`) ; une entrée du menu par produit | ➕ C5 | Les tables, l’ordre, le masquage et la corbeille (colonne `supprime_le` + `history`) sont possibles ; une entrée du menu **par produit** exige des entrées fournies par le module (C5). |
| PRD-02 | Assistant de création | Module `produits`, `openForm` en étapes ou `openSubpage` | ✅ | `StepList` existe ; le choix des ressources passe par les fonctions des connecteurs. |
| PRD-03 | Composants et liaisons | Module `produits` (table `produits_liaisons` : composant, type, compte `client/instance`, ressource) | ✅ | Une liaison vise un **compte** Alfred (`client/instance`) au lieu d’une connexion ; les fonctions des connecteurs reçoivent `instance` dans leur `input` (SDK § 6). La matrice des liaisons est un `DataTable`. |
| PRD-04 | Choix d’une ressource | Fonctions `lister-…` de chaque connecteur, appelées par `produits` (`requires`) | ✅ | `atlassian` a déjà `lister-depots` ; création de dépôt et de composant Jira à ajouter au connecteur. |
| PRD-05 | Import depuis GitLab | Module `gitlab` (fonction `lister-projets-groupe`) + `produits` | ✅ | — |
| PRD-06 | Espace local | Module `depots` + `produits` | ➕ C4 | Choisir un dossier, le parcourir, créer des sous-dossiers, cloner : aujourd’hui seulement par une fonction en script, sans dossier accordé ni sélecteur de dossier. |
| PRD-07 | Lecture distante | Module `atlassian` (`lire-fichier`, `lister-fichiers` existent) | ✅ | — |
| PRD-08 | Endpoint principal | Module `deploiements` ; `shell.openExternal` | ✅ | — |
| PRD-09 | Connexions | Cœur : comptes (Réglages › Modules, fiche du module, onboarding) | ➕ C2 | Ajout, méthode, TLS non vérifié, test et état existent ; manquent les paramètres non secrets d’un compte (realm, montage KV, endpoint) et le partage de la définition d’un compte avec l’équipe. La reconnaissance d’un outil à partir d’une adresse collée n’existe pas (onboarding guidé à la place). |
| PRD-10 | Environnements | Module `produits` (table `produits_environnements`, comptes Portainer, OpenBao, Keycloak, Grafana par environnement) | ✅ | Les comptes sont désignés par `client/instance` ; les boutons Secrets, Groupes, Clients naviguent vers les pages des modules `secrets` et `acces`. |
| PRD-11 | Portabilité d’un produit | Module `produits` (`documents`, `files.pick`, `files.export`) | ✅ | Export et import JSON ; Alfred exporte aussi les données d’un module (Réglages › Général). |
| PRD-12 | Annulation et historique | SDK `history` sur les tables de `produits` | ✅ | `history.revert` après confirmation. |
| PRD-13 | Commandes locales d’un composant | Module `depots` | ➕ C4, C1 | Lancer un terminal du poste dans le dossier du composant, avec un `.env` construit à partir des secrets sans que la page les lise : il faut un dossier accordé (C4) et l’écriture native d’un fichier d’environnement depuis des références (C1). |
| PRD-14 | Incohérences | Module `produits` (fonction `verifier-produit`) | ✅ | — |

## 2. Vue produit

| Id | Fonction | Où dans Alfred | Statut | Remarque |
|---|---|---|---|---|
| VUE-01 | Cartes d’état | Module `cockpit`, page « Composants » du produit | ➕ C5, C6 | Il faut la page d’un produit (C5) et une grille de cartes d’état avec pastilles (C6) : `@alfred/ui` n’a ni carte ni grille. |
| VUE-02 | Vue tableau | Module `cockpit`, `CollectionPage` | ➕ C5 | Le tableau est possible ; il dépend de la page par produit. |
| VUE-03 | Panneau de détail | Module `cockpit`, panneau `PanelSections` | ✅ | Le panneau unique, ses blocs repliables et déplaçables et leur disposition mémorisée existent (SDK § 8, DESIGN.md § 4.2). Faire défiler jusqu’à une section depuis la page : `shell.send`. |
| VUE-04 | Section Git | Module `depots` (fonctions) + `cockpit` | ➕ C4 | `commands.run("git", ["-C", dossier, …])` marche déjà, mais le dossier d’un produit est hors de l’espace et n’est pas accordé ; aucun garde-fou sur le dossier visé. |
| VUE-05 | Pull requests | Modules `atlassian` *(existant)*, `gitlab`, `cockpit` | ✅ | `lister-prs`, `lire-pr`, `commenter-pr`, `modifier-pr` existent pour Bitbucket. |
| VUE-06 | Section CI | Modules `ci`, `jenkins` *(existant)*, `gitlab` | ✅ | — |
| VUE-07 | Tag et release | Modules `ci`, `depots` | ➕ C4 | Dernier tag et commits depuis : Git local. |
| VUE-08 | Section Artefact | Module `artifactory`, `gitlab` | ➕ C3 | La liste et la copie du SHA sont possibles ; **télécharger** un binaire non : `client` décode la réponse en texte (UTF-8 avec pertes), 20 Mo au plus. |
| VUE-09 | Section Déploiement | Modules `portainer`, `deploiements` | ✅ | Lecture des conteneurs, comparaison à la version attendue. |
| VUE-10 | Section Qualité | Module `sonarqube` | ✅ | — |
| VUE-11 | Section Secrets | Module `secrets` | ➕ C1 | La présence des clés peut se lire sans valeur, mais l’API KV v2 renvoie toujours les valeurs avec les clés : sans réponse scellée, elles arrivent dans la fonction. |
| VUE-12 | Usine | Module `deploiements`, page « Usine » | ✅ | — |
| VUE-13 | Activité | Module `cockpit` | ➕ C6 | Frise d’activité absente de `@alfred/ui`. |
| VUE-14 | Affichage immédiat et cache | SDK : tables du module comme cache, `cache` des clients | ✅ | Les gabarits rechargent après écriture ; F5 = `reload()`. |

## 3. CI

| Id | Fonction | Où dans Alfred | Statut | Remarque |
|---|---|---|---|---|
| CI-01 | Dernière exécution et historique | Modules `jenkins` *(existant)*, `gitlab`, `ci` | ✅ | `jenkins` lit déjà les états et les logs. |
| CI-02 | Arbre des pipelines Jenkins | Module `jenkins` (à étendre) | ✅ | À reprendre de `jenkinsPipelineTree.ts`. |
| CI-03 | Lancer, relancer, arrêter | Modules `jenkins`, `gitlab` | ✅ | `relancer-job` existe ; ajouter lancement avec paramètres et sur un tag, et arrêt. |
| CI-04 | Suivi des exécutions lancées | Module `ci` : table des exécutions suivies, planification `everyMinutes: 1`, `shell.notify`, `events.publish("execution-terminee")` | ➕ C5 | Le suivi est possible (planification + table). La notification « Journal » qui ouvre la fenêtre sur ce build précis demande des notifications à actions et des fenêtres paramétrées (C5). |
| CI-05 | Sonde d’activité (10 s / 3 s) | Module `ci`, planification | ➕ C5 | La plus petite planification est d’une minute, et une page n’a pas de minuterie d’arrière-plan quand elle est fermée. Il faut une planification à la seconde ou des sondes gardées par la coque. Rangé dans C5 (« sondes rapides »). |
| CI-06 | Progression et durée | Module `ci` | ✅ | — |
| CI-07 | Fenêtre de journal CI | Module `ci`, page ouverte par `shell.openWindow` | ➕ C5, C6 | `openWindow` n’ouvre qu’une page, sans paramètre (quel build) ; visionneuse de journal (recherche, niveaux, suivi) absente de `@alfred/ui`. Suivi en direct : relectures périodiques suffisent (`consoleText` progressif), pas besoin de flux. |
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
| SEC-01 | Connexion OpenBao | Cœur (comptes) + module `openbao` | ➕ C1, C2 | Un jeton fixe passe déjà (`apiKey`, en-tête `X-Vault-Token`). OIDC par `bao login`, userpass ou LDAP renvoient un jeton dans la réponse : il faut une méthode « session » capturée nativement (C1). Montage KV et rôle : paramètres du compte (C2). |
| SEC-02 | Inventaire des secrets | Module `openbao` + `secrets` | ➕ C1 | Lister les dossiers et les clés est possible (`GET …/metadata/…?list=true`, sans valeur) ; mais connaître les clés d’un secret oblige à lire `…/data/…`, qui rend aussi les valeurs : réponse scellée (C1). |
| SEC-03 | Modale des secrets | Module `secrets` (page composée + `openModal` + panneau) | ➕ C1, C6 | Lecture scellée, « Afficher » sur un geste, écriture d’une valeur saisie, copie d’une clé d’un environnement à l’autre sans que la valeur passe par la page : C1. Matrice clés × environnements : `DataTable` suffit ; panneau imbriqué dans une modale : à vérifier (C6). |
| SEC-04 | Page Secrets globale | Module `secrets` | ➕ C1, C6 | Arborescence absente de `@alfred/ui` (C6). |
| SEC-05 | Secrets d’un environnement | Module `secrets` | ➕ C1 | — |
| SEC-06 | Valeurs scellées, `.env` | SDK (C1) | ➕ C1 | Cœur du chantier C1. |

## 7. Keycloak

| Id | Fonction | Où dans Alfred | Statut | Remarque |
|---|---|---|---|---|
| KC-01 | Connexion PKCE | Cœur (comptes, `oauth2` avec `clientId`, PKCE depuis `88b78e8`) + module `keycloak` | ➕ C2 | PKCE dans le navigateur existe ; l’adresse dépend du royaume (`{url}/realms/{realm}/protocol/openid-connect/auth`) : il faut un paramètre de compte `{realm}` (C2). Accès hors ligne : `scopes: ["offline_access"]`, à vérifier sur le renouvellement. |
| KC-02 | Groupes | Module `keycloak` (connecteur) + `acces` | ➕ C6 | API d’administration : possible ; arborescence des groupes : C6. |
| KC-03 | Clients applicatifs | Module `keycloak` | ✅ | — |
| KC-04 | Personnes | Module `keycloak` | ✅ | — |
| KC-05 | Keycloak → Grafana | Module `acces` | ✅ | Fonction qui appelle `keycloak/…` et `grafana/…`. |

## 8. Portainer

| Id | Fonction | Où dans Alfred | Statut | Remarque |
|---|---|---|---|---|
| PTN-01 | Conteneurs | Module `portainer` | ➕ C2 | Clé d’API Portainer (`X-API-Key`) : ✅. Identifiant + mot de passe (`/api/auth` renvoie un JWT) : C1. Endpoint Portainer par compte : C2. |
| PTN-02 | Journaux de conteneur | Module `deploiements`, fenêtre | ➕ C3, C5, C6 | Lecture des N dernières lignes : ✅ (la réponse Docker est multiplexée en binaire : il faut l’option binaire de C3). Suivi en direct : relecture `since` ou flux (C3). Fenêtre paramétrée (C5), visionneuse (C6). |
| PTN-03 | Console de conteneur | Module `deploiements` | ➕ C3, C6 | WebSocket d’exec ouvert nativement et relayé par un canal (C3) ; terminal (`@xterm/xterm` par `set_libraries`, ou composant C6). |
| PTN-04 | Fichier compose local | Module `depots` | ➕ C4 | — |
| PTN-05 | Fenêtre de déploiement | Module `deploiements` | ➕ C5 | Fenêtre paramétrée. |

## 9. Jira et Confluence

### 9.1 Tickets

| Id | Fonction | Où dans Alfred | Statut | Remarque |
|---|---|---|---|---|
| TIC-01 | Liste des tickets | Module `tickets` (pages), connecteurs `atlassian` *(existant)* et `gitlab` | ➕ C5 | La liste est un `CollectionPage` ; elle est un onglet de la page du produit (C5). |
| TIC-02 | Types et états communs | Module `tickets` (`lib/`) | ✅ | — |
| TIC-03 | Détail d’un ticket | Module `tickets`, panneau ; `atlassian` a `lire-ticket`, `modifier-champ`, `commenter-ticket` | ✅ | Versions d’élément Jira à ajouter au connecteur. Contenu riche : `HtmlContent` / `Markdown`. |
| TIC-04 | Workflow et transitions | `atlassian` (`transitionner-ticket` existe) + `tickets` | ✅ | — |
| TIC-05 | Création | `atlassian` (`creer-ticket` existe), `gitlab`, `tickets` ; rédaction par `ai.oneShot` | ✅ | — |
| TIC-06 | Pièces jointes | Connecteurs | ➕ C3 | Envoi multipart (`X-Atlassian-Token`, `multipart/form-data`) et lecture binaire : C3. |
| TIC-07 | Envoyer à un agent | Module `tickets` + `ai.startAgent` / agents de travail | ➕ C9 | `ai.startAgent` ouvre une conversation limitée au module ; un agent qui travaille dans le dépôt du produit demande C9. |

### 9.2 Documentation et livrables

| Id | Fonction | Où dans Alfred | Statut | Remarque |
|---|---|---|---|---|
| DOC-01 | Confluence : Aperçu | Module `documentation` ; `atlassian` (`lire-page`) | ➕ C3 | Le HTML passe par `HtmlContent` ; les images de Confluence demandent une lecture binaire authentifiée puis `files.save` (C3). |
| DOC-02 | Confluence : Modification | Module `documentation` + `depots` | ➕ C4, C6 | Lire et écrire `docs/index.md` du dépôt, commit (C4) ; éditeur Markdown (C6, ou Tiptap par `set_libraries`). Conversion Markdown → stockage Confluence : `lib/` du module. |
| DOC-03 | Change log | Module `documentation` + `depots` ; notes par `ai.oneShot` | ➕ C4 | Lecture distante par `atlassian/lire-fichier` : ✅. |
| DOC-04 | Dossier d’architecture | Module `architecture` | ➕ C4, C6 | Fichiers dans le dépôt (C4) ; schéma C4 éditable : librairie de diagramme par `set_libraries` (règle 4 : contenu dessiné par la librairie), ou composant C6. |
| DOC-05 | Approbations et cartouche | Module `architecture` / `specifications` | ✅ | Tables et formulaires. |
| DOC-06 | PDF des livrables | Modules `specifications`, `architecture` | ✅ | `documents.pdf` est trop pauvre (ni image, ni couleur, Helvetica) ; une librairie PDF (`pdfmake`, `pdf-lib`) par `set_libraries` dans une fonction, puis `files.save`, suffit. Les polices d’entreprise se rangent dans les fichiers du module. |
| DOC-07 | Brouillon de courriel | Module `outlook` *(existant)* : `creer-brouillon` | ✅ | Pièce jointe depuis un fichier d’un autre module : l’appelant passe le contenu (base64) ou l’`id` ; à vérifier, les fichiers sont cloisonnés par module. |
| DOC-08 | Images de documents | Module `depots` | ➕ C4 | — |

### 9.3 Spécifications

| Id | Fonction | Où dans Alfred | Statut | Remarque |
|---|---|---|---|---|
| SPE-01 | Exigences | Module `specifications` | ➕ C4 | Les fichiers vivent dans `.oneapp/specifications/` du dépôt porteur : C4. Rédaction et extraction : `ai.oneShot`, `documents.extractText`. |
| SPE-02 | Fiches de test | Module `specifications` | ➕ C4 | — |
| SPE-03 | Exécutions de test | Module `specifications` | ➕ C4 | — |
| SPE-04 | Couverture | Module `specifications` | ✅ | Calcul dans `lib/` ; matrice en `DataTable`. |
| SPE-05 | SRS | Module `specifications` | ➕ C4 | PDF : voir DOC-06. |
| SPE-06 | Plan de tests | Module `specifications` | ➕ C4 | — |
| SPE-07 | Versions Git | Module `depots` + `specifications` | ➕ C4, C6 | Historique et diff (C4), affichage d’un diff (C6). |
| SPE-08 | Fenêtre des spécifications | Module `specifications`, `shell.openWindow` | ➕ C5 | Fenêtre paramétrée (quel produit). |

## 10. Projets, équipes et absences

| Id | Fonction | Où dans Alfred | Statut | Remarque |
|---|---|---|---|---|
| PRJ-01 | Kanban | Module `projets` | ➕ C6 | Glisser-déposer entre colonnes : composant tableau (C6). Justification : `openForm`. |
| PRJ-02 | Ordre partagé | `atlassian` (rang Jira, `PUT /rest/agile/1.0/issue/rank`), `gitlab` | ✅ | Fonction à ajouter au connecteur. |
| PRJ-03 | Reconnaissance du responsable | Module `projets` | ✅ | — |
| PRJ-04 | Planning | Module `projets` | ➕ C6 | Frise par personne absente de `@alfred/ui`. Historique : changelog Jira par le connecteur. |
| PRJ-05 | Équipes | Module `projets` (tables partagées en équipe, SDK § 17) | ✅ | Clé texte générée. |
| PRJ-06 | Absences | Module `outlook` *(existant)* : fonction `lire-disponibilites` en PowerShell (COM, Windows) ; agenda ICS par un client | ➕ C1 | COM : ✅ (le module `outlook` le fait déjà en `pwsh`). Une adresse ICS publiée porte son jeton dans l’URL : il faut une méthode « adresse secrète » (C1). |

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
| SYN-01 | Plusieurs sources | SDK `sync` | ➕ C7 | Alfred relie un module à **un** dépôt ; OneApp unit plusieurs dépôts actifs. |
| SYN-02 | Déclarations partagées | SDK `sync` | ➕ C7 | Alfred range une ligne par fichier (`<module>/<table>/<clé>.json`) ; OneApp un document par produit (composants et liaisons dedans) sous `.oneapp/`. Compatibilité directe : C7 (disposition déclarée) ; sinon migration (module `reprise-oneapp`). |
| SYN-03 | Réglages personnels | SDK `sync` | ➕ C7 | Colonnes non partagées d’une table partagée. Contournement possible dès aujourd’hui : une table locale à part, jointe par la clé. |
| SYN-04 | Identité métier | SDK `sync` | ➕ C7 | — |
| SYN-05 | Choix récupérer / publier, conflits | SDK `sync` + Cœur (fiche du module) | ➕ C7 | Alfred : la version de l’équipe l’emporte, la version locale va au journal ; ni aperçu, ni choix, ni confirmation des suppressions. |
| SYN-06 | Synchronisation automatique | SDK `sync` | ✅ | Toutes les deux minutes et à la demande ; la règle « publier seulement le local » n’existe pas, mais l’échange bidirectionnel la couvre. |
| SYN-07 | Dépendances partagées | SDK `sync` (C2 pour les comptes) | ➕ C2, C7 | Les comptes ne voyagent pas aujourd’hui. |
| SYN-08 | Déplacer un produit | SDK `sync` | ➕ C7 | Suit SYN-01. |
| SYN-09 | Spécifications dans le dépôt du produit | Module `specifications` + `depots` | ➕ C4 | Ce n’est pas une synchronisation : c’est le dépôt Git du produit. |

## 13. Agents

| Id | Fonction | Où dans Alfred | Statut | Remarque |
|---|---|---|---|---|
| AGT-01 | Agents sur un produit ou un composant | Cœur (page Agent) + module `agents-produits` | ➕ C9 | L’agent d’Alfred travaille dans l’espace ; `ai.startAgent` est borné au module. Il faut un agent de travail dans un dossier accordé, avec les outils limités à son produit. |
| AGT-02 | Pilotage des CLI | Cœur | ➕ C8 | Alfred parle les protocoles côté interface (`agents.rs` ne fait que lancer `codex app-server`, `opencode acp`, `claude`) ; OneApp a basculé OpenCode sur `opencode serve` piloté par Rust (ADR 0022), dont les jetons restent dans Rust. |
| AGT-03 | Conversation | Cœur (page Agent) | ✅ | 94 lignes identiques, 43 partielles, 79 absentes selon `docs/parite-agent-oneapp.md` ; les lots 1 à 6 de ce document sont le plan. Les références `#` (ticket, produit, composant) : C9. |
| AGT-04 | Orchestrateur global | Cœur | ➕ C11 | Remplacé par l’ADR 0010 chez OneApp ; seul son historique est consultable. À ne porter que si l’utilisateur le veut (question). |
| AGT-05 | Demandes confidentielles | Cœur | ➕ C9 | Modèles habilités, cadenas par demande, refus de router. |
| AGT-06 | Réglages par produit et par source | Module `agents-produits` (consignes, skills) + Cœur (application au lancement) | ➕ C9 | — |
| AGT-07 | Outils MCP de OneApp | Fonctions `tool: true` des modules (outils `fn__module__fonction`) | ➕ C9 | Les outils existent par module ; manque le filtrage par périmètre (un agent de produit ne voit que les fonctions de son produit, appelées avec ce produit). Association externe : C13. |
| AGT-08 | Relances de fin d’exécution | Cœur + module `ci` (événement `execution-terminee`) | ➕ C10 | — |
| AGT-09 | Automatisations | Module `automatisations` + Cœur | ➕ C10 | Les déclencheurs se branchent sur les événements des modules (`ci/execution-terminee`, `sonarqube/gate-echouee`, `tickets/ticket-change`…) et les planifications ; il manque « lancer un agent » comme action, la confirmation et le journal. Déclencheur par script : fonction en script planifiée, ✅. |
| AGT-10 | Scripts d’action | Fonctions en script `tool: true` | ✅ | C’est exactement une fonction en script offerte aux agents, relue par l’utilisateur dans la fiche du module. |
| AGT-11 | Propositions d’agent | Cœur | ➕ C9 | — |
| AGT-12 | Agents dans la barre de gauche | Cœur | ➕ C5 | Alfred a une entrée « Agent » avec sa pastille ; la liste des conversations est dans la page Agent. |
| AGT-13 | Fenêtre Agents détachée | Cœur | ➕ C5 | `shell.openWindow` ouvre une page de module, pas la page Agent. |
| AGT-14 | Appel unique | SDK `ai.oneShot` | ✅ | — |
| AGT-15 | Demandes depuis les pages | SDK `ai.startAgent` / agents de travail | ➕ C9 | Contexte de page transmis à l’agent ciblé seulement. |
| AGT-16 | Modifications des agents | Cœur (lot 4 de la parité : pastille Git) | ➕ C9 | Dans un dossier de produit, pas dans l’espace. |
| AGT-17 | Réglages Orchestrateur | Cœur (Réglages › Agent) | ✅ | Détection, modèles, raisonnement, nommage existent ou sont dans la parité ; simultanéité et plafond : C9. |

## 14. Notifications, réglages, sauvegardes

| Id | Fonction | Où dans Alfred | Statut | Remarque |
|---|---|---|---|---|
| GEN-01 | Centre de notifications | Cœur, `shell.notify` | ➕ C5 | Centre, surimpression et système existent ; **actions** et notifications **persistantes** non. |
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
| GEN-12 | Parité Windows | Cœur | ➕ C12 | — |

---

## Les trois fonctions impossibles en l’état

Ces trois points ne manquent pas d’API : ils contredisent une règle d’Alfred. Ils ne sont pas comptés à part dans les tableaux, qui donnent la voie retenue.

1. **Agents Codex en `danger-full-access`, approbation `never`** (AGT-01, constat 2 de `docs/parite-agent-oneapp.md`). Alfred fait remonter les demandes selon un niveau d’autonomie. Reproduire la politique de OneApp revient à donner un accès complet au poste sans carte d’accord. Voie proposée : un niveau d’autonomie « dossier du produit » dans C9, l’accès complet restant un choix explicite de l’utilisateur.
2. **Valeur de secret envoyée dans le corps d’une requête depuis la page** (SEC-03, copier une clé vers un autre environnement). OneApp substitue une référence seulement dans les en-têtes d’authentification et le corps d’une connexion. Copier une clé sans que la valeur passe par le webview demande une commande native dédiée (`secrets.copy`), pas une substitution générale dans les corps, qu’un service pourrait renvoyer en écho. Prévu dans C1.
3. **Une page qui appelle un service** (le modèle `src/lib/*Client.ts` de OneApp, où l’interface construit les requêtes). Alfred l’interdit : tout passe par les fonctions du connecteur. Ce n’est pas une perte de fonction, mais aucun client de OneApp ne se recopie tel quel : chaque appel devient une fonction de connecteur avec `effect`, tests et exemples.
