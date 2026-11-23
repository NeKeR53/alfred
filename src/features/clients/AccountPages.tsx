/**
 * Pages qui se servent d’un compte, dans sa fiche : un compte est créé une fois par service, et plusieurs pages ou
 * onglets peuvent l’utiliser. Le choix se fait page par page (Réglages → Modules, fiche du module) ; ici, on le lit.
 */
import type { SettingsSection } from "socle-ui";
import { Text } from "../../kit";
import type { Snapshot } from "../../lib/types";
import type { ClientInstanceItem, ClientItem } from "./api";

/** Noms des onglets qui se servent du compte : « Prefect », ou « Prefect › Recette » dans une page à onglets. */
export function accountUsers(snapshot: Snapshot | null | undefined, client: string, instance: string): string[] {
  const references = snapshot?.accountUsage?.[`${client}/${instance}`] ?? [];
  const names: string[] = [];
  for (const section of snapshot?.sections ?? []) {
    for (const page of section.pages) {
      if (!references.includes(page.reference)) continue;
      names.push(section.pages.length > 1 ? `« ${section.label} › ${page.title} »` : `« ${section.label} »`);
    }
  }
  return names;
}

/** « Utilisé par « Prefect » et « Prefect Recette ». », ou que personne ne s’en sert. */
export function usageSentence(names: string[]): string {
  if (names.length === 0) return "Aucune page ne s’en sert.";
  const list = names.length > 1 ? `${names.slice(0, -1).join(", ")} et ${names[names.length - 1]}` : names[0];
  return `Utilisé par ${list}.`;
}

/** Section « Pages de ce compte » sous le formulaire du compte ; `null` pour un service à une seule adresse. */
export function accountPagesSection(
  snapshot: Snapshot | null | undefined,
  client: ClientItem,
  instance: Pick<ClientInstanceItem, "id">,
): SettingsSection | null {
  if (client.simple) return null;
  return {
    id: "account-pages",
    title: "Pages de ce compte",
    description: "Le compte d’une page se choisit dans la fiche de son module.",
    content: <Text tone="muted">{usageSentence(accountUsers(snapshot, client.id, instance.id))}</Text>,
  };
}
