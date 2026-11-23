import { ImageOff } from "lucide-react";
import type { ReactNode } from "react";

/**
 * Texte à chasse fixe : identifiant, chemin, extrait de code, valeur technique. Chiffres tabulaires. `block` :
 * bloc préformaté qui garde les retours à la ligne et défile horizontalement (joignable au clavier).
 */
export function Code({
  children,
  block = false,
  label = "Extrait de code",
  plain = false,
  strong = false,
}: {
  children: ReactNode;
  block?: boolean;
  /** Nom accessible du bloc (`block` seulement). */
  label?: string;
  /** Sans fond, dans le texte : un conteneur, une version, un nom de variable dans une cellule (comme OneApp). */
  plain?: boolean;
  /** En gras (une version, un nom de variable mis en avant). */
  strong?: boolean;
}) {
  if (!block)
    return (
      <code className={`ui-code${plain ? " ui-code--plain" : ""}${strong ? " ui-code--strong" : ""}`}>{children}</code>
    );
  return (
    // biome-ignore lint/a11y/noNoninteractiveTabindex: un bloc qui défile doit être joignable au clavier (WCAG 2.1.1) ; la région porte son nom.
    <section className="ui-code-block" aria-label={label} tabIndex={0}>
      <pre className="ui-code ui-code--block">
        <code>{children}</code>
      </pre>
    </section>
  );
}

/** Filet de séparation entre deux groupes d’une même section, quand un écart (`gap="lg"`) ne suffit pas. */
export function Divider() {
  return <hr className="ui-divider" />;
}

/**
 * Image fournie par les données ou un fichier (`data:` ou `blob:` ; le cadre ne charge aucune adresse distante).
 * `alt` est obligatoire : une description, ou `""` pour une image purement décorative. Une autre adresse affiche à
 * la place une vignette avec le texte de remplacement.
 */
export function Image({
  src,
  alt,
  size = "md",
  fit = "contain",
}: {
  src: string;
  alt: string;
  /** Largeur maximale : `sm` 120 px, `md` 240 px, `lg` 480 px, `full` toute la largeur. */
  size?: "sm" | "md" | "lg" | "full";
  /** `cover` remplit un cadre carré (vignette), `contain` (défaut) garde l’image entière. */
  fit?: "contain" | "cover";
}) {
  const classes = `ui-image ui-image--${size} ui-image--${fit}`;
  if (!/^(data:image\/|blob:)/i.test(src)) {
    return (
      <span className={`${classes} ui-image--unavailable`} role="img" aria-label={alt || "Image non affichée"}>
        <ImageOff size={16} aria-hidden="true" />
        <span aria-hidden="true">{alt || "Image non affichée"}</span>
      </span>
    );
  }
  return <img className={classes} src={src} alt={alt} decoding="async" />;
}
