import type { ReactNode } from "react";
import { List, type ListItemData, type StatusTone } from "socle-ui";
import { Text } from "../../../kit";

/**
 * Contenu des sections du suivi des conversations, posé en `content` d'une section de `Drawer` (DESIGN.md,
 * section 6) : une note courte, ou des lignes rendues par `List` de socle-ui.
 */

/** Ligne d'une section : une entrée de `List`. */
export type InfoPanelRow = {
  key: string;
  /** Visuel à gauche (pastille d'état). */
  glyph?: ReactNode;
  tone?: StatusTone;
  text: string;
  meta?: string;
  onSelect?: () => void;
  selected?: boolean;
  /** Précision de la ligne, en sous-titre avec la variante `detailed`. */
  description?: string;
  /** État de la ligne, montré en Badge sur la ligne 2. */
  announcement?: string;
  /** Action au survol, à la place de la méta. */
  action?: { icon: ReactNode; label: string; onPress: () => void };
};

export function InfoPanelNote({ children }: { children: ReactNode }) {
  return <Text tone="muted">{children}</Text>;
}

/** Lignes d'une section. `detailed` montre la précision de chaque ligne en sous-titre. */
export function InfoPanelRows({
  label = "Éléments",
  rows,
  empty,
  variant = "compact",
}: {
  label?: string;
  rows: readonly InfoPanelRow[];
  empty: ReactNode;
  variant?: "compact" | "detailed";
}) {
  if (!rows.length) return <InfoPanelNote>{empty}</InfoPanelNote>;
  const byKey = new Map(rows.map((row) => [row.key, row]));
  const items: ListItemData[] = rows.map((row) => ({
    id: row.key,
    title: row.text,
    subtitle: variant === "detailed" ? row.description : undefined,
    meta: row.meta,
    status: row.announcement ? { label: row.announcement, tone: row.tone ?? "neutral" } : undefined,
    visual: row.glyph,
  }));
  return (
    <List
      label={label}
      items={items}
      leading={rows.some((row) => row.glyph) ? "icon" : undefined}
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
