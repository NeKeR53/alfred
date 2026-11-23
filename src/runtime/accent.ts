/**
 * Accent du cadre d’une page : la coquille transmet le nom choisi par l’utilisateur (`blue`, `teal`…), `SocleProvider`
 * attend une couleur `#rrggbb` (D-012). Chaque teinte reprend celle des entrées de menu, avec un contraste AA sur
 * `--surface` en clair ; Socle calcule la variante sombre et refuse une couleur qui ne passe pas. Une couleur déjà
 * en hexadécimal passe telle quelle.
 */
const ACCENTS: Record<string, string> = {
  // biome-ignore lint/plugin: SocleProvider attend l’accent en hexadécimal (D-012).
  steel: "#3d6b7d",
  // biome-ignore lint/plugin: SocleProvider attend l’accent en hexadécimal (D-012).
  blue: "#2563c4",
  // biome-ignore lint/plugin: SocleProvider attend l’accent en hexadécimal (D-012).
  violet: "#7a45c2",
  // biome-ignore lint/plugin: SocleProvider attend l’accent en hexadécimal (D-012).
  pink: "#b33c78",
  // biome-ignore lint/plugin: SocleProvider attend l’accent en hexadécimal (D-012).
  red: "#c0392b",
  // biome-ignore lint/plugin: SocleProvider attend l’accent en hexadécimal (D-012).
  orange: "#a65a12",
  // biome-ignore lint/plugin: SocleProvider attend l’accent en hexadécimal (D-012).
  green: "#2e7a43",
  // biome-ignore lint/plugin: SocleProvider attend l’accent en hexadécimal (D-012).
  teal: "#16786f",
};

export function accentColor(accent: string | null | undefined): string | undefined {
  if (!accent) return undefined;
  if (/^#[0-9a-f]{6}$/i.test(accent)) return accent;
  return ACCENTS[accent];
}
