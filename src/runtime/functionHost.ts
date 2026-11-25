/**
 * Hôte des fonctions d’un module : un cadre invisible qui charge chaque fonction à la demande et l’exécute avec le
 * même pont que les pages. La coquille lui envoie les appels et reçoit le résultat.
 */
import { emitToShell, onShellEvent, request } from "@alfred/sdk";
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
/** Clé que la coquille remet au cadre pour le code de son module, et de lui seul. */
const moduleKey = params.get("key") ?? "";
const base = new URL(".", import.meta.url).href.replace(/runtime\/$/, "");

/** Code Mode (`alfred run`) : le cadre exécute le code d’un agent, sans module ; voir `src-tauri/src/code_mode.rs`. */
const codeKey = params.get("code");

/** Ligne de console gardée pour l’agent. */
interface LogLine {
  level: string;
  text: string;
}

function logText(value: unknown): string {
  if (typeof value === "string") return value;
  if (value instanceof Error) return value.stack ?? value.message;
  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
}

/**
 * API de Code Mode : `api.module.fonction(entrée)`, `api.call("module/fonction", entrée)`,
 * `api.states.get("module/etat", { params, key })`. Chaque appel est une requête au cœur, qui décide.
 */
function codeApi(): unknown {
  const call = (body: Record<string, unknown>) => request("agentCode.call", body);
  const states = { get: (name: string, options: Record<string, unknown> = {}) => request("agentCode.state", { name, ...options }) };
  return new Proxy(
    {},
    {
      get(_, module) {
        if (typeof module !== "string" || module === "then") return undefined;
        if (module === "call") return (reference: string, input?: unknown) => call({ function: reference, input });
        if (module === "states") return states;
        return new Proxy(
          {},
          {
            get(__, name) {
              if (typeof name !== "string" || name === "then") return undefined;
              return (input?: unknown) => call({ module, name, input });
            },
          },
        );
      },
    },
  );
}

if (codeKey) {
  const logs: LogLine[] = [];
  for (const level of ["log", "info", "warn", "error", "debug"] as const)
    console[level] = (...values: unknown[]) => {
      if (logs.length <= 1000) logs.push({ level, text: values.map(logText).join(" ") });
    };
  onShellEvent("run", (payload) => {
    const run = payload as { run: string; input: unknown };
    void (async () => {
      try {
        const code = (await import(/* @vite-ignore */ `${base}code/${codeKey}/${run.run}`)) as {
          default: (api: unknown, input: unknown) => unknown;
        };
        const output = await code.default(codeApi(), run.input ?? {});
        emitToShell("result", { output: output === undefined ? null : output, logs });
      } catch (error) {
        const known = error as { message?: string; stack?: string; alfredDiagnostics?: unknown };
        emitToShell("result", {
          logs,
          error: { message: known?.message ?? String(error), stack: known?.alfredDiagnostics ?? known?.stack },
        });
      }
    })();
  });
}

onShellEvent("call", (payload) => {
  const call = payload as FunctionCall;
  void (async () => {
    try {
      const module = (await import(
        /* @vite-ignore */ `${base}m/${moduleId}/${moduleKey}/functions/${call.function}?v=${call.revision}`
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
