/** Ce que la `Page` hôte libère en disparaissant, en plus de ses dialogues (les sous-pages ouvertes). */
export const releases = new Set<() => void>();
