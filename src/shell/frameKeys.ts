/**
 * Clé qui ouvre le code d’un module à son cadre (`/m/<module>/<clé>/…`). Rust la calcule avec un secret du
 * lancement ; la coquille la remet au seul cadre de ce module, qui ne peut donc pas charger le code d’un autre.
 */
import { invoke } from "../lib/native";

const keys = new Map<string, Promise<string>>();

export function frameKey(module: string): Promise<string> {
  let key = keys.get(module);
  if (!key) {
    key = invoke<{ key: string }>("pages.frameKey", { module }).then((result) => result.key);
    keys.set(module, key);
    key.catch(() => keys.delete(module));
  }
  return key;
}
