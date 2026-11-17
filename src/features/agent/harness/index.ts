import { createClaudeSession, listClaudeModels } from "./claude";
import { createCodexSession, listCodexModels } from "./codex";
import { createOpenCodeSession, listOpenCodeModels } from "./opencode";
import type { HarnessModel, HarnessSession, Provider, SessionOptions } from "./types";

export {
  ALL_PROVIDERS,
  checkHarnesses,
  installedOf,
  type Probe,
  usableProvider,
  useHarnesses,
  useInstalledProviders,
} from "./installed";
export { probe } from "./process";
export * from "./types";

/** Ouvre une conversation dans le harnais demandé. */
export function createSession(options: SessionOptions): Promise<HarnessSession> {
  switch (options.provider) {
    case "claude":
      return createClaudeSession(options);
    case "codex":
      return createCodexSession(options);
    case "opencode":
      return createOpenCodeSession(options);
  }
}

const catalogs = new Map<Provider, Promise<HarnessModel[]>>();

/** Modèles proposés par un harnais ; lu une fois par lancement d’Alfred. */
export function listModels(provider: Provider, cwd: string): Promise<HarnessModel[]> {
  let catalog = catalogs.get(provider);
  if (!catalog) {
    catalog =
      provider === "claude"
        ? Promise.resolve(listClaudeModels())
        : provider === "codex"
          ? listCodexModels(cwd)
          : listOpenCodeModels(cwd);
    catalogs.set(provider, catalog);
    // Un échec (CLI absent, non connecté) ne doit pas rester en cache.
    catalog.catch(() => catalogs.delete(provider));
  }
  return catalog;
}
