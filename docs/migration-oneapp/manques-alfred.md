# Socle d’Alfred : ce qui manque pour accueillir OneApp

Livrable 3 sur 4, réécrit le 20 novembre 2026 après les décisions de l’utilisateur. Seules restent les **fonctions de base d’Alfred** qui manquent, celles du cœur de la plateforme (menu, coque, comptes, coffre, natif, agents). L’organisation des modules et le marketplace viendront plus tard, module par module.

Décisions prises en compte :

- **Partage d’équipe** : il reste fondé sur des fichiers dans des dossiers (les dépôts `.oneapp/` actuels). Alfred y accède comme à des dossiers du poste ; aucun format de synchronisation propre n’est à porter. L’ancien chantier « synchronisation d’équipe étendue » disparaît ; il n’en reste que l’accès aux dossiers et Git local (S2).
- **Navigation** : une page peut créer des entrées dans le menu de gauche, en plus de ses onglets, regroupées dans une zone qu’elle personnalise, sous un petit séparateur (S1, prioritaire).
- **Jetons** : ressaisis dans le trousseau une fois les modules en place ; aucune reprise automatique.
- **Anciennes conversations de OneApp** : non gardées.
- **Délégation entre agents** : à porter (S11).
- **MCP** : rien à ajouter ; les fonctions d’Alfred remplacent le MCP de OneApp. L’association de clients externes est retirée.
- **Agents lancés depuis une page** : dossier de travail et mode imposables (S3).
- Marketplace et gabarit PDF d’entreprise : hors sujet ici.

Les identifiants de fonctions (`PRD-01`, `AGT-07`…) renvoient à [fonctions-oneapp.md](fonctions-oneapp.md) ; le statut de chacune est dans [correspondance.md](correspondance.md).

Tailles, pour un développement fait avec un agent de code et ses vérifications (tests, typecheck, interface Vite branchée sur Alfred debug) : **S** ≤ 2 jours, **M** 3 à 5 jours, **L** 1 à 2 semaines.

## Vue d’ensemble

| Ordre | Code | Manque de base | Taille | Dépend de | Fonctions de OneApp |
|---|---|---|---|---|---|
| 1 | S1 | Entrées du menu de gauche créées par une page | M | — | 5 |
| 2 | S2 | Dossiers du poste et Git local | M | — | 23 |
| 3 | S3 | Agents lancés par une page : dossier, mode et outils imposés | L | S2 | 8 |
| 4 | S4 | Secrets scellés et jetons émis par les services | L | — (S2 pour le `.env`) | 9 |
| 5 | S5 | Paramètres non secrets d’un compte | S | — | 4 |
| 6 | S6 | Transport des clients : binaire, multipart, flux, WebSocket | L | — | 5 |
| 7 | S7 | Notifications à actions, fenêtres paramétrées, relevés rapides | M | — | 8 |
| 8 | S8 | Composants `@alfred/ui` manquants | L | — | 13 |
| 9 | S10 | Suivis : relancer un agent sur un événement | M | S3, S7 | 2 |
| 10 | S11 | Délégation entre agents | L | S3, S10 | 1 |
| 11 | S9 | Pilotage des agents depuis Rust | L | — (après S3 de préférence) | 1 |
| — | S12 | Parité Windows | M, au fil des autres | chacun | 1 et tous |

Total : environ 12 à 15 semaines de développement assisté. S1, S2, S4, S6 et S8 ne touchent pas les mêmes fichiers et peuvent avancer en parallèle.

Le correctif de sécurité de S9 (jeton du serveur local passé en clair à Claude Code) est petit et peut partir tout de suite, à part du reste de S9.

---

## S1 · Entrées du menu de gauche créées par une page

**Taille** : M. **Ordre** : 1, prioritaire. **Dépend de** : rien.

**Ce qui manque.** Le menu de gauche d’Alfred ne liste que les pages de l’utilisateur et l’entrée Agent. Une page ne peut pas y faire apparaître ses propres éléments.

**Pourquoi OneApp en a besoin.** Le produit logiciel est l’unité de navigation de OneApp : une entrée par produit, avec une pastille d’état (PRD-01, VUE-01, VUE-02, TIC-01). La section Agents de OneApp, sous les produits, en est le premier exemple (AGT-12).

**Comportement proposé.**

