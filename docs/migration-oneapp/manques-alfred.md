# Ce qu’il faut ajouter à Alfred avant de créer les modules

Livrable 3 sur 4. Les manques viennent de [correspondance.md](correspondance.md) ; chacun est un **chantier** livrable seul, avec sa justification, l’API proposée, sa taille et sa place dans l’ordre. Les codes C1 à C13 sont ceux de la correspondance.

Tailles, pour un développement fait avec un agent de code et ses vérifications (tests, typecheck, interface Vite branchée sur Alfred debug) : **S** ≤ 2 jours, **M** 3 à 5 jours, **L** 1 à 2 semaines, **XL** plus de 2 semaines.

## Vue d’ensemble

| Ordre | Code | Chantier | Famille | Taille | Débloque |
|---|---|---|---|---|---|
| 1 | C1 | Secrets scellés et jetons émis par les services | Sécurité, comptes et coffre | L | `openbao`, `secrets`, `portainer` (mot de passe), absences ICS |
| 2 | C2 | Paramètres de compte et comptes partagés en équipe | Comptes et coffre | M | `keycloak`, `openbao`, `portainer`, partage des connexions |
| 3 | C3 | Transport des clients : binaire, multipart, flux, WebSocket | Natif Rust, SDK | L | artefacts, pièces jointes, images Confluence, journaux et console de conteneur |
| 4 | C4 | Dossiers du poste et Git local | Natif Rust, SDK | M | `depots`, Git de la vue produit, spécifications, change log, architecture |
| 5 | C5 | Coque : entrées fournies par un module, notifications à actions, fenêtres paramétrées, sondes rapides, agents dans la barre de gauche | Coque et navigation | L | toutes les pages « produit », fenêtres de journal, notifications de CI |
| 6 | C6 | Composants `@alfred/ui` manquants | Coque et navigation | L | cartes d’état, kanban, planning, journaux, arbres, terminal, diff |
| 7 | C8 | Moteur d’agents natif (Rust) | Agents, natif Rust | L | C9, C10 ; corrige le jeton MCP en ligne de commande |
| 8 | C9 | Agents de travail sur un dossier, outils limités, réglages, confidentialité | Agents | L | `agents-produits`, actions « Envoyer à un agent » |
| 9 | C10 | Suivis et automatisations d’agents | Agents | M | `automatisations`, relances de fin de CI |
| 10 | C7 | Synchronisation d’équipe étendue | Synchronisation d’équipe | XL | partage du catalogue entre équipes, reprise des dépôts `.oneapp/` |
| — | C12 | Parité Windows | Windows | M, au fil de l’eau | tout, sur les postes de l’équipe |
| option | C11 | Délégation (orchestrateur) | Agents | L | seulement si l’utilisateur la veut |
| option | C13 | MCP ouvert aux clients externes | Agents, sécurité | S | Codex ou Claude lancés hors d’Alfred |

Total sans les options : environ 12 à 16 semaines de développement assisté, dont une bonne part parallélisable (C3, C4, C6 et C8 ne touchent pas les mêmes fichiers).

C7 est placé en dernier exprès : la reprise des données de OneApp peut se faire par un import ponctuel (module `reprise-oneapp`, [plan.md](plan.md)) sans attendre la synchronisation étendue ; C7 ne devient indispensable que lorsque plusieurs équipes partagent le catalogue depuis Alfred.

---

## Vérifications demandées

### La garantie de sécurité des secrets

**Garantie de OneApp** (`AGENTS.md` § Security, `src-tauri/src/secret_references.rs`) : le webview ne voit jamais un secret. Il reçoit une référence opaque `oneapp-secret-ref:v1:<nonce>` que le transport natif remplace, seulement dans un en-tête d’authentification (`authorization`, `x-api-key`, `private-token`, `x-vault-token`, `x-jfrog-art-api`) ou le corps d’une connexion, et seulement vers l’origine de la connexion propriétaire. Les jetons émis par les services (Keycloak, Portainer, OpenBao, vérificateur et code PKCE) sont capturés nativement et ne parviennent au webview que comme références. Les valeurs des secrets OpenBao arrivent aussi comme références et ne se montrent que par `reveal_secret_value` ou s’écrivent par `save_environment_file`.

**Garantie d’Alfred** (`src-tauri/src/clients.rs`, SDK § 6) : plus forte sur un point, plus faible sur deux.

