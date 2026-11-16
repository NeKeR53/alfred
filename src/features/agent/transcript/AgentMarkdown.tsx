import { Markdown } from "@alfred/ui";
import { memo, useCallback } from "react";
import { followLink } from "../files";
import { agentFileLinks } from "../lib/agentFileLinks";
import { chatImageUrl, isLocalImageReference } from "../lib/chatImages";
import { ImagePreview } from "./ImagePreview";
import { LoadedImage } from "./LoadedImage";
import { MermaidDiagram } from "./MermaidDiagram";
import { useConversationResources } from "./resources";

const plugins = [agentFileLinks];

function renderCode(language: string, text: string) {
  // Un bloc ```mermaid est dessiné, comme dans OneApp.
  return language === "mermaid" ? <MermaidDiagram source={text.trim()} /> : undefined;
}

/**
 * Texte d’un message de la conversation, repris de `MarkdownText` de OneApp : chemins de fichiers cliquables, schémas
 * Mermaid, images `data:`, `https` et images locales de l’espace, agrandissables.
 */
export const AgentMarkdown = memo(function AgentMarkdown({ text, cwd }: { text: string; cwd: string }) {
  const { loadImage } = useConversationResources();
  const onLink = useCallback((href: string) => void followLink(href, cwd), [cwd]);
  const renderImage = useCallback(
    (src: string, alt: string) => {
      if (loadImage && isLocalImageReference(src)) return <LoadedImage reference={src} alt={alt} load={loadImage} />;
      const url = chatImageUrl(src);
      return url ? <ImagePreview src={url} alt={alt || "Image"} /> : <span>{alt || "Image indisponible"}</span>;
    },
    [loadImage],
  );
  return (
    <Markdown remarkPlugins={plugins} onLink={onLink} renderCode={renderCode} renderImage={renderImage}>
      {text}
    </Markdown>
  );
});