- Une page crée des **entrées** dans le menu de gauche, en plus de ses onglets. Elles sont regroupées dans **sa zone**, affichée sous l’entrée de la page et séparée du reste du menu par un **petit séparateur**.
- La page **personnalise sa zone** : un titre facultatif (« Produits », « Agents »), l’ordre des entrées (le sien ou celui de l’utilisateur), un nombre d’entrées visibles avec « Afficher plus », le repli de la zone.
- Une **entrée** a un identifiant, un libellé, une icône (Lucide ou logo du module), une couleur facultative, un **état** (`ok`, `warning`, `error`, `running`, `waiting`) rendu en pastille, et un compteur facultatif (comme `badge`).
- Un clic sur une entrée ouvre la page (ou une autre page du module) **avec cette entrée** : la page lit `usePageContext().entry`. Les onglets de la page suivent l’entrée ouverte.
- Une entrée peut porter des **actions au survol** (icônes compactes : renommer en place, ouvrir dans une fenêtre, archiver), reçues par la page ou par une fonction du module.
- Les entrées **durent** d’un lancement à l’autre ; une fonction (planifiée, abonnée à un événement) peut les mettre à jour quand la page est fermée.
- L’utilisateur garde la main : il replie ou masque la zone, la déplace dans Réglages › Ordre du menu ; masquer une page masque sa zone.
- La page **Agent** d’Alfred utilise ce même mécanisme pour ses conversations non archivées (état : au travail, réponse attendue, en échec, à consulter, en veille ; réponse attendue et échec en tête).

**API proposée.**

```ts
menu.setZone(options: { title?: string; order?: "page" | "user"; visible?: number }): Promise<void>;
menu.setEntries(entries: MenuEntry[]): Promise<void>;   // remplace la liste de la zone
menu.updateEntry(id: string, patch: Partial<MenuEntry>): Promise<void>;
menu.removeEntry(id: string): Promise<void>;
useMenuEntryAction(handler: (event: { entry: string; action: string }) => void): void;

interface MenuEntry {
  id: string;
  label: string;
  icon?: string;
  color?: "steel" | "blue" | "violet" | "pink" | "red" | "orange" | "green" | "teal";
  status?: "ok" | "warning" | "error" | "running" | "waiting";
  badge?: number;
  page?: string;            // autre page du module ouverte au clic, sinon celle-ci
  actions?: Array<{ id: string; label: string; icon: string }>;
}
// PageContext gagne : entry: { id: string; label: string } | null
```

`menu.*` est permis à une fonction, qui nomme la page (`{ page: "produits" }`), comme `badge`. Une copie de page de l’utilisateur (« liste@recette ») a sa propre zone.

**Fichiers touchés.** `src/shell/AppShell.tsx`, `src/features/navigation/`, `src-tauri/src/menu.rs`, `src/sdk/`, `src/features/agent/ConversationList.tsx` (zone de la page Agent), `DESIGN.md` (zone et séparateur), `docs/espace/SDK.md` § 8, `docs/espace/AGENTS.md`. Le prototype de la session `agents-nav` de OneApp (`SidebarSection`, `SidebarRow`, actions au survol) se reprend pour le rendu.

## S2 · Dossiers du poste et Git local

**Taille** : M. **Ordre** : 2. **Dépend de** : rien.

**Ce qui manque.** Une page n’a pas de disque, et rien ne lui permet de choisir un dossier du poste. Une fonction peut lancer `commands.run("git", …)` ou un script, mais toujours depuis le dossier du module, sans notion de dossier accordé : rien ne borne ce qu’elle lit, rien ne le montre à l’utilisateur.

**Pourquoi OneApp en a besoin.** L’espace local d’un produit (PRD-06), Git dans la vue produit (VUE-04, VUE-07), les commandes locales (PRD-13), la documentation, le change log et l’architecture dans les dépôts (DOC-02, DOC-03, DOC-04, DOC-08), les spécifications (SPE-01 à SPE-03, SPE-05 à SPE-07), le compose (PTN-04). Et, depuis la décision sur le partage, **toute la synchronisation d’équipe** : les dépôts `.oneapp/` sont des dossiers Git du poste que le module lit, écrit, tire et pousse (SYN-01, SYN-02, SYN-05 à SYN-09).

**API proposée.**