| Point | OneApp | Alfred | Écart |
|---|---|---|---|
| Qui construit la requête | le webview, avec des références | une fonction de connecteur ; la page ne peut pas appeler un client | Alfred est plus strict : aucune page n’atteint un service. |
| Où va le secret | en-têtes d’authentification de l’origine propriétaire | posé par Rust en dernier, en-têtes réservés refusés à l’appelant, `path` confiné sous l’adresse de base (ni `//`, `..`, `@`) | équivalent. |
| Écho d’un secret dans la réponse | — | `redact` retire le secret (texte, JSON échappé, base64) des en-têtes et du corps | Alfred est plus strict. |
| Jeton OAuth 2 et `clientCredentials` | natif (Keycloak) | natif, renouvelé sur 401 (`credential`, `renewable`) | équivalent. |
| Jeton rendu par une **connexion par identifiant** (Portainer `/api/auth`, OpenBao userpass/LDAP/OIDC, Keycloak mot de passe) | capturé nativement, référence au webview | **aucun mécanisme** : la fonction devrait poster l’identifiant et lirait le jeton dans le corps | **manque** (C1). |
| **Valeurs** de secrets rendues par un service (OpenBao KV) | références, `reveal_secret_value`, `save_environment_file` | rendues en clair dans le corps à la fonction | **manque** (C1). |
| Cadre qui exécute la fonction | webview principal | cadre invisible, sans réseau ni disque, sous le pont du SDK | Alfred isole mieux : même si une valeur arrive, elle ne sort que par le pont. |
| Jeton du serveur MCP local passé au CLI | variable d’environnement (OneApp, `ONEAPP_MCP_TOKEN`) | Codex et OpenCode : variable `ALFRED_MCP_TOKEN` ; **Claude Code : en clair dans l’argument `--mcp-config`** (`agents.rs` l. 314-316), lisible par tout processus de l’utilisateur | **défaut** à corriger (C8). |

Conclusion : la garantie tient pour tous les services à jeton fixe, OAuth 2 et `clientCredentials` (Jira, Bitbucket, Confluence, Jenkins, GitLab, SonarQube, Artifactory, Grafana, Portainer par clé d’API, OpenBao par jeton fixe, Keycloak par PKCE). Elle ne tient pas pour les jetons rendus par une connexion par identifiant ni pour les valeurs OpenBao : C1 les ferme.

### Les jetons fournis par les services

| Service | Méthode chez OneApp | Ce qu’Alfred sait faire | Ajout |
|---|---|---|---|
| Keycloak | PKCE au navigateur, accès hors ligne, royaume par connexion (`keycloak_auth.rs`) | `oauth2` avec `clientId` public et PKCE (`88b78e8`), `{url}` dans les adresses | paramètre `{realm}` dans `authorizationUrl` et `tokenUrl` (C2) ; vérifier le renouvellement d’un jeton hors ligne (`offline_access`). |
| Portainer | clé d’API, ou identifiant + mot de passe → JWT | clé d’API (`apiKey`, `X-API-Key`) | méthode `session` (C1) ; endpoint par compte (C2). |
| OpenBao | jeton, ou `bao login -method=oidc` lancé nativement | jeton fixe (`apiKey`, `X-Vault-Token`) | méthode `session` pour userpass et LDAP (C1) ; OIDC : méthode `session` avec `kind: "oidc"` (rappel au navigateur par la boucle locale d’`oauth.rs`) ou commande `bao login` lancée nativement (`fromCommand` ne suffit pas : le jeton expire) ; montage KV et rôle par compte (C2). |

### Le pilotage des agents de OneApp absent d’Alfred

| Élément | OneApp | Alfred | Chantier |
|---|---|---|---|
| `opencode serve` en Rust | serveur privé sur 127.0.0.1, mot de passe aléatoire en environnement, appairage `/api/pair` → jeton, SSE `/api/event`, rattrapage par `session.message.list` ; webview limité à des commandes fermées (ADR 0022, `src-tauri/src/agents/opencode/`) | `opencode acp` sur stdio, protocole parlé par l’interface | C8 |
| Demandes confidentielles | cadenas par demande, modèles « Autorisé pour les actions secret », refus de router | — | C9 |
| Orchestrateur global | `oneapp_threads` (dispatch, status, send, rapports), contrat JSON ; remplacé par l’ADR 0010 | — | C11 (option) |
| Automatisations | déclencheurs internes, cron, script ; confirmation ; journal | webhooks, planifications, événements entre modules ; pas d’action « lancer un agent » | C10 |
| Relances de fin de CI | `watch_completion`, suivis persistés avec l’agent | — | C10 |
| Agents sur un produit | dossier du produit, MCP limité au produit, réglages par produit et source | agent de l’espace ; `ai.startAgent` limité au module | C9 |

### La navigation

OneApp : produits et agents dans la barre de gauche, un panneau de droite unique. Alfred : le menu de gauche liste les **pages de l’utilisateur**, faites à partir des modèles des modules ; une entrée « Agent » ; un panneau de droite par page, qui laisse la place à la conversation d’un agent lancé par la page (`AppShell.tsx` l. 164-296).

- **Panneau de droite unique** : déjà là. Une page n’a qu’un panneau, ses blocs se replient et se déplacent, leur disposition est retenue, sa largeur est le choix de l’utilisateur (340, 460, large). Rien à ajouter.
- **Produits dans la barre de gauche** : impossible aujourd’hui sans que l’utilisateur crée à la main une page par produit. C5 ajoute des entrées fournies par un module.
- **Agents dans la barre de gauche** : C5.

### Le partage d’équipe et les dépôts `.oneapp/`

Alfred range une ligne par fichier (`<module>/<table>/<clé>.json`) dans **un** dépôt par module ; la version de l’équipe l’emporte. OneApp range une déclaration par fichier (`.oneapp/products/<id>.json` avec ses composants et liaisons, `connections/`, `environments/`, `settings/access.json`, `settings/agents.json`) dans **plusieurs** sources actives, avec rapprochement par identité métier, champs personnels, aperçu, choix et confirmation.

