# Où sont les choses

Guide de l’espace de travail Alfred, partie à lire pour cette tâche. Le reste est dans `AGENTS.md`.

```
alfred.json                  navigation et liaisons de l’utilisateur (ne pas modifier)
AGENTS.md, CLAUDE.md         ce guide (géré par Alfred)
docs/alfred/                 DESIGN.md et SDK.md (gérés par Alfred)
clients/<id>.json            clients (écrits par `declare_client`) : adresse et authentification (ou méthodes et instances), jamais de secret
modules/<module>/
  module.json                manifeste du module
  pages/<page>.tsx           page, panneau ou onglet des Réglages
  functions/<fonction>.ts    fonction (.sh, .ps1 ou .py pour un script)
  migrations/NNNN_nom.sql    structure des tables, appliquée dans l’ordre des noms
  lib/…                      code partagé, importé par chemin relatif (compilé par `check`)
  vendor/                    librairies npm (écrites par `set_libraries`, ne pas modifier)
  icons/<section>.svg        logo d’une entrée du menu (écrit par `set_section_icon`)
.alfred/                     base SQLite, fichiers des modules et sauvegardes (ne pas toucher)
```

Les identifiants sont en minuscules, chiffres et tirets, 64 caractères au plus. Le nom du dossier fait foi pour l’identifiant du module.

## `module.json`

`place_page`, `declare_function`, `declare_webhook` et `declare_schedule` l’écrivent. Tu le modifies à la main pour `requires`, `clients`, `uses`, `search`, `semantic`, `history`, `events`, `sync`, `python` ou un titre. Champs en camelCase ; **un champ mal orthographié est ignoré sans erreur** (sauf dans `python`, où `check` le signale). N’écris jamais `origin`, qui marque un module installé. L’`icon` d’une section est un nom Lucide (`list-checks`) ou le chemin d’un logo du module (`icons/principal.svg`) : ce dernier, pose-le avec `set_section_icon`, qui télécharge et nettoie l’image ; une image absente ou illisible s’affiche comme l’icône par défaut et `check` la signale dans `structure`.

```json
{
  "id": "suivi",
  "name": "Suivi",
  "version": "0.1.0",
  "description": "Tâches de l’équipe, synchronisées avec Jira.",
  "requires": [{ "module": "annuaire", "minVersion": "1.0.0" }, { "module": "jira" }],
  "sections": [{ "id": "principal", "label": "Suivi", "icon": "list-checks", "color": "blue" }],
  "pages": [
    {
      "id": "taches",
      "title": "Tâches",
      "icon": "list-checks",
      "description": "Tâches en cours et leur échéance.",
      "placement": { "kind": "tab", "section": "principal" },
      "uses": { "functions": ["synchroniser", "jira/lire-ticket"] }
    },
    { "id": "detail", "title": "Détail", "placement": { "kind": "panel", "page": "suivi/taches" } },
    { "id": "preferences", "title": "Suivi", "placement": { "kind": "settings" } }
  ],
  "functions": [
    {
      "id": "synchroniser",
      "description": "Récupère les tickets Jira ouverts (par le connecteur jira) et met à jour la table des tâches.",
      "input": { "type": "object", "properties": { "projet": { "type": "string" } } },
      "output": { "type": "object", "required": ["importees"], "properties": { "importees": { "type": "integer" } } },
      "effect": "write",
      "tool": true,
      "uses": { "functions": ["jira/lister-tickets"] },
      "tests": [
        { "name": "Importe le projet de test", "input": {}, "target": { "field": "projet", "label": "Projet de test" }, "expect": { "has": ["importees"] } }
      ]
    },
    {
      "id": "recevoir-ticket",
      "description": "Enregistre un ticket envoyé par le webhook de Jira.",
      "input": { "type": "object" },
      "output": { "type": "object" },
      "tool": false
    }
  ],
  "webhooks": [{ "id": "ticket-cree", "description": "Jira signale un nouveau ticket.", "function": "recevoir-ticket" }],
  "schedules": [
    { "id": "matin", "description": "Synchronisation de 8 h 30.", "function": "synchroniser", "at": "08:30" },
    {
      "id": "frequente",
      "description": "Synchronisation du projet ALF.",
      "function": "synchroniser",
      "everyMinutes": 15,
      "input": { "projet": "ALF" }
    }
  ]
}
```

