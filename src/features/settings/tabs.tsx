import {
  Activity,
  Bot,
  Boxes,
  FolderOpen,
  KeyRound,
  ListOrdered,
  Mic,
  Palette,
  ScrollText,
  SquareCode,
  Store,
  Workflow,
} from "lucide-react";
import type { BuiltInTab } from "../../shell/types";
import { useAgentSections } from "../agentSettings/AgentSettings";
import { useAutomationsSections } from "../automations/AutomationsSettings";
import { useJournalSections } from "../journal/JournalSettings";
import { useMarketplaceSections } from "../modules/MarketplaceSettings";
import { useModulesSections } from "../modules/ModulesSettings";
import { useNavigationSections } from "../navigation/NavigationSettings";
import { useScriptsSections } from "../scripts/ScriptsSettings";
import { useAppearanceSections, useSpaceSections } from "../space/SpaceSettings";
import { useStatesSections } from "../states/StatesSettings";
import { useVaultSections } from "../vault/VaultSettings";
import { useVoiceSections } from "../voice/VoiceSettings";

const icon = (Icon: typeof Bot) => <Icon size={15} aria-hidden="true" />;

/**
 * Rubriques des Réglages, dans l’ordre de la barre latérale : d’abord celles de l’espace de travail ouvert (Général,
 * la première, sur laquelle les Réglages s’ouvrent : la liste des espaces de travail et l’historique ; puis ses
 * modules installés, le Marketplace d’où en importer, son apparence, son menu, son journal), puis
 * celles d’Alfred, communes à tous les espaces de travail (agent, voix, mots de passe). Tout ce qui appartient à un
 * module (fonctions, services, webhooks, planifications, tâches de fond) se trouve dans la fiche de ce module.
 * Un trait sépare deux groupes ; un titre annonce l’espace de travail et Alfred ; les pages de l’espace de travail
 * placées dans les Réglages suivent.
 */
export const settingsTabs: BuiltInTab[] = [
  {
    id: "space",
    label: "Général",
    group: "espace",
    groupTitle: "Espace de travail",
    icon: icon(FolderOpen),
    useSections: useSpaceSections,
  },
  {
    id: "modules",
    label: "Modules",
    group: "espace",
    icon: icon(Boxes),
    useSections: useModulesSections,
  },
  {
    id: "marketplace",
    label: "Marketplace",
    group: "espace",
    icon: icon(Store),
    useSections: useMarketplaceSections,
  },
  {
    id: "appearance",
    label: "Apparence",
    group: "espace",
    icon: icon(Palette),
    useSections: useAppearanceSections,
  },
  {
    id: "navigation",
    label: "Ordre du menu",
    group: "espace",
    icon: icon(ListOrdered),
    useSections: useNavigationSections,
  },
  {
    id: "automations",
    label: "Automatisations",
    group: "espace",
    icon: icon(Workflow),
    useSections: useAutomationsSections,
    keywords: ["cron", "planning", "webhook", "déclencheur", "script"],
  },
  {
    id: "scripts",
    label: "Scripts de l’agent",
    group: "espace",
    icon: icon(SquareCode),
    useSections: useScriptsSections,
    keywords: ["code mode", "alfred run", "exécution", "script gardé", "fonction"],
  },
  { id: "states", label: "États", group: "espace", icon: icon(Activity), useSections: useStatesSections },
  { id: "journal", label: "Journal", group: "espace", icon: icon(ScrollText), useSections: useJournalSections },
  {
    id: "agents",
    label: "Agent",
    group: "alfred",
    groupTitle: "Alfred",
    icon: icon(Bot),
    useSections: useAgentSections,
  },
  { id: "voice", label: "Voix", group: "alfred", icon: icon(Mic), useSections: useVoiceSections },
  {
    id: "vault",
    label: "Mots de passe et clés",
    group: "alfred",
    icon: icon(KeyRound),
    useSections: useVaultSections,
  },
];

export { openModuleSettings, openSettings } from "./open";