Les deux formats ne sont pas compatibles. Deux voies :

1. **Migration** (recommandée) : un module `reprise-oneapp` lit une fois les dépôts `.oneapp/` (clonés ou locaux) et remplit les tables des modules et les comptes ; chaque équipe relie ensuite ses modules à un nouveau dépôt Alfred. OneApp et Alfred ne partagent plus rien après la bascule. Aucun chantier de plateforme ne la bloque, hormis C2 pour recréer les comptes et C4 pour lire un dépôt local.
2. **Compatibilité** : C7 avec une disposition déclarée (`sync.layout`) qui écrit les fichiers au format `.oneapp/`. Elle permet une cohabitation OneApp / Alfred dans la même équipe, au prix de recopier dans Alfred les règles de OneApp (identité métier, champs personnels, documents imbriqués). C’est l’essentiel de la taille XL de C7.

La question est posée dans [plan.md](plan.md).

### La parité Windows

Voir C12.

---

## C1 · Secrets scellés et jetons émis par les services

**Famille** : sécurité, comptes et coffre. **Taille** : L. **Ordre** : 1.

**Justification** : sans lui, `openbao` ferait arriver les valeurs des secrets dans les fonctions, et `portainer` ou `openbao` par identifiant feraient lire le jeton de session par la fonction. C’est la seule régression de sécurité par rapport à OneApp.

**API proposée** :

1. **Méthode d’authentification `session`** (dans `methods[]` et `auth`) : Alfred fait lui-même la requête de connexion, garde le jeton au coffre et le pose sur chaque requête ; renouvelle sur 401 ou à l’expiration.
   ```json
   { "id": "motdepasse", "label": "Identifiant et mot de passe", "type": "session",
     "login": { "method": "POST", "path": "/api/auth", "body": { "username": "{username}", "password": "{password}" },
                "token": "jwt", "expiresIn": null },
     "apply": { "header": "Authorization", "prefix": "Bearer " } }
   ```
   OpenBao userpass : `"path": "/v1/auth/userpass/login/{username}"`, `"token": "auth.client_token"`, `"expiresIn": "auth.lease_duration"`, `"apply": { "header": "X-Vault-Token" }`. Le coffre garde l’identifiant (`basic`) et le jeton ; le jeton n’apparaît dans aucune réponse rendue (il est ajouté à la liste de `redact`).
2. **Réponses scellées** : un client déclare les champs de réponse qui sont des secrets ; Alfred les remplace par une référence opaque `alfred-secret-ref:v1:<nonce>` avant de rendre la réponse.
   ```json
   "sealed": [{ "path": "/v1/{mount}/data/**", "fields": ["data.data.*"] }]
   ```
   Une référence vaut pour le compte, le module et la session d’Alfred ; elle expire (5 minutes, comme `VALUE_CACHE_TTL` de OneApp) et ne se résout que par :
   - `secrets.reveal(ref)` : page ou panneau seulement, sur un geste de l’utilisateur ; rend la valeur à afficher (comme `reveal_secret_value`) ; journalisé (`kind: "secret"`, sans valeur) ;
   - `secrets.writeEnvFile({ folder, file, entries: [{ name, ref }] })` : écrit un `.env` dans un dossier accordé (C4), sans que la valeur passe par la page (comme `save_environment_file`) ;
   - `secrets.copy({ from: ref, client, instance, path, field })` : écrit la valeur vers un autre compte du **même service** par une requête native, sans corps fourni par l’appelant (copie d’une clé d’un environnement à l’autre).
   Une référence placée dans le corps ou un paramètre d’une requête ordinaire n’est **pas** substituée : elle partirait telle quelle (règle de OneApp : substitution limitée aux en-têtes d’authentification).
3. **Méthode « adresse secrète »** (`type: "secretUrl"`) : toute l’adresse du compte est au coffre (agenda ICS publié par Outlook, avec son jeton dans l’URL) ; `client(id).get("/")` la lit.
4. **`ai` et références** : une référence passée à `ai.oneShot` ou à un agent reste une chaîne opaque ; aucun appel ne la résout.

**Fichiers** : `src-tauri/src/clients.rs` (méthode `session`, `sealed`), `src-tauri/src/vault.rs` (jeton de session), nouveau `src-tauri/src/secret_refs.rs`, `src/sdk/` (`secrets`), `docs/espace/SDK.md`, `docs/espace/AGENTS.md`, onboarding (méthode `session` : champs identifiant et mot de passe).

**Tests** : un faux Portainer rend un JWT, la fonction ne le voit jamais et les requêtes suivantes le portent ; un faux OpenBao rend des valeurs, la fonction reçoit des références, `reveal` rend la valeur sur un geste et refuse depuis une fonction ; `writeEnvFile` refuse un dossier non accordé ; une référence en corps n’est pas substituée.

## C2 · Paramètres de compte et comptes partagés en équipe

**Famille** : comptes et coffre. **Taille** : M. **Ordre** : 2.

