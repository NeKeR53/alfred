/**
 * Accent du cadre d’une page : la coquille transmet le nom choisi par l’utilisateur (`blue`, `teal`…), `SocleProvider`
 * attend une couleur `#rrggbb` (D-012). Chaque teinte reprend celle des entrées de menu, avec un contraste AA sur
 * `--surface` en clair ; Socle calcule la variante sombre et refuse une couleur qui ne passe pas. Une couleur déjà
 * en hexadécimal passe telle quelle.
 */
const ACCENTS: Record<string, string> = {
  steel: "#3d6b7d",
  blue: "#2563c4",
  violet: "#7a45c2",
  pink: "#b33c78",
  red: "#c0392b",
  orange: "#a65a12",
  green: "#2e7a43",
  teal: "#16786f",
};

export function accentColor(accent: string | null | undefined): string | undefined {
  if (!accent) return undefined;
  if (/^#[0-9a-f]{6}$/i.test(accent)) return accent;
  return ACCENTS[accent];
}
