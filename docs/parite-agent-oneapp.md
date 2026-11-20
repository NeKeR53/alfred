# Parité des agents : OneApp → Alfred

> Mis à jour le 20 novembre 2026 : pilotage des harnais depuis Rust (S9), agents lancés par une page avec dossier et mode imposés (S3), relance sur un événement (S10) et délégation entre agents (S11). Voir les sections 8 à 10.

Inventaire des fonctions d’agent de OneApp (`/Users/alexandre/Workspace/oneapp`) comparées à celles d’Alfred, en vue d’un périmètre identique. État d’Alfred : branche `verif-windows-agents` au 2026-11-16.

Les chemins OneApp sont relatifs au dépôt OneApp ; les chemins Alfred, relatifs à ce dépôt (`src/features/agent/` abrégé en `agent/`).

## Lecture du tableau

- **Statut dans Alfred** : `identique` (même comportement visible), `partiel` (présent avec des écarts), `absent`.
- **Catégorie** :
  - **A** : fonction d’agent générique, à porter.
  - **B** : liée au domaine de OneApp (produits, composants, tickets, Jira/Confluence, orchestrateur global qui délègue à des sous-agents, demandes secrètes) ou choix d’Alfred qui diverge volontairement : à discuter.
  - **C** : déjà équivalent pour l’utilisateur, même si le mécanisme diffère.

## Constats préalables

1. **OneApp ne pilote que Codex et OpenCode.** Il n’a pas de harnais Claude Code (`src/lib/agentSettings.ts:5`, `src-tauri/src/commands/agent_cli.rs:28`). Le harnais Claude d’Alfred n’a donc pas de modèle à copier ; ce qui suit vaut pour lui par analogie.
2. **OneApp ne montre presque jamais d’autorisation.** Codex tourne avec `approvalPolicy: "never"` et ses demandes sont refusées d’office ; OpenCode voit ses demandes acceptées d’office (`src/lib/codexSession.ts:477,712`, `src/lib/agentSession.ts:469`). Alfred fait remonter les demandes selon le niveau d’autonomie. C’est un écart volontaire, classé B.
3. **OneApp ne garde pas tout le relevé.** Il ne stocke que les messages de l’utilisateur et la dernière réponse, et relit le reste dans le CLI à l’ouverture (`src/lib/agentHistory.ts:5`). Alfred stocke tout le relevé (sorties d’outils tronquées à 4 000 caractères). Le résultat visible est proche ; classé C.
4. **Modifier un message envoyé et « Supprimer à partir d’ici » existent dans `MessageActions` de OneApp mais ne sont pas branchés sur la page Agents** (`onRevise` non passé, `src/pages/agents/AgentsPage.tsx:74-87`). Ils ne sont pas visibles ; classés C.
5. **Aucun suivi de consommation** (jetons, contexte, coût) dans OneApp ; rien à porter.
6. **Bug relevé dans Alfred** : un message qui n’a que des pièces jointes part avec un texte vide, que les harnais Claude et Codex ignorent (`agent/harness/claude.ts:168`, `agent/harness/codex.ts:463`). OneApp envoie alors « Analyse les fichiers joints. ».

Déjà fait dans Alfred, donc non listé comme manquant : Entrée envoie tout de suite et Ctrl/⌘+Entrée met en file, « Envoyer maintenant » depuis la file, orientation (steer) pour Codex, relance du dernier message, `Channel` Tauri par session, configuration OpenCode 1 et 2, politique Codex sous Windows.

## 1. Envoi et file d’attente

| Fonction | OneApp | Alfred | Ce qui manque ou diffère | Cat. |
|---|---|---|---|---|
| Entrée envoie, Maj+Entrée va à la ligne, hors composition IME | `src/components/agents/AgentComposer.tsx:243` | identique | — | C |
| Pendant un tour, Entrée envoie tout de suite, Ctrl/⌘+Entrée met en file | `src/components/agents/AgentComposer.tsx:246`, `src/hooks/useAgents.ts:248` | identique | — | C |
| Libellé du bouton d’envoi : « Relancer l’exécution », « Envoyer maintenant », « Envoyer », avec infobulle du raccourci | `src/components/agents/AgentComposer.tsx:96,264` | identique | — | C |
| Indice sous la saisie pendant un tour (« ↩ … ⌘↩ pour mettre en file ») | `src/components/agents/AgentComposer.tsx:277` | identique | — | C |
| Bouton d’envoi désactivé et en chargement pendant la préparation d’une pièce jointe | `src/components/agents/AgentComposer.tsx:270` | absent | Aucun état « préparation » : on peut envoyer avant que l’image collée soit enregistrée. | A |
| Envoyer sans rien écrire après une erreur ou un arrêt relance le dernier message | `src/hooks/useAgents.ts:247,289` | identique | OneApp le permet aussi sur le statut « partiel », qui n’existe pas dans Alfred. | C |
| Texte par défaut « Analyse les fichiers joints. » quand seules des pièces jointes partent ; « Applique les références sélectionnées. » pour des références seules | `src/hooks/useAgents.ts:261`, `src/lib/agentThreadsConversation.ts:292` | absent | Message vide transmis, ignoré par Claude et Codex (voir constat 6). | A |
| Envoi immédiat ou orientation (steer) du tour Codex, sinon interruption puis départ en tête de file | `src/lib/agentThreadsConversation.ts:349-435` | identique | — | C |
| Envois immédiats successifs d’une conversation sérialisés | `src/lib/agentThreadsConversation.ts:322` | identique | — | C |
| Arrêter l’agent : bouton carré (infobulle « Arrêter · Échap ») et Échap dans la saisie | `src/components/agents/AgentComposer.tsx:248`, `src/hooks/useAgents.ts:338` | identique | Libellé « Interrompre la réponse » dans Alfred. | C |
| Après envoi : brouillon vidé, suivi du bas réactivé, focus sur la saisie | `src/hooks/useAgents.ts:271` | partiel | Alfred vide la saisie mais ne recolle pas le relevé en bas si l’utilisateur était remonté. | A |
| Saisie vidée à l’envoi et restaurée si l’envoi échoue | `src/components/agents/NewAgentDialog.tsx:113`, `src/components/agents/ProductAgentsFlyout.tsx:112` | absent | Alfred vide la saisie et perd le texte en cas d’échec. | A |
| Verrou contre le double envoi (plusieurs Entrée avant le rendu) | `src/components/agents/NewAgentDialog.tsx:45`, `src/components/agents/ProductAgentsFlyout.tsx:83` | absent | `submit` lit le texte de la fermeture : deux Entrée rapides peuvent envoyer deux fois. | A |
| File affichée au-dessus de la saisie, une ligne par message, horloge, « part à la fin de l’étape en cours » | `src/components/agents/AgentQueue.tsx:29-63` | identique | — | C |
| Aperçu d’un message en file : pastilles de références, « Texte collé » pour un collage seul | `src/components/agents/AgentQueue.tsx:40,60` | partiel | Alfred affiche le texte brut ou « N pièce(s) jointe(s) ». | A |
| Réordonner la file par glisser-déposer ou flèches sur une poignée (« Déplacer le message N ») | `src/components/agents/AgentQueue.tsx:30-55`, `src/lib/agentThreadsConversation.ts:224-247` | absent | Ni poignée ni action de réordonnancement. | A |
| Modifier un message en file (le remet dans la saisie) | `src/components/agents/AgentQueue.tsx:66` | identique | Alfred le permet aussi avec pièces jointes et collages, ce que OneApp refuse. | C |
| Retirer un message de la file | `src/components/agents/AgentQueue.tsx:75` | identique | — | C |
| Envoyer maintenant un message de la file | `src/components/agents/AgentQueue.tsx:85` | identique | — | C |
| File plafonnée à 50 messages (« La file contient déjà 50 messages. ») | `src/lib/agentThreadsConversation.ts:105` | absent | File sans limite. | A |
| Message vide refusé ; message déjà présent (même identifiant) ignoré | `src/lib/agentThreadsConversation.ts:67-83` | partiel | Alfred refuse le vide côté saisie seulement ; pas de dédoublonnage. | A |
| Renvoyer un message de l’utilisateur tel quel (« Relancer le message ») | `src/hooks/useAgents.ts:297`, `src/components/chat/MessageActions.tsx:137` | absent | Seul le dernier message se relance, et seulement après erreur ou arrêt. | A |
| Réponse rapide depuis la navigation (volet produit), toujours mise en file pendant un tour | `src/hooks/useQuickAgentReply.ts:23-95` | absent | Lié au volet des agents d’un produit ; le panneau d’agent d’une page d’Alfred joue un rôle voisin. | B |
| Demande secrète : bascule sous la saisie, seuls les modèles habilités | `src/components/agents/AgentComposer.tsx:287`, `src/components/chat/SecretToggle.tsx:4` | absent | Notion de modèle habilité au secret propre à OneApp. | B |
| Messages d’automatisation déposés une seule fois dans un agent, qui est désarchivé | `src/lib/agentThreadsStore.ts:783-801` | absent | Pas d’automatisations d’agents dans Alfred. | B |

