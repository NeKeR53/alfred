import { createSession as createNativeSession, listNativeModels } from "./native";
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
export { probe } from "./native";
export * from "./types";

/** Ouvre une conversation dans le harnais demandé ; Rust parle son protocole. */
export function createSession(options: SessionOptions): Promise<HarnessSession> {
  return createNativeSession(options);
}

const catalogs = new Map<Provider, Promise<HarnessModel[]>>();

/** Modèles proposés par un harnais ; lu une fois par lancement d’Alfred. */
export function listModels(provider: Provider, cwd: string): Promise<HarnessModel[]> {
  let catalog = catalogs.get(provider);
  if (!catalog) {
    catalog = listNativeModels(provider, cwd);
    catalogs.set(provider, catalog);
    // Un échec (CLI absent, non connecté) ne doit pas rester en cache.
    catalog.catch(() => catalogs.delete(provider));
  }
  return catalog;
}
