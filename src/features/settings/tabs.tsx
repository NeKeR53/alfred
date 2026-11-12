import type { BuiltInTab } from "../../shell/AppShell";
import { AgentSettings } from "../agentSettings/AgentSettings";
import { ClientsSettings } from "../clients/ClientsSettings";
import { FunctionsSettings } from "../functions/FunctionsSettings";
import { JournalSettings } from "../journal/JournalSettings";
import { ModulesSettings } from "../modules/ModulesSettings";
import { NavigationSettings } from "../navigation/NavigationSettings";
import { SchedulesSettings } from "../schedules/SchedulesSettings";
import { SpaceSettings } from "../space/SpaceSettings";
import { VaultSettings } from "../vault/VaultSettings";
import { WebhooksSettings } from "../webhooks/WebhooksSettings";

/** Onglets intégrés des Réglages, dans l’ordre d’affichage. Les pages de l’espace placées dans les Réglages suivent. */
export const settingsTabs: BuiltInTab[] = [
  { id: "space", label: "Espace", render: () => <SpaceSettings /> },
  { id: "agents", label: "Agents", render: () => <AgentSettings /> },
  { id: "navigation", label: "Navigation", render: () => <NavigationSettings /> },
  { id: "modules", label: "Modules", render: () => <ModulesSettings /> },
  { id: "functions", label: "Fonctions", render: () => <FunctionsSettings /> },
  { id: "clients", label: "Clients", render: () => <ClientsSettings /> },
  { id: "vault", label: "Coffre", render: () => <VaultSettings /> },
  { id: "webhooks", label: "Webhooks", render: () => <WebhooksSettings /> },
  { id: "schedules", label: "Planification", render: () => <SchedulesSettings /> },
  { id: "journal", label: "Journal", render: () => <JournalSettings /> },
];
