import {
  Bot,
  Boxes,
  CalendarClock,
  FolderOpen,
  KeyRound,
  ListOrdered,
  Mic,
  Palette,
  ScrollText,
  SquareFunction,
  Webhook,
} from "lucide-react";
import type { BuiltInTab } from "../../shell/AppShell";
import { SETTINGS_SECTION } from "../../shell/navigationLayout";
import { useShell } from "../../shell/store";
import { AgentSettings } from "../agentSettings/AgentSettings";
import { FunctionsSettings } from "../functions/FunctionsSettings";
import { JournalSettings } from "../journal/JournalSettings";
import { MODULE_FOCUS, ModulesSettings } from "../modules/ModulesSettings";
import { NavigationSettings } from "../navigation/NavigationSettings";
import { SchedulesSettings } from "../schedules/SchedulesSettings";
import { AppearanceSettings, SpaceSettings } from "../space/SpaceSettings";
import { VaultSettings } from "../vault/VaultSettings";
import { VoiceSettings } from "../voice/VoiceSettings";
import { WebhooksSettings } from "../webhooks/WebhooksSettings";

const icon = (Icon: typeof Bot) => <Icon size={15} aria-hidden="true" />;

/**
 * Rubriques des Réglages, dans l’ordre de la barre latérale : les modules et l’agent d’abord, puis l’espace, puis
 * les réglages techniques. Un trait sépare deux groupes ; les pages de l’espace placées dans les Réglages suivent.
 */
export const settingsTabs: BuiltInTab[] = [
  { id: "modules", label: "Modules", group: "essentiel", icon: icon(Boxes), render: () => <ModulesSettings /> },
  { id: "agents", label: "Agent", group: "essentiel", icon: icon(Bot), render: () => <AgentSettings /> },
  { id: "voice", label: "Voix", group: "essentiel", icon: icon(Mic), render: () => <VoiceSettings /> },
  {
    id: "space",
    label: "Espace",
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
    id: "vault",
    label: "Mots de passe et clés",
    group: "espace",
    icon: icon(KeyRound),
    render: () => <VaultSettings />,
  },
  {
    id: "navigation",
    label: "Ordre du menu",
    group: "espace",
    icon: icon(ListOrdered),
    render: () => <NavigationSettings />,
  },
  {
    id: "functions",
    label: "Fonctions",
    group: "avancé",
    icon: icon(SquareFunction),
    render: () => <FunctionsSettings />,
  },
  { id: "webhooks", label: "Webhooks", group: "avancé", icon: icon(Webhook), render: () => <WebhooksSettings /> },
  {
    id: "schedules",
    label: "Tâches planifiées",
    group: "avancé",
    icon: icon(CalendarClock),
    render: () => <SchedulesSettings />,
  },
  { id: "journal", label: "Journal", group: "avancé", icon: icon(ScrollText), render: () => <JournalSettings /> },
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
