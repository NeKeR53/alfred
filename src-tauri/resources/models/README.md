# Modèles livrés avec Alfred

`multilingual-e5-small/` contient le modèle de la recherche par le sens, dans git, sans téléchargement :
`config.json` et `tokenizer.json` sont ici tels quels ; `model.safetensors` (470 Mo, au-delà de ce que GitHub accepte
par fichier) est découpé en morceaux de 45 Mo dans `src-tauri/model-parts/multilingual-e5-small/`, hors de ce dossier
pour que l’installeur ne l’embarque qu’une fois. `pnpm assemble:model` recolle les morceaux ici et vérifie chaque
empreinte ; `pnpm tauri dev` comme `pnpm tauri build` le font d’eux-mêmes. Tauri copie ce dossier dans les ressources
de l’application.
