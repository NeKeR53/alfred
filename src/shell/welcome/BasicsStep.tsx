import type { ReactNode } from "react";
import { Accordion, Badge, Button, Link, PageSection, Select, Separator } from "socle-ui";
import { ALL_PROVIDERS, checkHarnesses, type Probe, useHarnesses } from "../../features/agent/harness/installed";
import { PROVIDER_LABEL, type Provider } from "../../features/agent/harness/types";
import { describeSource, useModelSource } from "../../features/space/ModelSourceSection";
import { ACCENT_OPTIONS, THEME_OPTIONS, useAppearance } from "../../features/space/SpaceSettings";
import { Row, Stack, Text } from "../../kit";
import { openExternal } from "../../lib/native";
import { notify } from "../notifications";

/** Page d’installation de Claude Code, le premier harnais proposé. Rien ne s’installe depuis l’accueil. */
export const AGENT_INSTALL_URL = "https://code.claude.com/docs/fr/setup";

/** État d’un harnais en une étiquette, comme dans Réglages › Agent. */
function HarnessBadge({ probe }: { probe: Probe | undefined }) {
  if (!probe || probe.status === "loading") return <Badge tone="pending">Vérification…</Badge>;
  if (probe.status === "error") return <Badge>État inconnu</Badge>;
  if (!probe.value.installed) return <Badge>Non installé</Badge>;
  if (probe.value.loggedIn === false) return <Badge tone="pending">Non connecté</Badge>;
  return <Badge tone="success">{probe.value.loggedIn === true ? "Installé et connecté" : "Installé"}</Badge>;
}

/** Harnais installés et connectés, d’après la dernière vérification. */
export function harnessSummary(probes: Partial<Record<Provider, Probe>>): {
  checking: boolean;
  installed: Provider[];
  connected: Provider[];
} {
  const checking = ALL_PROVIDERS.some((provider) => !probes[provider] || probes[provider]?.status === "loading");
  const installed = ALL_PROVIDERS.filter((provider) => {
    const probe = probes[provider];
    return probe?.status === "ready" && probe.value.installed;
  });
  const connected = installed.filter((provider) => {
    const probe = probes[provider];
    return probe?.status === "ready" && probe.value.loggedIn !== false;
  });
  return { checking, installed, connected };
}

function AgentSection() {
  const probes = useHarnesses((state) => state.probes);
  const { checking, installed } = harnessSummary(probes);
  return (
    <PageSection
      title="Agent"
      description="Je m’appuie sur un agent de code installé sur cet ordinateur pour écrire vos pages."
      actions={[
        {
          id: "verifier",
          label: "Vérifier à nouveau",
          primary: true,
          isDisabled: checking,
          onPress: () => void checkHarnesses(),
        },
      ]}
    >
      {checking && installed.length === 0 ? (
        <Row justify="between">
          <Text>Agents de code</Text>
          <HarnessBadge probe={undefined} />
        </Row>
      ) : installed.length > 0 ? (
        <Stack gap="xs">
          {installed.map((provider) => {
            const probe = probes[provider];
            const disconnected = probe?.status === "ready" && probe.value.loggedIn === false;
            return (
              <Stack key={provider} gap="none">
                <Row justify="between">
                  <Text>{PROVIDER_LABEL[provider]}</Text>
                  <HarnessBadge probe={probe} />
                </Row>
                {disconnected ? (
                  <Text size="meta" tone="muted">
                    {`Connectez-vous à ${PROVIDER_LABEL[provider]} dans un terminal pour que je puisse l’utiliser.`}
                  </Text>
                ) : null}
              </Stack>
            );
          })}
        </Stack>
      ) : (
        <Stack gap="xs">
          <Text>Aucun agent n’est installé : Claude Code, Codex ou OpenCode.</Text>
          <Text tone="muted">
            Installez-en un puis connectez-vous dans un terminal ; je le détecterai tout seul.{" "}
            <Link onPress={() => void openExternal(AGENT_INSTALL_URL)}>Comment l’installer</Link>
          </Text>
        </Stack>
      )}
    </PageSection>
  );
}

/** Mode clair ou sombre et couleur d’accent, comme dans Réglages › Apparence. */
function AppearanceBlock() {
  const appearance = useAppearance();
  return (
    <PageSection title="Apparence" description="S’applique tout de suite.">
      <Row gap="md" wrap>
        <Select
          label="Mode"
          width="md"
          value={appearance.scheme}
          options={THEME_OPTIONS}
          onChange={(id) => id && appearance.changeScheme(id)}
        />
        {appearance.hasSpace ? (
          <Select
            label="Couleur d’accent"
            width="md"
            value={appearance.accent}
            options={ACCENT_OPTIONS}
            onChange={(id) =>
              id &&
              void appearance.changeAccent(id).catch((failure) =>
                notify({
                  title: "La couleur d’accent n’a pas été changée",
                  description: failure instanceof Error ? failure.message : String(failure),
                  tone: "error",
                }),
              )
            }
          />
        ) : null}
      </Row>
    </PageSection>
  );
}

/** Le miroir de l’entreprise pour les modèles locaux, replié : la source en une phrase et « Modifier… ». */
function ModelSourceBlock() {
  const { source, error, edit } = useModelSource();
  return (
    <Stack gap="sm">
      <Text tone="muted">
        Si votre entreprise ne laisse pas joindre Hugging Face, indiquez ici l’adresse de son miroir et, au besoin, un
        jeton. Je l’utiliserai pour télécharger les modèles locaux.
      </Text>
      <Text>
        {error ? `La source des modèles n’a pas pu être lue : ${error}` : source ? describeSource(source) : "…"}
      </Text>
      <Row>
        <Button size="sm" isDisabled={!source} onPress={() => void edit()}>
          Modifier la source des modèles…
        </Button>
      </Row>
    </Stack>
  );
}

/**
 * Quelques réglages, sur un seul écran : apparence, agent, réseau d’entreprise (replié) et voix. Tout a une valeur
 * par défaut et s’applique tout de suite ; rien ne se télécharge ni ne s’installe ici.
 */
export function BasicsStep({ footer }: { footer: ReactNode }) {
  return (
    <>
      <Stack gap="md">
        <AppearanceBlock />
        <Separator />
        <AgentSection />
        <Separator />
        <Accordion title="Réseau d’entreprise (facultatif)">
          <ModelSourceBlock />
        </Accordion>
        <Separator />
        <PageSection title="Voix" description="Dicter vos demandes et m’entendre répondre.">
          <Text size="meta" tone="muted">
            Facultatif : vous l’activerez quand vous voudrez, dans Réglages › Voix. Rien n’est téléchargé maintenant.
          </Text>
        </PageSection>
      </Stack>
      {footer}
    </>
  );
}