**Justification** : OneApp garde par connexion des réglages non secrets que les adresses et les fonctions utilisent : royaume Keycloak, montage KV et rôle OpenBao, endpoint Portainer, projet Grafana. Et une connexion (type + adresse, sans secret) voyage avec l’équipe : un collègue n’ajoute que son jeton.

**API proposée** :

1. **Paramètres d’une méthode** : `methods[].params` déclare des champs non secrets saisis avec le compte ; ils se substituent dans les adresses (`{realm}`, `{mount}`, `{endpoint}`) et se lisent dans les fonctions.
   ```json
   { "id": "pkce", "type": "oauth2", "clientId": "alfred",
     "params": [{ "id": "realm", "label": "Royaume", "example": "equipe" }],
     "authorizationUrl": "{url}/realms/{realm}/protocol/openid-connect/auth",
     "tokenUrl": "{url}/realms/{realm}/protocol/openid-connect/token", "scopes": ["openid", "offline_access"] }
   ```
   `client(id, { instance }).params()` → `{ realm: "equipe" }` ; `{param}` aussi permis en tête de `path` d’une requête (`/admin/realms/{realm}/users`). L’onboarding affiche ces champs dans l’assistant, l’état « à vérifier » les couvre.
2. **Comptes partagés** : une option « Partager ce compte avec l’équipe » range sa définition (libellé, adresse, méthode, paramètres non marqués `personal`, jamais le secret) dans le dépôt de partage de l’espace ; chez un collègue, le compte apparaît « Mot de passe manquant » et l’onboarding lui demande seulement son jeton. Identité d’un compte : type + adresse + paramètres d’identité (`params[].identity: true`, par exemple le royaume), pour rapprocher au lieu de dupliquer (ADR 0012 de OneApp). Les réglages personnels (méthode choisie, TLS non vérifié) restent locaux.

**Fichiers** : `src-tauri/src/clients.rs`, `src-tauri/src/team_sync.rs` (ou C7), `src/features/clients/`, onboarding, SDK.md.

## C3 · Transport des clients : binaire, multipart, flux, WebSocket

**Famille** : natif Rust, SDK. **Taille** : L. **Ordre** : 3.

**Justification** : `perform` lit la réponse en texte (`String::from_utf8_lossy`), 20 Mo et 60 s au plus, sans envoi de fichier ni connexion longue. OneApp télécharge des artefacts, lit et envoie des pièces jointes, lit les images de Confluence, suit les journaux Docker (multiplexés en binaire) et ouvre la console d’exec de Portainer en WebSocket.

**API proposée** :

1. **Téléchargement vers un fichier du module** : `client(id).download(path, { name, query?, maxBytes? })` → `FileInfo` ; le corps va directement dans `.alfred/files/<module>/` (limite portée à 2 Go, en flux), sans passer par la fonction ; SHA-256 calculé. La page propose `files.export`.
2. **Réponse binaire** : `request({ …, responseType: "base64" })` pour un petit binaire (≤ 5 Mo), par exemple une image de Confluence ou un journal Docker multiplexé.
3. **Envoi multipart** : `body: { multipart: [{ name: "file", file: "<id d’un fichier du module>" }, { name: "comment", value: "…" }] }`.
4. **Canaux** (flux et WebSocket) : une fonction de connecteur ouvre un canal ; la page lit et écrit par le canal, sans jamais joindre le client.
   ```ts
   // fonction du connecteur portainer
   const canal = await client("portainer", { instance }).socket(`/api/websocket/exec?id=${exec}&endpointId=${endpoint}`);
   return { canal: canal.id };
   // page
   channels.read(canal, { after }) // { chunks: [{ seq, data }], closed }
   channels.write(canal, texte);
   channels.close(canal);
   ```
   Même règle pour un flux HTTP (`client.stream(path)` : SSE, `follow=1` de Docker). Un canal appartient au module qui l’a ouvert, se ferme avec le cadre de la page et après 10 minutes sans lecture ; 64 Kio par écriture (comme `MAX_INPUT_BYTES` de OneApp).
5. **Proxy et certificats d’entreprise** : `git_network.rs` gère déjà proxy et certificats du système pour git. Vérifier que `shared_http` de `clients.rs` passe aussi par le proxy du système et le magasin de certificats sous Windows (non vérifié dans cette étude).

**Fichiers** : `src-tauri/src/clients.rs`, `src-tauri/src/module_files.rs`, nouveau `src-tauri/src/channels.rs`, `src/sdk/`, SDK.md (§ 6, nouveau § canaux), `script_sdk.rs` (méthodes `clients.download`, `channels.*` sur le pont des scripts).

## C4 · Dossiers du poste et Git local

**Famille** : natif Rust, SDK. **Taille** : M. **Ordre** : 4.

**Justification** : la moitié de OneApp travaille dans l’**espace local** d’un produit : état Git, fetch, pull, commit, push, branches, dernier tag, `docs/index.md`, `CHANGELOG.md`, `.oneapp/specifications/`, images de documents, compose, commandes locales. Alfred n’offre aujourd’hui que `commands.run` (dossier courant = dossier du module) et les fonctions en script, sans notion de dossier accordé : rien n’empêche un module de lire n’importe où, et rien ne permet à une page de choisir un dossier.

