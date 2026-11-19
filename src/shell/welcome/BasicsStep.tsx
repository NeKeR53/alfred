import { Button, Disclosure, Link, Section, SettingRow, SettingRows, Spinner, StatusBadge, Text } from "@alfred/ui";
import type { ReactNode } from "react";
import { ALL_PROVIDERS, checkHarnesses, type Probe, useHarnesses } from "../../features/agent/harness/installed";
import { PROVIDER_LABEL, type Provider } from "../../features/agent/harness/types";
import { ModelSourceSection } from "../../features/space/ModelSourceSection";
import { AppearanceSection } from "../../features/space/SpaceSettings";
import { openExternal } from "../../lib/native";
import { useShell } from "../store";

/** Page d’installation de Claude Code, le premier harnais proposé. Rien ne s’installe depuis l’accueil. */
export const AGENT_INSTALL_URL = "https://code.claude.com/docs/fr/setup";

/** État d’un harnais en une étiquette, comme dans Réglages › Agent. */
function HarnessBadge({ probe, label }: { probe: Probe | undefined; label: string }) {
  if (!probe || probe.status === "loading") {
    return (
      <span className="welcome-inline">
        <Spinner label={`Vérification de ${label}`} />
        <Text as="span" tone="muted">
          Vérification…
        </Text>
      </span>
    );
  }
  if (probe.status === "error") return <StatusBadge size="compact">État inconnu</StatusBadge>;
  if (!probe.value.installed)
    return (
      <Text as="span" tone="muted">
        Non installé
      </Text>
    );
  if (probe.value.loggedIn === false)
    return (
      <StatusBadge tone="pending" size="compact">
        Non connecté
      </StatusBadge>
    );
  return (
    <StatusBadge tone="success" size="compact">
      {probe.value.loggedIn === true ? "Installé et connecté" : "Installé"}
    </StatusBadge>
  );
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
  // Seuls les harnais installés sont listés ; sans aucun, deux lignes et le lien d’installation.
  const shown = installed.length > 0 ? installed : [];
  return (
    <Section
      title="Agent"
      description="Je m’appuie sur un agent de code installé sur cet ordinateur pour écrire vos pages."
      actions={
        <Button variant="subtle" disabled={checking} onClick={() => void checkHarnesses()}>
          Vérifier à nouveau
        </Button>
      }
    >
      {checking && installed.length === 0 ? (
        <SettingRows label="Agents">
          <SettingRow title="Agents de code">
            <HarnessBadge probe={undefined} label="vos agents" />
          </SettingRow>
        </SettingRows>
      ) : shown.length > 0 ? (
        <SettingRows label="Agents">
          {shown.map((provider) => (
            <SettingRow
              key={provider}
              title={PROVIDER_LABEL[provider]}
              description={
                probes[provider]?.status === "ready" &&
                (probes[provider] as Extract<Probe, { status: "ready" }>).value.loggedIn === false
                  ? `Connectez-vous à ${PROVIDER_LABEL[provider]} dans un terminal pour que je puisse l’utiliser.`
                  : undefined
              }
            >
              <HarnessBadge probe={probes[provider]} label={PROVIDER_LABEL[provider]} />
            </SettingRow>
          ))}
        </SettingRows>
      ) : (
        <div className="welcome-note">
          <p>Aucun agent n’est installé : Claude Code, Codex ou OpenCode.</p>
          <p>
            Installez-en un puis connectez-vous dans un terminal ; je le détecterai tout seul.{" "}
            <Link href={AGENT_INSTALL_URL} onNavigate={(href) => void openExternal(href)}>
              Comment l’installer
            </Link>
          </p>
        </div>
      )}
    </Section>
  );
}

/**
 * Quelques réglages, sur un seul écran : apparence, agent, réseau d’entreprise (replié) et voix. Tout a une valeur
 * par défaut et s’applique tout de suite ; rien ne se télécharge ni ne s’installe ici.
 */
export function BasicsStep({ footer }: { footer: ReactNode }) {
  const snapshot = useShell((state) => state.snapshot);
  return (
    <>
      <div className="welcome-basics">
        {snapshot ? <AppearanceSection snapshot={snapshot} description="S’applique tout de suite." /> : null}
        <AgentSection />
        <Disclosure className="welcome-disclosure" label="Réseau d’entreprise (facultatif)">
          <ModelSourceSection description="Si votre entreprise ne laisse pas joindre Hugging Face, indiquez ici l’adresse de son miroir et, au besoin, un jeton. Je l’utiliserai pour télécharger les modèles locaux." />
        </Disclosure>
        <Section title="Voix" description="Dicter vos demandes et m’entendre répondre.">
          <p className="welcome-meta">
            Facultatif : vous l’activerez quand vous voudrez, dans Réglages › Voix. Rien n’est téléchargé maintenant.
          </p>
        </Section>
      </div>
      {footer}
    </>
  );
}
