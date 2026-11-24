import type { ReactNode, RefObject } from "react";
import type { SettingsSection } from "socle-ui";
import type { ResolvedPage } from "../lib/types";
import type { ZoneRow } from "./MenuZone";

/** Affiche une conversation d’agent dans le panneau de droite ; `close` rend la place au panneau de la page. */
export type AgentPanelRenderer = (conversation: string, close: () => void) => ReactNode;

/**
 * Outils de la barre du haut pour la page affichée (« Corriger un élément ») ; `container` est la zone de la page,
 * où l’outil peut poser un calque.
 */
export type PageToolsRenderer = (page: ResolvedPage, container: RefObject<HTMLDivElement | null>) => ReactNode;

/**
 * Rubrique intégrée des Réglages, dessinée par `SettingsPage` de Socle. Elle décrit ses sections par des données
 * (`useSections`, un crochet React appelé seulement quand la rubrique est ouverte). `render` reste le repli : son
 * contenu devient le contenu libre d’une section unique.
 */
export interface BuiltInTab {
  id: string;
  label: string;
  /** Sections de la rubrique (`SettingsSection` de socle-ui) : lignes de réglage, actions, contenu libre. */
  useSections?: () => SettingsSection[];
  /** Repli : contenu libre de la rubrique, en une seule section. */
  render?: () => ReactNode;
  /** Mots de plus pour la recherche des Réglages (D-202). */
  keywords?: string[];
  /** Réglages : icône de l’entrée dans la navigation, 16 px. */
  icon?: ReactNode;
  /** Réglages : groupe de l’entrée ; un trait sépare deux groupes. */
  group?: string;
  /** Réglages : titre affiché au-dessus du groupe, porté par sa première entrée (« Espace de travail », « Alfred »). */
  groupTitle?: string;
}

/** État résumé des conversations de l’agent, affiché sur l’entrée Agent du menu. */
export interface AgentSummary {
  state: "attention" | "working" | "done";
  count: number;
  /** Réponses attendues, conversations au travail et à consulter : le libellé de l’entrée les cite toutes. */
  counts?: { attention: number; working: number; unread: number };
}

/** Zone de la page Agent dans le menu : ses conversations non archivées, sous l’entrée Agent. */
export interface AgentZone {
  rows: ZoneRow[];
  activeId?: string;
  visible?: number;
  onOpen: (id: string) => void;
  onAction: (id: string, action: string, value?: string) => void;
  /** Nouvelle conversation, comme Ctrl+N et la palette : un brouillon vide ouvert est repris plutôt que doublé. */
  onNew?: () => void;
}
