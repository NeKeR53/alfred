/**
 * Boîte de la coquille qui affiche une valeur scellée (`secrets.reveal` d’une page) : la page ne reçoit jamais la
 * valeur. La boîte dit d’où elle vient, puis la montre sur « Afficher » ou la copie sur « Copier » ; Alfred note au
 * journal qu’elle a été affichée, sans la valeur. Fermée, la valeur est oubliée.
 */
import { Copy, Eye } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { Button, Code, Modal } from "socle-ui";
import { Stack, Text } from "../../kit";
import { invoke } from "../../lib/native";
import { errorMessage } from "./api";

export interface RevealSubject {
  kind: string;
  module: string;
  reference: string;
}

interface RevealRequest {
  subject: RevealSubject;
  ref: string;
  label?: string;
  /** Qui demande, en clair (« La page « Secrets » (secrets/coffre) »). */
  from: string;
  done: (shown: boolean) => void;
}

const queue: RevealRequest[] = [];
const listeners = new Set<() => void>();

/** Demande l’affichage d’une valeur scellée ; rend vrai si l’utilisateur l’a affichée ou copiée. */
export function requestReveal(request: Omit<RevealRequest, "done">): Promise<boolean> {
  return new Promise((resolve) => {
    queue.push({ ...request, done: resolve });
    for (const listener of listeners) listener();
  });
}

export function SecretRevealHost() {
  const [, setVersion] = useState(0);
  useEffect(() => {
    const listener = () => setVersion((version) => version + 1);
    listeners.add(listener);
    return () => {
      listeners.delete(listener);
    };
  }, []);
  const current = queue[0];
  if (!current) return null;
  return (
    <SecretRevealDialog
      key={current.ref}
      request={current}
      onClose={(shown) => {
        queue.shift();
        current.done(shown);
        setVersion((version) => version + 1);
      }}
    />
  );
}

function SecretRevealDialog({ request, onClose }: { request: RevealRequest; onClose: (shown: boolean) => void }) {
  const [origin, setOrigin] = useState<{ client: string; instance: string } | null>(null);
  const [value, setValue] = useState<string | null>(null);
  const [error, setError] = useState<string>();
  const [copied, setCopied] = useState(false);
  const shown = useRef(false);

  useEffect(() => {
    void invoke<{ client: string; instance: string }>("secrets.describe", {
      subject: request.subject,
      reference: request.ref,
    }).then(setOrigin, (failed) => setError(errorMessage(failed)));
  }, [request]);

  const fetchValue = async () => {
    if (value !== null) return value;
    const result = await invoke<{ value: string }>("secrets.reveal", {
      subject: request.subject,
      reference: request.ref,
      ...(request.label ? { label: request.label } : {}),
    });
    shown.current = true;
    return result.value;
  };

  const show = async () => {
    try {
      setValue(await fetchValue());
    } catch (failed) {
      setError(errorMessage(failed));
    }
  };

  const copy = async () => {
    try {
      await navigator.clipboard.writeText(await fetchValue());
      setCopied(true);
    } catch (failed) {
      setError(errorMessage(failed));
    }
  };

  const name = request.label ? `« ${request.label} »` : "la valeur secrète";
  const close = () => {
    // La valeur n’est gardée nulle part une fois la boîte fermée.
    setValue(null);
    onClose(shown.current);
  };
  return (
    <Modal
      isOpen
      title={`Afficher ${name} ?`}
      onOpenChange={(open) => {
        if (!open) close();
      }}
      footer={
        <>
          <Button icon={<Copy size={16} aria-hidden="true" />} isDisabled={Boolean(error)} onPress={() => void copy()}>
            Copier
          </Button>
          {value === null ? (
            <Button
              variant="primary"
              icon={<Eye size={16} aria-hidden="true" />}
              isDisabled={Boolean(error)}
              onPress={() => void show()}
            >
              Afficher
            </Button>
          ) : (
            <Button variant="primary" onPress={close}>
              Fermer
            </Button>
          )}
        </>
      }
    >
      <Stack gap="md">
        <Text>
          {`${request.from} veut vous montrer ${name}${origin ? `, lue sur le compte ${origin.instance} de ${origin.client}` : ""}. La page ne la voit pas : elle ne s’affiche qu’ici.`}
        </Text>
        {value !== null ? (
          <output aria-label={request.label ?? "Valeur"}>
            <Code block label={request.label ?? "Valeur"}>
              {value}
            </Code>
          </output>
        ) : null}
        {copied ? (
          <Text size="meta" tone="success">
            Copiée dans le presse-papiers.
          </Text>
        ) : null}
        {error ? (
          <div role="alert">
            <Text tone="danger">{error}</Text>
          </div>
        ) : null}
      </Stack>
    </Modal>
  );
}
