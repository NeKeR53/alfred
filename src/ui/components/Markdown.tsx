import type { ComponentProps } from "react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import "./markdown-text.css";

type Plugins = ComponentProps<typeof ReactMarkdown>["remarkPlugins"];

/**
 * Texte Markdown (titres, listes, tableaux, code). Les liens ne naviguent jamais d’eux-mêmes : `onLink` reçoit
 * l’adresse et décide quoi en faire (dans une page : `shell.openExternal`).
 */
export function Markdown({
  children,
  onLink,
  remarkPlugins,
}: {
  children: string;
  onLink?: (href: string) => void;
  /** Extensions de lecture supplémentaires (réservé à la coquille). */
  remarkPlugins?: Plugins;
}) {
  return (
    <div className="markdown-text">
      <ReactMarkdown
        remarkPlugins={[remarkGfm, ...(remarkPlugins ?? [])]}
        // Les chemins de fichiers locaux sont des cibles légitimes : c’est `onLink` qui les traite.
        urlTransform={(url) => url}
        components={{
          a: ({ href, children: label }) => (
            <a
              href={href}
              onClick={(event) => {
                event.preventDefault();
                if (href) onLink?.(href);
              }}
            >
              {label}
            </a>
          ),
          table: ({ children: content }) => (
            <div className="markdown-text__table">
              <table>{content}</table>
            </div>
          ),
          // Une image distante ne se charge pas d’elle-même : son adresse reste un lien.
          img: ({ src, alt }) =>
            typeof src === "string" && src.startsWith("data:image/") ? (
              <img src={src} alt={alt ?? ""} />
            ) : (
              <a
                href={typeof src === "string" ? src : undefined}
                onClick={(event) => {
                  event.preventDefault();
                  if (typeof src === "string") onLink?.(src);
                }}
              >
                {alt || "Image"}
              </a>
            ),
        }}
      >
        {children}
      </ReactMarkdown>
    </div>
  );
}
