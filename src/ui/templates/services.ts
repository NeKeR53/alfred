import { createContext, useContext, useEffect, useRef } from "react";

/**
 * Ce que les gabarits demandent à Alfred sans que la page s’en charge : notifier, publier la sélection, montrer le
 * panneau, prévenir l’autre cadre d’un changement. L’hôte du cadre (`src/runtime/pageHost.tsx`) branche ces services
 * sur `@alfred/sdk` ; ailleurs (tests, coquille), ils ne font rien.
 */
export interface FrameServices {
  notify(options: { title: string; description?: string; tone?: "info" | "success" | "warning" | "error" }): void;
  publish(selection: unknown): void;
  setPanelVisible(visible: boolean): void;
  /** Ouvre une adresse web ou `mailto:` hors d’Alfred. */
  openExternal(url: string): void;
  /** Message à l’autre cadre de la page (page ↔ panneau). */
  send(message: unknown): void;
  /** Abonnement aux messages de l’autre cadre ; renvoie le désabonnement. */
  onPeer(handler: (message: unknown) => void): () => void;
  /** Abonnement à la sélection publiée par la page (pour un panneau) ; renvoie le désabonnement. */
  onSelection(handler: (selection: unknown) => void): () => void;
  /** Contenu d’un fichier du module, en base64 (`files.read`) : pour `DocumentViewer`. */
  readFile?(id: string): Promise<{ name: string; mime: string; data: string }>;
  /** Ouvre un fichier du module avec l’application du système (`files.open`). */
  openFile?(id: string): Promise<void>;
  /**
   * Place la recherche de la page dans la barre du haut d’Alfred (`useTopBarSearch` du SDK) ; `onQuery` reçoit le
   * texte tapé. Absent hors d’un cadre de page : le gabarit garde alors son champ dans sa barre d’outils.
   */
  topBarSearch?(
    options: { label?: string; placeholder?: string },
    onQuery: (query: string) => void,
  ): { setQuery(query: string): void; dispose(): void };
  /**
   * Place les actions de la page dans la barre du haut d’Alfred (`useTopBarActions` du SDK) : leur description
   * seule ; `onActivate` reçoit l’identifiant choisi. Absent hors d’un cadre de page (panneau, capture, tests).
   */
  topBarActions?(
    descriptors: ReadonlyArray<{
      id: string;
      label: string;
      icon?: string;
      primary?: boolean;
      danger?: boolean;
      disabled?: boolean;
      running?: boolean;
    }>,
    onActivate: (id: string) => void,
  ): { update(descriptors: ReadonlyArray<{ id: string; label: string }>): void; dispose(): void };
  /** État retenu par Alfred pour cette page (`usePageState`) : valeurs au chargement, et enregistrement. */
  state?: { initial: Record<string, unknown>; set(key: string, value: unknown): void };
}

const none: FrameServices = {
  notify: () => undefined,
  publish: () => undefined,
  setPanelVisible: () => undefined,
  openExternal: () => undefined,
  send: () => undefined,
  onPeer: () => () => undefined,
  onSelection: () => () => undefined,
};

export const FrameServicesContext = createContext<FrameServices>(none);

export function useFrameServices() {
  return useContext(FrameServicesContext);
}

/** Message qu’un gabarit envoie à l’autre cadre après une écriture : la liste ou le détail se recharge seul. */
export const CHANGED = { alfred: "changed" } as const;

export function isChanged(message: unknown) {
  return typeof message === "object" && message !== null && (message as { alfred?: unknown }).alfred === "changed";
}

/** Recharge quand l’autre cadre signale une écriture. */
export function useReloadOnPeerChange(reload: () => void) {
  const services = useFrameServices();
  const latest = useRef(reload);
  latest.current = reload;
  useEffect(() => services.onPeer((message) => isChanged(message) && latest.current()), [services]);
}

export function errorMessage(error: unknown) {
  if (error instanceof Error) return error.message;
  return typeof error === "string" ? error : undefined;
}
