# Modèles locaux : source, cache et Artifactory

Plusieurs fonctions d’Alfred calculent sur l’ordinateur avec un modèle téléchargé une seule fois, à la demande :

| Rubrique | Modèle | Taille | Téléchargé par |
| --- | --- | --- | --- |
| Recherche par le sens (Réglages → Général) | `intfloat/multilingual-e5-small` | 470 Mo | Alfred |
| Décisions locales, `ai.decide` (Réglages → Général) | `convaiinnovations/laya-multilingual` | 647 Mo | Alfred |
| Dictée (Réglages → Voix) | `ggerganov/whisper.cpp`, un fichier par niveau | 74 Mo à 2,9 Go | Alfred |
| Voix d’Alfred (Réglages → Voix) | Qwen3-TTS (`mlx-community/…` sur Mac, `Qwen/…` ailleurs) | ≈ 1 à 4 Go | Python |

Tous passent par la même **source des modèles** (ci-dessous) : Hugging Face, ou le miroir de l’entreprise.

## Révision

Alfred prend la **dernière révision**, celle que la source annonce pour `main` : la dernière version publiée sur
huggingface.co, ou l’identifiant que renvoie un miroir (Artifactory ignore la révision demandée et annonce un
identifiant à lui, qui n’existe pas sur huggingface.co). Une fois tous les fichiers en place, la révision est notée
dans le cache (`refs/main`, comme Python) : c’est la révision installée, affichée discrètement dans Réglages → Général
(« Version 614241f »).

Une mise à jour ne se fait **jamais toute seule** : seulement quand l’utilisateur clique « Télécharger »,
« Télécharger à nouveau » ou « Réessayer ». Le modèle en mémoire est alors remplacé au prochain usage.

Si une révision plus récente change de format (configuration, noms de tenseurs) et qu’Alfred ne sait plus la
charger, la rubrique le dit : « la version … du modèle … n’est pas prise en charge par cette version d’Alfred (…).
Une mise à jour d’Alfred est nécessaire. » Il en va de même si la liste des fichiers n’a plus un fichier qu’Alfred lit.

## Intégrité

Alfred ne compare plus les fichiers à des empreintes inscrites dans son code. Chaque fichier est vérifié avec ce que
la source annonce elle-même :

1. l’empreinte SHA-256 des gros fichiers (LFS), dans la liste des fichiers (`lfs.sha256`, demandée par
   `?blobs=true`) ;
2. sinon l’en-tête `X-Linked-Etag` de la réponse du fichier ;
3. sans empreinte annoncée (petits fichiers, ou miroir qui n’en donne pas), sa taille (`size` de la liste,
   `X-Linked-Size` ou `Content-Length`).

Cela couvre un téléchargement abîmé ou tronqué : le fichier est écarté, avec une erreur qui le nomme. Un fichier ne
prend sa place dans le cache qu’une fois vérifié.

## Téléchargement

Alfred suit le déroulé de `snapshot_download`, que la documentation d’Artifactory demande pour résoudre un modèle :

1. la liste des fichiers : `GET <source>/api/models/<dépôt>/revision/main?blobs=true`, puis sans `?blobs=true` si
   le miroir le refuse. Elle doit porter chacun des fichiers qu’Alfred lit ;
2. chaque fichier : `GET <source>/<dépôt>/resolve/<révision annoncée>/<fichier>`, puis `…/resolve/main/…` si le
   miroir ne sert pas la première ; un simple GET, sans demande de plage. Les fichiers sont rangés sous
   `snapshots/<révision annoncée>/`.

Les redirections (le CDN de huggingface.co) sont suivies par Alfred lui-même : les en-têtes `X-Linked-*` sont lus
sur la première réponse, et le jeton n’est jamais envoyé à un autre hôte que celui de la source.

[`hf-hub`](https://crates.io/crates/hf-hub) 0.5.0, la bibliothèque Rust de Hugging Face (dépôt
`huggingface/hf-hub`), sert à l’emplacement du cache et au jeton de `huggingface-cli login`. Son téléchargement n’est
pas employé : il demande d’abord l’octet 0 de chaque fichier et exige un en-tête `Content-Range`, qu’Artifactory ne
renvoie pas (« en-tête content-range absent »). Le GET simple est celui de la bibliothèque Python.

Pas de délai d’attente : la première fois, Artifactory peut mettre longtemps à répondre, le temps de récupérer le
fichier chez Hugging Face. C’est ce que sa documentation obtient en Python avec `etag_timeout=86400` ou
`HF_HUB_ETAG_TIMEOUT` ; Alfred attend sans limite.

La 1.0 de `hf-hub` n’est pas retenue : elle télécharge par Xet, un protocole à part qu’un miroir ne relaie pas
forcément et qu’on ne peut pas couper, et ajoute près de 300 dépendances.