```ts
folders.pick(options?: { title?: string }): Promise<Folder | null>;    // page, sur un geste
folders.list(): Promise<Folder[]>;                                   // dossiers accordés au module
folders.readText(folder: string, path: string): Promise<string>;
folders.writeText(folder: string, path: string, text: string): Promise<void>;  // écriture atomique
folders.readFile(folder: string, path: string): Promise<{ data: string }>;     // base64, 20 Mo
folders.entries(folder: string, path?: string, options?: { glob?: string }): Promise<Entry[]>;
folders.mkdir(folder: string, path: string): Promise<void>;
folders.remove(folder: string, path: string): Promise<void>;          // vers la corbeille du système
interface Folder { id: string; path: string; label: string }

git.status(folder, path?); git.branches(folder, path?); git.tags(folder, path?);
git.log(folder, { path?, since?, limit? }); git.diff(folder, { path?, from?, to? }); git.show(folder, ref, file);
git.fetch(folder); git.pull(folder); git.push(folder); git.commit(folder, { message, paths });
git.switch(folder, branch); git.clone(url, folder, path);

terminal.open(options: { folder: string; path?: string; command?: string }): Promise<void>;
// commands.run gagne l’option cwd: { folder, path? }
```

- Un dossier se choisit par `folders.pick` (ou s’accorde d’avance par l’agent avec `grant_access`, `folder`) ; l’accord est gardé pour le module, visible et révocable dans sa fiche.
- Chemins relatifs confinés au dossier : ni `..`, ni lien symbolique qui en sort.
- Git suit les règles du git de l’espace : aucun crochet, refus d’un `.git/config` qui lancerait un programme, proxy et certificats du système (`git_network.rs`).
- Les fonctions en script reçoivent les mêmes méthodes par le pont du SDK.

**Fichiers touchés.** Nouveau `src-tauri/src/folders.rs`, `src-tauri/src/git.rs` (fonctions de dépôt à part de celles de l’espace), `src-tauri/src/commands.rs`, `src-tauri/src/permissions.rs`, `src-tauri/src/script_sdk.rs`, `src/sdk/`, fiche du module (dossiers accordés), SDK.md.

## S3 · Agents lancés par une page : dossier, mode et outils imposés

**Taille** : L. **Ordre** : 3. **Dépend de** : S2 (dossier accordé). S9 n’est pas requis : les modes se traduisent dans les options des harnais actuels.

**Ce qui manque.** `ai.startAgent` lance une conversation bornée au module de la page, en autonomie stricte (chaque action demandée), sans dossier de travail ni outils autres que les fonctions du module. Un agent de OneApp travaille dans le dossier d’un produit, avec les outils limités à ce produit et une politique d’autorisation choisie.

**Pourquoi OneApp en a besoin.** Agents sur un produit ou un composant (AGT-01), outils de OneApp donnés aux agents (AGT-07, désormais des fonctions d’Alfred), demandes confidentielles (AGT-05), demandes depuis les pages et « Envoyer à un agent » (AGT-15, TIC-07), propositions d’agent (AGT-11), modifications de l’agent dans son dossier (AGT-16).

**Comportement proposé.**

- **Dossier imposé** : la page donne un dossier accordé (S2) et un sous-chemin ; l’agent y démarre et y travaille. Sans dossier, il reste dans l’espace, comme aujourd’hui.
- **Mode imposé** : la page choisit un mode parmi une liste fermée ; Alfred le traduit pour chaque harnais. Proposition :

  | Mode | Lecture | Écriture de fichiers | Commandes | Hors du dossier | Demandes |
  |---|---|---|---|---|---|
  | `strict` (actuel) | oui | demandée | demandée | demandé | chaque action |
  | `lecture` | oui | non | lecture seule | non | aucune ; le reste est refusé |
  | `ecriture` | oui | dans le dossier | demandées | demandé | commandes et hors dossier |
  | `dossier` | oui | dans le dossier | dans le dossier | demandé | seulement hors du dossier |
  | `complet` | oui | partout | partout | oui | **aucune** |

  Traduction indicative : Codex `sandbox` (`read-only`, `workspace-write`, `danger-full-access`) et `approvalPolicy` (`on-request`, `never`) ; Claude Code `--permission-mode` (`plan`, `acceptEdits`, `bypassPermissions`) ; OpenCode `permission` (`edit`, `bash`, `external_directory` à `ask`, `allow` ou `deny`).