## 2. Saisie (références, pièces jointes, collages, dictée…)

| Fonction | OneApp | Alfred | Ce qui manque ou diffère | Cat. |
|---|---|---|---|---|
| Éditeur riche : les références choisies deviennent des pastilles non éditables avec « × », insérées au curseur | `src/components/chat/ReferenceComposer.tsx:89-201,362` | absent | Alfred laisse la mention en texte (`@chemin`, `/nom`) dans une zone de texte simple. | A |
| Positions des références suivies au fil des modifications | `src/lib/composerReferences.ts:125-153` | partiel | Alfred retrouve les références encore mentionnées au moment d’envoyer ; pas de suivi de position. | C |
| Frappe sans latence pendant une réponse (`flushSync`, état partagé en `startTransition`) | `src/components/agents/AgentComposer.tsx:59-76` | absent | Aucune mesure particulière. | A |
| Collage forcé en texte brut | `src/components/chat/ReferenceComposer.tsx:391` | identique | Zone de texte simple dans Alfred. | C |
| Indication de la saisie : « Déposez vos fichiers ici », « Ajouter un message à la file… » pendant un tour, « Répondre à l’agent… » | `src/components/agents/AgentComposer.tsx:219` | partiel | Pas d’indication propre au tour en cours ; textes d’Alfred (« Votre réponse… », dictée). | A |
| Menu « + » : « Joindre des fichiers… », « Skill ou commande · / », « Fichier du dossier · @ » | `src/components/agents/AgentComposer.tsx:177-205` | partiel | Alfred n’a que « Joindre des fichiers… ». | A |
| Entrée « Ticket, produit ou composant · # » du menu « + » | `src/components/agents/AgentComposer.tsx:177` | absent | Objets métier de OneApp. | B |
| Insertion du déclencheur au curseur depuis le menu (espace ajoutée si besoin, suggestions ouvertes) | `src/components/agents/AgentComposer.tsx:78-95` | absent | — | A |
| Déclencheurs `@` (fichier) et `/` (commande et skill) en début de mot | `src/lib/composerReferences.ts:56` | identique | — | C |
| Déclencheur `$` pour les skills | `src/lib/composerReferences.ts:56` | absent | Les skills ne passent que par `/`. | A |
| Déclencheur `#` (ticket, produit, composant ; tickets Jira ouverts, cache 2 min) | `src/lib/conversationObjectReferences.ts:16-80` | absent | Objets métier de OneApp. | B |
| Recherche floue des références (sans accents, une faute tolérée, 50 résultats) | `src/lib/composerReferences.ts:13-54` | identique | — | C |
| Consignes envoyées pour les références, l’interface n’affichant que le nom | `src/lib/composerReferences.ts:105-118` | partiel | Formulations différentes et bloc `<references>` dans Alfred ; skill « Utilise le skill $nom. » dans OneApp. | A |
| Liste de suggestions au-dessus du champ, clavier ↑/↓, Entrée ou Tab, Échap, clic sans perte du focus, états « Recherche… » / indisponible / aucun résultat | `src/components/chat/ReferenceComposer.tsx:268-490` | identique | Hauteur 260 px dans Alfred contre 224 px. | C |
| Recherche `@` côté natif : profondeur 12, 20 000 entrées, 50 résultats, dossiers ignorés, liens symboliques exclus | `src-tauri/src/composer_references.rs:24-92` | identique | — | C |
| Catalogue `/` : commandes et skills du harnais dans les dossiers du projet et du compte | `src-tauri/src/composer_references.rs:94-178` | identique | Alfred couvre aussi Claude Code. | C |
| Skills Codex lus par `codex app-server` `skills/list` (activés seulement, avec description), cache 30 s | `src/lib/composerReferenceCatalog.ts:9-75` | partiel | Alfred lit les dossiers de skills sur disque : il propose aussi des skills désactivés. | A |
| Joindre par le sélecteur du système, plusieurs fichiers | `src/lib/agentAttachments.ts:50-83` | identique | — | C |
| 16 pièces jointes au plus, 20 Mo chacune (« Joignez au plus 16 fichiers de 20 Mo chacun. ») | `src/lib/agentAttachments.ts:84-118`, `src/hooks/useAgents.ts:207` | absent | Aucune limite. | A |
| Vignette d’image dans la saisie (aperçu WebP, 1 600 px, 2 Mo) | `src/components/agents/AgentComposer.tsx:148`, `src/lib/agentAttachments.ts:18` | absent | Trombone et nom seulement. | A |
| Coller une image l’ajoute en pièce jointe | `src/components/agents/AgentComposer.tsx:222`, `src/lib/chatClipboard.ts:34` | identique | — | C |
| Collage long replié en carte « Texte collé N », supprimable | `src/components/agents/AgentComposer.tsx:229`, `src/lib/chatClipboard.ts:4` | partiel | Seuils : 2 000 caractères ou 20 lignes dans OneApp, 40 lignes dans Alfred ; libellé « Contexte N · L lignes ». | A |
| Glisser-déposer de fichiers sur la zone, état visuel | `src/hooks/useAgents.ts:225`, `src/pages/agents/AgentsPage.tsx:245` | identique | — | C |
| Pièces jointes dédoublonnées par chemin | `src/hooks/useAgents.ts:207` | identique | — | C |
| Brouillon par agent conservé d’une conversation à l’autre et après redémarrage | `src/hooks/useAgents.ts:165-193` | absent | Changer de conversation vide la saisie ; rien n’est enregistré. | A |
| Bandeaux d’erreur des brouillons (non chargés, illisible) avec « Réessayer » et « Supprimer le brouillon » ; récupération après fermeture anormale | `src/components/agents/AgentComposer.tsx:100-117`, `src/hooks/useAgents.ts:165` | absent | Suit les brouillons enregistrés. | A |
| Saisie verrouillée tant que conversations ou brouillons ne sont pas prêts | `src/hooks/useAgents.ts:198` | absent | — | A |
| Citer un passage dans la réponse (citation Markdown en fin de saisie, curseur à la fin) | `src/pages/agents/AgentsPage.tsx:142-164` | partiel | OneApp cite la sélection si elle existe, sinon tout le message ; Alfred cite tout le message. | A |
| Fonctions de la saisie de lancement réservées à la fenêtre principale | `src/components/agents/AgentLaunchComposer.tsx:35-45` | absent | Alfred n’a qu’une fenêtre d’agents. | B |
| Fenêtre Agents détachée (ADR 0021 de OneApp) : affichage et commandes, la fenêtre principale reste le moteur | `src/lib/agentsWindowBridge.ts` | identique | `agentsWindow.ts` : bouton « Ouvrir dans une fenêtre » de la page Agent, fenêtre `page-agents` (`agents/window.rs`). La principale publie l’état (ce qui a changé seulement) et exécute les actions ; la conversation ouverte reste propre à chaque fenêtre. Non vérifié dans une vraie fenêtre native. | B |

