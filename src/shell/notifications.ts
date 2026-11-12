import { create } from "zustand";

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
}

interface NotificationState {
  items: AppNotification[];
  /** Notifications encore affichées en surimpression. */
  toasts: number[];
  notify: (notification: { title: string; description?: string; tone?: NotificationTone; source?: string }) => void;
  dismissToast: (id: number) => void;
  markAllRead: () => void;
  clear: () => void;
}

let nextId = 1;

export const useNotifications = create<NotificationState>((set) => ({
  items: [],
  toasts: [],
  notify({ title, description, tone = "info", source }) {
    const id = nextId++;
    set((state) => ({
      items: [{ id, title, description, tone, source, at: Date.now(), read: false }, ...state.items].slice(0, 200),
      toasts: [...state.toasts, id],
    }));
    // Une erreur reste affichée jusqu’à ce qu’on la ferme ; le reste s’efface seul.
    if (tone !== "error") {
      setTimeout(() => set((state) => ({ toasts: state.toasts.filter((toast) => toast !== id) })), 5000);
    }
  },
  dismissToast: (id) => set((state) => ({ toasts: state.toasts.filter((toast) => toast !== id) })),
  markAllRead: () => set((state) => ({ items: state.items.map((item) => ({ ...item, read: true })) })),
  clear: () => set({ items: [], toasts: [] }),
}));

export const notify = (notification: Parameters<NotificationState["notify"]>[0]) =>
  useNotifications.getState().notify(notification);
