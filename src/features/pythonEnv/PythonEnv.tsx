import { RefreshCw } from "lucide-react";
import { useCallback, useEffect, useState } from "react";
import { Code, type SettingsSection, type StatusTone } from "socle-ui";
import { invoke, onNativeEvent } from "../../lib/native";
import { notify } from "../../shell/notifications";

/** État de l’environnement Python d’un module, tel que le rend `python.envs`. */
export interface PythonEnvStatus {
  module: string;
  status: "ready" | "pending" | "installing" | "failed" | "uv-missing" | "invalid";
  requirements: string[];
  version: string | null;
  message: string | null;
  log: string | null;
  installedAt: string | null;
  python: string | null;
}

interface PythonEnvs {
  uv: boolean;
  envs: PythonEnvStatus[];
}

const STATUS: Record<PythonEnvStatus["status"], { label: string; tone: StatusTone }> = {
  ready: { label: "Prêt", tone: "success" },
  pending: { label: "À installer", tone: "pending" },
  installing: { label: "Installation en cours", tone: "info" },
  failed: { label: "Échec", tone: "danger" },
  "uv-missing": { label: "uv absent", tone: "danger" },
  invalid: { label: "À corriger", tone: "danger" },
};

const dateTime = new Intl.DateTimeFormat("fr-FR", { dateStyle: "medium", timeStyle: "short" });

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** Ce que dit la ligne : l’état en mots, puis les paquets. */
function describe(env: PythonEnvStatus): string {
  const python = env.python ? `Python ${env.python}` : env.version ? `Python ${env.version}` : null;
  const state =
    env.status === "ready"
      ? env.installedAt
        ? `Installé le ${dateTime.format(new Date(env.installedAt))}`
        : "Installé"
      : env.status === "pending"
        ? "S’installe au premier appel d’une fonction Python du module."
        : env.status === "installing"
          ? "Installation des paquets…"
          : env.message;
  return [state, python, env.requirements.length > 0 ? env.requirements.join(", ") : null].filter(Boolean).join(" · ");
}

/**
 * Section « Environnement Python » de la fiche d’un module (Réglages → Modules) : l’état de l’environnement
 * isolé de ses paquets (`python` de son `module.json`), la fin du journal après un échec, et « Réinstaller ».
 * Aucune section pour un module sans paquets Python. `module` absent : aucune fiche ouverte.
 */
export function usePythonEnvSection(module: string | undefined): SettingsSection | null {
  const [envs, setEnvs] = useState<PythonEnvs>();
  const [error, setError] = useState<string>();

  const load = useCallback(async () => {
    try {
      setEnvs(await invoke<PythonEnvs>("python.envs"));
      setError(undefined);
    } catch (failure) {
      setError(errorMessage(failure));
    }
  }, []);

  useEffect(() => {
    if (!module) return;
    void load();
    const stop = onNativeEvent("python:changed", () => void load());
    return stop;
  }, [load, module]);

  const env = envs?.envs.find((candidate) => candidate.module === module);
  if (!module) return null;
  if (!env) {
    return error
      ? { id: "python", title: "Environnement Python", emptyMessage: `L’état n’a pas pu être lu : ${error}` }
      : null;
  }

  const reinstall = async () => {
    try {
      await invoke("python.reinstall", { module });
      await load();
    } catch (problem) {
      notify({ title: "L’environnement n’a pas été réinstallé", description: errorMessage(problem), tone: "error" });
    }
  };
  const canReinstall = env.status !== "installing" && env.status !== "uv-missing" && env.status !== "invalid";

  return {
    id: "python",
    title: "Environnement Python",
    description: "Paquets Python du module, installés à part pour lui avec uv.",
    settings: [
      {
        type: "item",
        id: "python-env",
        label: "Paquets",
        description: describe(env),
        tags: [STATUS[env.status]],
        actions: canReinstall
          ? [
              {
                id: "reinstall",
                label: "Réinstaller",
                icon: <RefreshCw size={16} aria-hidden="true" />,
                onPress: reinstall,
              },
            ]
          : [],
      },
    ],
    content:
      env.status === "failed" && env.log ? (
        <Code block label="Fin du journal d’installation">
          {env.log}
        </Code>
      ) : undefined,
  };
}