- **Accord** : la première fois, l’utilisateur accorde à la page le droit de lancer un agent **dans ce mode et ce dossier** ; la carte d’accord nomme les deux. `complet` exige un accord explicite à part, révocable dans la fiche du module ; l’agent d’Alfred ne peut pas l’accorder d’avance (`grant_access` le refuse).
- **Outils imposés** : la page offre des fonctions (`"module/fonction"`) avec des **entrées imposées** que le modèle ne peut pas changer (`{ produit: "alpha" }`) : l’agent ne voit que son périmètre. C’est le filtrage par rôle de OneApp, sans serveur MCP de plus.
- **Consignes et skills** : la page passe des consignes (celles du produit et de sa source) et une sélection de skills (les autres sont masqués à l’agent).
- **Modèle et confidentialité** : la page peut imposer un harnais et un modèle, ou exiger un modèle « habilité aux demandes confidentielles » (marqué dans Réglages › Agent) ; Alfred refuse de lancer ou de poursuivre l’agent sinon, y compris quand il reçoit le résultat d’une demande confidentielle.
- **Contexte privé** : `context` peut être un fichier joint à cet agent seul (contexte d’une page, détail d’un ticket), jamais recopié dans le fil visible.
- **Propositions** : `ai.proposeAgent(options)` affiche une carte « Lancer l’agent / Ignorer » dans la conversation d’où vient la proposition ; rien ne part sans clic.
- La conversation apparaît dans la page Agent et dans sa zone du menu (S1) ; la page qui l’a lancée peut aussi créer une entrée pour elle dans sa propre zone.
- La simultanéité et le plafond de sessions deviennent réglables (`MAX_SESSIONS` vaut 32 en dur dans `agents.rs`).

**API proposée.**

```ts
ai.startAgent<Result>(options: {
  instruction: string;
  context?: unknown;
  title?: string;
  folder?: { id: string; path?: string };                          // S2
  mode?: "strict" | "lecture" | "ecriture" | "dossier" | "complet"; // "strict" par défaut
  functions?: Array<string | { name: string; input: Record<string, unknown> }>; // entrées imposées
  instructions?: string;
  skills?: string[];
  harness?: "claude" | "codex" | "opencode";
  model?: string;
  confidential?: boolean;
  resultSchema?: Record<string, unknown>;
}): Promise<{ conversationId: string; message: string; result?: Result }>;
ai.sendToAgent(conversationId: string, message: string): Promise<void>;
ai.proposeAgent(options: Omit<Parameters<typeof ai.startAgent>[0], "resultSchema"> & { reason: string }): Promise<void>;
```

**Fichiers touchés.** `src/features/agent/pageAgent.tsx`, `src/features/agent/store.ts`, `src/features/agent/harness/*` (traduction des modes), `src-tauri/src/agents.rs` (dossier de départ, options de permission), `src-tauri/src/mcp.rs` (entrées imposées des fonctions offertes, sans nouvel outil), `src-tauri/src/permissions.rs`, `src/features/agentSettings/` (modèles habilités, simultanéité), SDK.md § 7, AGENTS.md (« Conversation lancée par une page »).

## S4 · Secrets scellés et jetons émis par les services

**Taille** : L. **Ordre** : 4. **Dépend de** : rien ; `secrets.writeEnvFile` utilise un dossier de S2.

**Ce qui manque.** La garantie d’Alfred tient pour les jetons fixes, OAuth 2 et `clientCredentials` : Rust pose l’authentification, aucune page n’atteint un service, un secret renvoyé en écho est effacé (`redact`). Elle ne tient pas pour deux cas :

1. un **jeton rendu par une connexion par identifiant** (Portainer `/api/auth`, OpenBao userpass, LDAP ou OIDC) : la fonction devrait poster l’identifiant et lirait le jeton dans la réponse ;
2. les **valeurs de secrets** rendues par un service (OpenBao KV) : elles arrivent en clair dans la fonction.

OneApp les traite par des références opaques remplacées nativement, `reveal_secret_value` et `save_environment_file` (`src-tauri/src/secret_references.rs`, `commands/secret_values.rs`).

**Pourquoi OneApp en a besoin.** OpenBao (SEC-01 à SEC-06, VUE-11), Portainer par identifiant (PTN-01), commandes locales avec `.env` (PRD-13), agenda publié dont l’adresse porte un jeton (PRJ-06).

**API proposée.**

