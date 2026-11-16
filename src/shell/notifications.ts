import { toast } from "sonner";
import { create } from "zustand";

/**
 * Notifications d’Alfred, reprises de OneApp (`lib/notifications.ts`, `lib/notificationCenter.ts`,
 * `components/shell/NotificationCenter.tsx`) : surimpressions sonner en bas à droite, quatre au plus, dédoublonnées,
 * durée selon le ton (5 s, 8 s pour une alerte ou une erreur, illimitée sur demande), une action et un bouton de
 * fermeture. Alfred garde en plus l’historique de la cloche de la barre du haut.
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
  /** Durée d’affichage en millisecondes ; `null` : jusqu’à ce qu’on la ferme. Par défaut selon le ton. */
  duration?: number | null;
  /** Reste affichée jusqu’à ce qu’on la ferme (un agent qui attend une réponse) ; équivaut à `duration: null`. */
  persistent?: boolean;
  /** Une notification identique (même clé, ton, titre et texte) remplace la précédente au lieu de s’empiler. */
  dedupeKey?: string;
}

/** Surimpressions visibles en même temps, comme dans OneApp. */
export const maximumVisibleNotifications = 4;

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
const toastId = (id: number) => `alfred-notification-${id}`;

export const useNotifications = create<NotificationState>((set, get) => {
  const dismissToast = (id: number) => {
    if (!get().toasts.includes(id)) return;
    set((state) => ({ toasts: state.toasts.filter((toast) => toast !== id) }));
    toast.dismiss(toastId(id));
  };
  return {
    items: [],
    toasts: [],
    notify({ title, description, tone = "info", source, action, duration, persistent, dedupeKey }) {
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
      for (const old of hidden) toast.dismiss(toastId(old));
      const shown = persistent ? null : duration === undefined ? notificationDuration(tone) : duration;
      const onDismiss = () => dismissToast(id);
      toast[tone](title, {
        id: toastId(id),
        description,
        duration: shown === null ? Number.POSITIVE_INFINITY : shown,
        action: action
          ? {
              label: action.label,
              onClick: () => {
                action.run();
                onDismiss();
              },
            }
          : undefined,
        onDismiss,
        onAutoClose: onDismiss,
      });
      return id;
    },
    dismissToast,
    markAllRead: () => set((state) => ({ items: state.items.map((item) => ({ ...item, read: true })) })),
    clear: () => {
      for (const id of get().toasts) toast.dismiss(toastId(id));
      set({ items: [], toasts: [] });
    },
  };
});

export const notify = (notification: NotificationInput) => useNotifications.getState().notify(notification);
