import { AnchoredPanel, Button, EmptyState, IconButton } from "@alfred/ui";
import { Bell, X } from "lucide-react";
import { useState } from "react";
import { type AppNotification, useNotifications } from "./notifications";

const toneLabel: Record<AppNotification["tone"], string> = {
  info: "Information",
  success: "Succès",
  warning: "Avertissement",
  error: "Erreur",
};

function time(at: number) {
  return new Date(at).toLocaleTimeString("fr-FR", { hour: "2-digit", minute: "2-digit" });
}

function NotificationRow({ item }: { item: AppNotification }) {
  return (
    <li className={`notification notification--${item.tone}`}>
      <span className="notification__tone">{toneLabel[item.tone]}</span>
      <strong>{item.title}</strong>
      {item.description ? <p>{item.description}</p> : null}
      <span className="notification__meta">
        {time(item.at)}
        {item.source ? ` · ${item.source}` : ""}
      </span>
    </li>
  );
}

/** Cloche de la barre du haut : nombre de notifications non lues et liste complète. */
export function NotificationBell() {
  const items = useNotifications((state) => state.items);
  const markAllRead = useNotifications((state) => state.markAllRead);
  const clear = useNotifications((state) => state.clear);
  const [anchor, setAnchor] = useState<HTMLElement | null>(null);
  const unread = items.filter((item) => !item.read).length;

  return (
    <>
      <IconButton
        className="notification-bell"
        label={unread > 0 ? `Notifications : ${unread} non lue${unread > 1 ? "s" : ""}` : "Notifications"}
        aria-expanded={anchor !== null}
        onClick={(event) => {
          setAnchor(anchor ? null : event.currentTarget);
          markAllRead();
        }}
      >
        <Bell size={15} aria-hidden="true" />
        {unread > 0 ? <span className="notification-bell__count">{unread > 9 ? "9+" : unread}</span> : null}
      </IconButton>
      {anchor ? (
        <AnchoredPanel
          anchor={anchor}
          label="Notifications"
          className="notification-panel"
          onClose={() => setAnchor(null)}
        >
          <header className="notification-panel__header">
            <h2>Notifications</h2>
            {items.length > 0 ? <Button onClick={clear}>Tout effacer</Button> : null}
          </header>
          {items.length === 0 ? (
            <EmptyState title="Aucune notification" size="compact" />
          ) : (
            <ul className="notification-list">
              {items.map((item) => (
                <NotificationRow key={item.id} item={item} />
              ))}
            </ul>
          )}
        </AnchoredPanel>
      ) : null}
    </>
  );
}

/** Notifications récentes en surimpression, en bas à droite. */
export function NotificationToasts() {
  const items = useNotifications((state) => state.items);
  const toasts = useNotifications((state) => state.toasts);
  const dismiss = useNotifications((state) => state.dismissToast);
  const shown = items.filter((item) => toasts.includes(item.id)).slice(0, 4);
  return (
    <div className="notification-toasts" aria-live="polite">
      {shown.map((item) => (
        <div
          key={item.id}
          className={`notification notification--${item.tone} notification--toast`}
          role={item.tone === "error" ? "alert" : "status"}
        >
          <div>
            <strong>{item.title}</strong>
            {item.description ? <p>{item.description}</p> : null}
          </div>
          {item.action ? (
            <Button
              onClick={() => {
                item.action?.run();
                dismiss(item.id);
              }}
            >
              {item.action.label}
            </Button>
          ) : null}
          <IconButton label="Fermer la notification" size="small" onClick={() => dismiss(item.id)}>
            <X size={14} aria-hidden="true" />
          </IconButton>
        </div>
      ))}
    </div>
  );
}
