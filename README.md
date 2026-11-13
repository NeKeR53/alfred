# Alfred

Alfred est une application de bureau (Tauri 2, React 19) livrée vide : l’utilisateur la construit en parlant à un agent
de code (Claude Code, Codex ou OpenCode). Pages, fonctions, tables, clients, webhooks et planifications vivent dans un
dossier d’espace sous git, rangé par modules ; chaque tour d’agent y fait un commit que l’on peut annuler.

## Développement

Prérequis : Node.js, pnpm, Rust stable et les dépendances système de Tauri 2.

```bash
pnpm install
pnpm tauri dev
```

L’interface est servie sur `http://localhost:14730` et le backend écoute sur le port `14731`. En développement, un
navigateur ouvert sur `http://localhost:14730` passe par le même backend (pont HTTP réservé au développement).

Vérifications :

```bash
npx tsc -b
pnpm exec biome check src
pnpm exec vitest run
cd src-tauri && cargo test --lib && cargo clippy --all-targets
```

## Construction

```bash
pnpm tauri build
```

La signature et la notarisation sont décrites dans [docs/publication.md](docs/publication.md).

## Documents

- [DESIGN.md](DESIGN.md) : règles de présentation, reprises de l’application OneApp.
- [docs/espace/AGENTS.md](docs/espace/AGENTS.md) : guide de l’agent, recopié dans chaque espace.
- [docs/espace/SDK.md](docs/espace/SDK.md) : SDK des pages et des fonctions (`@alfred/sdk`).
- [docs/publication.md](docs/publication.md) : livrer une version signée.