- **Méthode d’authentification `session`** : Alfred fait la requête de connexion, garde le jeton au trousseau, le pose sur chaque requête, le renouvelle sur 401 ou à l’expiration ; le jeton est ajouté à ce que `redact` efface.
  ```json
  { "id": "motdepasse", "label": "Identifiant et mot de passe", "type": "session",
    "login": { "method": "POST", "path": "/api/auth",
               "body": { "username": "{username}", "password": "{password}" }, "token": "jwt" },
    "apply": { "header": "Authorization", "prefix": "Bearer " } }
  ```
  OpenBao userpass : `"path": "/v1/auth/userpass/login/{username}"`, `"token": "auth.client_token"`, `"expiresIn": "auth.lease_duration"`, `"apply": { "header": "X-Vault-Token" }`. OIDC : même méthode avec un retour au navigateur par la boucle locale d’`oauth.rs`.
- **Réponses scellées** : le client déclare les champs secrets d’une réponse (`"sealed": [{ "path": "/v1/{mount}/data/**", "fields": ["data.data.*"] }]`) ; Alfred les remplace par une référence opaque (`alfred-secret-ref:v1:<nonce>`), valable pour ce compte, ce module et cette session, 5 minutes. Elle ne se résout que par :
  - `secrets.reveal(ref)` : page ou panneau, sur un geste de l’utilisateur, journalisé sans la valeur ;
  - `secrets.writeEnvFile({ folder, path, entries: [{ name, ref }] })` : `.env` écrit dans un dossier accordé (S2) ;
  - `secrets.copy({ from: ref, instance, path, field })` : écrit la valeur vers un autre compte du même service par une requête native.
  Une référence placée dans un corps ou un paramètre ordinaire n’est **jamais** substituée.
- **Méthode `secretUrl`** : toute l’adresse du compte est au trousseau (agenda ICS publié).

**Fichiers touchés.** `src-tauri/src/clients.rs`, `src-tauri/src/vault.rs`, nouveau `src-tauri/src/secret_refs.rs`, `src/sdk/`, onboarding (champs identifiant et mot de passe de la méthode `session`), SDK.md § 6, AGENTS.md.

## S5 · Paramètres non secrets d’un compte

**Taille** : S. **Ordre** : 5. **Dépend de** : rien.

**Ce qui manque.** Un compte Alfred a une adresse, une méthode et un secret. OneApp garde en plus, par connexion, des réglages non secrets que les adresses et les requêtes utilisent.

**Pourquoi OneApp en a besoin.** Royaume Keycloak dans les adresses PKCE (KC-01), montage KV et rôle OpenBao (SEC-01), endpoint Portainer (PTN-01), saisie d’une connexion complète (PRD-09).

**API proposée.** `methods[].params` déclare des champs saisis avec le compte (`{ "id": "realm", "label": "Royaume", "example": "equipe" }`) ; `{realm}` se substitue dans `authorizationUrl`, `tokenUrl` et en tête du `path` d’une requête ; `client(id, { instance }).params()` les rend aux fonctions. L’onboarding les demande dans l’assistant ; les modifier remet le compte « à vérifier ». Vérifier au passage le renouvellement d’un jeton Keycloak hors ligne (`offline_access`).

Le partage des comptes avec l’équipe n’est plus nécessaire : les adresses partagées se lisent dans les fichiers `.oneapp/` (S2) et chacun ressaisit son jeton.

**Fichiers touchés.** `src-tauri/src/clients.rs`, `src-tauri/src/oauth.rs`, `src/features/clients/`, onboarding, SDK.md § 6.

## S6 · Transport des clients : binaire, multipart, flux, WebSocket

**Taille** : L. **Ordre** : 6. **Dépend de** : rien.

**Ce qui manque.** `perform` (`clients.rs`) lit la réponse en texte (`from_utf8_lossy`), 20 Mo et 60 secondes au plus ; pas d’envoi de fichier, pas de connexion longue.

**Pourquoi OneApp en a besoin.** Téléchargement d’artefacts (VUE-08), pièces jointes en lecture et en envoi (TIC-06), images de Confluence (DOC-01), journaux Docker multiplexés et suivis en direct (PTN-02), console d’exec Portainer en WebSocket (PTN-03).

**API proposée.**

