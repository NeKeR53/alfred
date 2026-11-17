import { Bot, Boxes, FolderOpen, KeyRound, ListOrdered, Mic, Palette, ScrollText, Store } from "lucide-react";
import type { BuiltInTab } from "../../shell/AppShell";
import { SETTINGS_SECTION } from "../../shell/navigationLayout";
import { useShell } from "../../shell/store";
import { AgentSettings } from "../agentSettings/AgentSettings";
import { JournalSettings } from "../journal/JournalSettings";
import { MarketplaceSettings } from "../modules/MarketplaceSettings";
import { MODULE_FOCUS, ModulesSettings } from "../modules/ModulesSettings";
import { NavigationSettings } from "../navigation/NavigationSettings";
import { AppearanceSettings, SpaceSettings } from "../space/SpaceSettings";
import { VaultSettings } from "../vault/VaultSettings";
import { VoiceSettings } from "../voice/VoiceSettings";

const icon = (Icon: typeof Bot) => <Icon size={15} aria-hidden="true" />;

/**
 * Rubriques des Réglages, dans l’ordre de la barre latérale : d’abord celles de l’espace de travail ouvert (ses
 * modules installés, le Marketplace d’où en importer, son dossier, son apparence, son menu, son journal), puis
 * celles d’Alfred, communes à tous les espaces de travail (agent, voix, mots de passe). Tout ce qui appartient à un
 * module (fonctions, services, webhooks, planifications, tâches de fond) se trouve dans la fiche de ce module.
 * Un trait sépare deux groupes ; un titre annonce l’espace de travail et Alfred ; les pages de l’espace de travail
 * placées dans les Réglages suivent.
 */
export const settingsTabs: BuiltInTab[] = [
  {
    id: "modules",
    label: "Modules",
    group: "espace",
    groupTitle: "Espace de travail",
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
    id: "space",
    label: "Général",
    group: "espace",
    icon: icon(FolderOpen),
    render: () => <SpaceSettings />,
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

/** Ouvre les Réglages sur une rubrique. */
export function openSettings(tab: string) {
  const shell = useShell.getState();
  shell.setView({ kind: "settings" });
  shell.setActiveTab(SETTINGS_SECTION, tab);
}

/** Ouvre la fiche d’un module dans la rubrique Modules. */
export function openModuleSettings(module: string) {
  openSettings("modules");
  useShell.getState().setActiveTab(MODULE_FOCUS, module);
}
