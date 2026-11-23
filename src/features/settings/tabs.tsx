import { Bot, Boxes, FolderOpen, KeyRound, ListOrdered, Mic, Palette, ScrollText, Store } from "lucide-react";
import type { BuiltInTab } from "../../shell/types";
import { AgentSettings } from "../agentSettings/AgentSettings";
import { JournalSettings } from "../journal/JournalSettings";
import { MarketplaceSettings } from "../modules/MarketplaceSettings";
import { ModulesSettings } from "../modules/ModulesSettings";
import { NavigationSettings } from "../navigation/NavigationSettings";
import { AppearanceSettings, SpaceSettings } from "../space/SpaceSettings";
import { VaultSettings } from "../vault/VaultSettings";
import { VoiceSettings } from "../voice/VoiceSettings";

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
    render: () => <SpaceSettings />,
  },
  {
    id: "modules",
    label: "Modules",
    group: "espace",
    icon: icon(Boxes),
    render: () => <ModulesSettings />,
  },
  {
    id: "marketplace",
    label: "Marketplace",
    group: "espace",
    icon: icon(Store),
    render: () => <MarketplaceSettings />,
  },
  {
    id: "appearance",
    label: "Apparence",
    group: "espace",
    icon: icon(Palette),
    render: () => <AppearanceSettings />,
  },
  {
    id: "navigation",
    label: "Ordre du menu",
    group: "espace",
    icon: icon(ListOrdered),
    render: () => <NavigationSettings />,
  },
  { id: "journal", label: "Journal", group: "avancé", icon: icon(ScrollText), render: () => <JournalSettings /> },
  {
    id: "agents",
    label: "Agent",
    group: "alfred",
    groupTitle: "Alfred",
    icon: icon(Bot),
    render: () => <AgentSettings />,
  },
  { id: "voice", label: "Voix", group: "alfred", icon: icon(Mic), render: () => <VoiceSettings /> },
  {
    id: "vault",
    label: "Mots de passe et clés",
    group: "alfred",
    icon: icon(KeyRound),
    render: () => <VaultSettings />,
  },
];

export { openModuleSettings, openSettings } from "./open";