## 3. Rendu de la conversation

| Fonction | OneApp | Alfred | Ce qui manque ou diffère | Cat. |
|---|---|---|---|---|
| Ouverture progressive : 12 derniers blocs d’abord, le reste ensuite | `src/pages/chat/ChatTranscript.tsx:438,616` | absent | Tout le relevé est rendu d’un coup. | A |
| Tours terminés non redessinés pendant une réponse (rendu mémoïsé) | `src/pages/chat/ChatTranscript.tsx:256,375,476` | absent | — | A |
| Message de l’utilisateur en bulle à droite, colonne de 760 px | `src/pages/chat/agent-chat.css:20` | identique | — | C |
| Tour terminé replié derrière « A travaillé pendant … · N outils appelés », réponse finale visible | `src/pages/chat/ChatTranscript.tsx:371-436` | identique | — | C |
| Comptage des outils sans raisonnement ni bilan des fichiers | `src/lib/agentTurns.ts:23-38` | identique | — | C |
| Travail en cours : état (« Autorisation requise », « Rédaction en cours »…), minuteur à la seconde, heure de début | `src/pages/chat/ChatTranscript.tsx:137-163` | identique | Alfred dit « Accord requis ». | C |
| Activités consécutives regroupées (« N outils exécutés », « … en cours », « … en échec ») | `src/pages/chat/ChatActivities.tsx:193-227` | identique | — | C |
| Raisonnement terminé sans contenu masqué | `src/pages/chat/entryPresentation.ts:21` | identique | — | C |
| Titre des commandes « Exécuté {commande} » | `src/pages/chat/ChatActivities.tsx:12-29` | identique | — | C |
| Icônes par type d’activité, cercle animé tant qu’elle tourne | `src/pages/chat/ChatActivities.tsx:31-92` | identique | — | C |
| Statut « Arrêté » d’une activité interrompue | `src/pages/chat/ChatActivities.tsx:96-104`, `src/lib/agentThreadsStore.ts:178-194` | partiel | Alfred marque en échec un outil resté ouvert à la fin du tour (pas d’état « arrêté »). | A |
| Lignes « Lu / Modifié / Recherché / Listé » avec « +a −r » | `src/pages/chat/ChatActivities.tsx:109-164` | partiel | Nom de fichier non cliquable dans Alfred. | A |
| Titres « Read/Lire/Edited/Modifié {chemin} » rendus avec chemin cliquable | `src/pages/chat/ChatActivities.tsx:165-179` | absent | — | A |
| Détail d’outil dépliable en lecture seule (2 à 12 lignes), images et fichiers dessous | `src/pages/chat/ChatActivities.tsx:49-85,186` | identique | — | C |
| Images produites (génération, image de l’agent) visibles sous le tour, hors du repli | `src/pages/chat/ChatTranscript.tsx:394-400,423` | partiel | Alfred les montre dans le détail replié de l’activité. | A |
| « Fichiers du tour » sous le tour | `src/pages/chat/ChatTranscript.tsx:401,424` | partiel | Fichiers visibles seulement dans le détail de l’activité. | A |
| Bilan des modifications du tour : nombre de fichiers, total « +a −r », 3 fichiers puis « Afficher N de plus », chemins cliquables, « — » si inconnu, groupé par composant, infobulle de prudence | `src/pages/chat/ChatTranscript.tsx:47-135` | partiel | Alfred liste les fichiers du commit du tour avec « Annuler cette modification », sans « +a −r » par fichier ni total, chemins non cliquables. Le regroupement par composant relève de B. | A |
| Bilan des fichiers calculé par instantané avant/après du dossier, lignes par LCS | `src/lib/agentWorkspaceChanges.ts:26-157` | partiel | Alfred s’appuie sur le commit Git de l’espace : un dossier de travail hors de l’espace n’a pas de bilan. | A |
| Rôles lus par les lecteurs d’écran (« Vous », nom du harnais) | `src/pages/chat/ChatTranscript.tsx:547` | identique | Alfred lit « Alfred ». | C |
| Long message de l’utilisateur (≥ 2 000 caractères ou 20 lignes) en carte « Texte · N caractères » ouvrant une boîte de lecture | `src/pages/chat/ChatTranscript.tsx:339`, `src/components/chat/TextPreview.tsx:30` | partiel | Alfred affiche le texte entier dans la bulle ; seuls les collages sont en carte. | A |
| Collages affichés en cartes dans le message envoyé | `src/pages/chat/ChatTranscript.tsx:311` | identique | — | C |
| Pastilles de références dans les messages envoyés | `src/components/chat/ReferencePills.tsx:7-47` | absent | Mention en texte. La pastille `#` qui ouvre un objet OneApp relève de B. | A |
| Pièces jointes du message : vignette chargée depuis le disque avec états « Chargement… » et « Image indisponible · Réessayer » | `src/components/chat/ChatAttachments.tsx:12-119` | partiel | Alfred affiche l’image ou rien, sans état ni nouvel essai. | A |
| « Contexte transmis » (page d’origine, faits, fichiers de contexte) dans les actions du message | `src/pages/chat/ChatTranscript.tsx:206-254`, `src/components/chat/SourceContextSummary.tsx:9` | absent | Contexte de page de OneApp ; Alfred n’indique que la page d’origine. | B |
| Markdown : titres rabaissés, tableaux défilants | `src/components/shared/MarkdownText.tsx:33-70` | identique | — | C |
| Bouton « Copier le bloc » sur les blocs de code | `src/components/shared/MarkdownText.tsx:142-161` | absent | — | A |
| Blocs ```mermaid dessinés | `src/components/shared/MarkdownText.tsx:142` | absent | — | A |
| Liens web ouverts dans le navigateur du système | `src/components/shared/MarkdownText.tsx:109` | identique | — | C |
| Chemins de fichiers cliquables dans le texte et le code en ligne, avec `:ligne:col`, `#L10-L20`, `file://` | `src/lib/agentFileLinks.ts:3-86` | identique | OneApp les ouvre dans l’éditeur configuré, Alfred dans l’application du système. | C |
| Clés de tickets Jira et liens `oneapp://` ouverts dans l’application | `src/lib/conversationLinks.ts:105-193` | absent | Objets métier de OneApp. | B |
| Images Markdown : adresses `data:`, `https`, image locale de l’espace | `src/components/shared/MarkdownText.tsx:129`, `src/lib/chatImages.ts:5` | partiel | Alfred n’affiche que les adresses `data:` ; une image distante reste un lien, une image locale n’est pas lue. | A |
| « Images citées » : images locales citées par chemin montrées sous le message (8 au plus), cache de 48 | `src/lib/agentConversationImages.ts:19-60` | absent | — | A |
| Agrandir une image et « Enregistrer une copie de l’image » | `src/components/shared/ImagePreview.tsx:30`, `src/components/chat/ConversationImages.tsx:14` | absent | — | A |
| « Fichiers cités » : documents cités par chemin en cartes avec « Ouvrir », « Enregistrer… » et aperçu PDF | `src/lib/conversationFileKinds.ts:3`, `src/components/chat/ConversationFiles.tsx:13-50` | partiel | Alfred affiche une carte qui ouvre le fichier, seulement pour les fichiers des activités ; pas de copie ni d’aperçu. | A |
| Question de l’agent : bloc final ```oneapp-question retiré du texte, carte au-dessus de la saisie, options numérotées, touches 1 à n, « Autre réponse… » | `src/lib/agentQuestions.ts:9-65`, `src/components/agents/AgentQuestion.tsx:7-92` | absent | Alfred refuse `AskUserQuestion` et demande à l’agent d’écrire sa question dans la réponse. | A |
| Replier la question en pastille « … en attente » | `src/components/agents/AgentQuestion.tsx:26-63` | absent | — | A |
| Autorisation dans la même carte au-dessus de la saisie, options numérotées | `src/pages/agents/AgentsPage.tsx:63,334` | partiel | Alfred affiche les demandes d’accord en cartes à la fin du relevé, sans raccourci. | A |
| Actions du message au survol : horodatage, copier, citer | `src/components/chat/MessageActions.tsx:137-248` | partiel | Alfred : copier, et citer pour les messages de l’agent ; pas d’horodatage. | A |
| Statut de remise du message de l’utilisateur (« Envoyé », « En cours », « Échec », « Interrompu ») | `src/components/chat/MessageActions.tsx:144-166` | absent | — | A |
| « Repartir d’ici » : nouvel agent « {titre} · reprise » avec l’historique jusqu’au message | `src/hooks/useAgents.ts:318`, `src/lib/agentThreadsStore.ts:660-687` | absent | — | A |
| Modifier un message envoyé, « Supprimer à partir d’ici » | `src/components/chat/MessageActions.tsx:75-131,271` | absent | Non branchés sur la page Agents de OneApp (constat 4). | C |
| « Exécution arrêtée · Travail non terminé » | `src/pages/chat/ChatTranscript.tsx:704` | identique | — | C |
| Erreur de l’agent sous le fil avec bouton « Réessayer le message » | `src/pages/chat/ChatTranscript.tsx:708` | partiel | Alfred affiche l’erreur sans bouton (la relance passe par l’envoi vide). | A |
| Suivi automatique du bas tant que l’utilisateur est à moins de 100 px | `src/pages/agents/AgentsPage.tsx:306` | identique | — | C |
| Conversation focusable au clavier, erreur de rendu isolée par agent | `src/pages/agents/AgentsPage.tsx:299-327` | partiel | Pas de limite d’erreur (ErrorBoundary) autour du relevé. | A |
| En-tête « Depuis {origine} · {date} », infobulle du modèle | `src/pages/agents/AgentsPage.tsx:69` | partiel | Alfred montre la date au-dessus du relevé et l’origine dans la barre, sans le modèle. | A |
| Résultat structuré d’un sous-agent (statut, résumé, questions, artefacts) | `src/components/chat/AgentResultView.tsx:13-82` | absent | Délégation de OneApp. | B |
| Reconnexion au modèle visible (activité « Reconnexion au modèle ») | `src/lib/codexSession.ts:622` | identique | — | C |

## 4. Modèles et réglages

| Fonction | OneApp | Alfred | Ce qui manque ou diffère | Cat. |
|---|---|---|---|---|
| Choix du modèle sous la saisie : « {modèle} · {effort} », harnais en onglets, liste, curseur de raisonnement | `src/components/agents/AgentModelPicker.tsx:16-121`, `src/components/agents/EffortSlider.tsx:5` | identique | — | C |
| Libellés d’effort (aucun, minimal, faible, moyen, élevé, très élevé, par défaut) | `src/lib/agentLaunch.ts:72-88` | identique | — | C |
| Changer de harnais en cours de conversation : la session suivante rejoue l’historique | `src/hooks/useAgents.ts:339`, `src/lib/agentThreadsStore.ts:718` | partiel | Alfred fixe le harnais dès le premier message. | A |
| Changer de modèle ou d’effort en cours : appliqué au tour suivant | `src/lib/agentThreads.ts:345-362` | identique | — | C |
| Modèles masqués des sélecteurs (« modèles affichés » par harnais), un modèle déjà choisi restant visible | `src/lib/agentSettings.ts:38-42`, `src/components/agents/AgentModelPicker.tsx:37` | absent | Alfred propose tout le catalogue. | A |
| Modèle de nommage distinct du modèle par défaut | `src/lib/agentSettings.ts:34-37` | absent | Suit le nommage automatique (section 7). | A |
| Catalogue lu dans le CLI installé : Codex `model/list` paginé, OpenCode via `session/set_config_option` | `src/lib/agentSession.ts:334-398` | identique | — | C |
| OpenCode sans catalogue ACP : « Mettez le CLI à jour. » | `src/lib/agentSession.ts:389` | partiel | Alfred rend une liste vide sans explication. | A |
| Modèle par défaut au lancement | `src/lib/agentLaunch.ts:25-43` | identique | Alfred retient un modèle et un effort par harnais dans les réglages. | C |
| Consignes de l’application passées hors du fil (instructions développeur Codex, fichier OpenCode) | `src/lib/agentRuntime.ts:37-43`, `src/lib/codexSession.ts:481` | identique | — | C |
| Consigne Codex : lectures simples séparées et `apply_patch`, pour que les lectures et recherches s’affichent en « Lu / Recherché » | `src/lib/agentThreads.ts:309-312` | absent | — | A |
| Modèles habilités aux demandes secrètes | `src/lib/agentSettings.ts:29-33` | absent | Propre à OneApp. | B |
| Simultanéité (`maxConcurrent`) et plafond d’agents (`maxThreads`) | `src/lib/agentSettings.ts:47-53` | absent | Sert la délégation de OneApp ; Alfred plafonne à 32 sessions dans Rust. | B |
| Choix du modèle par l’orchestrateur (consignes de profils, détection Luna) | `src/lib/agentModelInstructions.ts:5-21` | absent | Délégation de OneApp. | B |
| Autorisations : Codex sans demande et en accès complet, OpenCode accepté d’office | `src/lib/codexSession.ts:477-512,712`, `src/lib/agentSession.ts:469` | partiel | Alfred règle le bac à sable et les demandes selon l’autonomie (`ask`, `auto`, `strict`) et les montre à l’utilisateur (constat 2). | B |
| Sessions « OneApp seule » (outils coupés, MCP filtrés, `OPENCODE_DISABLE_*`) | `src/lib/codexSession.ts:428-471`, `src/lib/openCodeConfiguration.ts:68-115` | absent | Sert l’orchestrateur de OneApp ; l’appel unique d’Alfred coupe déjà les outils. | B |
| Outils MCP filtrés par rôle | `src/lib/agentRuntime.ts:49-85` | absent | Rôles de OneApp. | B |
| Configuration OpenCode vérifiée avant lancement (`opencode debug config`) | `src/lib/agentSession.ts:504-514` | absent | Une configuration refusée n’est connue qu’à l’arrêt d’OpenCode. | A |

## 5. Historique et reprise

| Fonction | OneApp | Alfred | Ce qui manque ou diffère | Cat. |
|---|---|---|---|---|
| Relevé retrouvé à la réouverture (OneApp relit le CLI, Alfred lit sa base) | `src/lib/agentHistory.ts:5-42`, `src/lib/agentThreadsStore.ts:218-270` | identique | Mécanismes différents (constat 3). | C |
| « Relecture de l’historique dans Codex… » et échec avec « Réessayer » | `src/hooks/useAgentHistory.ts:5-31` | absent | Sans objet tant qu’Alfred garde le relevé. | C |
| Une ligne SQLite par conversation, écriture regroupée et différée | `src/lib/agentConversationsRepository.ts:38-224` | identique | 2 s dans OneApp, 1,5 s dans Alfred. | C |
| Échec d’enregistrement : message persistant et « Réessayer la sauvegarde » près de la saisie | `src/lib/agentConversationsRepository.ts:252`, `docs/chat-ia.md:91` | partiel | Alfred affiche une notification par échec, sans bouton. | A |
| Échec de chargement : bandeau « L’historique des agents n’a pas pu être chargé. » avec « Réessayer », aucune écriture d’ici là | `src/lib/agentConversationsRepository.ts:263-291`, `src/pages/agents/AgentsPage.tsx:270` | partiel | Notification seule ; Alfred peut écrire par-dessus. | A |
| Validation stricte de l’historique au chargement | `src/lib/agentThreadPersistence.ts:36-459` | absent | Une conversation mal formée est lue telle quelle. | A |
| Enregistrement à la fermeture de la fenêtre, avec « Fermer OneApp quand même ? » en cas d’échec | `src/lib/agentRuntime.ts:204-233` | absent | Un enregistrement différé en attente est perdu à la fermeture. | A |
| CLI et leurs descendants arrêtés à la fermeture | `src/lib/agentRuntime.ts:219` | identique | — | C |
| Tour en cours à la fermeture marqué arrêté au redémarrage | `src/lib/agentThreadsStore.ts:422-441` | partiel | Alfred affiche « Exécution arrêtée » sans le message « interrompue à la fermeture … Reprenez-la explicitement ». | A |
| Reprise de la session du harnais au message suivant | `src/lib/agentThreads.ts:363-404` | identique | — | C |
| Reprise impossible : session neuve avec l’historique rejoué dans les consignes | `src/lib/agentThreads.ts:370-405` | absent | Alfred échoue sur l’erreur du CLI et retente la même reprise au message suivant. | A |
| CLI inactifs libérés après 10 min, rouverts au message suivant | `src/lib/agentRuntime.ts:45,245`, `src/lib/agentThreadsConversation.ts:502-537` | absent | Une session reste ouverte jusqu’à la fermeture d’Alfred. | A |
| Sortie d’activité bornée à 32 000 caractères, fin conservée (« [… début de la sortie omis …] ») | `src/lib/agentThreads.ts:53-65` | partiel | Alfred ne borne rien en mémoire et garde le début (4 000 caractères) à l’enregistrement. | A |
| Sessions éphémères (Codex `ephemeral`, OpenCode `session/delete`) | `src/lib/agentSession.ts:601`, `src/lib/codexSession.ts:488` | identique | — | C |
| Nom de la discussion Codex fixé au titre (`thread/name/set`) | `src/lib/codexSession.ts:493` | identique | — | C |
| Agent sélectionné mémorisé (`sessionStorage`), sinon le plus récent | `src/hooks/useAgents.ts:95,127` | partiel | Alfred rouvre la première conversation de la liste. | A |
| Archiver : masque sans effacer, arrête le CLI, notification avec « Annuler » | `src/hooks/useAgents.ts:367`, `src/lib/agentThreadsStore.ts:650` | identique | — | C |
| Restaurer sans marquer « À consulter » | `src/lib/agentThreadsStore.ts:689` | identique | — | C |
| Réglages › Agents archivés : tri par date d’archivage, « archivé le … », « Restaurer » avec notification, « Supprimer définitivement », « Tout supprimer » | `src/pages/settings/ai/ArchivedAgentsSettings.tsx:13-150` | partiel | Alfred : « Désarchiver » et « Ouvrir », sans date d’archivage, sans suppression ni « Tout supprimer ». | A |
| Suppression : arrêt du CLI, suppression du brouillon | `src/lib/agentThreadsConversation.ts:632` | identique | Alfred supprime depuis la barre de la conversation. | C |
| Ancien Assistant et anciennes conversations de produit en lecture seule, regroupements | `src/lib/agentThreadPersistence.ts:461`, `src/hooks/useAgents.ts:125` | absent | Migrations de OneApp. | B |

## 6. Notifications et suivi d’activité

| Fonction | OneApp | Alfred | Ce qui manque ou diffère | Cat. |
|---|---|---|---|---|
| Notifications dans l’application, seulement pour un agent non affiché : « attend ta réponse », « a terminé », « s’est arrêté » | `src/hooks/useAgentNotifications.ts:11-72` | identique | Libellés d’Alfred au ton du majordome. | C |
| Boutons « Répondre » et « Ouvrir » qui ouvrent l’agent ; attente persistante ; une notification par tour | `src/hooks/useAgentNotifications.ts:44-68` | partiel | Alfred n’a ni bouton d’ouverture, ni notification persistante, ni dédoublonnage par tour. | A |
| Notifications du système | `src-tauri/Cargo.toml:57` | identique | OneApp n’en émet pas pour les agents ; Alfred en émet quand la fenêtre est en arrière-plan. | C |
| Agent affiché = lu | `src/hooks/useAgents.ts:159` | identique | — | C |
| États : réponse attendue, en échec, au travail, en attente, à consulter, en veille ; arrêté ou partiel non lu = en échec | `src/lib/agentMonitor.ts:4-62` | partiel | Pas d’état « en attente » (file ou dépendances) ; un tour arrêté non lu apparaît « À consulter ». | A |
| Tri stable : par état, agents actifs par date de création, autres par mise à jour | `src/lib/agentMonitor.ts:64-75` | partiel | Alfred garde l’ordre de la liste chargée. | A |
| Entrée Agents de la navigation avec pastille (attention, travail, à consulter) | `src/components/shell/AppShell.tsx:305-312,497` | identique | — | C |
| Résumé de la navigation publié seulement quand il change | `src/hooks/useAgentActivity.ts:29-50` | identique | — | C |
| Annonces regroupées pendant une réponse (au plus toutes les 120 ms) | `src/lib/agentThreadsStore.ts:126-177` | absent | Chaque fragment déclenche une mise à jour. | A |
| Surveillance du silence : tour arrêté après 3 min sans signe en pleine réponse, 15 min en réflexion, aucune limite pendant un outil | `src/lib/agentThreads.ts:49-139` | absent | Un CLI figé laisse le tour « en cours » indéfiniment. | A |
| Archivés exclus des notifications et compteurs | `src/hooks/useAgentNotifications.ts:18` | identique | — | C |
| Pastille et volet par produit dans la navigation, carte « Agents » du panneau produit | `src/components/agents/ProductAgentsFlyout.tsx:27-58`, `src/hooks/useProductAgentThreads.ts:4` | absent | Produits de OneApp. | B |
| Nombre de sous-agents lancés (« Exécutions ») | `src/lib/agentMonitor.ts:111-124` | absent | Délégation de OneApp. | B |

## 7. Titres

| Fonction | OneApp | Alfred | Ce qui manque ou diffère | Cat. |
|---|---|---|---|---|
| Titre initial : première ligne, 60 caractères avec « … » | `src/lib/agentLaunch.ts:45-50` | identique | « Nouvelle conversation » au lieu de « Nouvel agent ». | C |
| Titre limité à 80 caractères | `src/lib/agentThreadsStore.ts:613,707` | partiel | 120 caractères dans Alfred. | A |
| Nommage automatique par un modèle quand le titre est générique, tronqué ou en double (3 à 7 mots, 60 s, sans nouvel essai, renommage manuel prioritaire) | `src/lib/agentTitling.ts:5-91`, `src/lib/agentRuntime.ts:246` | absent | Le titre reste la première ligne tronquée. | A |
| Renommer en place dans la barre (texte sélectionné, vide = ancien nom) | `src/pages/agents/AgentsPage.tsx:166-210` | identique | — | C |
| Raccourci F2 « Renommer {titre} » | `src/hooks/useAgents.ts:348-357` | absent | Renommer passe par le menu. | A |
| Titre d’un agent lancé depuis une page = titre de la source | `src/lib/agentLaunch.ts:131-141` | identique | Alfred garde l’origine de la page qui lance l’agent. | C |

## 8. Multi-agents, délégation, transferts

| Fonction | OneApp | Alfred | Ce qui manque ou diffère | Cat. |
|---|---|---|---|---|
| Orchestrateur global unique qui délègue (`oneapp_threads` : plan, status, send, dispatch, report) | `src/lib/agentThreadBridge.ts:1-192`, `src/lib/globalOrchestrator.ts:117-300` | partiel | Alfred : conversation coordinatrice désignée par l’utilisateur (page Agent) ou par une page (`coordinator: true`), outils `delegate`, `task_status`, `read_report`, `relaunch_task` (`agents/delegation.rs`, `delegation.ts`). Pas d’orchestrateur global unique. | B |
| Plan validé en bloc (1 à 50 tâches, dépendances acycliques, profils autorisés), idempotent | `src/lib/agentThreadModel.ts:365-413`, `src/lib/agentThreadsDelegation.ts:103-129` | identique | `delegate` : lot vérifié en entier (clés, boucles, dossiers, mode borné par celui de la coordinatrice), `requestId`. Pas de profils : harnais et modèle par tâche. | B |
| Messages originaux transmis tels quels aux sous-agents, avec leurs pièces jointes (16 au plus) | `src/lib/agentThreadsDelegation.ts:35-97` | absent | — | B |
| Dépendances entre sous-agents, statuts « en attente » et « attend ses agents » | `src/lib/agentThreads.ts:141-178`, `src/lib/agentThreadsStore.ts:282-322` | partiel | Dépendances et annulation en cascade d’un échec ; pas de statut affiché « attend ses agents ». | B |
| Reprise en main d’un sous-agent par l’utilisateur | `src/lib/agentThreadsStore.ts:271-281` | identique | Un délégué est une conversation ordinaire de la page Agent. | B |
| Arrêt en cascade des sous-agents | `src/lib/agentThreadsConversation.ts:463-494` | partiel | À l’archivage de la coordinatrice ; pas encore à l’arrêt d’un tour. | B |
| Contrat de retour JSON des sous-agents, artefacts vérifiés, statut partiel | `src/lib/agentResults.ts:16-255`, `src/lib/agentThreads.ts:530-574` | identique | `status`, `summary` (600), `artifacts` vérifiés dans le dossier du délégué, `questions`. | B |
| Rapports volumineux transmis par fichier, résumé compacté, lecture paginée | `src/lib/agentHandoffs.ts:5-58`, `src/lib/agentThreadsDelegation.ts:270-377` | partiel | Rapport gardé dans la base de l’espace, lu par pages de 4 000 caractères (`read_report`). | B |
| Rapport de sous-agent replié dans le fil parent (« Retour de … »), « Voir l’agent » | `src/pages/chat/ChatTranscript.tsx:502-540` | partiel | Le rapport arrive comme message dans la coordinatrice, sans repli ni bouton « Voir l’agent ». | B |
| Proposition d’agent sur un produit lié : carte « Lancer l’agent » / « Ignorer », 5 au plus | `src/lib/agentThreadsConversation.ts:538-578`, `src/hooks/useAgents.ts:386-436` | absent | Noyau générique possible (« proposer un agent ailleurs, l’utilisateur décide »). | B |
| Lancement d’un agent depuis une page avec fichier de contexte privé, un seul par demande | `src/lib/agentThreadsStore.ts:731-781` | partiel | `ai.startAgent` : dossier accordé, mode (`espace-de-travail` ou `complet`), fonctions à entrées imposées, coordinatrice ; `ai.sendToAgent`. Sans dédoublonnage par demande ni fichier de contexte privé. | B |
| Événements « document modifié par l’agent » pour rafraîchir les vues | `src/lib/agentDocumentEvents.ts:1-18` | absent | — | B |
| Sous-agents natifs du CLI affichés (« Agent · … ») | `src/lib/codexSession.ts:298-307` | identique | — | C |
| Consigne pour des agents concurrents dans le même dossier | `src/lib/agentQuestions.ts:3-4` | absent | Consigne d’agent produit. | B |

## 9. Harnais Codex, OpenCode et Claude

| Fonction | OneApp | Alfred | Ce qui manque ou diffère | Cat. |
|---|---|---|---|---|
| Codex : `codex app-server`, `initialize` + `initialized`, `thread/start` ou `thread/resume` (`excludeTurns`) | `src/lib/codexSession.ts:380-492,756` | identique | — | C |
| Codex : `turn/start` avec texte et images en `localImage`, autres fichiers cités | `src/lib/codexSession.ts:57-67,499` | identique | — | C |
| Codex : `turn/steer`, `turn/interrupt`, `turn/completed` | `src/lib/codexSession.ts:524-546,667` | identique | — | C |
| Codex : délai de 30 s par requête | `src/lib/codexSession.ts:560` | identique | — | C |
| Codex : fragments et texte final remplaçant ; sorties de commande, résumé de raisonnement, plan, progression MCP | `src/lib/codexSession.ts:636-666` | identique | — | C |
| Codex : types d’éléments affichés (raisonnement, plan, commande, fichiers, MCP, outils dynamiques, collaboration, web, image) | `src/lib/codexSession.ts:187-340` | identique | — | C |
| Codex : JSONL tolérant, une erreur sur un message n’arrête pas les suivants | `src/lib/codexSession.ts:109-128,595` | identique | — | C |
| Codex : requête non prise en charge signalée à l’utilisateur (« Le CLI demande une interaction non prise en charge… ») | `src/lib/codexSession.ts:717-728` | identique | Porté en Rust (`agents/codex/mod.rs`). | A |
| Codex : dernière erreur du modèle ajoutée au message d’échec | `src/lib/codexSession.ts:634,667` | identique | — | C |
| Codex : outils dynamiques (`item/tool/call`, 120 s) | `src/lib/codexSession.ts:681-711` | absent | Délégation de OneApp ; Alfred passe ses outils par MCP. | B |
| OpenCode : `opencode serve` privé (ADR 0022 de OneApp), client généré depuis l’OpenAPI, mot de passe et appairage dans Rust, demandes envoyées une par une, rattrapage par `session.message.list` | `src-tauri/src/agents/opencode/` | identique | Repris de OneApp ; un serveur par session d’Alfred (jeton des outils propre à la conversation). OpenCode 2.1 ou plus : OpenCode 1 n’a pas l’API v2. | C |
| OpenCode : `session/prompt` avec `resource_link`, adresses Windows, refus signalé | `src/lib/agentSession.ts:17-39,570` | identique | — | C |
| OpenCode : annulation (autorisations annulées puis `session/cancel`), filtrage par session, -32601 | `src/lib/agentSession.ts:495-600` | identique | — | C |
| OpenCode : traduction des mises à jour ACP (message, pensée, outils, plan, images) | `src/lib/agentSession.ts:155-332` | identique | — | C |
| Sondes d’installation (`--version`, `codex login status`) | `src/lib/codexCli.ts:73-190` | identique | Alfred sonde aussi `claude auth status`. | C |
| Harnais Claude Code | — | identique | Absent de OneApp ; Alfred va au-delà (constat 1). | C |

## 10. Couche processus Rust

Depuis le 20 novembre 2026 (S9), Alfred pilote les trois harnais depuis Rust (`src-tauri/src/agents/`) : Claude Code en `stream-json`, Codex `app-server` sur les types générés depuis son JSON Schema, OpenCode par `opencode serve` et son client généré (`src-tauri/codegen`). L’interface n’a que des commandes fermées (`agents.start`, `send`, `steer`, `answer`, `cancel`, `close`, `models`, `skills`) et reçoit des événements normalisés par un `Channel` ; `agents.spawn`/`write`/`kill`, qui écrivaient du texte libre sur l’entrée d’un CLI, ont disparu, comme les 1 900 lignes de protocole de `src/features/agent/harness/`.

| Fonction | OneApp | Alfred | Ce qui manque ou diffère | Cat. |
|---|---|---|---|---|
| Programmes et arguments fixés par Rust, l’interface ne choisit rien | `src-tauri/src/commands/agent_cli.rs:1-47` | identique | Alfred valide en plus les options Claude. | C |
| Binaire introuvable signalé clairement | `src-tauri/src/commands/agent_cli.rs:153-163` | identique | Alfred cherche aussi dans le PATH du shell et les dossiers usuels de Windows. | C |
| Dossier de travail vérifié | `src-tauri/src/commands/agent_cli.rs:165` | identique | — | C |
| Pas de console sous Windows (`CREATE_NO_WINDOW`) | `src-tauri/src/commands/agent_cli.rs:181` | identique | — | C |
| Variables d’environnement en liste fermée, jeton MCP hors de portée de l’interface | `src-tauri/src/commands/agent_cli.rs:49-69,280` | identique | — | C |
| 32 sessions au plus | `src-tauri/src/commands/agent_cli.rs:23` | identique | — | C |
| stdout ligne à ligne, stderr par blocs de 8 Kio, fin annoncée après la dernière ligne | `src-tauri/src/commands/agent_cli.rs:233-355` | identique | — | C |
| `Channel` Tauri par session, sorties précoces conservées | `src-tauri/src/commands/agent_cli.rs:103`, `src/lib/codexCli.ts:104-152` | identique | — | C |
| Écriture sur stdin bornée | `src-tauri/src/commands/agent_cli.rs:22` | identique | 4 Mio dans OneApp, 8 Mio dans Alfred. | C |
| Arrêt de l’arbre : SIGTERM puis SIGKILL, `taskkill /T /F` | `src-tauri/src/commands/agent_cli_process.rs:10-149` | identique | — | C |
| Erreurs du CLI expurgées (jetons, courriels), AADSTS50078 reconnu | `src/lib/agentProtocol.ts:13-38` | identique | — | C |
| Commandes d’agent réservées à la fenêtre principale | `src-tauri/src/commands/agent_cli.rs:142-151` | absent | Alfred ne vérifie pas la fenêtre appelante. | B |
| Artefacts des sous-agents : chemins validés, ouverture | `src-tauri/src/agent_artifacts.rs:7-172` | absent | Délégation de OneApp. | B |

## 11. Autres

| Fonction | OneApp | Alfred | Ce qui manque ou diffère | Cat. |
|---|---|---|---|---|
| Page Agents : conversation au centre, suivi à droite masquable | `src/pages/agents/AgentsPage.tsx:92-216,364` | identique | — | C |
| « Nouvel agent » dans la barre | `src/pages/agents/AgentsPage.tsx:180` | identique | — | C |
| « Ouvrir {dossier} dans l’éditeur » et « … dans l’explorateur » dans la barre | `src/components/shared/FolderActions.tsx:42-59`, `src/hooks/useAgents.ts:449-472` | absent | — | A |
| État vide et chargement | `src/pages/agents/AgentsPage.tsx:266-296` | identique | — | C |
| Suivi en cartes repliables : « À traiter », « En cours », « Terminés » (archivage en un clic), « Modifications » | `src/components/agents/AgentList.tsx:231-352` | identique | — | C |
| Carte « Automatisations » | `src/components/agents/AgentList.tsx:199-297` | absent | Automatisations de OneApp. | B |
| Ligne d’agent : état, titre, portée, « il y a N min » | `src/components/agents/AgentList.tsx:130-197` | identique | — | C |
| Carte « Modifications » : état Git relu à chaque fin de tour, un groupe par dépôt, « Lecture de l’état Git… », dépôts indisponibles | `src/components/agents/AgentList.tsx:18-128` | partiel | Alfred additionne les lignes des commits de la conversation dans l’espace ; pas d’état Git du dossier de travail. | A |
| Pastille Git sous la saisie « N fichiers modifiés +a −r » | `src/components/agents/AgentGitSummaryPill.tsx:1-33` | absent | — | A |
| Volet « Nouvel agent » avec choix du produit, du composant ou d’un dossier | `src/components/agents/NewAgentDialog.tsx:76-180`, `src/components/agents/AgentTargetPicker.tsx:8` | partiel | Alfred ouvre un brouillon et choisit le dossier sous la saisie. Produit et composant relèvent de OneApp. | B |
| Lancer un agent depuis la navigation ou une page (volet, contexte de page, suggestions) | `src/components/agents/ProductNewAgentFlyout.tsx:8`, `src/components/chat/OrchestratorAction.tsx:23` | partiel | Alfred a le panneau d’agent de page et « Corriger un élément ». | B |
| Libellé de portée (« Sans produit », produit · composant) | `src/lib/agentLaunch.ts:90-98` | absent | — | B |
| Ouvrir un agent depuis l’extérieur (notification, lien, autre fenêtre) | `src/hooks/useAgents.ts:142-150` | absent | Aucune action d’ouverture depuis une notification. | A |

## Fonctions d’Alfred absentes de OneApp

Pour mémoire, sans ligne dans les tableaux : harnais Claude Code ; niveaux d’autonomie et cartes d’accord ; annulation d’un tour par commit de l’espace ; notifications du système ; dictée et lecture des réponses ; question d’emplacement d’une page ; appel unique (`ai.oneShot`) ; « Corriger un élément » ; « Marquer comme non lue » ; suppression depuis la conversation.

## Décompte

| Statut | Lignes |
|---|---|
| identique | 94 |
| partiel | 43 |
| absent | 79 |
| **Total** | **216** |

| Catégorie | Lignes |
|---|---|
| A | 81 (38 partielles, 43 absentes) |
| B | 38 |
| C | 97 |

## Plan proposé

Les lignes A regroupées en lots. Chaque lot possède ses fichiers ; deux lots ne modifient pas le même fichier, à une exception près signalée. Les lots 1 à 5 peuvent partir en parallèle ; le lot 6 attend les lots 1 et 3.

### Lot 1 — Saisie et file

Lignes : préparation des pièces jointes, saisie restaurée sur échec, verrou contre le double envoi, aperçu et réordonnancement de la file (interface), éditeur à pastilles, frappe sans latence, indications de la saisie, menu « + » complet, insertion du déclencheur, `$` pour les skills, consignes des références, skills Codex par `skills/list`, limites 16 × 20 Mo, vignettes, seuils de collage, brouillons enregistrés par conversation avec leurs bandeaux, saisie verrouillée au chargement, citation de la sélection.

Fichiers : `src/features/agent/Composer.tsx`, `src/features/agent/ReferenceSuggestions.tsx`, `src/features/agent/lib/composerReferences.ts`, `src/features/agent/drafts.ts`, `src/features/agent/files.ts`, `src/features/agent/agent-composer.css`, `src-tauri/src/composer.rs`, nouveaux `src/features/agent/ComposerEditor.tsx` et `src/features/agent/QueueList.tsx`. Les brouillons s’enregistrent par `settings.get` / `settings.set`, sans nouvelle commande Rust.

Le réordonnancement s’appuie sur une action `reorderQueued` du lot 3 ; la poignée reste masquée tant qu’elle n’existe pas. La citation de la sélection touche aussi `Transcript.tsx` (lot 2) : à faire dans le lot 2.

### Lot 2 — Relevé

Lignes : ouverture progressive, rendu mémoïsé, état « Arrêté » à l’affichage, fichiers cliquables dans les activités, images et fichiers sous le tour, bilan des modifications par fichier, long message en carte, pastilles de références dans les messages, états des images jointes, copie des blocs de code, mermaid, images Markdown distantes et locales, « Images citées », agrandir et enregistrer une image, « Fichiers cités » avec aperçu PDF, carte de question au-dessus de la saisie (détection du bloc, touches 1 à n, repli), autorisations dans cette carte, actions du message (horodatage, citer la sélection, relancer, repartir d’ici), statut de remise, « Réessayer le message », limite d’erreur, en-tête avec le modèle.

Fichiers : `src/features/agent/Transcript.tsx`, `src/features/agent/Activities.tsx`, `src/features/agent/TextPreview.tsx`, `src/features/agent/agent.css`, `src/features/agent/lib/agentFileLinks.ts`, `src/features/agent/lib/chatImages.ts`, `src/features/agent/lib/conversationFileKinds.ts`, `src/features/agent/lib/contentFiles.ts`, `src/ui/components/Markdown.tsx`, `src/ui/components/markdown-text.css`, `src-tauri/src/conversations.rs` (copie d’un fichier ou d’une image), nouveaux composants sous `src/features/agent/transcript/`.

Les boutons « Relancer le message » et « Repartir d’ici » appellent les actions `resend` et `fork` du lot 3. La consigne qui demande le bloc de question est ajoutée par le lot 3 dans les consignes d’Alfred.

### Lot 3 — Moteur des conversations

Lignes : texte par défaut sans texte, refus du vide et dédoublonnage, plafond de 50 messages, actions `reorderQueued`, `resend` et `fork`, recollage en bas après envoi (état exposé au relevé), enregistrement à la fermeture avec dialogue, erreurs d’enregistrement et de chargement exposées en état, validation au chargement, message « interrompue à la fermeture », reprise impossible rattrapée par une session neuve avec historique rejoué, libération des CLI inactifs après 10 min, sortie d’activité bornée par la fin, notifications avec ouverture, persistance et dédoublonnage par tour, ouverture d’un agent depuis l’extérieur, annonces regroupées toutes les 120 ms, surveillance du silence, état « en attente » et arrêté non lu en échec, titre à 80 caractères, nommage automatique avec son modèle, consigne du bloc de question, mémoire de la conversation ouverte, date d’archivage.

Fichiers : `src/features/agent/store.ts`, `src/features/agent/model.ts`, `src/features/agent/oneShot.ts`, `src/features/agent/summary.ts`, `src/features/agent/systemNotification.ts`, nouveaux `src/features/agent/titling.ts` et `src/features/agent/watchdog.ts`, et le gestionnaire de fermeture de la fenêtre dans `src/shell/` (fichier à choisir, hors des autres lots).

### Lot 4 — Page, suivi et réglages

Lignes : bandeaux d’erreur de chargement et de sauvegarde avec « Réessayer » (à partir de l’état du lot 3), tri stable du suivi, carte « Modifications » avec l’état Git du dossier de travail, pastille Git sous la saisie (rendue par la page sous la saisie), actions « Ouvrir dans l’éditeur » et « dans l’explorateur », raccourci F2, Réglages › Agents archivés complets (tri, date, suppression, « Tout supprimer »), modèles affichés par harnais et modèle de nommage dans les réglages, filtre des modèles masqués dans le choix du modèle.

Fichiers : `src/features/agent/AgentPage.tsx`, `src/features/agent/ConversationList.tsx`, `src/features/agent/panel/InfoPanel.tsx`, `src/features/agent/panel/ModelPicker.tsx`, `src/features/agent/panel/info-panel.css`, `src/features/agentSettings/AgentSettings.tsx`, `src/features/agentSettings/ArchivedConversations.tsx`. L’état Git du dossier de travail demande une commande de lecture : à ajouter dans un module Rust propre au lot (par exemple `src-tauri/src/agent_git.rs`), son enregistrement dans le routeur des commandes étant la seule ligne partagée.

### Lot 5 — Harnais

Lignes : consigne Codex de lectures séparées et `apply_patch`, requête Codex non prise en charge affichée, statut « arrêté » d’une activité dans le contrat des événements, message d’OpenCode sans catalogue ACP, vérification `opencode debug config` avant lancement.

Fichiers : `src/features/agent/harness/codex.ts`, `src/features/agent/harness/opencode.ts`, `src/features/agent/harness/claude.ts`, `src/features/agent/harness/types.ts`, `src/features/agent/harness/process.ts`, `src-tauri/src/agents.rs` (sonde `opencode debug config`).

L’affichage du statut « arrêté » est fait par le lot 2 ; tant que le lot 5 n’a pas ajouté la valeur, le lot 2 garde « Échec ».

### Lot 6 — Changer de harnais en cours de conversation (après les lots 1 et 3)

Ligne : changer de harnais en cours, la session suivante rejouant l’historique.

Fichiers : `src/features/agent/Composer.tsx` (déverrouillage dans les réglages de la conversation) et `src/features/agent/panel/ModelPicker.tsx`, puis `src/features/agent/store.ts` pour le rejeu, qui réutilise celui du lot 3. Il touche des fichiers des lots 1, 3 et 4 : à lancer seul, après eux.

### À discuter (catégorie B)

Délégation et orchestrateur (outil de délégation, contrat de retour, rapports, propositions d’agent), demandes secrètes, automatisations, objets métier `#` et liens `oneapp://`, contexte de page transmis, simultanéité et plafond d’agents, filtrage des outils par rôle, réservation à la fenêtre principale, et l’écart volontaire sur les autorisations (constat 2).
