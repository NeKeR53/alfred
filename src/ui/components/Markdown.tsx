import { Check, Copy } from "lucide-react";
import { type ComponentProps, memo, type ReactNode, useEffect, useMemo, useRef, useState } from "react";
import ReactMarkdown, { type Components } from "react-markdown";
import remarkGfm from "remark-gfm";
import { IconButton } from "./Button";
import "./markdown-text.css";

type Plugins = ComponentProps<typeof ReactMarkdown>["remarkPlugins"];

/** Durée du retour « Bloc copié », comme `copyFeedbackDurationMs` de OneApp. */
const copyFeedbackMs = 2000;

/**
 * Bloc de code avec « Copier le bloc », repris de `MarkdownText` de OneApp. Un échec est signalé à `onCopyError` quand
 * il est fourni (une notification, comme OneApp), sinon par le libellé du bouton.
 */
function CodeBlock({
  text,
  children,
  onCopyError,
}: {
  text: string;
  children: ReactNode;
  onCopyError?: (error: unknown) => void;
}) {
  const [state, setState] = useState<"idle" | "copied" | "failed">("idle");
  const timer = useRef<ReturnType<typeof setTimeout>>(undefined);
  useEffect(() => () => clearTimeout(timer.current), []);
  const label = state === "copied" ? "Bloc copié" : state === "failed" ? "Copie impossible" : "Copier le bloc";
  return (
    <section className="markdown-text__code" aria-label="Bloc de code">
      <div className="markdown-text__code-actions">
        <IconButton
          size="small"
          label={label}
          tooltip={label}
          onClick={async () => {
            try {
              // Le rendu Markdown ajoute un retour final au contenu du bloc.
              await navigator.clipboard.writeText(text.replace(/\n$/, ""));
              setState("copied");
            } catch (error) {
              if (onCopyError) {
                onCopyError(error);
                return;
              }
              setState("failed");
            }
            clearTimeout(timer.current);
            timer.current = setTimeout(() => setState("idle"), copyFeedbackMs);
          }}
        >
          {state === "copied" ? <Check size={14} aria-hidden="true" /> : <Copy size={14} aria-hidden="true" />}
        </IconButton>
      </div>
      {/* biome-ignore lint/a11y/noNoninteractiveTabindex: le code doit défiler au clavier. */}
      <pre tabIndex={0}>{children}</pre>
    </section>
  );
}

/**
 * Texte Markdown (titres, listes, tableaux, code). Les liens ne naviguent jamais d’eux-mêmes : `onLink` reçoit
 * l’adresse et décide quoi en faire (dans une page : `shell.openExternal`). Chaque bloc de code a son bouton
 * « Copier le bloc ».
 */
/** Titres décalés comme `MarkdownText` de OneApp : un `#` devient un intertitre de message, pas un titre de page. */
const compactHeadings: Components = {
  h1: ({ children }) => <h3>{children}</h3>,
  h2: ({ children }) => <h4>{children}</h4>,
  h3: ({ children }) => <h5>{children}</h5>,
  h4: ({ children }) => <h6>{children}</h6>,
  h5: ({ children }) => <h6>{children}</h6>,
  h6: ({ children }) => <h6>{children}</h6>,
};

export const Markdown = memo(function Markdown({
  children,
  onLink,
  remarkPlugins,
  renderCode,
  renderImage,
  renderLink,
  onCopyError,
  skipHtml = false,
  shiftHeadings = false,
}: {
  children: string;
  onLink?: (href: string) => void;
  /** Extensions de lecture supplémentaires (réservé à la coquille). */
  remarkPlugins?: Plugins;
  /** Rendu propre d’un bloc de code selon son langage (un schéma ```mermaid) ; `undefined` garde le bloc. */
  renderCode?: (language: string, text: string) => ReactNode | undefined;
  /** Rendu d’une image ; sans lui, seule une adresse `data:` s’affiche et les autres restent des liens. */
  renderImage?: (src: string, alt: string) => ReactNode;
  /** Rendu d’un lien (hors image) ; `undefined` garde le lien ordinaire transmis à `onLink`. */
  renderLink?: (href: string | undefined, label: ReactNode) => ReactNode | undefined;
  /** Échec de « Copier le bloc » ; sans lui, le bouton affiche « Copie impossible ». */
  onCopyError?: (error: unknown) => void;
  /** Ignore le HTML écrit dans le texte, comme OneApp pour les messages des agents. */
  skipHtml?: boolean;
  /** `#` et `##` deviennent des intertitres (h3, h4…), comme dans les messages de OneApp. */
  shiftHeadings?: boolean;
}) {
  const plugins = useMemo(() => [remarkGfm, ...(remarkPlugins ?? [])], [remarkPlugins]);
  const components = useMemo<Components>(
    () => ({
      ...(shiftHeadings ? compactHeadings : {}),
      a: ({ href, children: label, node }) =>
        // Une image dans un lien s’agrandit d’un clic : le lien ne la capture pas.
        renderImage && node?.children.some((child) => child.type === "element" && child.tagName === "img") ? (
          <span>{label}</span>
        ) : (
          (renderLink?.(href, label) ?? (
            <a
              href={href}
              onClick={(event) => {
                event.preventDefault();
                if (href) onLink?.(href);
              }}
            >
              {label}
            </a>
          ))
        ),
      pre: ({ children: content, node }) => {
        const code = node?.children[0];
        const language =
          code?.type === "element" ? (/language-(\S+)/.exec(String(code.properties?.className ?? ""))?.[1] ?? "") : "";
        const text = code?.type === "element" && code.children[0]?.type === "text" ? code.children[0].value : "";
        const custom = language ? renderCode?.(language, text) : undefined;
        return (
          custom ?? (
            <CodeBlock text={text} onCopyError={onCopyError}>
              {content}
            </CodeBlock>
          )
        );
      },
      table: ({ children: content }) => (
        // biome-ignore lint/a11y/noNoninteractiveTabindex: le tableau large doit défiler au clavier.
        <section className="markdown-text__table" tabIndex={0} aria-label="Tableau">
          <table>{content}</table>
        </section>
      ),
      img: ({ src, alt }) => {
        if (renderImage && typeof src === "string" && src) return renderImage(src, alt ?? "");
        // Une image distante ne se charge pas d’elle-même : son adresse reste un lien.
        return typeof src === "string" && src.startsWith("data:image/") ? (
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
        );
      },
    }),
    [onLink, onCopyError, renderCode, renderImage, renderLink, shiftHeadings],
  );
  return (
    <div className="markdown-text">
      <ReactMarkdown
        remarkPlugins={plugins}
        // Les chemins de fichiers locaux sont des cibles légitimes : c’est `onLink` qui les traite.
        urlTransform={(url) => url}
        components={components}
        skipHtml={skipHtml}
      >
        {children}
      </ReactMarkdown>
    </div>
  );
});