TLS : le téléchargement emploie le client HTTP d’Alfred (reqwest, rustls) avec les **certificats racines du système** —
Trousseau d’accès sur Mac, magasin de certificats sur Windows. Un certificat d’entreprise installé sur le poste est
donc accepté. Le proxy du système est suivi, ainsi que `HTTPS_PROXY`.

## Source

Dans l’ordre :

1. **Réglages → Général → Source des modèles**, « Miroir de l’entreprise » : l’adresse saisie ;
2. la variable **`HF_ENDPOINT`** ;
3. `https://huggingface.co`.

La rubrique indique la source utilisée et d’où elle vient.

## Jeton

Dans l’ordre :

1. le jeton saisi avec l’adresse du réglage, rangé dans le trousseau (il n’est envoyé qu’à cette adresse) ;
2. la variable **`HF_TOKEN`** ;
3. le fichier de `huggingface-cli login` : `$HF_HOME/token`, sinon `~/.cache/huggingface/token`.

Il part dans l’en-tête `Authorization: Bearer …`. Il n’apparaît dans aucun journal ni message d’erreur.

## Emplacement

Le cache Hugging Face standard, partagé avec Python : `$HF_HOME/hub`, sinon `~/.cache/huggingface/hub` (sous
Windows, `%USERPROFILE%\.cache\huggingface\hub`). Comme en Python, le contenu est dans
`models--<org>--<nom>/blobs/<etag>` et `models--<org>--<nom>/snapshots/<révision>/<fichier>` le désigne par un lien
(sous Windows, sans droit de créer un lien, le fichier y est déplacé). Un fichier déjà dans le dossier de la révision
annoncée (téléchargé par Python, ou avant une coupure) n’est pas téléchargé à nouveau.

Alfred lit le modèle installé dans cet ordre : la révision notée dans `refs/main`, si elle est complète ; la copie du
cache à la révision que figeaient les versions précédentes d’Alfred ; puis l’ancien dossier
`<données d’Alfred>/models/<modèle>` (le Laya déjà téléchargé y reste lu tel quel, sans nouveau téléchargement).

## Pointer Alfred vers un Artifactory

Un dépôt distant Artifactory de type **Hugging Face** (`huggingfaceml`) se présente comme huggingface.co à cette
adresse :

```text
https://<serveur>/artifactory/api/huggingfaceml/<clé du dépôt>
```

où `<clé du dépôt>` est le nom affiché dans « Set Up A Hugging Face Client » (champ Repository), par exemple
`https://jfrog.exemple.fr/artifactory/api/huggingfaceml/huggingface`.

- **Avec le réglage** (conseillé sur Mac) : Réglages → Général → Source des modèles → Modifier…, « Miroir de
  l’entreprise », l’adresse ci-dessus, et le jeton d’identité Artifactory si le dépôt en demande un.
- **Avec les variables** : `HF_ENDPOINT` (et `HF_TOKEN`), comme pour Python. Sur Mac, une application ouverte depuis le
  Dock ou le Finder ne voit pas les variables du terminal (`~/.zshrc`) : elles ne s’appliquent que si Alfred est
  lancé depuis ce terminal, d’où le réglage. Sous Windows, une variable d’utilisateur (Paramètres → Variables
  d’environnement) s’applique à Alfred au prochain lancement.

## Voix

### Dictée : Whisper

Réglages → Voix → Dictée propose les niveaux de Whisper, chacun avec sa taille et ce qu’il apporte. Ce sont les
modèles ggml de whisper.cpp, dans le dépôt Hugging Face `ggerganov/whisper.cpp`. Tous sont multilingues : le français
est pris en charge par chacun.

| Niveau | Fichier | Taille | En une ligne |
| --- | --- | --- | --- |
| tiny | `ggml-tiny.bin` | 74 Mo | le plus rapide, beaucoup de fautes : pour essayer |
| base | `ggml-base.bin` | 141 Mo | très rapide, fautes fréquentes en français |
| small | `ggml-small.bin` | 465 Mo | rapide et correct en français : ordinateur modeste |
| medium | `ggml-medium.bin` | 1,4 Go | précis, lent sans carte graphique |
| large-v3-turbo | `ggml-large-v3-turbo.bin` | 1,5 Go | presque aussi précis que large-v3, plusieurs fois plus rapide |
| large-v3 | `ggml-large-v3.bin` | 2,9 Go | le plus précis, lent et gourmand |

« Télécharger » passe par le même code que e5 et Laya (`model_files.rs`) : liste des fichiers, GET simple, empreinte
annoncée, progression, mêmes erreurs. Le niveau téléchargé sert aussitôt ; un niveau déjà là se choisit d’un clic
(« Utiliser »). Le dépôt range tous les niveaux : télécharger un niveau avance `refs/main`, et ceux déjà téléchargés
restent reconnus dans leur révision. Un contenu déjà présent dans `blobs/` sous son empreinte n’est pas retéléchargé.

