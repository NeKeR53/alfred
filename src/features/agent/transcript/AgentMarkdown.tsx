import { Markdown } from "@alfred/ui";
import { memo, type ReactNode, useCallback } from "react";
import { notify } from "../../../shell/notifications";
import { followLink } from "../files";
import { agentFileLinks, isAgentFileReference } from "../lib/agentFileLinks";
import { chatImageUrl, isLocalImageReference } from "../lib/chatImages";
import { markdownUrl } from "../lib/markdown";
import { ImagePreview } from "./ImagePreview";
import { LoadedImage } from "./LoadedImage";
import { MermaidDiagram } from "./MermaidDiagram";
import { useConversationResources } from "./resources";

const plugins = [agentFileLinks];

function renderCode(language: string, text: string) {
  // Un bloc ```mermaid est dessiné, comme dans OneApp.
  return language === "mermaid" ? <MermaidDiagram source={text.trim()} /> : undefined;
}

function copyError() {
  notify({ title: "Copie impossible", description: "Le presse-papiers est indisponible.", tone: "error" });
}

/**
 * Texte d’un message de la conversation, repris de `MarkdownText` de OneApp : chemins de fichiers cliquables, schémas
 * Mermaid, images `data:`, `https` et images locales de l’espace, agrandissables. Comme OneApp, seuls les liens web et
 * de courriel restent des liens ; une autre adresse reste du texte, et le HTML écrit dans le message est ignoré.
 */
export const AgentMarkdown = memo(function AgentMarkdown({ text, cwd }: { text: string; cwd: string }) {
  const { loadImage } = useConversationResources();
  const onLink = useCallback((href: string) => void followLink(href, cwd), [cwd]);
  const renderLink = useCallback(
    (href: string | undefined, label: ReactNode) => {
      if (href && isAgentFileReference(href))
        return (
          <button type="button" className="markdown-text__file-link" onClick={() => void followLink(href, cwd)}>
            {label}
          </button>
        );
      const url = href ? markdownUrl(href) : undefined;
      if (!url) return <span>{label}</span>;
      return (
        <a
          href={url}
          target="_blank"
          rel="noopener noreferrer"
          onClick={(event) => {
            event.preventDefault();
            void followLink(url, cwd);
          }}
        >
          {label}
        </a>
      );
    },
    [cwd],
  );
  const renderImage = useCallback(
    (src: string, alt: string) => {
      if (loadImage && isLocalImageReference(src)) return <LoadedImage reference={src} alt={alt} load={loadImage} />;
      const url = chatImageUrl(src);
      return url ? <ImagePreview src={url} alt={alt || "Image"} /> : <span>{alt || "Image indisponible"}</span>;
    },
    [loadImage],
  );
  return (
    <Markdown
      remarkPlugins={plugins}
      onLink={onLink}
      renderCode={renderCode}
      renderImage={renderImage}
      renderLink={renderLink}
      onCopyError={copyError}
      skipHtml
      shiftHeadings
    >
      {text}
    </Markdown>
  );
});