**API proposée** :

1. **Dossiers accordés** : `folders.pick({ title })` (page, geste) → `{ id, path, label }` ; l’accord est gardé pour le module, visible et révocable dans sa fiche ; `folders.list()`.
2. **Fichiers texte d’un dossier accordé** : `folders.readText(id, relatif)`, `folders.writeText(id, relatif, texte)` (écriture atomique), `folders.list(id, relatif, { glob })`, `folders.exists`, `folders.mkdir`, `folders.remove` (corbeille du système), `folders.readFile` (base64, 20 Mo) ; chemins relatifs confinés (ni `..` ni lien sortant, comme `agent_artifacts.rs` de OneApp).
3. **`commands.run` dans un dossier accordé** : option `cwd: { folder: id, path?: relatif }` ; refus hors d’un dossier accordé.
4. **Git natif, en lecture et en écriture courantes** : `git.status(folder)`, `git.branches`, `git.log({ since, path, limit })`, `git.tags`, `git.diff`, `git.show(ref, path)`, `git.fetch`, `git.pull`, `git.push`, `git.commit({ message, paths })`, `git.switch(branch)`, `git.clone(url, folder, relatif)` ; mêmes règles que le git de l’espace (aucun crochet, refus d’un `.git/config` qui lance un programme, proxy et certificats de `git_network.rs`). Une commande par appel, rendue en JSON.
5. **Terminal du poste** : `terminal.open({ folder, path?, command?, envFile? })` ouvre Terminal, Windows Terminal ou Git Bash dans le dossier (commandes locales de OneApp, `local_shell.rs`).

**Fichiers** : nouveau `src-tauri/src/folders.rs`, `src-tauri/src/git.rs` (fonctions de dépôt à part de celles de l’espace), `src-tauri/src/commands.rs` (`cwd`), `src-tauri/src/permissions.rs`, `src/sdk/`, SDK.md, fiche du module (dossiers accordés).

## C5 · Coque : entrées fournies par un module, notifications, fenêtres, sondes, agents

**Famille** : coque et navigation. **Taille** : L (trois livraisons possibles : C5a M, C5b S, C5c M). **Ordre** : 5.

**C5a · Entrées du menu fournies par un module** (M). Le produit logiciel est l’unité de navigation de OneApp. Un module déclare une section **par élément** de ses données ; l’utilisateur garde la main sur l’ordre et le masquage.

```json
"sections": [{ "id": "produit", "label": "Produit", "icon": "box",
  "entries": { "function": "lister-entrees", "everyMinutes": 1 } }]
```

`lister-entrees` rend `[{ key: "alpha", label: "Alpha", icon?, color?, status?: "ok" | "warning" | "error" | "running", badge? }]`. Chaque entrée ouvre les onglets de la section ; la page lit `usePageContext().entry` (`{ key, label }`). L’état colore la pastille de l’entrée (point bleu d’une exécution, rouge d’un échec) en plus du compteur `badge`. `shell.navigate("cockpit/composants#alpha")` ouvre l’entrée. Les pages de l’utilisateur restent le modèle : une section à entrées est une page de l’utilisateur que le module « déplie ».

**C5b · Notifications à actions et fenêtres paramétrées** (S).
- `shell.notify({ …, persistent?: boolean, actions?: [{ label, navigate?: "module/page#entry", window?: { page, params }, function?: { id, input } }] })` : « Journal », « Lancer », « Voir l’agent » ; une notification persistante reste au centre jusqu’à son action ou sa fermeture. Une fonction planifiée peut en émettre.
- `shell.openWindow(reference, { params, key })` : la fenêtre reçoit `usePageContext().params` (`{ build: 412 }`) ; la même `key` ramène la fenêtre existante au premier plan.

**C5b bis · Sondes rapides** (S). La plus petite planification est d’une minute ; OneApp sonde toutes les 10 s, 3 s pendant une exécution. `declare_schedule` accepte `everySeconds` (au moins 5) et une fonction peut rendre `{ nextInSeconds }` pour se rapprocher pendant une exécution et s’espacer au repos.

**C5c · Agents dans la barre de gauche et fenêtre Agents** (M). Une section « Agents » sous les entrées du menu : conversations non archivées avec leur état (au travail, réponse attendue, en échec, à consulter, en veille), tri (réponse attendue et échec en tête, puis les plus récentes), Renommer, Fenêtre, Archiver au survol ; notification qui ouvre l’agent. Fenêtre Agents détachée : la page Agent seule dans sa fenêtre, le moteur restant dans la fenêtre principale (ADR 0021 de OneApp). Le prototype et les choix de la session `agents-nav` de OneApp (`SidebarSection`, `SidebarRow`, navigation réduite de la fenêtre) se reprennent.

**Fichiers** : `src/shell/AppShell.tsx`, `src-tauri/src/menu.rs`, `src-tauri/src/schedules.rs`, `src/shell/notifications.ts`, `src-tauri/src/system_notifications.rs`, `src-tauri/src/page_windows.rs`, `src/features/navigation/`, `src/features/agent/ConversationList.tsx`, `DESIGN.md`, SDK.md § 8, AGENTS.md.