**Niveau conseillé** : large-v3-turbo dès 16 Go de mémoire, small en dessous. large-v3-turbo transcrit presque comme
large-v3 pour une fraction du temps (30 s d’audio en ≈ 1 s sur Mac Apple Silicon) ; il occupe environ 2 Go de mémoire
en plus de la voix d’Alfred, qui en garde déjà plusieurs. Sur 8 Go, small (moins d’1 Go) laisse la machine respirer.
Le choix reste à l’utilisateur : le niveau conseillé porte l’étiquette « Conseillé », rien ne se télécharge seul.

**Fichier existant** : la dernière ligne garde le réglage d’avant, un fichier ggml indiqué à la main (ou repris
d’Argos). L’indiquer remplace le niveau.

**whisper-server** (le programme de whisper.cpp qui garde le modèle chargé) n’est pas fourni avec Alfred. Il est
cherché tel quel s’il a un dossier, sinon dans le `PATH` du terminal et les dossiers usuels (Homebrew…), même quand
Alfred est ouvert depuis le Dock. Absent, la dictée dit quoi installer :

- Mac : `brew install whisper-cpp` ;
- Windows : `whisper-bin-x64.zip` dans les Releases de `github.com/ggml-org/whisper.cpp`, décompressé, puis
  `whisper-server.exe` indiqué dans Réglages → Voix → Serveur whisper.cpp.

### Voix d’Alfred : Qwen3-TTS

Le modèle est téléchargé par le programme Python de la voix (`voice/qwen_worker.py`), avec la bibliothèque Python de
Hugging Face (`load` de mlx-audio sur Mac Apple Silicon, `from_pretrained` de qwen-tts ailleurs), au premier
chargement. Alfred le lance avec les variables déduites de la source des modèles, même ouvert depuis le Dock ou le
menu Démarrer :

| Variable | Valeur |
| --- | --- |
| `HF_ENDPOINT` | l’adresse du réglage ou de `HF_ENDPOINT` ; absente pour huggingface.co par défaut |
| `HF_TOKEN` | le jeton qu’Alfred enverrait (réglage, puis `HF_TOKEN`) ; sinon Python lit le fichier de `huggingface-cli login` |
| `HF_HOME` | le dossier du cache d’Alfred (sauf si `HF_HUB_CACHE` est déjà fixé) : un seul cache pour tous |
| `HF_HUB_ETAG_TIMEOUT`, `HF_HUB_DOWNLOAD_TIMEOUT` | 86400 avec un miroir, qui peut mettre longtemps à répondre la première fois |

Le jeton n’apparaît dans aucun journal : la sortie d’erreur du programme est ignorée et la structure qui le porte le
masque à l’affichage.

Un miroir qui annonce sa propre révision est géré par la bibliothèque Python : elle demande la liste des fichiers à
cette révision puis chaque fichier à `resolve/<révision annoncée>/…`, et range le tout sous
`snapshots/<révision annoncée>`. Vérifié sur un faux miroir avec la bibliothèque de mlx-audio (`huggingface_hub`
2.4). Attention : depuis la version 1.0, cette bibliothèque liste les fichiers par
`GET <source>/api/models/<dépôt>/tree/<révision>?recursive=true`, et non plus par la liste de `revision/main` qu’emploie
Alfred. Un miroir qui ne sert pas `/tree/` fait échouer le premier chargement de la voix (« Cannot find an appropriate
cached snapshot folder ») ; un modèle déjà dans le cache reste lu.

## Erreurs

| Message | Cause |
| --- | --- |
| « … est injoignable » | adresse fausse, réseau, proxy |
| « … refuse l’accès (401 / 403) : jeton manquant ou refusé » | jeton absent, expiré ou sans droit sur le dépôt |
| « … absent de … (404) » | le miroir n’a pas ce modèle ou ce fichier |
| « le certificat de … est refusé » | certificat de l’entreprise non installé sur le poste |
| « … n’a pas répondu comme un dépôt Hugging Face » | l’adresse ne mène pas à l’API `huggingfaceml` |
| « le fichier … n’a pas l’empreinte que la source annonce : fichier écarté » | téléchargement abîmé : réessayer |
| « le fichier … est incomplet (… octets sur …) : fichier écarté » | téléchargement tronqué : réessayer |
| « la version … du modèle … n’est pas prise en charge par cette version d’Alfred » | la dernière révision a changé de format : mettre à jour Alfred |
| « le modèle Whisper … n’est pas téléchargé » | niveau choisi absent du cache : Réglages → Voix, Télécharger |
| « whisper-server (whisper.cpp) est introuvable : … » | whisper.cpp pas installé : la suite du message dit quoi installer |
