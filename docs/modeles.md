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

Alfred passe par [`hf-hub`](https://crates.io/crates/hf-hub) 0.5.0, la bibliothèque Rust de Hugging Face (dépôt
`huggingface/hf-hub`) : mêmes adresses (`<source>/<dépôt>/resolve/<révision>/<fichier>`), mêmes en-têtes et même cache
que la bibliothèque Python `huggingface_hub`. La 1.0 n’est pas retenue : elle télécharge par Xet, un protocole à part
qu’un miroir ne relaie pas forcément et qu’on ne peut pas couper, et ajoute près de 300 dépendances.

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
Windows, `%USERPROFILE%\.cache\huggingface\hub`). Un modèle y est rangé sous
`models--<org>--<nom>/snapshots/<révision>/`. Un modèle déjà téléchargé par Python à la même révision n’est pas
téléchargé à nouveau.

Un modèle téléchargé avant cette version, complet dans `<données d’Alfred>/models/<modèle>`, reste là : Alfred continue
de l’y lire et ne le télécharge pas à nouveau.

## Pointer Alfred vers un Artifactory

Un dépôt distant Artifactory de type **Hugging Face** (`huggingfaceml`) se présente comme huggingface.co à cette
adresse :

```text
https://<serveur>/artifactory/api/huggingfaceml/<clé du dépôt>
```

par exemple `https://jfrog.exemple.fr/artifactory/api/huggingfaceml/huggingface-remote`.

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
| « … n’a pas l’empreinte attendue : fichier écarté » | le miroir sert une autre version du fichier |
