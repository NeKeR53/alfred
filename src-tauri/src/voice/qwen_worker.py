"""Voix d'Alfred : Qwen3-TTS en local, voix clonée d'un échantillon de référence.

Un seul processus pour toute la session : le modèle et la voix restent chargés. Lignes JSON sur stdin :

- {"op": "prepare", "text": "..."} : met la phrase en calcul d'avance, sans la dire (aucune réponse) ;
- {"op": "say", "id": 3, "text": "..."} : dit la phrase (calculée d'avance si elle a été préparée) ;
- {"op": "stop"} : coupe la phrase en cours, oublie celles en attente et ce qui a été préparé.

Chaque « say » reçoit une ligne JSON sur stdout : {"id": 3, "ok": true}, {"id": 3, "interrupted": true} ou
{"id": 3, "error": "..."}. La ligne {"ready": true} (ou {"ready": false, "error": "..."}) annonce que le
modèle est chargé et préchauffé. Le texte ne quitte jamais la machine.

Deux moteurs, choisis selon ce qui est installé :
- mlx-audio (Mac Apple Silicon) : le son sort par morceaux d'une demi-seconde pendant le calcul, le premier
  au bout de quelques dixièmes de seconde ;
- qwen-tts (PyTorch, carte NVIDIA ou processeur) : chaque phrase est calculée entière avant d'être dite.

Un fil calcule les phrases dans l'ordre, un autre les dit dans l'ordre : la suivante se calcule pendant que la
précédente est dite. La sortie audio reste ouverte et joue du silence entre deux phrases : sans cela, macOS met
le haut-parleur en veille et le réveil avale le début de la phrase suivante.
"""

import json
import os
import queue
import sys
import threading

# Le protocole garde pour lui la vraie sortie standard ; tout ce que les bibliothèques y écrivent
# (barres de progression, avertissements) part sur stderr.
protocol = os.fdopen(os.dup(1), "w", encoding="utf-8")
os.dup2(2, 1)
sys.stdout = sys.stderr

# Certificats : ceux du système (Trousseau, magasin de Windows), où se trouve l'autorité d'une entreprise
# derrière un miroir des modèles. Sans cela, Python ne connaît que les autorités publiques de certifi.
# truststore (installé avec la voix) les vérifie par le système lui-même, avant toute connexion ; il remplace
# alors le fichier des racines du système qu'Alfred indique (ALFRED_CA_BUNDLE), qui reste le recours d'une
# installation sans truststore. La vérification n'est jamais désactivée.
try:
    import truststore

    truststore.inject_into_ssl()
    alfred_bundle = os.environ.pop("ALFRED_CA_BUNDLE", None)
    for name in ("SSL_CERT_FILE", "REQUESTS_CA_BUNDLE", "CURL_CA_BUNDLE"):
        if alfred_bundle and os.environ.get(name) == alfred_bundle:
            del os.environ[name]
except ImportError:
    pass

import numpy as np
import sounddevice as sd

model_id, reference, reference_text, language = sys.argv[1:5]

RATE = 24000
# Durée des morceaux diffusés par mlx-audio.
CHUNK_S = 0.5
# Sans nouveau morceau pendant ce temps, le calcul est tenu pour bloqué.
STALL_S = 30.0
write_lock = threading.Lock()


def reply(message):
    with write_lock:
        protocol.write(json.dumps(message, ensure_ascii=False) + "\n")
        protocol.flush()


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
    """Flux de sortie permanent : il lit ce qu'on lui confie, au fil de l'eau, et du silence sinon."""

    def __init__(self):
        self.lock = threading.Lock()
        self.samples = np.zeros(0, dtype=np.float32)
        self.drained = threading.Event()
        self.drained.set()
        self.rate = output_rate(RATE)
        self.resampler = Resampler(RATE, self.rate)
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

    def feed(self, samples, last=False):
        converted = self.resampler.process(samples, last=last)
        with self.lock:
            self.samples = np.concatenate([self.samples, converted])
            if len(self.samples):
                self.drained.clear()
        if last:
            self.resampler.reset()

    def finish(self):
        """Fin de phrase : rend ce que le convertisseur gardait encore en réserve."""
        self.feed(np.zeros(0, dtype=np.float32), last=True)

    def wait(self, timeout):
        return self.drained.wait(timeout)

    def stop(self):
        with self.lock:
            self.samples = np.zeros(0, dtype=np.float32)
            self.resampler.reset()
            self.drained.set()

    def close(self):
        try:
            self.stream.close()
        except Exception:
            pass


def describe(error):
    """Le message d'une erreur, sur une ligne. Un certificat refusé est souvent caché sous une erreur plus vague
    (« cannot find the requested files… » de huggingface_hub) : la cause TLS de la chaîne passe alors devant,
    avec l'hôte."""
    chain, seen = [], error
    while seen is not None and all(seen is not known for known in chain) and len(chain) < 12:
        chain.append(seen)
        seen = seen.__cause__ or seen.__context__
    for cause in chain:
        text = str(cause)
        if "certificate" in text.lower() or "SSLCert" in type(cause).__name__:
            if "host=" not in text:
                try:
                    text += f" (host='{cause.request.url.host}')"
                except Exception:
                    pass
            return f"certificate refused: {text}".replace("\n", " ")
    return str(error).replace("\n", " ")