## C6 · Composants `@alfred/ui` manquants

**Famille** : coque et navigation. **Taille** : L. **Ordre** : 6 (parallèle à C3, C4, C8).

**Justification** : la règle 4 d’AGENTS.md interdit tout style propre ; une librairie ne peut dessiner que son propre contenu. OneApp a des surfaces qu’aucun composant de `src/ui/components/` ne couvre. Chaque composant se reprend de `src/components/` de OneApp, dans le style d’Alfred (`DESIGN.md`).

| Composant | Sert à | Reprend de OneApp |
|---|---|---|
| `StatusCardGrid` / `StatusCard` | cartes d’état des composants, pastilles d’état avec icône, carte grisée | `ComponentCard.tsx`, `component-cards.css` |
| `Board` | kanban à colonnes, glisser-déposer au clavier et à la souris | `ProjectKanban.tsx`, `ReorderHandle.tsx` |
| `Timeline` | planning par personne, frise d’activité | `ProjectPlanning.tsx`, `HistoryTimeline.tsx` |
| `TreeView` | groupes Keycloak, secrets OpenBao, pages Confluence | `KeycloakGroupTreePane.tsx`, `OpenBaoSecretTree.tsx`, `ConfluencePageTree.tsx` |
| `LogViewer` | journaux CI et conteneur : niveaux avec compteurs, recherche, suivi, retour à la ligne, horodatage, copie, fenêtrage des longues sorties | `src/components/logs/*`, `useWindowedList.ts` |
| `Terminal` | console de conteneur (enveloppe de `@xterm/xterm`) | `TerminalEmulator.tsx` |
| `MarkdownEditor` | documentation, change log, chapitres SRS | `MarkdownEditor.tsx` |
| `DiffView` | versions des spécifications, modifications des agents | `SpecificationGitDiffDialog.tsx` |
| `Matrix` (mode de `DataTable`) | liaisons, accès, secrets × environnements : cases d’état cliquables, en-têtes figés | `ComponentLiaisonTable.tsx`, `AccessOverviewTable.tsx`, `ComponentSecretsDialog.tsx` |

**Fichiers** : `src/ui/components/`, `src/ui/index.ts`, `DESIGN.md` § 5, `src-tauri/src/design_lint.rs` (règles du nouveau catalogue).

## C7 · Synchronisation d’équipe étendue

**Famille** : synchronisation d’équipe. **Taille** : XL (L sans la disposition `.oneapp/`). **Ordre** : 10.

**Justification** : `team_sync.rs` relie un module à un dépôt, une ligne par fichier, la version de l’équipe l’emporte. OneApp exige plusieurs sources actives, des champs personnels, le rapprochement par identité métier, un aperçu avec choix (récupérer, publier, conflit, suppression à confirmer) et des dépendances qui suivent leur produit.

**API proposée** (`module.json`) :

```json
"sync": {
  "tables": ["produits_produits", "produits_composants", "produits_liaisons", "produits_environnements"],
  "documents": [{ "root": "produits_produits", "children": ["produits_composants", "produits_liaisons"] }],
  "personal": { "produits_produits": ["ordre", "dossier_local"], "produits_composants": ["dossier_local"] },
  "identity": { "produits_environnements": ["url_base"] },
  "conflicts": "ask",
  "sources": "many"
}
```

- `sources: "many"` : le module se relie à plusieurs dépôts ; chaque ligne racine porte sa source (colonne réservée `_source`) ; un même identifiant dans deux sources est un conflit ; déplacer une ligne entre sources est une action de la fiche du module.
- `documents` : une ligne racine et ses enfants vont dans un même fichier (un produit et ses composants), comme une déclaration partagée.
- `personal` : colonnes jamais publiées ni écrasées ; une ligne reçue prend les valeurs par défaut.
- `identity` : colonnes qui rapprochent une ligne locale d’une ligne reçue au lieu de la dupliquer.
- `conflicts: "ask"` : un écart des deux côtés attend un choix (« Ma version », « La version de l’équipe ») dans un aperçu de la fiche du module ; une suppression locale à venir attend une confirmation ; « Récupérer » et « Publier » n’agissent que dans leur sens.
- **Option de compatibilité `.oneapp/`** : `"layout": "oneapp"` écrit et lit les fichiers au format des déclarations de OneApp (`.oneapp/products/<id>.json`…). Seulement si l’utilisateur veut une cohabitation (question de [plan.md](plan.md)).

**Fichiers** : `src-tauri/src/team_sync.rs` (découpé), `src/features/teamSync/`, SDK.md § 17, AGENTS.md.

## C8 · Moteur d’agents natif (Rust)

**Famille** : agents, natif Rust, sécurité. **Taille** : L. **Ordre** : 7.

**Justification** : OneApp a accepté l’ADR 0022 (pilotage natif depuis Rust) et proposé l’ADR 0023 (bibliothèque commune `agents-kit`, que la session `agents-lib-analysis` décrit dans `docs/agents-lib/analyse.md` de OneApp). Alfred parle encore les protocoles dans l’interface (`agents.rs` : « Le protocole de chaque CLI est parlé côté interface, ligne à ligne »), lance `opencode acp` et passe le jeton MCP de Claude en argument.

