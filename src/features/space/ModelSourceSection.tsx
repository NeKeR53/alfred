import {
  Button,
  Dialog,
  FeedbackBanner,
  FormActions,
  FormField,
  Section,
  SelectControl,
  SettingRow,
  SettingRows,
  Stack,
  TextInput,
} from "@alfred/ui";
import { type FormEvent, useCallback, useEffect, useId, useRef, useState } from "react";
import { invoke } from "../../lib/native";
import { DialogHeader } from "../../shell/DialogHeader";
import { notify } from "../../shell/notifications";
import "../vault/settings-dialog.css";

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

function describe(source: ModelSource): string {
  const where =
    source.origin === "setting"
      ? `${source.host}, l’adresse réglée ici${source.hasToken ? ", avec son jeton" : ""}.`
      : source.origin === "env"
        ? `${source.host}, d’après la variable HF_ENDPOINT.`
        : "Hugging Face (huggingface.co).";
  return `${where} Les modèles sont rangés dans le cache Hugging Face (${source.cacheDir}), partagé avec Python.`;
}

/**
 * D’où viennent les modèles locaux (recherche par le sens, décisions) : Hugging Face, ou le miroir de
 * l’entreprise (Artifactory…), avec un jeton facultatif rangé dans le trousseau.
 */
export function ModelSourceSection() {
  const [source, setSource] = useState<ModelSource>();
  const [error, setError] = useState<string>();
  const [editing, setEditing] = useState(false);

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

  return (
    <Section
      title="Source des modèles"
      description="D’où Alfred télécharge les modèles ci-dessus. Une entreprise qui ne laisse pas joindre Hugging Face y met l’adresse de son miroir."
    >
      {error ? (
        <FeedbackBanner
          tone="error"
          appearance="contained"
          action={<Button onClick={() => void load()}>Réessayer</Button>}
        >
          {`La source des modèles n’a pas pu être lue : ${error}`}
        </FeedbackBanner>
      ) : null}
      <SettingRows label="Source des modèles">
        <SettingRow title="Source utilisée" description={source ? describe(source) : "…"}>
          <Button disabled={!source} onClick={() => setEditing(true)}>
            Modifier…
          </Button>
        </SettingRow>
      </SettingRows>
      {editing && source ? (
        <ModelSourceDialog source={source} onClose={() => setEditing(false)} onSaved={setSource} />
      ) : null}
    </Section>
  );
}

type Choice = "huggingface" | "custom";

function ModelSourceDialog({
  source,
  onClose,
  onSaved,
}: {
  source: ModelSource;
  onClose: () => void;
  onSaved: (source: ModelSource) => void;
}) {
  const formId = useId();
  const titleId = useId();
  const dialog = useRef<HTMLDialogElement>(null);
  const [choice, setChoice] = useState<Choice>(source.custom ? "custom" : "huggingface");
  const [endpoint, setEndpoint] = useState(source.custom ?? "");
  const [token, setToken] = useState("");
  const [endpointError, setEndpointError] = useState<string>();
  const [pending, setPending] = useState(false);

  useEffect(() => {
    const element = dialog.current;
    if (element && !element.open) element.showModal();
  }, []);

  // Changer d’adresse sans ressaisir le jeton l’efface : il allait avec l’ancienne.
  const sameEndpoint = endpoint.trim().replace(/\/+$/, "") === (source.custom ?? "");
  const keepsToken = source.hasToken && sameEndpoint;

  const submit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const address = endpoint.trim();
    if (choice === "custom" && !/^https?:\/\/\S+$/i.test(address)) {
      setEndpointError("Saisissez l’adresse du miroir, par exemple https://…/artifactory/api/huggingfaceml/dépôt.");
      return;
    }
    setPending(true);
    try {
      const args =
        choice === "huggingface"
          ? { endpoint: null, token: null }
          : token
            ? { endpoint: address, token }
            : keepsToken
              ? { endpoint: address }
              : { endpoint: address, token: null };
      const saved = await invoke<ModelSource>("models.setSource", args);
      notify({ title: "Source des modèles enregistrée", tone: "success" });
      onSaved(saved);
      dialog.current?.close();
    } catch (failure) {
      if (choice === "custom") setEndpointError(errorMessage(failure));
      else notify({ title: "La source n’a pas été enregistrée", description: errorMessage(failure), tone: "error" });
      setPending(false);
    }
  };

  return (
    <Dialog
      ref={dialog}
      className="settings-dialog"
      aria-labelledby={titleId}
      onCancel={(event) => {
        if (pending) event.preventDefault();
      }}
      onClose={onClose}
    >
      <form id={formId} noValidate onSubmit={submit}>
        <DialogHeader title="Source des modèles" titleId={titleId} dialogRef={dialog} />
        <div className="settings-dialog__body">
          <Stack gap="md">
            <FormField
              label="Source"
              hint={
                choice === "huggingface" && source.envEndpoint
                  ? "La variable HF_ENDPOINT de cet ordinateur s’applique alors."
                  : undefined
              }
            >
              <SelectControl
                value={choice}
                onChange={(event) => {
                  setChoice(event.target.value as Choice);
                  setEndpointError(undefined);
                }}
              >
                <option value="huggingface">Hugging Face (huggingface.co)</option>
                <option value="custom">Miroir de l’entreprise (Artifactory…)</option>
              </SelectControl>
            </FormField>
            {choice === "custom" ? (
              <>
                <FormField
                  label="Adresse"
                  hint="Pour Artifactory : https://<serveur>/artifactory/api/huggingfaceml/<dépôt>."
                  error={endpointError}
                >
                  <TextInput
                    value={endpoint}
                    aria-required="true"
                    autoComplete="off"
                    spellCheck={false}
                    placeholder="https://"
                    onChange={(event) => {
                      setEndpoint(event.target.value);
                      setEndpointError(undefined);
                    }}
                  />
                </FormField>
                <FormField
                  label="Jeton (facultatif)"
                  hint={
                    keepsToken
                      ? "Laisser vide pour conserver le jeton enregistré."
                      : "Rangé dans le trousseau de ce poste ; Alfred ne l’affiche jamais. Sans jeton, HF_TOKEN ou celui de huggingface-cli login s’applique."
                  }
                >
                  <TextInput
                    type="password"
                    value={token}
                    autoComplete="new-password"
                    spellCheck={false}
                    onChange={(event) => setToken(event.target.value)}
                  />
                </FormField>
              </>
            ) : null}
          </Stack>
        </div>
        <footer className="settings-dialog__footer">
          <FormActions
            form={formId}
            submitLabel="Enregistrer"
            pendingLabel="Enregistrement…"
            pending={pending}
            onCancel={() => dialog.current?.close()}
          />
        </footer>
      </form>
    </Dialog>
  );
}