- `placement` : `tab` (`section` : section du même module, ou `module/section`), `panel` (`page` : toujours `module/page`), `settings`.
- `pages[].perInstance` (facultatif) : besoin client (`clients[].id`, ou `dépendance/besoin`) dont la page montre un compte ; `sections[].perInstance` le donne à toutes les pages de la section. Voir « Des pages qui montrent un compte ».
- `sections[].instancesAs` (facultatif, ancienne forme) : ne sert qu’à reprendre le menu d’un espace d’avant. Voir « Ancienne forme ».
- `uses` informe l’utilisateur ; il n’accorde rien. L’accès est demandé à l’utilisateur au premier usage.
- `requires` : modules dont celui-ci appelle les fonctions (`"module/fonction"`) et dont ses fonctions utilisent les clients (`client("module/besoin")`), accordés d’office. Un module importé d’un marketplace importe ses dépendances avec lui, depuis le même marketplace, masquées du menu, et un module dont un autre dépend ne se retire pas.
- `clients[].auth` : `none`, `bearer`, `apiKey`, `basic`, `oauth2` ou `clientCredentials`. Dans le module, `client("jira")` désigne le client que l’utilisateur a relié à ce besoin, sinon `clients/jira.json`.
- **Configuration (onboarding)** : un module importé d’un marketplace ouvre un panneau de configuration, à part des Réglages (l’utilisateur peut aussi le lancer pour tout module, depuis son menu « … » ou le bouton « Configurer » de la page d’attente, et tu l’ouvres avec `open_onboarding`). Il va de la page vers le compte, pour quelqu’un qui n’y connaît rien : il présente le module en une phrase (`setup.welcome`) avec ses pages ; puis « Quelles pages voulez-vous ? », une carte par section du module, cochée une fois (l’utilisateur en décoche, en ajoute une deuxième, les renomme) ; puis, pour chaque page qui a besoin d’un compte (d’après les besoins de ses onglets), « À quel compte Jira se connecter pour « Jira » ? » : les comptes déjà connectés de l’espace qui sont du bon type, y compris ceux d’un autre module, ou « Connecter un nouveau compte », un assistant guidé (nom, façon de se connecter parmi tes `methods`, adresse vérifiée aussitôt, jeton ou « Se connecter avec … », test immédiat). Après le premier compte d’une page, il propose un onglet de plus pour un autre compte. Un besoin qu’aucune page ne demande a sa propre étape. Il écrit les mêmes pages, onglets et comptes que la fiche du module. Le module reste « à configurer » tant que chaque besoin non facultatif n’a pas un compte prêt **et testé avec succès** depuis sa dernière modification, mais il sert dès qu’un service est prêt. Tant qu’un service non facultatif de ses `uses.clients` n’est pas prêt, une page ne se charge pas : Alfred montre à sa place une page d’attente qui nomme, compte par compte, ce qui manque à cette page-ci (à ajouter, à connecter, à tester ; « utilisé par le module … » pour un service d’une dépendance), avec un seul bouton « Configurer » qui ouvre le parcours sur le premier de ces comptes ; la vraie page s’affiche d’elle-même dès que ses comptes sont prêts, même si d’autres services du module attendent encore. Un service seulement pas encore testé est testé d’office ; un service facultatif qui manque ne retient pas la page, qui doit alors montrer ce qu’elle peut sans lui. Déclare donc `uses.clients` sur chaque page, et qu’une page qui combine plusieurs services montre ce qu’elle peut quand l’un d’eux échoue, au lieu d’une erreur pour toute la page. Pour un module destiné à être partagé, renseigne :
  - `setup.welcome` : texte d’accueil en mots simples (ce que fait le module, ce qu’il faut avoir sous la main) ;
  - `clients[].help` : une phrase qui dit où trouver la clé ou quel compte utiliser ;
  - `clients[].optional: true` : le module marche sans ce service ;
  - `clients[].client` : modèle du service, de la même forme que `clients/<id>.json` mais **sans** `secret` ni `instances` (`baseUrl`, `auth` sans `secret` ou `methods`, `headers`, `testPath`, adresses OAuth et `scopes`). Le parcours le crée tel quel : l’utilisateur n’indique plus que son compte. Donne toujours un `testPath` qui demande l’authentification ;
  - sur chaque méthode (`methods[]`), l’aide de l’assistant, toute facultative : `label` en clair (« Prefect Cloud », « Serveur de l’entreprise »), `urlExample` (adresse d’exemple du compte), `help` (consigne de trois lignes au plus : où créer le jeton, quels droits lui donner), `tokenPage` (page du service où créer le jeton, ouverte par « Créer mon jeton » ; `{url}` y devient l’adresse du compte) et, pour `oauth2`, `clientId` : l’identifiant public d’une application que tu as déclarée chez le service ; l’assistant propose alors « Se connecter avec … » dans le navigateur (PKCE), sans rien faire saisir. Voir SDK.md, section 6.

  ```json
  "setup": { "welcome": "Range vos mails importants. Il vous faut un compte Gmail." },
  "clients": [{
    "id": "gmail", "label": "Gmail", "help": "Connectez-vous avec votre compte Google.",
    "client": { "baseUrl": "https://gmail.googleapis.com", "testPath": "/gmail/v1/users/me/profile",
      "auth": { "type": "oauth2", "authorizationUrl": "https://accounts.google.com/o/oauth2/v2/auth",
        "tokenUrl": "https://oauth2.googleapis.com/token", "scopes": ["https://www.googleapis.com/auth/gmail.readonly"] } }
  }]
  ```
