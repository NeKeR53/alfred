import { useCallback, useEffect, useMemo, useState } from "react";
import { Alert, type Setting, type SettingsSection, useOpenForm } from "socle-ui";
import { useLastKnown } from "../../shell/lastKnown";
import { notify } from "../../shell/notifications";
import { LoadingRows } from "../space/SpaceSettings";
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
import { pathSetting } from "./PathField";
import { useVoice } from "./store";
import { useWhisperLevelRows } from "./WhisperLevelRows";

const LANGUAGES = [
  { id: "fr", label: "Français" },
  { id: "en", label: "Anglais" },
  { id: "auto", label: "Détection automatique" },
];

const SAMPLE = "Bonjour. Je suis Alfred, à votre service.";

/** Durées proposées pour l’envoi après un silence ; 0 : la dictée se termine au clic. */
const PAUSES = [
  { id: "0", label: "Jamais" },
  { id: "1000", label: "1 seconde" },
  { id: "1500", label: "1,5 seconde" },
  { id: "2000", label: "2 secondes" },
  { id: "3000", label: "3 secondes" },
];

const BACKENDS = [
  { id: "qwen", label: "Alfred" },
  { id: "system", label: "Système" },
  { id: "kokoro", label: "Kokoro" },
];

/** Valeur de la liste pour la voix par défaut du système : un `Select` de Socle n’a pas d’option vide. */
const SYSTEM_DEFAULT = "__system";

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** Sections de la rubrique, dans l’ordre : leurs titres s’affichent avant les réglages. */
const VOICE_SECTIONS = [
  { id: "voice", title: "Voix" },
  { id: "dictation", title: "Dictée" },
  { id: "reading", title: "Lecture à voix haute" },
  { id: "notifications", title: "Notifications" },
  { id: "agent", title: "Agent" },
];

