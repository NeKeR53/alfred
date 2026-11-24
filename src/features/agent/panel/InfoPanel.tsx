import type { ReactNode } from "react";
import { List, type ListItemData, type StatusTone } from "socle-ui";

/**
 * Lignes d'une section du suivi des conversations, posées en `content` d'une section de `Drawer` (DESIGN.md,
 * section 6) et rendues par `List` de socle-ui : titre, précision en sous-titre, état en `Badge`, méta à droite.
 */
export type InfoPanelRow = {
  key: string;
  text: string;
  /** Précision de la ligne, en sous-titre. */
  description?: string;
  /** État de la ligne, en `Badge` sur la ligne 2, avec son ton. */
  announcement?: string;
  tone?: StatusTone;
  meta?: string;
  onSelect?: () => void;
  selected?: boolean;
  /** Action au survol, à la place de la méta. */
  action?: { icon: ReactNode; label: string; onPress: () => void };
};

export function InfoPanelRows({ label = "Éléments", rows }: { label?: string; rows: readonly InfoPanelRow[] }) {
  const byKey = new Map(rows.map((row) => [row.key, row]));
  const items: ListItemData[] = rows.map((row) => ({
    id: row.key,
    title: row.text,
    subtitle: row.description,
    meta: row.meta,
    status: row.announcement ? { label: row.announcement, tone: row.tone ?? "neutral" } : undefined,
  }));
  return (
    <List
      label={label}
      items={items}
      selectionMode={rows.some((row) => row.onSelect) ? "single" : "none"}
      selectedKeys={rows.filter((row) => row.selected).map((row) => row.key)}
      onSelectionChange={(keys) => {
        const [key] = [...keys];
        if (key !== undefined) byKey.get(String(key))?.onSelect?.();
      }}
      itemActions={(item) => {
        const action = byKey.get(item.id)?.action;
        return action ? [action] : [];
      }}
    />
  );
}