class Sentence:
    """L'audio d'une phrase, rempli morceau par morceau par le fil de calcul."""

    def __init__(self, text):
        self.text = text
        self.chunks = queue.Queue()  # tableaux numpy, puis None à la fin ; une Exception en cas d'échec
        self.cancelled = False


def load_mlx():
    from mlx_audio.tts.utils import load

    model = load(model_id)

    def generate(sentence):
        for result in model.generate(
            text=sentence.text,
            ref_audio=reference,
            ref_text=reference_text,
            lang_code=language.lower(),
            stream=True,
            streaming_interval=CHUNK_S,
        ):
            if sentence.cancelled:
                return
            sentence.chunks.put(np.array(result.audio, dtype=np.float32))

    return generate


def load_torch():
    import torch
    from qwen_tts import Qwen3TTSModel

    if torch.backends.mps.is_available():
        device, dtype = "mps", torch.bfloat16
    elif torch.cuda.is_available():
        device, dtype = "cuda:0", torch.bfloat16
    else:
        device, dtype = "cpu", torch.float32
    model = Qwen3TTSModel.from_pretrained(model_id, device_map=device, dtype=dtype)
    voice = model.create_voice_clone_prompt(ref_audio=reference, ref_text=reference_text)

    def generate(sentence):
        wavs, rate = model.generate_voice_clone(text=sentence.text, language=language, voice_clone_prompt=voice)
        audio = np.asarray(wavs[0], dtype=np.float32)
        if rate != RATE:
            audio = np.interp(np.linspace(0, len(audio), int(len(audio) * RATE / rate), endpoint=False),
                              np.arange(len(audio)), audio).astype(np.float32)
        sentence.chunks.put(audio)

    return generate


try:
    try:
        import mlx_audio  # noqa: F401

        generate = load_mlx()
    except ImportError:
        generate = load_torch()
    # Préchauffage : la première génération compile le calcul et encode la voix de référence (≈ 10 s) ;
    # la première vraie phrase n'a plus à l'attendre.
    warm = Sentence("Bonjour.")
    generate(warm)
    failure = None
except Exception as error:  # chaque phrase dira l'erreur de chargement
    generate = None
    failure = describe(error)

to_generate = queue.Queue()
prepared = {}
prepared_lock = threading.Lock()
says = queue.Queue()
# Phrases demandées et pas encore dites : un « stop » arrête leur calcul.
live = set()
live_lock = threading.Lock()
# Chaque « stop » ouvre une nouvelle époque : ce qui appartient à une époque passée n'est pas dit.
epoch = 0
output = None


def generator():
    while True:
        sentence = to_generate.get()
        if sentence.cancelled:
            sentence.chunks.put(None)
            continue
        try:
            if failure is not None:
                raise RuntimeError(failure)
            generate(sentence)
            sentence.chunks.put(None)
        except Exception as error:
            sentence.chunks.put(error)


def sentence_for(text):
    with prepared_lock:
        sentence = prepared.pop(text, None)
    if sentence is None:
        sentence = Sentence(text)
        to_generate.put(sentence)
    return sentence


def speaker():
    global output
    while True:
        ident, said_epoch, sentence = says.get()
        try:
            interrupted = False
            while said_epoch == epoch:
                chunk = sentence.chunks.get(timeout=STALL_S)
                if said_epoch != epoch:
                    interrupted = True
                    break
                if chunk is None:
                    if output is not None:
                        output.finish()
                    break
                if isinstance(chunk, Exception):
                    raise chunk
                if output is None:
                    output = Output()
                output.feed(chunk)
            if not interrupted:
                # Attendre que tout soit parti au haut-parleur (ou qu'un « stop » vide la sortie).
                while output is not None and not output.wait(0.1):
                    if said_epoch != epoch:
                        break
            interrupted = said_epoch != epoch
            reply({"id": ident, "interrupted": True} if interrupted else {"id": ident, "ok": True})
        except queue.Empty:
            reply({"id": ident, "error": "la synthèse ne répond plus"})
        except Exception as error:
            if output is not None and "PortAudio" in type(error).__name__ + str(error):
                # Périphérique perdu (casque débranché…) : la phrase suivante en rouvre un.
                output.close()
                output = None
            reply({"id": ident, "error": describe(error)})
        finally:
            with live_lock:
                live.discard(sentence)


threading.Thread(target=generator, daemon=True).start()
threading.Thread(target=speaker, daemon=True).start()
reply({"ready": failure is None, **({"error": failure} if failure else {})})

for line in sys.stdin:
    try:
        command = json.loads(line)
    except ValueError:
        continue
    op = command.get("op")
    if op == "prepare":
        text = str(command.get("text", "")).strip()
        if text:
            with prepared_lock:
                if text not in prepared:
                    prepared[text] = Sentence(text)
                    to_generate.put(prepared[text])
    elif op == "say":
        text = str(command.get("text", "")).strip()
        ident = int(command.get("id", 0))
        if not text:
            reply({"id": ident, "ok": True})
            continue
        sentence = sentence_for(text)
        with live_lock:
            live.add(sentence)
        says.put((ident, epoch, sentence))
    elif op == "stop":
        epoch += 1
        with prepared_lock:
            for sentence in prepared.values():
                sentence.cancelled = True
            prepared.clear()
        with live_lock:
            for sentence in live:
                sentence.cancelled = True
        if output is not None:
            output.stop()
