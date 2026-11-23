import { useCallback, useEffect, useState } from "react";
import { Alert, type SettingsSection, useOpenForm } from "socle-ui";
import { invoke } from "../../lib/native";
import { notify } from "../../shell/notifications";

export interface ModelSource {
  /** Adresse effectivement utilisée. */
  endpoint: string;
  host: string;
  /** D’où elle vient : le réglage d’Alfred, la variable `HF_ENDPOINT`, ou Hugging Face par défaut. */
  origin: "setting" | "env" | "default";
  /** Adresse saisie dans Alfred, s’il y en a une. */
  custom: string | null;
  /** Un jeton est rangé dans le trousseau pour cette adresse (jamais sa valeur). */
  hasToken: boolean;
  envEndpoint: boolean;
  envToken: boolean;
  loginToken: boolean;
  cacheDir: string;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export function describeSource(source: ModelSource): string {
  const where =
    source.origin === "setting"
      ? `${source.host}, l’adresse réglée ici${source.hasToken ? ", avec son jeton" : ""}.`
      : source.origin === "env"
        ? `${source.host}, d’après la variable HF_ENDPOINT.`
        : "Hugging Face (huggingface.co).";
  return `${where} Les modèles sont rangés dans le cache Hugging Face (${source.cacheDir}), partagé avec Python.`;
}

const normalize = (address: string) => address.trim().replace(/\/+$/, "");

/**
 * D’où viennent les modèles locaux (recherche par le sens, décisions) : Hugging Face, ou le miroir de l’entreprise
 * (Artifactory…), avec un jeton facultatif rangé dans le trousseau. `edit` ouvre le formulaire en modale.
 */
export function useModelSource() {
  const [source, setSource] = useState<ModelSource>();
  const [error, setError] = useState<string>();
  const openForm = useOpenForm();

  const load = useCallback(async () => {
    try {
      setSource(await invoke<ModelSource>("models.source"));
      setError(undefined);
    } catch (failure) {
      setError(errorMessage(failure));
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  const edit = async () => {
    if (!source) return;
    await openForm({
      title: "Source des modèles",
      description: source.envEndpoint
        ? "Avec Hugging Face, la variable HF_ENDPOINT de cet ordinateur s’applique."
        : undefined,
      submitLabel: "Enregistrer",
      initialValues: { origin: source.custom ? "custom" : "huggingface", endpoint: source.custom ?? "", token: "" },
      fields: [
        {
          name: "origin",
          type: "select",
          label: "Source",
          isRequired: true,
          options: [
            { id: "huggingface", label: "Hugging Face (huggingface.co)" },
            { id: "custom", label: "Miroir de l’entreprise (Artifactory…)" },
          ],
        },
        {
          name: "endpoint",
          label: "Adresse du miroir",
          type: "url",
          placeholder: "https://",
          autoComplete: "off",
          description: "Pour Artifactory : https://<serveur>/artifactory/api/huggingfaceml/<dépôt>.",
          validate: (value, values) =>
            values.origin === "custom" && !/^https?:\/\/\S+$/i.test(value.trim())
              ? "Saisissez l’adresse du miroir, par exemple https://…/artifactory/api/huggingfaceml/dépôt."
              : null,
        },
        {
          name: "token",
          label: "Jeton",
          type: "password",
          autoComplete: "new-password",
          description: source.hasToken
            ? "Laisser vide pour conserver le jeton enregistré, si l’adresse ne change pas."
            : "Rangé dans le trousseau de ce poste ; Alfred ne l’affiche jamais. Sans jeton, HF_TOKEN ou celui de huggingface-cli login s’applique.",
        },
      ],
      onSubmit: async (values) => {
        const address = normalize(String(values.endpoint ?? ""));
        const token = String(values.token ?? "");
        // Changer d’adresse sans ressaisir le jeton l’efface : il allait avec l’ancienne.
        const keepsToken = source.hasToken && address === (source.custom ?? "");
        const args =
          values.origin !== "custom"
            ? { endpoint: null, token: null }
            : token
              ? { endpoint: address, token }
              : keepsToken
                ? { endpoint: address }
                : { endpoint: address, token: null };
        const saved = await invoke<ModelSource>("models.setSource", args);
        setSource(saved);
        notify({ title: "Source des modèles enregistrée", tone: "success" });
      },
    });
  };

  return { source, error, reload: load, edit };
}

export function useModelSourceSection(description?: string): SettingsSection {
  const { source, error, edit } = useModelSource();
  return {
    id: "model-source",
    title: "Source des modèles",
    description:
      description ??
      "D’où Alfred télécharge les modèles ci-dessus. Une entreprise qui ne laisse pas joindre Hugging Face y met l’adresse de son miroir.",
    settings: [
      {
        id: "source",
        type: "action",
        label: "Source utilisée",
        description: source ? describeSource(source) : "…",
        action: { id: "edit", label: "Modifier…", isDisabled: !source, onPress: edit },
      },
    ],
    content: error ? (
      <Alert announce tone="danger" title="La source des modèles n’a pas pu être lue">
        {error}
      </Alert>
    ) : undefined,
  };
}
