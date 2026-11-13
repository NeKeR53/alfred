/**
 * Conversations archivées : masquées de la page Agent, rien n’est effacé. On les retrouve ici, comme les agents
 * archivés de OneApp dans Réglages › Agents, pour les rouvrir ou les remettre dans la liste.
 */

import { Button, EmptyState, List, ListItem, Row, Section } from "@alfred/ui";
import { useEffect } from "react";
import { useShell } from "../../shell/store";
import { PROVIDER_LABEL } from "../agent/harness";
import { useAgents } from "../agent/store";

const day = new Intl.DateTimeFormat("fr-FR", { dateStyle: "medium" });

export function ArchivedConversations() {
  const headers = useAgents((state) => state.headers);
  const ready = useAgents((state) => state.ready);
  const load = useAgents((state) => state.load);
  const unarchive = useAgents((state) => state.unarchive);
  const open = useAgents((state) => state.open);
  const setView = useShell((state) => state.setView);

  useEffect(() => {
    if (!ready) void load().catch(() => undefined);
  }, [ready, load]);

  const archived = headers.filter((header) => header.archived && header.started);

  return (
    <Section
      title="Conversations archivées"
      description="Masquées de la page Agent, sans rien effacer. Les rouvrir les remet dans la liste."
    >
      {archived.length === 0 ? (
        <EmptyState size="compact" title="Aucune conversation archivée" />
      ) : (
        <List label="Conversations archivées">
          {archived.map((header) => (
            <ListItem
              key={header.id}
              title={header.title}
              description={[
                PROVIDER_LABEL[header.provider],
                header.origin ? `depuis ${header.origin.title}` : "",
                day.format(header.updatedAt),
              ]
                .filter(Boolean)
                .join(" · ")}
              trailing={
                <Row gap="xs">
                  <Button onClick={() => void unarchive(header.id)} aria-label={`Désarchiver ${header.title}`}>
                    Désarchiver
                  </Button>
                  <Button
                    variant="primary"
                    aria-label={`Ouvrir ${header.title}`}
                    onClick={async () => {
                      await unarchive(header.id);
                      await open(header.id);
                      setView({ kind: "agent" });
                    }}
                  >
                    Ouvrir
                  </Button>
                </Row>
              }
            />
          ))}
        </List>
      )}
    </Section>
  );
}
