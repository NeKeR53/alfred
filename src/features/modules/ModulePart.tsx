import type { ReactNode } from "react";
import { Row, Stack, Text } from "../../kit";

/**
 * Partie titrée (titre `h3`, HTML d’app aux tokens Socle) dans le contenu libre d’une section des Réglages (fiche d’un module) : un titre, une courte phrase,
 * des actions éventuelles à droite, puis ses éléments. Composant local : `SettingsSection` n’a pas de sous-partie
 * titrée dans son contenu libre (voir les manques de la migration). Les parties de la fiche décrites par l’app
 * passent plutôt par une `SettingsSection` à elles ; celle-ci sert aux parties rendues par un autre dossier
 * (synchronisation d’équipe).
 */
export function ModulePart({
  title,
  description,
  actions,
  part,
  children,
}: {
  title: string;
  description?: string;
  actions?: ReactNode;
  /** Nom stable de la partie (`data-part`), pour les tests et la capture. */
  part: string;
  children: ReactNode;
}) {
  return (
    <section data-part={part} aria-label={title}>
      <Stack gap="sm">
        <Row justify="between" wrap>
          <Stack gap="none">
            <h3 className="m-0 font-semibold text-fg text-md">{title}</h3>
            {description ? (
              <Text size="meta" tone="muted">
                {description}
              </Text>
            ) : null}
          </Stack>
          {actions ? <Row gap="sm">{actions}</Row> : null}
        </Row>
        {children}
      </Stack>
    </section>
  );
}
