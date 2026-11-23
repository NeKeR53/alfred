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
