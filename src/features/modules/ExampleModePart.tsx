/**
 * Interrupteur « Données d’exemple » de la fiche d’un module : ses pages s’affichent avec les réponses d’exemple de
 * ses fonctions de connecteur, sans compte et sans appeler aucun service (ses dépendances suivent quand il les
 * appelle). Le réglage reste sur ce poste, hors de l’espace.
 */
import { SwitchControl, Text } from "@alfred/ui";
import { useState } from "react";
import type { ModuleSummary, Snapshot } from "../../lib/types";
import { inExampleMode, setExampleMode } from "../../shell/examples";
import { notify } from "../../shell/notifications";
import { ModulePart } from "./ModulePart";

/** Fonctions de connecteur du module et de ses dépendances, celles qui rendent un exemple dans ce mode. */
function connectors(snapshot: Snapshot, module: ModuleSummary) {
  const reached = new Set([module.id, ...module.requires.map((required) => required.module)]);
  return snapshot.functions.filter((fn) => reached.has(fn.module) && (fn.uses.clients ?? []).length > 0);
}

export function ExampleModePart({ module, snapshot }: { module: ModuleSummary; snapshot: Snapshot }) {
  const [saving, setSaving] = useState(false);
  const functions = connectors(snapshot, module);
  if (functions.length === 0 && module.clients.length === 0) return null;
  const on = inExampleMode(snapshot, module.id);
  const without = functions.filter((fn) => !fn.examples);
  return (
    <ModulePart
      part="examples"
      title="Données d’exemple"
      description="Affichez les pages de ce module sans vous connecter à ses services : ses fonctions rendent des réponses d’exemple et aucune requête ne part vers les services. Ce qui s’enregistre dans les données du module reste réel."
      actions={
        <SwitchControl
          label=""
          aria-label="Données d’exemple"
          checked={on}
          disabled={saving}
          onChange={(event) => {
            const wanted = event.target.checked;
            setSaving(true);
            setExampleMode(module.id, wanted)
              .catch((error: unknown) =>
                notify({
                  title: wanted
                    ? "Les données d’exemple n’ont pas pu être activées"
                    : "Les données d’exemple n’ont pas pu être quittées",
                  description: error instanceof Error ? error.message : String(error),
                  tone: "error",
                }),
              )
              .finally(() => setSaving(false));
          }}
        />
      }
    >
      {without.length > 0 ? (
        <Text size="meta" tone="muted">
          {without.length === 1
            ? `La fonction « ${without[0]?.id} » n’a pas encore d’exemple : demandez-m’en, sinon elle répondra par une erreur.`
            : `${without.length} fonctions n’ont pas encore d’exemple : demandez-m’en, sinon elles répondront par une erreur.`}
        </Text>
      ) : null}
    </ModulePart>
  );
}