- `client(id).download(path, { name, query? })` → `FileInfo` : le corps va en flux dans les fichiers du module (jusqu’à 2 Go), avec son SHA-256, sans passer par la fonction.
- `request({ …, responseType: "base64" })` pour un petit binaire (5 Mo au plus).
- Corps multipart : `body: { multipart: [{ name: "file", file: "<id d’un fichier du module>" }, { name: "comment", value: "…" }] }`.
- **Canaux** : une fonction du connecteur ouvre un flux (`client(id).stream(path)`, SSE ou réponse longue) ou un WebSocket (`client(id).socket(path)`) et rend l’identifiant du canal ; la page lit et écrit par `channels.read(id, { after })`, `channels.write(id, text)`, `channels.close(id)`, sans jamais joindre le client. Un canal appartient au module, se ferme avec le cadre de la page ou après 10 minutes sans lecture ; 64 Kio par écriture.
- Vérifier que les clients passent par le proxy et le magasin de certificats du système, comme git le fait déjà (`git_network.rs`) ; non vérifié dans cette étude.

**Fichiers touchés.** `src-tauri/src/clients.rs`, `src-tauri/src/module_files.rs`, nouveau `src-tauri/src/channels.rs`, `src-tauri/src/script_sdk.rs`, `src/sdk/`, SDK.md § 6.

## S7 · Notifications à actions, fenêtres paramétrées, relevés rapides

**Taille** : M. **Ordre** : 7. **Dépend de** : rien.

**Ce qui manque.**

- `shell.notify` n’a ni action ni notification persistante.
- `shell.openWindow` ouvre une page sans paramètre et ne sait pas ouvrir la page Agent.
- La plus petite planification est d’une minute.

**Pourquoi OneApp en a besoin.** Fin d’exécution CI avec « Journal » (CI-04), centre de notifications à actions (GEN-01), sonde de 10 s, 3 s pendant une exécution (CI-05), fenêtres de journal CI, de journaux et de console de conteneur, de spécifications ouvertes sur l’élément précis (CI-07, PTN-02, PTN-05, SPE-08), fenêtre Agents détachée (AGT-13). Confirmation avant le lancement d’une automatisation (avec S10).

**API proposée.**

- `shell.notify({ …, persistent?: boolean, actions?: [{ label, navigate?: "module/page", entry?: string, window?: { page, params }, function?: { id, input } }] })` ; permis à une fonction planifiée.
- `shell.openWindow(reference, { params, key })` : la fenêtre lit `usePageContext().params` ; la même `key` ramène la fenêtre existante. `shell.openWindow("agent", { params: { conversation } })` ouvre la page Agent seule dans sa fenêtre, le moteur restant dans la fenêtre principale.
- `declare_schedule` accepte `everySeconds` (au moins 5) ; une fonction planifiée peut rendre `{ nextInSeconds }` pour se rapprocher pendant une exécution et s’espacer au repos.

**Fichiers touchés.** `src/shell/notifications.ts`, `src/shell/NotificationCenter.tsx`, `src-tauri/src/system_notifications.rs`, `src-tauri/src/page_windows.rs`, `src/shell/PageWindow.tsx`, `src-tauri/src/schedules.rs`, SDK.md § 8, AGENTS.md.

## S8 · Composants `@alfred/ui` manquants

**Taille** : L. **Ordre** : 8. **Dépend de** : rien.

**Ce qui manque.** La règle 4 d’AGENTS.md interdit tout style propre ; une librairie ne dessine que son propre contenu. Plusieurs surfaces de OneApp n’ont pas de composant dans `src/ui/components/`.

**Pourquoi OneApp en a besoin, et composant proposé.**

| Composant | Fonctions | Reprend de OneApp |
|---|---|---|
| `StatusCardGrid`, `StatusCard` | VUE-01 | `ComponentCard.tsx` |
| `Board` (kanban, glisser au clavier et à la souris) | PRJ-01 | `ProjectKanban.tsx`, `ReorderHandle.tsx` |
| `Timeline` (planning, frise d’activité) | PRJ-04, VUE-13 | `ProjectPlanning.tsx`, `HistoryTimeline.tsx` |
| `TreeView` | KC-02, SEC-04 | `KeycloakGroupTreePane.tsx`, `OpenBaoSecretTree.tsx` |
| `LogViewer` (niveaux et compteurs, recherche, suivi, fenêtrage des longues sorties) | CI-07, PTN-02 | `src/components/logs/*`, `useWindowedList.ts` |
| `Terminal` (enveloppe de `@xterm/xterm`) | PTN-03 | `TerminalEmulator.tsx` |
| `MarkdownEditor` | DOC-02, DOC-04 | `MarkdownEditor.tsx` |
| `DiffView` | SPE-07 | `SpecificationGitDiffDialog.tsx` |
| `Matrix` (mode de `DataTable` : cases d’état cliquables, en-têtes figés) ; panneau dans une modale | SEC-03 | `ComponentSecretsDialog.tsx`, `AccessOverviewTable.tsx` |

