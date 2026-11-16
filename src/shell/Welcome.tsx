import { Button, FormField, TextInput } from "@alfred/ui";
import { type FormEvent, useState } from "react";
import { inTauri, pickFolder } from "../lib/native";
import { useShell } from "./store";

/** Premier lancement, ou espace fermé : choisir le dossier où vit l’application que l’on construit. */
export function Welcome() {
  const openSpace = useShell((state) => state.openSpace);
  const home = useShell((state) => state.info?.home ?? null);
  const startupError = useShell((state) => state.startupError);
  const separator = home?.includes("\\") ? "\\" : "/";
  const [path, setPath] = useState(home ? `${home}${separator}Alfred` : "");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    if (!path.trim()) return;
    setBusy(true);
    setError(null);
    try {
      await openSpace(path.trim());
    } catch (failure) {
      setError(failure instanceof Error ? failure.message : String(failure));
    } finally {
      setBusy(false);
    }
  };

  return (
    <main className="welcome">
      <div className="welcome__panel">
        <h1>Bonjour, je suis Alfred</h1>
        <p>
          Dites-moi ce dont vous avez besoin et je le mets en place : pages, onglets, panneaux, réglages. Je range tout
          ce que nous créons dans un dossier, votre espace. Choisissez un dossier existant pour l’ouvrir, ou un nouvel
          emplacement pour le créer.
        </p>
        {startupError ? <p role="alert">{startupError}</p> : null}
        <form className="welcome__form" onSubmit={submit}>
          <div className="welcome__path">
            <FormField label="Dossier de l’espace" error={error ?? undefined}>
              <TextInput value={path} onChange={(event) => setPath(event.target.value)} spellCheck={false} required />
            </FormField>
            {inTauri ? (
              <Button
                onClick={async () => {
                  const selected = await pickFolder("Choisir le dossier de l’espace");
                  if (selected) setPath(selected);
                }}
              >
                Parcourir…
              </Button>
            ) : null}
          </div>
          <div>
            <Button type="submit" variant="primary" loading={busy} disabled={!path.trim()}>
              Ouvrir l’espace
            </Button>
          </div>
        </form>
      </div>
    </main>
  );
}
