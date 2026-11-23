import type { NotificationTone as SocleTone } from "socle-ui";
import { create } from "zustand";
import { notifications } from "./socle";

/**
 * Notifications d’Alfred : la file de socle-ui (toasts et centre de notifications de la barre du haut, D-150 à
 * D-158) les affiche. Alfred garde ici l’API de ses modules (`notify`, tons `error`, dédoublonnage, actions) et une
 * copie de l’historique, lue par les badges et les tests.
 */
export type NotificationTone = "info" | "success" | "warning" | "error";

export interface AppNotification {
  id: number;
  title: string;
  description?: string;
  tone: NotificationTone;
  at: number;
  read: boolean;
  /** Origine affichée : page, fonction, webhook ou agent. */
  source?: string;
  /** Action proposée dans la surimpression, par exemple « Annuler » après un archivage. */
  action?: NotificationAction;
  /** Actions supplémentaires (deux au plus en tout), aussi dans la cloche : « Journal », « Ouvrir ». */
  actions?: NotificationAction[];
  /** Reste dans la surimpression jusqu’à ce qu’on la ferme ou qu’on choisisse une action. */
  persistent?: boolean;
  dedupeKey?: string;
}

export interface NotificationAction {
  label: string;
  run: () => void;
}

export interface NotificationInput {
  title: string;
  description?: string;
  tone?: NotificationTone;
  source?: string;
  action?: NotificationAction;
  /** Actions proposées (deux au plus, avec `action`) : la surimpression montre les deux, la cloche les garde. */
  actions?: NotificationAction[];
  /** Durée d’affichage en millisecondes ; `null` : jusqu’à ce qu’on la ferme. Par défaut selon le ton. */
  duration?: number | null;
  /** Reste affichée jusqu’à ce qu’on la ferme (un agent qui attend une réponse) ; équivaut à `duration: null`. */
  persistent?: boolean;
  /** Une notification identique (même clé, ton, titre et texte) remplace la précédente au lieu de s’empiler. */
  dedupeKey?: string;
}

/** Surimpressions visibles en même temps, comme dans OneApp. */
export const maximumVisibleNotifications = 3;

export function notificationDuration(tone: NotificationTone) {
  return tone === "error" || tone === "warning" ? 8_000 : 5_000;
}

interface NotificationState {
  items: AppNotification[];
  /** Notifications encore affichées en surimpression, de la plus ancienne à la plus récente. */
  toasts: number[];
  notify: (notification: NotificationInput) => number;
  dismissToast: (id: number) => void;
  markAllRead: () => void;
  clear: () => void;
}

let nextId = 1;
/** Identifiant de la file Socle de chaque notification d’Alfred encore affichée. */
const socleIds = new Map<number, string>();

const socleTone = (tone: NotificationTone): SocleTone => (tone === "error" ? "danger" : tone);

export const useNotifications = create<NotificationState>((set, get) => {
  const dismissToast = (id: number) => {
    if (!get().toasts.includes(id)) return;
    set((state) => ({ toasts: state.toasts.filter((toast) => toast !== id) }));
    const socleId = socleIds.get(id);
    if (socleId) notifications.dismiss(socleId);
  };
  return {
    items: [],
    toasts: [],
    notify({
      title,
      description,
      tone = "info",
      source,
      action: single,
      actions: more,
      duration,
      persistent,
      dedupeKey,
    }) {
      const actions = [...(single ? [single] : []), ...(more ?? [])].slice(0, 2);
      const [action] = actions;
      const state = get();
      const duplicate = state.items.find(
        (item) =>
          state.toasts.includes(item.id) &&
          item.dedupeKey === dedupeKey &&
          item.tone === tone &&
          item.title === title &&
          item.description === description,
      );
      const id = duplicate?.id ?? nextId++;
      const item: AppNotification = {
        id,
        title,
        description,
        tone,
        source,
        action,
        ...(actions.length > 1 ? { actions: actions.slice(1) } : {}),
        ...(persistent ? { persistent: true } : {}),
        dedupeKey,
        at: Date.now(),
        read: false,
      };
      const toasts = [...state.toasts.filter((toast) => toast !== id), id];
      const hidden = toasts.slice(0, -maximumVisibleNotifications);
      set({
        items: [item, ...state.items.filter((known) => known.id !== id)].slice(0, 200),
        toasts: toasts.slice(-maximumVisibleNotifications),
      });
      for (const old of hidden) dismissToast(old);
      // Une notification identique remplace la précédente : sa ligne du centre aussi.
      const previous = socleIds.get(id);
      if (previous) {
        notifications.dismiss(previous);
        notifications.remove(previous);
      }
      const shown = persistent ? null : duration === undefined ? notificationDuration(tone) : duration;
      socleIds.set(
        id,
        notifications.notify({
          title,
          description,
          tone: socleTone(tone),
          source,
          // Socle ne montre qu’une action par toast (D-155) : la première. La seconde reste dans l’historique.
          action: action ? { label: action.label, onAction: action.run } : undefined,
          // Dans le centre, la ligne ouvre ce que fait la première action (« Ouvrir », « Journal »).
          onOpen: action?.run,
          duration: shown === null ? null : Math.max(5_000, shown),
        }),
      );
      return id;
    },
    dismissToast,
    markAllRead: () => {
      notifications.markAllRead();
      set((state) => ({ items: state.items.map((item) => ({ ...item, read: true })) }));
    },
    clear: () => {
      for (const id of get().toasts) dismissToast(id);
      notifications.clear();
      socleIds.clear();
      set({ items: [], toasts: [] });
    },
  };
});

export const notify = (notification: NotificationInput) => useNotifications.getState().notify(notification);
