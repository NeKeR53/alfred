import { useEffect, useState } from "react";
import { Code } from "socle-ui";
import { Stack, Text } from "../../../kit";
import { type MermaidTheme, renderMermaid } from "./mermaid";

function applicationTheme(): MermaidTheme {
  const theme = document.documentElement.dataset.theme;
  if (theme) return theme === "dark" ? "dark" : "light";
  return window.matchMedia?.("(prefers-color-scheme: dark)").matches ? "dark" : "light";
}

/** Schéma Mermaid dans le thème de l’application ; une erreur de syntaxe laisse le texte visible. Repris de OneApp. */
export function MermaidDiagram({ source }: { source: string }) {
  const [theme, setTheme] = useState(applicationTheme);
  const [result, setResult] = useState<{ key: string; svg?: string; error?: string }>();
  const key = `${theme}:${source}`;

  useEffect(() => {
    const observer = new MutationObserver(() => setTheme(applicationTheme()));
    observer.observe(document.documentElement, { attributes: true, attributeFilter: ["data-theme"] });
    return () => observer.disconnect();
  }, []);
  useEffect(() => {
    let active = true;
    renderMermaid(source, theme).then(
      (svg) => {
        if (active) setResult({ key: `${theme}:${source}`, svg });
      },
      (cause) => {
        if (active)
          setResult({
            key: `${theme}:${source}`,
            error: cause instanceof Error ? cause.message : "Syntaxe non reconnue.",
          });
      },
    );
    return () => {
      active = false;
    };
  }, [source, theme]);

  if (result?.key === key && result.svg)
    return (
      <div
        className="mermaid-diagram"
        role="img"
        aria-label="Schéma Mermaid"
        // biome-ignore lint/security/noDangerouslySetInnerHtml: SVG produit par Mermaid en securityLevel strict, qui l’assainit.
        dangerouslySetInnerHTML={{ __html: result.svg }}
      />
    );
  return (
    <Stack gap="sm">
      {result?.key === key && result.error ? (
        <Text tone="muted" size="meta">{`Schéma Mermaid non dessiné : ${result.error}`}</Text>
      ) : null}
      <Code block label="Source du schéma Mermaid">
        {source}
      </Code>
    </Stack>
  );
}