- `functions[].effect` : `read` (ne fait que lire chez le service ou dans la base) ou `write` (crée, modifie, envoie, supprime). Absent, la fonction compte comme une écriture.
- `functions[].tests` : cas de test (voir « Tests d’une fonction »). Dans un connecteur (module `jira` qui détient le client `jira`), une lecture s’écrit par exemple :

  ```json
  {
    "id": "lister-tickets",
    "description": "Tickets d’un projet Jira, filtrés par statut.",
    "effect": "read",
    "input": { "type": "object", "required": ["projet"], "properties": { "projet": { "type": "string" }, "statut": { "type": "string" } } },
    "output": { "type": "object", "required": ["tickets"], "properties": { "tickets": { "type": "array", "items": { "type": "object", "required": ["cle", "titre"] } } } },
    "uses": { "clients": ["jira"] },
    "tests": [{ "name": "Tickets ouverts du projet ALF", "input": { "projet": "ALF", "statut": "Open" }, "expect": { "nonEmpty": ["tickets"], "equals": { "tickets.0.statut": "Open" } } }],
    "examples": [
      { "name": "Deux tickets ouverts", "input": { "projet": "ALF", "statut": "Open" }, "output": { "tickets": [{ "cle": "ALF-12", "titre": "Export PDF des factures", "statut": "Open" }, { "cle": "ALF-15", "titre": "Relance automatique", "statut": "Open" }] } },
      { "name": "Aucun ticket fermé", "input": { "projet": "ALF", "statut": "Done" }, "output": { "tickets": [] } }
    ]
  }
  ```
- `functions[].examples` : données d’exemple d’une fonction de connecteur (voir « Données d’exemple » dans `fonction.md`), rendues à la place du service en mode exemple.
- `webhooks[].function`, `schedules[].function` : identifiant d’une fonction **du même module**, sans préfixe.
- `schedules` : `everyMinutes` (au moins 1), `everySeconds` (au moins 5) **ou** `at` (« HH:MM », heure locale, une fois par jour), un seul des trois ; `input` est passé à la fonction (`{}` par défaut).
