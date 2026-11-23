# Captures après la migration vers socle-ui (2026-11-23)

Prises dans un navigateur (Chrome) sur la coquille de la branche de migration, branchée sur l'Alfred de développement
par son pont (espace « taff », lecture seule : aucune écriture, la confirmation est annulée).

| Fichier | Parcours |
|---|---|
| `apres-01-menu-agent-clair.png` | Menu de gauche (Sidebar : sections, conversations, pied Agent / espace / compte), page Agent |
| `apres-02-page-liste-clair.png` | Une section : titre, état « Exemple », vues de la page, actions de la barre du haut |
| `apres-03-panneau-de-droite-clair.png` | Panneau de détail d'AppShell, avec Agrandir |
| `apres-04-reglages-clair.png`, `apres-04b-reglages-apparence-clair.png` | Réglages : Dialog xl et SettingsPage |
| `apres-05-notification-clair.png`, `apres-05b-centre-notifications-clair.png` | Toast et centre de notifications |
| `apres-06-actions-de-page-clair.png` | Menu « … » des actions de la page |
| `apres-07-confirmation-clair.png` | Confirmation (`useConfirm`) d'une suppression, annulée |
| `apres-08` à `apres-10` | Les mêmes écrans en mode sombre |

Limite : le contenu des pages de modules (cadres) vient du runtime de l'Alfred de développement déjà lancé, encore
sur l'ancienne version ; il ne s'affiche pas à travers le pont de l'essai. Les cadres sur socle-ui sont couverts par
les tests (`tests/frames.test.tsx`, `pnpm build:runtime`, `cargo test --lib`).

## Pages des espaces encore sur `@alfred/ui` (transition, 2026-11-23)

Prises dans l'app de dev lancée (`http://localhost:14730/`, espace « taff », lecture seule) après la remise en
service de `@alfred/ui` pour les cadres.

| Fichier | Page |
|---|---|
| `transition-01-jenkins-clair.png` | Jenkins, tableau de bord (actions de la page dans la barre du haut) |
| `transition-02-atom-projet-clair.png` | Atom, Projet, avec son panneau |
| `transition-03-atom-secrets-panneau-clair.png` | Atom, Secrets : résumé de la barre du haut, tableau, panneau de détail |
| `transition-04-atlassian-bitbucket-clair.png`, `transition-05-atlassian-bitbucket-sombre.png` | Atlassian, Bitbucket, en clair puis en sombre |

## Pages des espaces passées à socle-ui (fin de la transition)

Prises dans l'app de dev lancée après le retrait de `@alfred/ui` (lecture seule) : `socle-11-jenkins-clair.png`,
`socle-12-atom-usine-clair.png`, `socle-13-atlassian-confluence-clair.png`.