**Fichiers touchés.** `src/ui/components/`, `src/ui/index.ts`, `DESIGN.md` § 5, `src-tauri/src/design_lint.rs`.

## S10 · Suivis : relancer un agent sur un événement

**Taille** : M. **Ordre** : 9. **Dépend de** : S3 (`ai.sendToAgent`), S7 (confirmation par notification).

**Ce qui manque.** Les événements entre modules sont déjà livrés après coup, même après une fermeture ; mais rien ne relie un événement à une conversation d’agent.

**Pourquoi OneApp en a besoin.** Relance d’un agent à la fin d’une exécution CI ou d’une automatisation (AGT-08, ADR 0018) ; automatisations qui lancent un agent ou lui parlent, avec confirmation (AGT-09).

**API proposée.**

- `ai.watch({ conversationId, event: "module/evenement", match?: Record<string, unknown>, timeoutMinutes })` → `{ id }` ; `ai.cancelWatch(id)`. Offert à l’agent comme fonction de la plateforme (`attendre-evenement`, `annuler-attente`). À la livraison (ou à l’échéance), Alfred dépose un message avec le contenu de l’événement dans la conversation et la relance. Le suivi survit à la fermeture ; archiver la conversation arrête ses suivis ; une ligne « Relance à la fin de … · au plus tard … » au-dessus de la saisie, avec sa croix.
- `events.publish(event, payload, { occurrence })` : un identifiant d’occurrence dédoublonné, pour la règle « une fois par occurrence observée ».
- Le reste des automatisations (règles, périmètre, journal) appartient à un module, qui appelle `ai.startAgent` ou `ai.sendToAgent` depuis une fonction abonnée.

**Fichiers touchés.** `src-tauri/src/module_events.rs`, `src/features/agent/store.ts`, `src/features/agent/Composer.tsx` (ligne de relance), `src-tauri/src/mcp.rs` (deux fonctions de la plateforme offertes aux agents, sans outil MCP de plus pour les modules).

## S11 · Délégation entre agents

**Taille** : L. **Ordre** : 10. **Dépend de** : S3, S10.

**Ce qui manque.** Une conversation d’Alfred ne peut pas confier une partie de son travail à d’autres agents et suivre leurs résultats.

**Pourquoi OneApp en a besoin.** L’orchestrateur de OneApp (AGT-04, `docs/orchestrateur-global.md`) : à porter, décision de l’utilisateur.

**Comportement proposé.**

- Une conversation **coordinatrice** (marquée par l’utilisateur, ou lancée par une page avec `coordinator: true`) reçoit les fonctions de la plateforme `deleguer`, `etat-des-taches`, `relancer-tache`, `lire-rapport`.
- `deleguer` reçoit de 1 à 50 tâches : objectif, cible (dossier et mode de S3, entrées imposées des fonctions), harnais et modèle parmi ceux autorisés, dépendances acycliques ; le lot est validé en entier avant tout lancement ; un `requestId` rend la même réponse si la demande est répétée.
- Chaque agent délégué finit par un **contrat de retour** : `status` (`success`, `partial`, `failed`, `needs_information`, `cancelled`), `summary` (600 caractères), `artifacts` (chemins relatifs vérifiés dans son dossier), `questions` (pour la coordinatrice ou pour l’utilisateur). Le rapport complet est rangé à part et lu par pages ; les dépendants attendent un succès.
- Les délégués apparaissent sous leur coordinatrice dans la zone Agents du menu (S1) ; un retour se replie dans le fil de la coordinatrice avec « Voir l’agent » ; l’utilisateur peut reprendre la main sur un délégué ; arrêter la coordinatrice arrête ses délégués.
- Les délégués n’ont pas `deleguer` ; la confidentialité de S3 s’applique à toute la chaîne.

**Fichiers touchés.** `src/features/agent/store.ts`, `src/features/agent/model.ts`, `src/features/agent/Transcript.tsx`, nouveau `src/features/agent/delegation.ts`, `src-tauri/src/mcp.rs`, nouveau `src-tauri/src/agent_reports.rs`.

## S9 · Pilotage des agents depuis Rust

