/**
 * Hôte des fonctions d’un module : un cadre invisible qui charge chaque fonction à la demande et l’exécute avec le
 * même pont que les pages. La coquille lui envoie les appels et reçoit le résultat.
 */
import { emitToShell, onShellEvent } from "@alfred/sdk";
import { sealNetwork } from "./sealNetwork";

sealNetwork();

interface FunctionCall {
  callId: string;
  function: string;
  input: unknown;
  revision: string;
}

const params = new URLSearchParams(window.location.search);
const moduleId = params.get("module") ?? "";
const base = new URL(".", import.meta.url).href.replace(/runtime\/$/, "");

onShellEvent("call", (payload) => {
  const call = payload as FunctionCall;
  void (async () => {
    try {
      const module = (await import(
        /* @vite-ignore */ `${base}m/${moduleId}/functions/${call.function}?v=${call.revision}`
      )) as { default?: (input: unknown) => unknown };
      if (typeof module.default !== "function") {
        throw new Error("La fonction doit être exportée par défaut : `export default async function (input)`.");
      }
      const output = await module.default(call.input);
      emitToShell("result", { callId: call.callId, output: output === undefined ? null : output });
    } catch (error) {
      const known = error as { message?: string; alfredDiagnostics?: unknown; stack?: string };
      emitToShell("result", {
        callId: call.callId,
        error: {
          message: known?.message ?? String(error),
          detail: known?.alfredDiagnostics ?? known?.stack,
        },
      });
    }
  })();
});

emitToShell("ready");
