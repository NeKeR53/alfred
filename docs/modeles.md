# Modèles locaux : source, cache et Artifactory

Deux fonctions d’Alfred calculent sur l’ordinateur avec un modèle téléchargé une seule fois, à la demande, depuis
Réglages → Général :

| Rubrique | Modèle | Taille |
| --- | --- | --- |
| Recherche par le sens | `intfloat/multilingual-e5-small` | 470 Mo |
| Décisions locales (`ai.decide`) | `convaiinnovations/laya-multilingual` | 647 Mo |

Chaque fichier est demandé à une révision figée, et son empreinte SHA-256 est comparée à celle inscrite dans Alfred
(`src-tauri/src/decisions.rs`, `src-tauri/src/module_semantic.rs`) : un fichier différent est écarté, avec une
erreur qui le dit.

## Téléchargement

Alfred suit le déroulé de `snapshot_download`, que la documentation d’Artifactory demande pour résoudre un modèle :

1. la liste des fichiers du modèle à sa révision : `GET <source>/api/models/<dépôt>/revision/<révision>`. La réponse
   doit porter chacun des fichiers attendus. La révision qu’elle annonce peut différer de la révision figée :
   Artifactory ignore la révision demandée et annonce un identifiant à lui, qui n’existe pas sur huggingface.co ;
2. chaque fichier : `GET <source>/<dépôt>/resolve/<révision>/<fichier>`, un simple GET, sans demande de plage, à la
   révision figée d’abord, puis, si le miroir ne la sert pas, à celle qu’il annonce.

Ce qui garantit le modèle n’est pas la révision annoncée mais l’empreinte SHA-256 figée de chaque fichier : un fichier
accepté a exactement le contenu de la révision figée, quelle que soit la révision par laquelle le miroir l’a servi. Il
est rangé sous `snapshots/<révision figée>/`.

La première étape, les adresses, le jeton et le cache passent par [`hf-hub`](https://crates.io/crates/hf-hub) 0.5.0,
la bibliothèque Rust de Hugging Face (dépôt `huggingface/hf-hub`). Les fichiers, eux, ne passent pas par son
téléchargement : il demande d’abord l’octet 0 de chaque fichier et exige un en-tête `Content-Range`, qu’Artifactory
ne renvoie pas (« en-tête content-range absent »). Le GET simple est celui de la bibliothèque Python.

Pas de délai d’attente : la première fois, Artifactory peut mettre longtemps à répondre, le temps de récupérer le
fichier chez Hugging Face. C’est ce que sa documentation obtient en Python avec `etag_timeout=86400` ou
`HF_HUB_ETAG_TIMEOUT` ; Alfred attend sans limite.

La 1.0 de `hf-hub` n’est pas retenue : elle télécharge par Xet, un protocole à part qu’un miroir ne relaie pas
forcément et qu’on ne peut pas couper, et ajoute près de 300 dépendances.

TLS : `hf-hub` emploie le client HTTP d’Alfred (reqwest, rustls) avec les **certificats racines du système** —
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
(sous Windows, sans droit de créer un lien, le fichier y est déplacé). Un modèle déjà téléchargé par Python à la même révision n’est pas
téléchargé à nouveau.

Un modèle téléchargé avant cette version, complet dans `<données d’Alfred>/models/<modèle>`, reste là : Alfred continue
de l’y lire et ne le télécharge pas à nouveau.

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

## Erreurs

| Message | Cause |
| --- | --- |
| « … est injoignable » | adresse fausse, réseau, proxy |
| « … refuse l’accès (401 / 403) : jeton manquant ou refusé » | jeton absent, expiré ou sans droit sur le dépôt |
| « … absent de … (404) » | le miroir n’a pas ce modèle, ce fichier ou cette révision |
| « le certificat de … est refusé » | certificat de l’entreprise non installé sur le poste |
| « … ne répond pas comme un dépôt Hugging Face » | l’adresse ne mène pas à l’API `huggingfaceml` |
| « le fichier … n’a pas l’empreinte attendue : fichier écarté. Le modèle … a changé… » | le miroir sert une autre version de ce fichier : le modèle a changé depuis la révision figée, Alfred doit être mis à jour |
