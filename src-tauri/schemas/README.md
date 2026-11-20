# Schémas des harnais d’agents

Sources des types générés du pilotage des agents depuis Rust (`src/agents/`), repris de OneApp (ADR 0022).

- `codex/codex_app_server_protocol.schemas.json` : `codex app-server generate-json-schema` de Codex **0.169**. Source de
  `src/agents/codex/generated.rs` (typify), réduit aux définitions atteintes depuis `CODEX_ROOTS`.
- `opencode/openapi.json` : `GET /openapi.json` d’un `opencode serve` **2.1.2** (OpenAPI 3.1, indentation de deux
  espaces). Source de `src/agents/opencode/generated.rs` (progenitor), réduit aux opérations de `OPERATIONS`. Les
  événements SSE de `/api/event` ne sont pas décrits (`V2EventEncoded` est une chaîne opaque) : ils sont lus à la main
  dans `src/agents/opencode/mapping.rs`.

Après une nouvelle version d’un CLI :

1. Codex : `codex app-server generate-json-schema --out <dossier>` et garder `codex_app_server_protocol.schemas.json`.
   OpenCode : lancer un serveur privé protégé par un mot de passe aléatoire passé par l’environnement
   (`OPENCODE_SERVER_PASSWORD`), puis enregistrer `GET /openapi.json` (authentification `opencode:<mot de passe>`), sans
   y laisser le mot de passe.
2. `cargo run --manifest-path src-tauri/codegen/Cargo.toml` réécrit les deux fichiers générés ;
   `-- --check` vérifie qu’ils sont à jour.
3. Relancer les scénarios réels, ignorés par défaut :
   `cargo test --manifest-path src-tauri/Cargo.toml --lib agents::tests_reel -- --ignored --nocapture --test-threads 1`.
