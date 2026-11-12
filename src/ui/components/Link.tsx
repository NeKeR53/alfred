import { ExternalLink } from "lucide-react";
import type { ButtonHTMLAttributes, MouseEvent, ReactNode } from "react";
import "./content.css";

type LinkProps =
  | {
      /** Adresse affichée au survol et transmise à `onNavigate` : le cadre ne suit jamais un lien de lui-même. */
      href: string;
      /** Reçoit `href` au clic (dans une page : `shell.openExternal` ou `shell.navigate`). */
      onNavigate: (href: string) => void;
      onClick?: never;
      children: ReactNode;
    }
  | ({
      href?: never;
      onNavigate?: never;
      /** Sans `href` : bouton à l’apparence d’un lien, pour une action secondaire dans une phrase. */
      onClick: (event: MouseEvent<HTMLButtonElement>) => void;
      children: ReactNode;
    } & Omit<ButtonHTMLAttributes<HTMLButtonElement>, "onClick" | "className" | "style" | "children">);

const isExternal = (href: string) => /^(https?:|mailto:)/i.test(href);

/**
 * Lien texte, souligné, dans une phrase ou une cellule. Avec `href`, c’est un vrai lien dont `onNavigate` reçoit
 * l’adresse ; une adresse web porte l’icône « ouvre à l’extérieur ». Sans `href`, c’est un bouton d’apparence lien.
 */
export function Link(props: LinkProps) {
  if (props.href !== undefined) {
    const { href, onNavigate, children } = props;
    const external = isExternal(href);
    return (
      <a
        className="ui-link"
        href={href}
        onClick={(event) => {
          event.preventDefault();
          onNavigate(href);
        }}
      >
        {children}
        {external ? (
          <>
            <ExternalLink className="ui-link__icon" size={12} aria-hidden="true" />{" "}
            <span className="sr-only">(s’ouvre hors d’Alfred)</span>
          </>
        ) : null}
      </a>
    );
  }
  const { children, onClick, type = "button", ...rest } = props;
  return (
    <button {...rest} type={type} className="ui-link ui-link--button" onClick={onClick}>
      {children}
    </button>
  );
}
