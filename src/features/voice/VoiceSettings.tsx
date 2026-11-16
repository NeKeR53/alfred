import {
  Button,
  ChoiceButton,
  ChoiceGroup,
  FeedbackBanner,
  Page,
  Section,
  SelectControl,
  SettingRow,
  SettingRows,
  Spinner,
  SwitchControl,
  TextInput,
} from "@alfred/ui";
import { useEffect, useMemo, useState } from "react";
import { inTauri, pickFile } from "../../lib/native";
import { notify } from "../../shell/notifications";
import {
  getVoiceSettings,
  importArgosVoice,
  installAlfredVoice,
  listSystemVoices,
  type SystemVoice,
  saveVoiceSettings,
  type VoiceConfig,
  type VoiceStatus,
} from "./api";
import { useVoice } from "./store";
import "./voice.css";

const LANGUAGES = [
  { value: "fr", label: "Français" },
  { value: "en", label: "Anglais" },
  { value: "auto", label: "Détection automatique" },
];

const SAMPLE = "Bonjour. Je suis Alfred, à votre service.";

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** Champ de chemin : saisie libre, enregistrée en quittant le champ, et sélecteur de fichier dans l’application. */
function PathField({
  label,
  value,
  placeholder,
  onCommit,
}: {
  label: string;
  value: string;
  placeholder?: string;
  onCommit: (value: string) => void;
}) {
  const [draft, setDraft] = useState(value);
  useEffect(() => setDraft(value), [value]);
  return (
    <div className="voice-settings__path">
      <TextInput
        aria-label={label}
        value={draft}
        placeholder={placeholder}
        spellCheck={false}
        onChange={(event) => setDraft(event.target.value)}
        onBlur={() => {
          if (draft.trim() !== value) onCommit(draft.trim());
        }}
      />
      {inTauri ? (
        <Button
          variant="secondary"
          onClick={async () => {
            const picked = await pickFile(label);
            if (picked) onCommit(picked);
          }}
        >
          Choisir…
        </Button>
      ) : null}
    </div>
  );
}

/** Texte de l’enregistrement à cloner, enregistré en quittant le champ. */
function ReferenceText({ value, onCommit }: { value: string; onCommit: (value: string) => void }) {
  const [draft, setDraft] = useState(value);
  useEffect(() => setDraft(value), [value]);
  return (
    <TextInput
      aria-label="Texte de l’enregistrement"
      value={draft}
      onChange={(event) => setDraft(event.target.value)}
      onBlur={() => {
        if (draft.trim() && draft.trim() !== value) onCommit(draft.trim());
      }}
    />
  );
}

