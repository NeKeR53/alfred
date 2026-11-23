/**
 * Nom de la personne dans la zone du compte de la sidebar (layout-rules, `sidebar` → `account`) : c'est elle qui
 * utilise l'app, pas l'assistant. Alfred n'a pas de compte en ligne : le nom vient de la session du système, lue dans
 * le dossier personnel que donne `app.info` (`/Users/alexandre`, `C:\Users\alexandre`). Première lettre en
 * majuscule ; « Vous » si le dossier est inconnu.
 */
export function accountName(home: string | null | undefined): string {
  const login = home
    ?.split(/[\\/]+/)
    .filter(Boolean)
    .pop()
    ?.trim();
  if (!login) return "Vous";
  return login.charAt(0).toLocaleUpperCase("fr-FR") + login.slice(1);
}
