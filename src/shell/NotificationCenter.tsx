import { AnchoredPanel, Button, EmptyState, IconButton } from "@alfred/ui";
import { Bell, CircleAlert, CircleCheck, Info, TriangleAlert } from "lucide-react";
import { type CSSProperties, useEffect, useState } from "react";
import { createPortal } from "react-dom";
import { Toaster } from "sonner";
import { type AppNotification, maximumVisibleNotifications, useNotifications } from "./notifications";
import "./notification-toasts.css";

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

/** Thème affiché par la racine (`data-theme`), sinon celui du système. */
function readDocumentTheme(): "light" | "dark" {
  return document.documentElement.dataset.theme === "dark" ||
    (!document.documentElement.dataset.theme && window.matchMedia?.("(prefers-color-scheme: dark)").matches)
    ? "dark"
    : "light";
}

/** Thème affiché, suivi en direct : les surimpressions suivent le choix de l’utilisateur. */
function useDocumentTheme(): "light" | "dark" {
  const [theme, setTheme] = useState(readDocumentTheme);
  useEffect(() => {
    const observer = new MutationObserver(() => setTheme(readDocumentTheme()));
    observer.observe(document.documentElement, { attributes: true, attributeFilter: ["data-theme"] });
    return () => observer.disconnect();
  }, []);
  return theme;
}

/** Notifications récentes en surimpression, en bas à droite, comme le `NotificationProvider` de OneApp. */
export function NotificationToasts() {
  const theme = useDocumentTheme();
  return createPortal(
    <Toaster
      className="notification-toaster"
      theme={theme}
      position="bottom-right"
      visibleToasts={maximumVisibleNotifications}
      gap={8}
      offset={16}
      closeButton
      containerAriaLabel="Notifications"
      customAriaLabel="Notifications"
      icons={{
        success: <CircleCheck size={16} />,
        warning: <TriangleAlert size={16} />,
        error: <CircleAlert size={16} />,
        info: <Info size={16} />,
      }}
      style={
        {
          "--normal-bg": "var(--color-bg)",
          "--normal-text": "var(--color-ink)",
          "--normal-border": "var(--line)",
          "--border-radius": "8px",
          "--width": "380px",
        } as CSSProperties
      }
      toastOptions={{
        closeButtonAriaLabel: "Fermer la notification",
        classNames: {
          toast: "notification-toast",
          title: "notification-title",
          description: "notification-description",
          actionButton: "notification-action",
          closeButton: "notification-close",
        },
      }}
    />,
    document.body,
  );
}