/** Rubrique « Voix » des Réglages : la dictée (Whisper local) et la lecture à voix haute. */
export function useVoiceSections(): SettingsSection[] {
  const [config, setConfig] = useLastKnown<VoiceConfig | undefined>("reglages/voix", undefined);
  const [status, setStatus] = useLastKnown<VoiceStatus | undefined>("reglages/voix-etat", undefined);
  const [voices, setVoices] = useLastKnown<SystemVoice[]>("reglages/voix-systeme", []);
  const [loadError, setLoadError] = useState<string>();
  const read = useVoice((state) => state.read);
  const stopReading = useVoice((state) => state.stopReading);
  const speaking = useVoice((state) => state.speaking);
  const openForm = useOpenForm();

  useEffect(() => {
    getVoiceSettings()
      .then(setConfig)
      .catch((error) => setLoadError(errorMessage(error)));
    void useVoice.getState().refresh().then(setStatus);
    listSystemVoices()
      .then(setVoices)
      .catch(() => setVoices([]));
  }, [setVoices, setConfig, setStatus]);

  // Le niveau de Whisper a changé côté Alfred (choisi, ou téléchargé puis choisi) : réglages et état relus.
  const reloadAfterWhisper = useCallback(() => {
    void getVoiceSettings().then(setConfig);
    void useVoice.getState().refresh().then(setStatus);
  }, [setStatus, setConfig]);

  /** Un échec rejette : la ligne reprend l’ancienne valeur et le signale (D-204). */
  const save = async (next: VoiceConfig) => {
    const previous = config;
    setConfig(next);
    try {
      const saved = await saveVoiceSettings(next);
      setStatus(saved);
      useVoice.setState({ status: saved });
    } catch (error) {
      setConfig(previous);
      throw error;
    }
  };

  /** Pour une action : l’échec est signalé ici. */
  const saveOrReport = (next: VoiceConfig) =>
    save(next).catch((error) =>
      notify({
        title: "Le réglage de la voix n’a pas été enregistré",
        description: errorMessage(error),
        tone: "error",
      }),
    );

  const whisperRows = useWhisperLevelRows({
    onChanged: reloadAfterWhisper,
    onCustom: async (whisperModel) => {
      if (config) await saveOrReport({ ...config, whisperLevel: null, whisperModel });
    },
    openForm,
  });

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

  if (loadError) {
    return [
      {
        id: "error",
        content: (
          <Alert announce tone="danger" title="Réglages de la voix indisponibles">
            {loadError}
          </Alert>
        ),
      },
    ];
  }
  // L’interface d’abord : les titres des sections tout de suite, chacune attend ses réglages.
  if (!config)
    return VOICE_SECTIONS.map((section) => ({
      ...section,
      content: <LoadingRows label={`Chargement : ${section.title}`} rows={2} />,
    }));

  const takeOverArgos = async () => {
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

  const install = async () => {
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
    }
  };

  /** Bloquer la dictée, lire les notifications : appliqué sans recharger la voix. */
  const setPreference = async (preferences: {
    dictation?: boolean;
    readNotifications?: boolean;
    pauseSendMs?: number;
  }) => {
    await useVoice.getState().setPreferences(preferences);
    const next = useVoice.getState().status;
    if (next) setStatus(next);
    setConfig((current) => (current ? { ...current, ...preferences } : current));
  };

  const dictation = status?.dictation ?? config.dictation;
  const path = (
    id: string,
    label: string,
    description: string,
    value: string,
    onCommit: (v: string) => unknown,
    placeholder?: string,
  ) => pathSetting({ id, label, description, value, placeholder, openForm, onCommit });

  const backendRows: Setting[] =
    config.ttsBackend === "qwen"
      ? [
          {
            id: "install",
            type: "action",
            label: "Installation",
            description: status?.qwenInstalled
              ? "Installée. Le modèle (≈ 4 Go) se charge à la première lecture, puis reste en mémoire."
              : "Environnement Python de Qwen3-TTS, installé par uv ; le modèle (≈ 4 Go) se télécharge à la première lecture.",
            action: { id: "install", label: status?.qwenInstalled ? "Réinstaller" : "Installer", onPress: install },
          },
          path(
            "reference",
            "Voix à cloner",
            "Un enregistrement de quelques secondes.",
            config.qwenReference ?? "",
            (value) => saveOrReport({ ...config, qwenReference: value || null }),
            "la voix du majordome",
          ),
          ...(config.qwenReference
            ? [
                {
                  id: "reference-text",
                  type: "text" as const,
                  label: "Texte de l’enregistrement",
                  description: "Ce qui est dit, mot pour mot.",
                  value: config.qwenReferenceText,
                  width: "lg" as const,
                  isRequired: true,
                  onChange: (qwenReferenceText: string) =>
                    save({ ...config, qwenReferenceText: qwenReferenceText.trim() }),
                },
              ]
            : []),
        ]
      : config.ttsBackend === "system"
        ? [
            {
              id: "voice",
              type: "select",
              label: "Voix du système",
              description: "Par défaut, une voix d’homme grave et âgée.",
              value: config.voice || SYSTEM_DEFAULT,
              width: "lg",
              options: [
                { id: SYSTEM_DEFAULT, label: "Voix par défaut du système" },
                ...voiceOptions.map((voice) => ({
                  id: voice.id,
                  label: voice.language ? `${voice.label} · ${voice.language}` : voice.label,
                })),
              ],
              onChange: (voice) => save({ ...config, voice: voice === SYSTEM_DEFAULT ? "" : voice }),
            },
            {
              id: "rate",
              type: "select",
              label: "Débit de la voix",
              description: "En mots par minute ; une diction posée vers 160.",
              value: String(config.rate),
              options: [
                { id: "0", label: "Celui de la voix" },
                ...[140, 150, 165, 180, 200, 220].map((rate) => ({
                  id: String(rate),
                  label: `${rate} mots par minute`,
                })),
              ],
              onChange: (rate) => save({ ...config, rate: Number(rate) }),
            },
          ]
        : [
            path(
              "kokoro-python",
              "Python de Kokoro",
              "L’interpréteur où kokoro-onnx est installé.",
              config.kokoroPython ?? "",
              (value) => saveOrReport({ ...config, kokoroPython: value || null }),
            ),
            path("kokoro-model", "Modèle Kokoro", "Fichier kokoro-v1.0.onnx.", config.kokoroModel ?? "", (value) =>
              saveOrReport({ ...config, kokoroModel: value || null }),
            ),
            path("kokoro-voices", "Voix Kokoro", "Fichier voices-v1.0.bin.", config.kokoroVoices ?? "", (value) =>
              saveOrReport({ ...config, kokoroVoices: value || null }),
            ),
          ];

  return [
    {
      id: "voice",
      title: "Voix",
      description: "Dictée dans la page Agent, lecture des réponses, et voix offerte aux pages de l’espace de travail.",
      settings: [
        {
          id: "enabled",
          type: "switch",
          label: "Activer la voix",
          description:
            "Activée, la voix d’Alfred se charge au démarrage (≈ 4 Go de mémoire) pour répondre sans attendre. Coupée, rien ne tourne.",
          value: status?.enabled ?? config.enabled,
          onChange: async (enabled) => {
            await useVoice.getState().setEnabled(enabled);
            const next = useVoice.getState().status;
            if (next) setStatus(next);
            setConfig((current) => (current ? { ...current, enabled } : current));
          },
        },
      ],
    },
    {
      id: "dictation",
      title: "Dictée",
      description:
        "Sur cet ordinateur, avec whisper.cpp : rien ne part sur le réseau. Plus gros, plus précis et plus lent.",
      actions: [{ id: "argos", label: "Reprendre les réglages d’Argos", onPress: takeOverArgos }],
      settings: [
        {
          id: "allow",
          type: "switch",
          label: "Autoriser la dictée",
          description: "Bloquée, le micro ne s’ouvre plus nulle part. La lecture à voix haute continue.",
          value: dictation,
          onChange: (value) => setPreference({ dictation: value }),
        },
        ...whisperRows,
        path(
          "server",
          "Serveur whisper.cpp",
          "Le programme whisper-server (sur Mac : brew install whisper-cpp ; sous Windows : whisper-bin-x64.zip de github.com/ggml-org/whisper.cpp).",
          config.whisperServer,
          (whisperServer) => saveOrReport({ ...config, whisperServer: whisperServer || "whisper-server" }),
          "whisper-server",
        ),
        {
          id: "language",
          type: "select",
          label: "Langue de la dictée",
          description: "La langue dans laquelle vous dictez.",
          value: config.language,
          options: LANGUAGES,
          onChange: (language) => save({ ...config, language }),
        },
      ],
      content:
        dictation === false ? (
          <Alert tone="info">La dictée est bloquée : aucun micro ne s’ouvre.</Alert>
        ) : status?.listenError ? (
          <Alert tone="warning">{status.listenError}</Alert>
        ) : status ? (
          <Alert tone="info">La dictée est prête : bouton micro dans la page Agent.</Alert>
        ) : undefined,
    },
    {
      id: "reading",
      title: "Lecture à voix haute",
      description: "La voix d’Alfred est un majordome âgé à la voix grave, générée sur cet ordinateur par Qwen3-TTS.",
      settings: [
        {
          id: "backend",
          type: "select",
          label: "Synthèse",
          description:
            "Alfred : sa voix, sur Mac Apple Silicon ou carte NVIDIA. Kokoro n’a qu’une voix française, féminine.",
          value: config.ttsBackend,
          options: BACKENDS,
          onChange: (ttsBackend) => save({ ...config, ttsBackend: ttsBackend as VoiceConfig["ttsBackend"] }),
        },
        ...backendRows,
        {
          id: "try",
          type: "action",
          label: "Essai",
          description: `« ${SAMPLE} »`,
          action: speaking
            ? { id: "stop", label: "Arrêter", onPress: () => stopReading() }
            : { id: "try", label: "Écouter un essai", onPress: () => read(SAMPLE) },
        },
      ],
      content: status?.speakError ? (
        <Alert tone="warning">
          {config.ttsBackend === "qwen" && !status.qwenInstalled
            ? "La voix d’Alfred n’est pas installée : en attendant, la voix du système parle."
            : status.speakError}
        </Alert>
      ) : undefined,
    },
    {
      id: "notifications",
      title: "Notifications",
      description: "Les notifications envoyées par les pages et les fonctions de l’espace de travail.",
      settings: [
        {
          id: "read-notifications",
          type: "switch",
          label: "Lire les notifications à voix haute",
          description:
            "Le titre et le texte de chaque notification sont lus, sauf pendant une dictée ou une autre lecture.",
          value: status?.readNotifications ?? config.readNotifications,
          onChange: (value) => setPreference({ readNotifications: value }),
        },
      ],
    },
    {
      id: "agent",
      title: "Agent",
      description: "La voix dans la page Agent.",
      settings: [
        {
          id: "read-replies",
          type: "switch",
          label: "Lire les réponses aux demandes dictées",
          description:
            "Alfred commence à parler dès sa première phrase, pendant qu’il écrit la suite. Une demande tapée n’est jamais lue. Rouvrir le micro coupe la lecture.",
          value: config.readReplies,
          onChange: (readReplies) => save({ ...config, readReplies }),
        },
        {
          id: "pause",
          type: "select",
          label: "Envoyer après un silence",
          description:
            "Pendant une dictée, une pause de cette durée après avoir parlé envoie le message, sans cliquer.",
          value: String(status?.pauseSendMs ?? config.pauseSendMs),
          options: PAUSES,
          onChange: (value) => setPreference({ pauseSendMs: Number(value) }),
        },
      ],
    },
  ];
}
