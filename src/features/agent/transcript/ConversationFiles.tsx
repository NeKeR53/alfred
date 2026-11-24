import { Accordion, Button, Card } from "socle-ui";
import { Row, Stack, Text } from "../../../kit";
import { conversationFileName, conversationFilePath, isPdfDocument } from "../lib/conversationFileKinds";
import { PdfPreview } from "./PdfPreview";
import { useConversationResources } from "./resources";

/**
 * Fichier produit ou cité par l’agent, repris de `ConversationFile` de OneApp : une `Card` à son nom, son dossier,
 * l’ouverture avec l’application du système, l’enregistrement d’une copie et l’aperçu d’un PDF.
 */
function ConversationFile({ reference }: { reference: string }) {
  const { files } = useConversationResources();
  const label = conversationFileName(reference);
  const folder = conversationFilePath(reference).split(/[\\/]/).slice(0, -1).join("/");
  return (
    <Card title={label} headingLevel={4}>
      <Stack gap="sm">
        {folder ? (
          <Text tone="muted" size="meta">
            {folder}
          </Text>
        ) : null}
        {files ? (
          <Row gap="sm">
            <Button size="sm" aria-label={`Ouvrir ${label}`} onPress={() => files.open(reference)}>
              Ouvrir
            </Button>
            <Button size="sm" aria-label={`Enregistrer… une copie de ${label}`} onPress={() => files.save(reference)}>
              Enregistrer…
            </Button>
          </Row>
        ) : null}
        {files && isPdfDocument(reference) ? (
          <Accordion title="Aperçu">
            <PdfPreview label={`Aperçu de ${label}`} source={reference} generate={() => files.read(reference)} />
          </Accordion>
        ) : null}
      </Stack>
    </Card>
  );
}

/** Documents produits ou cités par l’agent, montrés sous le message ou sous le tour. */
export function ConversationFiles({ files, label }: { files: readonly string[]; label: string }) {
  const shown = [...new Set(files)];
  if (!shown.length) return null;
  return (
    <section aria-label={label}>
      <Stack gap="sm">
        {shown.map((reference) => (
          <ConversationFile key={reference} reference={reference} />
        ))}
      </Stack>
    </section>
  );
}