**API proposée** (commandes fermées, comme OneApp) : `agent_session_start({ harness, model, effort, folder, instructions, tools, autonomy })`, `agent_session_send`, `agent_session_respond` (autorisation, question), `agent_session_cancel`, `agent_session_close`, `agent_read_history`, `agent_list_models` ; événements typés par tour (`seq` durable, permissions à options typées, `files-changed`), sur un `Channel` par tour.

- OpenCode : `opencode serve` privé (mot de passe aléatoire en environnement, appairage, SSE, rattrapage par `session.message.list`), une demande envoyée après la fin de la précédente ; reprendre `src-tauri/src/agents/opencode/` de OneApp et son générateur.
- Codex : `codex app-server` piloté depuis Rust (types générés du schéma JSON, prototype `prototypes/agent-protocols`).
- Claude Code : `claude -p --input-format stream-json` ; jeton MCP par variable d’environnement (`Bearer ${ALFRED_MCP_TOKEN}` dans `--mcp-config`, prouvé par le prototype) au lieu de la valeur en argument.
- Décision à prendre : écrire ce moteur dans Alfred, ou dans la bibliothèque commune `agents-kit` de l’ADR 0023 de OneApp, partagée par les deux applications pendant la transition (chantier desktop-kit en pause). Voir les questions.

**Fichiers** : `src-tauri/src/agents.rs` (devient un dossier `agents/`), `src/features/agent/harness/*` (deviennent des adaptateurs d’affichage), `src/features/agent/store.ts`.

## C9 · Agents de travail sur un dossier, outils limités, réglages, confidentialité

**Famille** : agents. **Taille** : L. **Ordre** : 8.

**Justification** : un agent de OneApp travaille dans le dossier d’un produit ou d’un composant, avec les outils de OneApp limités à ce produit, les consignes et skills du produit et de sa source, et une confidentialité choisie par demande.

**API proposée** :

```ts
agents.start({
  title: "Corriger la CI d’Alpha",
  folder: "<id d’un dossier accordé>", path?: "alpha-api",   // C4
  scope: { module: "produits", entry: "alpha", component?: "api" },
  instructions?: string,                                     // consignes du produit et de sa source
  skills?: string[],                                         // sélection, sinon tous
  tools?: string[],                                          // fonctions "module/fonction" offertes
  sensitivity?: "normal" | "secret",
  message: string, context?: unknown,                        // contexte de page, fichier joint à cet agent seul
}): Promise<{ conversationId }>;
```

- La conversation apparaît dans la page Agent et dans la barre de gauche (C5c), rattachée à son entrée (`scope`).
- **Outils limités** : les fonctions `tool: true` reçoivent `scope` en entrée imposée (`input.produit = "alpha"`, non modifiable par le modèle) ; une fonction peut déclarer `scope: "entry"` pour n’être offerte qu’aux agents d’une entrée. C’est le filtrage par rôle du MCP de OneApp, sans second serveur.
- **Autonomie** : un niveau « dossier du produit » (modifications et commandes dans le dossier sans carte d’accord, le reste demandé), à côté des niveaux existants ; l’accès complet reste un choix explicite.
- **Confidentialité** : Réglages › Agent marque des modèles « Autorisé pour les demandes confidentielles » ; un cadenas dans la saisie et sur `agents.start` ; refus de lancer ou de poursuivre un agent dont le modèle n’est pas marqué, y compris quand il reçoit le résultat d’une demande confidentielle.
- **Propositions** : `agents.propose({ … })` depuis un agent ou une fonction : une carte « Lancer l’agent / Ignorer » dans la conversation, rien ne part sans clic.
- **Références `#`** : un module déclare une source de références (`references: { function: "chercher" }`) que la saisie de l’agent propose après `#` (ticket, produit, composant).
- Simultanéité et plafond d’agents réglables (Alfred plafonne aujourd’hui à 32 sessions en dur, `MAX_SESSIONS`).

**Fichiers** : `src/features/agent/`, `src-tauri/src/mcp.rs` (entrées imposées, filtrage), `src-tauri/src/agent_workspace.rs`, `src/features/agentSettings/`, `src/sdk/` (`agents`), SDK.md § 7, AGENTS.md.

## C10 · Suivis et automatisations d’agents

**Famille** : agents. **Taille** : M. **Ordre** : 9.

**Justification** : OneApp relance un agent à la fin d’une exécution (ADR 0018) et lance des agents sur déclencheur (ADR 0009, 0011). Alfred a déjà les briques (événements entre modules livrés même après fermeture, planifications, webhooks, fonctions en script) mais pas l’action « parler à un agent ».

**API proposée** :

