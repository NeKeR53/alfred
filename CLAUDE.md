# Alfred

## Design system
- Package : socle-ui 1.14.0 (installé avec yalc, en local ; version : voir package.json)
- Guide pour l'IA, à la version installée : node_modules/socle-ui/ai/AI.md
  (specs dans node_modules/socle-ui/ai/specs/, règles dans node_modules/socle-ui/ai/docs/)
- Dépôt de référence, seulement pour faire évoluer le design : ../app-design/design-system
- Skill : /design

Règles :
- Avant d'écrire de l'UI, lire node_modules/socle-ui/ai/AI.md, puis la spec du composant utilisé.
- Toute UI utilise uniquement les composants, patterns et tokens de socle-ui.
- Ne jamais créer un composant qui en remplace un existant, ni surcharger son style.
- Toute demande d'UI passe d'abord par /design check.
- Si la spec ne prévoit pas ce qui est demandé : répondre « Hors design », ne rien
  implémenter localement, et proposer /design propose.
- Placer les informations selon node_modules/socle-ui/ai/docs/layout-rules.md.
