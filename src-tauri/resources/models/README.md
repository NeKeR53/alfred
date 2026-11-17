# Modèles livrés avec Alfred

`multilingual-e5-small/` contient le modèle de la recherche par le sens. Il n’est pas dans git (470 Mo) :
`pnpm fetch:model` le récupère à une révision figée, en vérifiant chaque empreinte, et `pnpm tauri dev` comme
`pnpm tauri build` le font d’eux-mêmes. Tauri copie ce dossier dans les ressources de l’application.