1. **Suivi** : `agents.watch({ conversationId, event: "ci/execution-terminee", match: { execution: "412" }, timeoutMinutes: 60 })` ; offert aux agents comme outil `watch_event` / `cancel_watch`. À la livraison de l’événement (ou à l’échéance), Alfred dépose un message dans la conversation avec le contenu de l’événement et relance l’agent ; le suivi survit à la fermeture ; archiver arrête ses suivis ; une ligne « Relance à la fin de … · au plus tard … » au-dessus de la saisie, avec sa croix.
2. **Automatisation** : un module abonné à un événement peut rendre `{ agent: { start | send, … } }` au lieu de traiter lui-même ; ou plus simplement une fonction appelle `agents.start` / `agents.send` (C9). Le module `automatisations` porte les règles (déclencheur, périmètre, consigne, confidentialité, confirmation) et leur journal ; la plateforme ajoute seulement : la confirmation avant lancement (notification persistante « Lancer », C5b), la règle « une fois par occurrence observée » (identifiant d’occurrence dans `events.publish`, dédoublonné), et la proposition d’une automatisation par un agent (enregistrée inactive).

**Fichiers** : `src-tauri/src/module_events.rs`, `src/features/agent/store.ts`, `src-tauri/src/mcp.rs`, `src/features/automations/`.

## C11 · Délégation (orchestrateur), en option

**Famille** : agents. **Taille** : L. **Ordre** : après C10, seulement sur décision.

OneApp a remplacé l’Assistant global par des agents autonomes (ADR 0010) ; la délégation n’y sert plus qu’à relire l’historique. La porter n’a de sens que si l’utilisateur veut qu’un agent répartisse le travail entre plusieurs produits. Proposition minimale : un outil `delegate` réservé à une conversation marquée coordinatrice (tâches, cible `scope`, dépendances acycliques, contrat de retour JSON `status`, `summary`, `artifacts`, `questions`, rapports par fichier en lecture paginée), sur la base de C9.

## C12 · Parité Windows

**Famille** : Windows. **Taille** : M, réparti sur les autres chantiers. **Ordre** : en continu.

À vérifier ou faire, chantier par chantier :

- **Coffre** : Gestionnaire d’identifiants Windows (limite de taille par entrée : déjà découpée en parts UTF-16 dans `vault.rs`) ; jetons de session de C1 compris.
- **CLI d’agents** : recherche des `.cmd` et `.ps1` des CLI installés par npm (défaut relevé chez OneApp par l’analyse de l’ADR 0023 : recherche dans le PATH seul) ; arrêt de tout l’arbre de processus (`process_tree.rs`, `windows_process_tree.rs` de OneApp).
- **PowerShell** : Windows PowerShell 5.1 en STA pour le COM d’Outlook (absences, brouillon avec pièce jointe) ; accents (`[Console]::OutputEncoding`) ; le module `outlook` le fait déjà.
- **Git** : Git Bash (jamais celui de WSL) pour les scripts `bash` ; performance de `git status` sur de gros dépôts (`docs/git-performance.md` de OneApp) pour C4.
- **Chemins** : lecteurs, partages UNC, chemins longs dans les dossiers accordés (C4) ; refus des chemins relatifs et de `~` comme dans l’ADR 0014 de OneApp.
- **Affichage** : échelle 100, 125, 150 %, contraste élevé (`forced-colors`) des nouveaux composants (C6) ; fenêtres secondaires (C5b) et mémorisation de leur taille.
- **Réseau d’entreprise** : proxy et magasin de certificats Windows pour les clients (C3, point 5).
- **Terminal du poste** (C4, point 5) : Windows Terminal, à défaut `conhost`, ou Git Bash.
- **Outlook sur macOS** : le COM n’existe pas ; les absences n’y viennent que d’un agenda publié (ICS, C1 point 3).

## C13 · MCP ouvert aux clients externes, en option

**Famille** : agents, sécurité. **Taille** : S.

OneApp permet d’associer un client MCP externe (Réglages › MCP, credential remis une fois, révocable). Alfred sert son MCP à ses propres conversations. Ajouter une association externe n’est utile que si l’utilisateur lance encore Codex ou Claude hors d’Alfred sur ses produits.

---

## Ce qui n’a pas besoin d’être ajouté

Pour ne pas surestimer le travail, ce qu’Alfred offre déjà et qui couvre OneApp :

- Panneau de droite unique, blocs repliables et déplaçables, disposition retenue.
- Comptes à plusieurs instances, choix du compte par page et par onglet, onboarding guidé, test d’office, TLS non vérifié accepté par compte, OAuth 2 PKCE avec application publique.
- Cache des lectures, tables comme cache, rechargement après écriture et après arrivée de données de l’équipe.
- Historique des lignes et retour en arrière, sauvegardes quotidiennes et avant migration, restauration par module.
- Événements entre modules livrés après coup, planifications, webhooks, tâches de fond, fonctions en script (PowerShell, bash, Python), `commands.run`.
- `ai.oneShot` (appel unique), `ai.decide`, `ai.startAgent` limité au module, voix.
- Documents PDF simples, CSV, Excel, extraction de texte ; librairies npm par module (PDF riche, diagrammes, Tiptap) dans le cadre de la règle 4.
- Notifications dans Alfred et au système, compteurs sur les entrées du menu, palette, accueil, données d’exemple pour développer sans compte.
- Le module `atlassian` couvre déjà l’essentiel de Jira, Bitbucket et Confluence ; `jenkins` les états, journaux et relances ; `outlook` la boîte et le COM.
