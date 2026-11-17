/**
 * Bandeau discret en haut d’une page en mode « données d’exemple » : il dit que ce qui s’affiche est un exemple et
 * propose d’en sortir. Hors de ce mode, il ne montre rien.
 */
import { Button, FeedbackBanner } from "@alfred/ui";
import { useState } from "react";
import { setExampleMode, useExampleMode } from "./examples";
import { notify } from "./notifications";

export function ExampleBanner({ module }: { module: string }) {
  const examples = useExampleMode(module);
  const [leaving, setLeaving] = useState(false);
  if (!examples) return null;
  return (
    <FeedbackBanner
      tone="info"
      appearance="bar"
      className="example-banner"
      action={
        <Button
          loading={leaving}
          onClick={() => {
            setLeaving(true);
            setExampleMode(module, false)
              .catch((error: unknown) =>
                notify({
                  title: "Les données d’exemple n’ont pas pu être quittées",
                  description: error instanceof Error ? error.message : String(error),
                  tone: "error",
                }),
              )
              .finally(() => setLeaving(false));
          }}
        >
          Quitter
        </Button>
      }
    >
      <strong>Données d’exemple</strong> · Cette page montre des réponses d’exemple : aucun service n’est appelé.
    </FeedbackBanner>
  );
}