/** Réglages › Voix : la dictée (Whisper local) et la lecture à voix haute. */
export function VoiceSettings() {
  const [config, setConfig] = useState<VoiceConfig>();
  const [status, setStatus] = useState<VoiceStatus>();
  const [voices, setVoices] = useState<SystemVoice[]>([]);
  const [loadError, setLoadError] = useState<string>();
  const [trying, setTrying] = useState(false);
  const [installing, setInstalling] = useState(false);
  const read = useVoice((state) => state.read);
  const stopReading = useVoice((state) => state.stopReading);
  const speaking = useVoice((state) => state.speaking);

  useEffect(() => {
    getVoiceSettings()
      .then(setConfig)
      .catch((error) => setLoadError(errorMessage(error)));
    void useVoice.getState().refresh().then(setStatus);
    listSystemVoices()
      .then(setVoices)
      .catch(() => setVoices([]));
  }, []);

  const save = async (next: VoiceConfig) => {
    const previous = config;
    setConfig(next);
    try {
      const saved = await saveVoiceSettings(next);
      setStatus(saved);
      useVoice.setState({ status: saved });
    } catch (error) {
      setConfig(previous);
      notify({
        title: "Le réglage de la voix n’a pas été enregistré",
        description: errorMessage(error),
        tone: "error",
      });
    }
  };

  const takeOverArgos = async () => {
    if (!config) return;
    try {
      const argos = await importArgosVoice();
      // La voix reste celle d’Alfred : seuls la dictée et les fichiers de Kokoro sont repris.
      await save({
        ...argos,
        ttsBackend: config.ttsBackend,
        voice: config.voice,
        rate: config.rate,
        qwenPython: config.qwenPython,
        qwenModel: config.qwenModel,
        qwenReference: config.qwenReference,
        qwenReferenceText: config.qwenReferenceText,
        readReplies: config.readReplies,
        dictation: config.dictation,
        readNotifications: config.readNotifications,
      });
      notify({ title: "Réglages d’Argos repris", description: "Dictée et fichiers de Kokoro.", tone: "success" });
    } catch (error) {
      notify({ title: "Réglages d’Argos non repris", description: errorMessage(error), tone: "error" });
    }
  };

  // Les voix de la langue de la dictée d’abord ; la voix choisie reste proposée même absente de la liste.
  const voiceOptions = useMemo(() => {
    const language = config?.language && config.language !== "auto" ? config.language : "fr";
    const sorted = [...voices].sort(
      (a, b) =>
        Number(!a.language.startsWith(language)) - Number(!b.language.startsWith(language)) ||
        a.label.localeCompare(b.label),
    );
    if (config?.voice && !sorted.some((voice) => voice.id === config.voice))
      sorted.unshift({ id: config.voice, label: config.voice, language: "" });
    return sorted;
  }, [voices, config?.voice, config?.language]);

  if (loadError) return <FeedbackBanner>{`Réglages de la voix indisponibles : ${loadError}`}</FeedbackBanner>;
  if (!config) return <Spinner label="Chargement des réglages de la voix" />;

  const install = async () => {
    setInstalling(true);
    try {
      const installed = await installAlfredVoice();
      setStatus(installed);
      useVoice.setState({ status: installed });
      notify({
        title: "Voix d’Alfred installée",
        description: "Le modèle se charge à la première lecture.",
        tone: "success",
      });
    } catch (error) {
      notify({ title: "Voix d’Alfred non installée", description: errorMessage(error), tone: "error" });
    } finally {
      setInstalling(false);
    }
  };

  /** Bloquer la dictée, lire les notifications : appliqué sans recharger la voix. */
  const setPreference = async (preferences: { dictation?: boolean; readNotifications?: boolean }) => {
    await useVoice.getState().setPreferences(preferences);
    const next = useVoice.getState().status;
    if (next) setStatus(next);
    setConfig((current) => (current ? { ...current, ...preferences } : current));
  };

  const tryVoice = async () => {
    setTrying(true);
    try {
      await read(SAMPLE);
    } finally {
      setTrying(false);
    }
  };

  return (
    <Page width="text">
      <Section
        title="Voix"
        description="Dictée dans la page Agent, lecture des réponses, et voix offerte aux pages de l’espace."
      >
        <SettingRows>
          <SettingRow
            title="Activer la voix"
            description="Activée, la voix d’Alfred se charge au démarrage (≈ 4 Go de mémoire) pour répondre sans attendre. Coupée, rien ne tourne."
          >
            <SwitchControl
              label=""
              aria-label="Activer la voix"
              checked={status?.enabled ?? config.enabled}
              onChange={async (event) => {
                await useVoice.getState().setEnabled(event.target.checked);
                const next = useVoice.getState().status;
                if (next) setStatus(next);
                setConfig((current) => (current ? { ...current, enabled: event.target.checked } : current));
              }}
            />
          </SettingRow>
        </SettingRows>
      </Section>

      <Section
        title="Dictée"
        description="La transcription tourne sur cet ordinateur avec whisper.cpp : rien ne part sur le réseau. Le modèle se charge à la première dictée."
        actions={
          <Button variant="secondary" onClick={() => void takeOverArgos()}>
            Reprendre les réglages d’Argos
          </Button>
        }
      >
        <SettingRows>
          <SettingRow
            title="Autoriser la dictée"
            description="Bloquée, le micro ne s’ouvre plus, ni dans la page Agent ni dans une page de l’espace, même si vous parlez. La lecture à voix haute continue."
          >
            <SwitchControl
              label=""
              aria-label="Autoriser la dictée"
              checked={status?.dictation ?? config.dictation}
              onChange={(event) => void setPreference({ dictation: event.target.checked })}
            />
          </SettingRow>
        </SettingRows>
        {(status?.dictation ?? config.dictation) === false ? (
          <FeedbackBanner tone="info">La dictée est bloquée : aucun micro ne s’ouvre.</FeedbackBanner>
        ) : status?.listenError ? (
          <FeedbackBanner tone="warning">{status.listenError}</FeedbackBanner>
        ) : status ? (
          <FeedbackBanner tone="info">La dictée est prête : bouton micro dans la page Agent.</FeedbackBanner>
        ) : null}
        <SettingRows>
          <SettingRow title="Modèle Whisper" description="Fichier ggml, par exemple ggml-large-v3-turbo.bin.">
            <PathField
              label="Modèle Whisper"
              value={config.whisperModel}
              placeholder="~/models/ggml-large-v3-turbo.bin"
              onCommit={(whisperModel) => void save({ ...config, whisperModel })}
            />
          </SettingRow>
          <SettingRow
            title="Serveur whisper.cpp"
            description="Le programme whisper-server (brew install whisper-cpp), cherché dans le PATH sans dossier."
          >
            <PathField
              label="Serveur whisper.cpp"
              value={config.whisperServer}
              placeholder="whisper-server"
              onCommit={(whisperServer) => void save({ ...config, whisperServer: whisperServer || "whisper-server" })}
            />
          </SettingRow>
          <SettingRow title="Langue" description="La langue dans laquelle vous dictez.">
            <SelectControl
              aria-label="Langue de la dictée"
              value={config.language}
              onChange={(event) => void save({ ...config, language: event.target.value })}
            >
              {LANGUAGES.map((language) => (
                <option key={language.value} value={language.value}>
                  {language.label}
                </option>
              ))}
            </SelectControl>
          </SettingRow>
        </SettingRows>
      </Section>

      <Section
        title="Lecture à voix haute"
        description="La voix d’Alfred est un majordome âgé à la voix grave, générée sur cet ordinateur par Qwen3-TTS."
      >
        {status?.speakError ? (
          <FeedbackBanner tone="warning">
            {config.ttsBackend === "qwen" && !status.qwenInstalled
              ? "La voix d’Alfred n’est pas installée : en attendant, la voix du système parle."
              : status.speakError}
          </FeedbackBanner>
        ) : null}
        <SettingRows>
          <SettingRow
            title="Synthèse"
            description="Alfred : sa voix, sur Mac Apple Silicon ou carte NVIDIA. Kokoro n’a qu’une voix française, féminine."
          >
            <ChoiceGroup label="Synthèse" appearance="segmented">
              {(
                [
                  ["qwen", "Alfred"],
                  ["system", "Système"],
                  ["kokoro", "Kokoro"],
                ] as const
              ).map(([value, label]) => (
                <ChoiceButton
                  key={value}
                  variant="label"
                  selectionMode="radio"
                  label={label}
                  selected={config.ttsBackend === value}
                  onClick={() => void save({ ...config, ttsBackend: value })}
                >
                  {label}
                </ChoiceButton>
              ))}
            </ChoiceGroup>
          </SettingRow>
          {config.ttsBackend === "qwen" ? (
            <>
              <SettingRow
                title="Installation"
                description={
                  status?.qwenInstalled
                    ? "Installée. Le modèle (≈ 4 Go) se charge à la première lecture, puis reste en mémoire."
                    : "Environnement Python de Qwen3-TTS, installé par uv ; le modèle (≈ 4 Go) se télécharge à la première lecture."
                }
              >
                <Button variant="secondary" disabled={installing} onClick={() => void install()}>
                  {installing ? "Installation…" : status?.qwenInstalled ? "Réinstaller" : "Installer"}
                </Button>
              </SettingRow>
              <SettingRow
                title="Voix à cloner"
                description="Un enregistrement de quelques secondes ; vide, la voix du majordome."
              >
                <PathField
                  label="Voix à cloner"
                  value={config.qwenReference ?? ""}
                  placeholder="Voix d’Alfred (majordome)"
                  onCommit={(value) => void save({ ...config, qwenReference: value || null })}
                />
              </SettingRow>
              {config.qwenReference ? (
                <SettingRow title="Texte de l’enregistrement" description="Ce qui est dit, mot pour mot.">
                  <ReferenceText
                    value={config.qwenReferenceText}
                    onCommit={(qwenReferenceText) => void save({ ...config, qwenReferenceText })}
                  />
                </SettingRow>
              ) : null}
            </>
          ) : config.ttsBackend === "system" ? (
            <>
              <SettingRow title="Voix" description="Par défaut, une voix d’homme grave et âgée.">
                <SelectControl
                  aria-label="Voix du système"
                  value={config.voice}
                  onChange={(event) => void save({ ...config, voice: event.target.value })}
                >
                  <option value="">Voix par défaut du système</option>
                  {voiceOptions.map((voice) => (
                    <option key={voice.id} value={voice.id}>
                      {voice.language ? `${voice.label} · ${voice.language}` : voice.label}
                    </option>
                  ))}
                </SelectControl>
              </SettingRow>
              <SettingRow title="Débit" description="En mots par minute ; une diction posée vers 160.">
                <SelectControl
                  aria-label="Débit de la voix"
                  value={String(config.rate)}
                  onChange={(event) => void save({ ...config, rate: Number(event.target.value) })}
                >
                  <option value="0">Celui de la voix</option>
                  {[140, 150, 165, 180, 200, 220].map((rate) => (
                    <option key={rate} value={rate}>
                      {rate} mots par minute
                    </option>
                  ))}
                </SelectControl>
              </SettingRow>
            </>
          ) : (
            <>
              <SettingRow title="Python de Kokoro" description="L’interpréteur où kokoro-onnx est installé.">
                <PathField
                  label="Python de Kokoro"
                  value={config.kokoroPython ?? ""}
                  onCommit={(value) => void save({ ...config, kokoroPython: value || null })}
                />
              </SettingRow>
              <SettingRow title="Modèle Kokoro" description="Fichier kokoro-v1.0.onnx.">
                <PathField
                  label="Modèle Kokoro"
                  value={config.kokoroModel ?? ""}
                  onCommit={(value) => void save({ ...config, kokoroModel: value || null })}
                />
              </SettingRow>
              <SettingRow title="Voix Kokoro" description="Fichier voices-v1.0.bin.">
                <PathField
                  label="Voix Kokoro"
                  value={config.kokoroVoices ?? ""}
                  onCommit={(value) => void save({ ...config, kokoroVoices: value || null })}
                />
              </SettingRow>
            </>
          )}
          <SettingRow title="Essai" description={`« ${SAMPLE} »`}>
            {speaking ? (
              <Button variant="secondary" onClick={() => void stopReading()}>
                Arrêter
              </Button>
            ) : (
              <Button variant="secondary" disabled={trying} onClick={() => void tryVoice()}>
                Écouter un essai
              </Button>
            )}
          </SettingRow>
        </SettingRows>
      </Section>

      <Section
        title="Notifications"
        description="Les notifications envoyées par les pages et les fonctions de l’espace."
      >
        <SettingRows>
          <SettingRow
            title="Lire les notifications à voix haute"
            description="Le titre et le texte de chaque notification sont lus, sauf pendant une dictée ou une autre lecture."
          >
            <SwitchControl
              label=""
              aria-label="Lire les notifications à voix haute"
              checked={status?.readNotifications ?? config.readNotifications}
              onChange={(event) => void setPreference({ readNotifications: event.target.checked })}
            />
          </SettingRow>
        </SettingRows>
      </Section>

      <Section title="Agent" description="La voix dans la page Agent.">
        <SettingRows>
          <SettingRow
            title="Lire les réponses aux demandes dictées"
            description="Une demande tapée n’est jamais lue. Rouvrir le micro coupe la lecture."
          >
            <SwitchControl
              label=""
              aria-label="Lire les réponses aux demandes dictées"
              checked={config.readReplies}
              onChange={(event) => void save({ ...config, readReplies: event.target.checked })}
            />
          </SettingRow>
        </SettingRows>
      </Section>
    </Page>
  );
}