**Taille** : L, plus un correctif S à faire tout de suite. **Ordre** : 11 (le correctif : dès maintenant). **Dépend de** : rien ; de préférence après S3 pour ne pas refaire la traduction des modes.

**Ce qui manque.** Alfred parle les protocoles des harnais dans l’interface (`agents.rs` : « Le protocole de chaque CLI est parlé côté interface ») et lance `opencode acp` ; OneApp a accepté l’ADR 0022 (pilotage depuis Rust, `opencode serve`, mot de passe, appairage et jeton restant dans Rust).

**Correctif de sécurité (S, immédiat).** Pour Claude Code, le jeton du serveur local d’Alfred est passé en clair dans l’argument `--mcp-config` (`src-tauri/src/agents.rs`, lignes 314 à 316), lisible par tout processus de l’utilisateur. Le passer par une variable d’environnement (`Bearer ${ALFRED_MCP_TOKEN}` dans `--mcp-config`, comme Codex et OpenCode, démontré par le prototype `agent-protocols` de OneApp).

**Pourquoi OneApp en a besoin.** Pilotage des CLI (AGT-02) ; socle plus sûr pour les modes imposés (S3) et la délégation (S11).

**API proposée.** Commandes fermées (`agent_session_start`, `send`, `respond`, `cancel`, `close`, `read_history`, `list_models`), événements typés par tour sur un `Channel` (`seq` durable, permissions à options typées, `files-changed`). OpenCode par `opencode serve` (reprendre `src-tauri/src/agents/opencode/` de OneApp et son générateur), Codex `app-server` et Claude `stream-json` depuis Rust. À trancher : l’écrire dans Alfred, ou dans la bibliothèque commune `agents-kit` (ADR 0023 de OneApp, chantier desktop-kit en pause).

**Fichiers touchés.** `src-tauri/src/agents.rs` (devient `agents/`), `src/features/agent/harness/*`, `src/features/agent/store.ts`.

## S12 · Parité Windows

**Taille** : M, répartie sur les autres manques. **Ordre** : en continu.

**Pourquoi OneApp en a besoin.** L’équipe travaille sur Windows (GEN-12, ADR 0014).

À vérifier pour chaque manque :

- **Trousseau** : Gestionnaire d’identifiants Windows (taille par entrée déjà découpée dans `vault.rs`), jetons de session de S4 compris.
- **Agents** : `.cmd` et `.ps1` des CLI installés par npm ; arrêt de tout l’arbre de processus ; traduction des modes de S3 sous Windows (bac à sable de Codex).
- **PowerShell 5.1 en STA** pour le COM d’Outlook ; accents.
- **Git** : Git Bash (jamais celui de WSL), performance de `git status` sur de gros dépôts (S2).
- **Chemins** : lecteurs, partages UNC, chemins longs dans les dossiers accordés (S2).
- **Affichage** : échelle 100, 125 et 150 %, contraste élevé pour la zone du menu (S1), les composants (S8) et les fenêtres (S7).
- **Réseau d’entreprise** : proxy et certificats du système pour les clients (S6).
- **Terminal du poste** (S2) : Windows Terminal, à défaut Git Bash.

---

## Retiré de l’analyse précédente

| Ancien chantier | Raison |
|---|---|
| Synchronisation d’équipe étendue | Le partage reste fondé sur des fichiers dans des dossiers ; il n’en reste que S2. |
| Comptes partagés en équipe (moitié de l’ancien C2) | Adresses lues dans les fichiers `.oneapp/`, jetons ressaisis. |
| MCP ouvert aux clients externes | Les fonctions d’Alfred remplacent le MCP. |
| Reprise des jetons et des conversations de OneApp | Jetons ressaisis, conversations non gardées. |
| Module de reprise, organisation des 25 modules, marketplace | Viendront plus tard, module par module. |

## Ce qu’Alfred offre déjà

Panneau de droite unique avec blocs repliables et déplaçables ; comptes à plusieurs instances, choix du compte par page, onboarding guidé, test d’office, OAuth 2 PKCE ; cache des lectures ; historique des lignes et sauvegardes ; événements entre modules, planifications, webhooks, tâches de fond, fonctions en script ; `commands.run` ; `ai.oneShot`, `ai.decide`, `ai.startAgent` ; documents simples et librairies par module ; notifications, compteurs, palette, accueil ; données d’exemple ; fonctions offertes aux agents (`tool: true`).
