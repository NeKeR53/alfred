/**
 * Écran de départ de la fenêtre principale. Tant que le démarrage n’est pas fini, rien : sinon l’accueil complet
 * s’afficherait (aucun espace récent encore lu), se marquerait actif et resterait affiché par-dessus l’espace
 * rouvert.
 */
export function startScreen({
  started,
  welcoming,
  snapshotOpen,
  firstRun,
}: {
  started: boolean;
  welcoming: boolean;
  snapshotOpen: boolean;
  firstRun: boolean;
}): "loading" | "welcome" | "short-welcome" | "shell" {
  if (welcoming) return "welcome";
  if (!started) return "loading";
  if (!snapshotOpen && firstRun) return "welcome";
  if (!snapshotOpen) return "short-welcome";
  return "shell";
}
