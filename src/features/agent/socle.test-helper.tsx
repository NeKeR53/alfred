import { type RenderOptions, render as renderBase, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { ReactElement, ReactNode } from "react";
import { createNotifications, SocleProvider } from "socle-ui";
import { expect } from "vitest";
import { AgentPage, ConversationTracking } from "./AgentPage";

/** `render` de Testing Library, dans un `SocleProvider` comme à la racine de l’app (`src/main.tsx`). */
export function render(ui: ReactElement, options?: Omit<RenderOptions, "wrapper">) {
  const notifications = createNotifications();
  const wrapper = ({ children }: { children: ReactNode }) => (
    <SocleProvider density="desktop" notifications={notifications}>
      {children}
    </SocleProvider>
  );
  return renderBase(ui, { ...options, wrapper });
}

/**
 * La page Agent et son suivi des conversations, que l’enveloppe pose dans le panneau de détail de l’AppShell
 * (repère « Détail » de Socle, ici nommé par le suivi).
 */
export function AgentPageWithTracking() {
  return (
    <>
      <AgentPage />
      <aside aria-label="Suivi des conversations">
        <ConversationTracking />
      </aside>
    </>
  );
}

/** Attend que le nom de la conversation ouverte, en tête de la page Agent, soit `name`. */
export async function findConversationTitle(name: string) {
  await waitFor(() => {
    const title = document.querySelector(".agents-page__title");
    expect(title?.textContent?.replace("Modifier « Nom de la conversation »", "").trim()).toBe(name);
  });
}

/** Ouvre le menu « Plus d'actions » de la conversation et choisit `label`. */
export async function chooseConversationAction(label: string) {
  const user = userEvent.setup();
  await user.click(screen.getByRole("button", { name: "Plus d'actions" }));
  await user.click(await screen.findByRole("menuitem", { name: new RegExp(`^${label}`) }));
}
