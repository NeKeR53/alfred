/** Remise d’un message de l’utilisateur et horodatage court, montrés au bout de ses actions (`meta` de `ChatMessage`). */
export type Delivery = { startedAt: number; status: "sent" | "pending" | "error" | "cancelled" };

const dateTimeShort = new Intl.DateTimeFormat("fr-FR", { dateStyle: "short", timeStyle: "short" });

export function formatDateTimeShort(value: number): string {
  return dateTimeShort.format(value);
}

export function deliveryLabel(status: Delivery["status"]): string {
  return status === "sent" ? "Envoyé" : status === "pending" ? "En cours" : status === "error" ? "Échec" : "Interrompu";
}
