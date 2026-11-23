import { memo, useCallback, useMemo } from "react";
import { Markdown } from "socle-ui/markdown";
import { followLink } from "../files";
import { fileFromLink, linkAgentFiles } from "../lib/agentFileLinks";
import { chatImageUrl, isLocalImageReference } from "../lib/chatImages";
import { markdownUrl } from "../lib/markdown";
import { ImagePreview } from "./ImagePreview";
import { LoadedImage } from "./LoadedImage";
import { MermaidDiagram } from "./MermaidDiagram";
import { useConversationResources } from "./resources";

function renderCode(language: string, text: string) {
  // Un bloc ```mermaid est dessiné, comme dans OneApp.
  return language === "mermaid" ? <MermaidDiagram source={text.trim()} /> : undefined;
}

/**
 * Texte d’un message de la conversation, repris de `MarkdownText` de OneApp : chemins de fichiers cliquables, schémas
 * Mermaid, images `data:`, `https` et images locales de l’espace, agrandissables. Seuls les liens web, de courriel et
 * de fichier s’ouvrent ; le HTML écrit dans le message est ignoré (`Markdown` de Socle).
 */
export const AgentMarkdown = memo(function AgentMarkdown({ text, cwd }: { text: string; cwd: string }) {
  const { loadImage } = useConversationResources();
  const onLinkPress = useCallback(
    (href: string) => {
      const file = fileFromLink(href);
      if (file) return void followLink(file, cwd);
      const url = markdownUrl(href);
      if (url) void followLink(url, cwd);
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
  const linked = useMemo(() => linkAgentFiles(text), [text]);
  return (
    <Markdown headingLevel={3} onLinkPress={onLinkPress} renderCode={renderCode} renderImage={renderImage}>
      {linked}
    </Markdown>
  );
});
