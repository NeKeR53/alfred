/**
 * Zones du menu de gauche (`menu.*` du SDK) : les entrées qu’une page, ou une fonction de son module, fait apparaître
 * sous l’entrée de sa section. Rust les garde par espace ; toutes les fenêtres suivent `menuZones:changed`. Les
 * actions d’une entrée vont à la page (événement `menuEntryAction`) ou à une fonction du module.
 */
import { create } from "zustand";
import { invoke, onNativeEvent } from "../lib/native";
import { findPage } from "./navigationLayout";
import { useShell } from "./store";

export type MenuEntryStatus = "ok" | "warning" | "error" | "running" | "waiting";

export interface MenuEntryAction {
  id: string;
  label: string;
  icon: string;
  function?: string;
}

export interface MenuEntry {
  id: string;
  label: string;
  icon?: string;
  color?: string;
  status?: MenuEntryStatus;
  badge?: number;
  /** Autre page du module ouverte au clic (identifiant de page), sinon celle de la zone. */
  page?: string;
  actions?: MenuEntryAction[];
}

export interface MenuZone {
  title?: string;
  order: "page" | "user";
  visible?: number;
  entries: MenuEntry[];
  userOrder?: string[];
}

interface ZoneState {
  /** `module/page` → zone. */
  zones: Record<string, MenuZone>;
}

export const useMenuZones = create<ZoneState>(() => ({ zones: {} }));

let started = false;

/** Lit les zones de l’espace ouvert et les suit ; à appeler une fois au démarrage de la coquille. */
export function startMenuZones() {
  if (started) return;
  started = true;
  const load = () =>
    void invoke<Record<string, MenuZone>>("menuZones.list").then(
      (zones) => useMenuZones.setState({ zones: zones ?? {} }),
      () => useMenuZones.setState({ zones: {} }),
    );
  onNativeEvent("menuZones:changed", (payload) =>
    useMenuZones.setState({ zones: (payload as Record<string, MenuZone> | null) ?? {} }),
  );
  let path = useShell.getState().snapshot?.path;
  if (path) load();
  useShell.subscribe((state) => {
    if (state.snapshot?.path === path) return;
    path = state.snapshot?.path;
    if (path) load();
    else useMenuZones.setState({ zones: {} });
  });
}

/** Entrées dans l’ordre affiché : celui de la page, ou celui choisi par l’utilisateur (les nouvelles à la fin). */
export function orderedEntries(zone: MenuZone): MenuEntry[] {
  const userOrder = zone.userOrder ?? [];
  if (zone.order !== "user" || !userOrder.length) return zone.entries;
  const rank = new Map(userOrder.map((id, index) => [id, index]));
  return zone.entries
    .map((entry, index) => ({ entry, index }))
    .sort(
      (left, right) =>
        (rank.get(left.entry.id) ?? userOrder.length + left.index) -
        (rank.get(right.entry.id) ?? userOrder.length + right.index),
    )
    .map(({ entry }) => entry);
}

/** Déplace une entrée d’un cran (ordre de l’utilisateur) ; faux si elle est déjà au bord. */
export function moveEntry(zonePage: string, zone: MenuZone, id: string, step: -1 | 1): boolean {
  const ids = orderedEntries(zone).map((entry) => entry.id);
  const index = ids.indexOf(id);
  const target = index + step;
  if (index < 0 || target < 0 || target >= ids.length) return false;
  [ids[index], ids[target]] = [ids[target], ids[index]];
  // Affiché tout de suite ; Rust confirme par `menuZones:changed`.
  useMenuZones.setState((state) => ({ zones: { ...state.zones, [zonePage]: { ...zone, userOrder: ids } } }));
  void invoke("menuZones.reorder", { page: zonePage, order: ids }).catch(() => undefined);
  return true;
}

/** Préfixe des zones qui portent les entrées d’une section créée par un module (`section:<module>/<id>`). */
export const SECTION_ZONE = "section:";

/** Zone d’une section créée par un module. */
export const sectionZone = (module: string, id: string) => `${SECTION_ZONE}${module}/${id}`;

/** Module d’une zone : celui de sa page, ou celui de sa section. */
export function zoneModule(zone: string): string {
  return (zone.startsWith(SECTION_ZONE) ? zone.slice(SECTION_ZONE.length) : zone).split("/")[0] ?? "";
}

/**
 * Page ouverte par une entrée : `entry.page` (même module, même copie), sinon la page de la zone ; pour une section
 * créée, sa page. La référence est celle affichée dans le menu (la première copie d’une page déclarée).
 */
export function entryTarget(zonePage: string, entry: MenuEntry): string {
  if (zonePage.startsWith(SECTION_ZONE)) {
    const module = zoneModule(zonePage);
    const id = zonePage.slice(SECTION_ZONE.length + module.length + 1);
    const snapshot = useShell.getState().snapshot;
    const section = snapshot?.createdSections?.find((known) => known.module === module && known.id === id);
    const named = `${module}/${entry.page ?? section?.page ?? ""}`;
    return (snapshot && findPage(snapshot, named)?.page.reference) ?? named;
  }
  if (!entry.page) return zonePage;
  const module = zonePage.split("/")[0];
  const suffix = /@([^@/]*)$/.exec(zonePage)?.[1];
  const named = `${module}/${entry.page}`;
  return suffix && !entry.page.includes("@") ? `${named}@${suffix}` : named;
}

/** Action d’entrée remise à une page : `value` porte le nouveau libellé d’un renommage. */
export interface MenuEntryActionEvent {
  entry: string;
  action: string;
  value?: string;
}

type Signal = () => void;
const listeners = new Map<string, Set<Signal>>();
const pending = new Map<string, MenuEntryActionEvent[]>();

/**
 * Un cadre de page est prévenu qu’une action attend tant qu’il est affiché ; la page la lit alors
 * (`menu.takeActions`). Rien ne se perd entre l’ouverture de la page et le moment où elle écoute.
 */
export function registerEntryActions(page: string, signal: Signal): () => void {
  const set = listeners.get(page) ?? new Set();
  set.add(signal);
  listeners.set(page, set);
  return () => {
    set.delete(signal);
  };
}

/** Range une action pour la page de la zone et prévient ses cadres affichés. */
export function deliverEntryAction(page: string, event: MenuEntryActionEvent) {
  const queue = pending.get(page) ?? [];
  queue.push(event);
  pending.set(page, queue.slice(-20));
  for (const signal of listeners.get(page) ?? []) signal();
}

/** Actions en attente pour la page : rendues une fois, puis oubliées. */
export function takePendingEntryActions(page: string): MenuEntryActionEvent[] {
  const queue = pending.get(page) ?? [];
  pending.delete(page);
  return queue;
}
