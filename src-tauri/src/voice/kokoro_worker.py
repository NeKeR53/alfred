"""Synthèse Kokoro locale : un seul processus pour toute la session, le modèle reste chargé.

Chaque ligne reçue sur stdin est une phrase, encodée en JSON. Pour chacune, la réponse sur
stdout est « ok », ou « erreur <message> » si la phrase n'a pas pu être dite. Le texte ne
quitte jamais la machine.

La sortie audio reste ouverte tout du long et joue du silence entre deux phrases : sans
cela, macOS met le haut-parleur en veille après quelques secondes muettes, et le réveil
avale le début du son suivant — la première phrase après une pause n'était pas entendue."""
import json
import sys
import threading

import numpy as np
import sounddevice as sd
from kokoro_onnx import SAMPLE_RATE, Kokoro

# Marge au-delà de la durée d'une phrase avant de tenir la sortie pour perdue.
PLAY_MARGIN_S = 2.0


# Python nourrit la sortie par blocs de 2048 échantillons (≈ 85 ms) avec une grande latence :
# avec les blocs minuscules par défaut (0,6 ms), le calcul du modèle retient parfois le GIL
# plus longtemps que le tampon, et la voix grésille.
BLOCK = 2048


# La sortie s'ouvre au taux natif du haut-parleur (48 kHz sur un Mac), et la voix y est convertie
# ici, avec soxr : la conversion faite au vol par macOS depuis 24 kHz, comme une interpolation
# linéaire, laisse des aigus parasites qu'on entend comme un grésillement.
def output_rate(source_rate):
    try:
        return int(sd.query_devices(kind="output")["default_samplerate"]) or source_rate
    except Exception:
        return source_rate


class Resampler:
    """Conversion de taux en continu, morceau par morceau, sans saut aux jonctions."""

    def __init__(self, source_rate, target_rate):
        self.step = source_rate / target_rate
        self.stream = None
        if source_rate != target_rate:
            try:
                import soxr

                self.stream = soxr.ResampleStream(source_rate, target_rate, 1, dtype="float32")
            except Exception:  # soxr absent : interpolation linéaire, de moindre qualité
                pass
        self.reset()

    def reset(self):
        self.tail = np.zeros(0, dtype=np.float32)
        self.position = 0.0
        if self.stream is not None:
            self.stream.clear()

    def process(self, samples, last=False):
        samples = np.asarray(samples, dtype=np.float32).reshape(-1)
        if self.step == 1:
            return samples
        if self.stream is not None:
            return self.stream.resample_chunk(samples, last=last)
        # Le dernier échantillon du morceau précédent sert d'appui au début de celui-ci.
        data = np.concatenate([self.tail, samples])
        end = len(data) - 1
        if end < self.position:
            self.tail = data[-1:]
            self.position -= max(end, 0)
            return np.zeros(0, dtype=np.float32)
        times = self.position + np.arange(int((end - self.position) / self.step) + 1) * self.step
        out = np.interp(times, np.arange(len(data)), data).astype(np.float32)
        self.position = times[-1] + self.step - end
        self.tail = data[-1:]
        return out


class Output:
    """Flux de sortie permanent : il lit la phrase confiée, du silence sinon."""

    def __init__(self):
        self.lock = threading.Lock()
        self.samples = np.zeros(0, dtype=np.float32)
        self.drained = threading.Event()
        self.drained.set()
        self.rate = output_rate(SAMPLE_RATE)
        self.resampler = Resampler(SAMPLE_RATE, self.rate)
        self.stream = sd.OutputStream(
            samplerate=self.rate, channels=1, dtype="float32", callback=self.fill,
            blocksize=BLOCK, latency="high",
        )
        self.stream.start()

    def fill(self, out, frames, _time, _status):
        with self.lock:
            count = min(frames, len(self.samples))
            out[:count, 0] = self.samples[:count]
            out[count:, 0] = 0
            self.samples = self.samples[count:]
            if not len(self.samples):
                self.drained.set()

    def play(self, samples):
        """Joue `samples` et rend la main quand tout est parti au haut-parleur."""
        self.resampler.reset()
        converted = self.resampler.process(samples, last=True)
        with self.lock:
            self.samples = converted
            self.drained.clear()
        if not self.drained.wait(len(converted) / self.rate + PLAY_MARGIN_S):
            raise RuntimeError("la sortie audio ne répond plus")

    def close(self):
        try:
            self.stream.close()
        except Exception:
            pass


model, voices, voice = sys.argv[1:4]
try:
    # La sortie d'abord : le haut-parleur se réveille pendant le chargement du modèle.
    output = Output()
except Exception:  # retentée à la première phrase, qui dira l'erreur
    output = None
try:
    kokoro = Kokoro(model, voices)
    failure = None
except Exception as error:  # le chargement échoue : chaque phrase le dira
    kokoro = None
    failure = str(error).replace("\n", " ")

for line in sys.stdin:
    try:
        if failure is not None:
            raise RuntimeError(failure)
        text = json.loads(line)
        if text.strip():
            samples, _rate = kokoro.create(text, voice=voice, lang="fr-fr")
            if output is None:
                output = Output()
            try:
                output.play(samples)
            except Exception:
                # Périphérique perdu (casque débranché…) : la phrase suivante en rouvre un.
                output.close()
                output = None
                raise
        print("ok", flush=True)
    except Exception as error:
        print("erreur " + str(error).replace("\n", " "), flush=True)
