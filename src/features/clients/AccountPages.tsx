/**
 * Les pages d’un compte : celles que l’utilisateur lui a ajoutées, parmi les pages du module qui sont pour chaque
 * compte de ce service (`perInstance`). Chacune se retire ; « Ajouter une page » propose les autres. Un compte
 * nouveau n’en a aucune : sa fiche l’invite à en ajouter. Le choix part aussitôt, sans attendre « Enregistrer ».
 */
import { Button, MenuButton, MenuItem, Section, SettingRow, SettingRows, Text } from "@alfred/ui";
import { useState } from "react";
import { notify } from "../../shell/notifications";
import { useShell } from "../../shell/store";
import { errorMessage } from "../vault/api";
import { type ClientInstanceItem, type ClientItem, setAccountPages } from "./api";

export function AccountPages({
  client,
  instance,
  created = false,
}: {
  client: ClientItem;
  instance: Pick<ClientInstanceItem, "id" | "label">;
  /** Le compte vient d’être ajouté : la fiche invite à lui ajouter des pages. */
  created?: boolean;
}) {
  const snapshot = useShell((state) => state.snapshot);
  const offered = (snapshot?.accountPages ?? []).filter((page) => page.client === client.id);
  const key = `${client.id}/${instance.id}`;
  const [added, setAdded] = useState<string[]>(() => snapshot?.accounts?.[key] ?? []);
  const [pending, setPending] = useState(false);
  if (offered.length === 0) return null;

  const several = new Set(offered.map((page) => `${page.module}/${page.section}`)).size > 1;
  const name = (page: (typeof offered)[number]) => (several ? `${page.title} · ${page.section}` : page.title);
  const shown = offered.filter((page) => added.includes(page.reference));
  const others = offered.filter((page) => !added.includes(page.reference));
  const account = client.simple ? client.label : `${client.label} — ${instance.label}`;

  const change = async (pages: string[], title: string) => {
    setPending(true);
    try {
      const { accounts } = await setAccountPages(client.id, instance.id, pages);
      setAdded(accounts[key] ?? pages);
      notify({ title, tone: "success" });
    } catch (failure) {
      notify({ title: "Les pages du compte n’ont pas changé", description: errorMessage(failure), tone: "error" });
    } finally {
      setPending(false);
    }
  };
  // Les pages gardent l’ordre du module, quel que soit l’ordre où elles sont ajoutées.
  const withPage = (reference: string) =>
    offered.map((page) => page.reference).filter((known) => known === reference || added.includes(known));

  return (
    <Section
      title="Pages de ce compte"
      description={
        created
          ? "Votre compte est ajouté. Choisissez les pages à montrer pour lui dans le menu."
          : "Les pages du menu qui existent pour ce compte. Retirer une page ne supprime pas ses données."
      }
    >
      {shown.length > 0 ? (
        <SettingRows label={`Pages de ${account}`}>
          {shown.map((page) => (
            <SettingRow key={page.reference} title={name(page)}>
              <Button
                variant="secondary"
                aria-label={`Retirer la page ${page.title}`}
                disabled={pending}
                onClick={() =>
                  void change(
                    added.filter((reference) => reference !== page.reference),
                    `Page « ${page.title} » retirée`,
                  )
                }
              >
                Retirer
              </Button>
            </SettingRow>
          ))}
        </SettingRows>
      ) : (
        <Text tone="muted">Aucune page pour ce compte pour l’instant.</Text>
      )}
      {others.length > 0 ? (
        <div className="service-block__footer">
          <MenuButton label="Ajouter une page" variant={shown.length === 0 ? "primary" : "secondary"} disabled={pending}>
            {others.map((page) => (
              <MenuItem
                key={page.reference}
                onClickCapture={() => void change(withPage(page.reference), `Page « ${page.title} » ajoutée`)}
              >
                {name(page)}
              </MenuItem>
            ))}
          </MenuButton>
        </div>
      ) : null}
    </Section>
  );
}
