# Publier Alfred

Ce qu’il faut pour livrer une version signée. Aucun certificat ni identifiant n’est dans le dépôt : tout passe par des
variables d’environnement, posées sur la machine de construction ou dans les secrets de la CI.

## Construire sans signer (vérification locale)

```bash
pnpm install
pnpm tauri build --bundles app
```

Le paquet sort dans `src-tauri/target/release/bundle/macos/Alfred.app` (environ 12,5 Mio, arm64). Il n’a qu’une signature
locale (« ad hoc ») : il se lance sur la machine qui l’a construit, mais Gatekeeper le bloque une fois téléchargé.

## macOS : signer et notariser

### Prérequis

- Une adhésion au programme Apple Developer (compte d’équipe, 99 $ par an).
- Un certificat **Developer ID Application**, créé dans le compte développeur et installé dans le trousseau de la machine
  de construction (avec sa clé privée).
- Pour la notarisation, au choix :
  - une clé d’API App Store Connect (rôle Developer) : identifiant de l’émetteur, identifiant de la clé et fichier `.p8` ;
  - ou un identifiant Apple, un mot de passe pour app et l’identifiant d’équipe.
- Xcode ou les Command Line Tools (`xcrun notarytool`, `xcrun stapler`).

### Sur un Mac de développeur

```bash
security find-identity -v -p codesigning
```

Recopier le nom complet de l’identité, par exemple `Developer ID Application: Nom (ABCDE12345)`, puis :

```bash
export APPLE_SIGNING_IDENTITY="Developer ID Application: Nom (ABCDE12345)"
export APPLE_API_ISSUER="<identifiant de l’émetteur>"
export APPLE_API_KEY="<identifiant de la clé>"
export APPLE_API_KEY_PATH="$HOME/.private_keys/AuthKey_<identifiant de la clé>.p8"
pnpm tauri build --bundles app,dmg
```

Variante sans clé d’API : remplacer les trois variables `APPLE_API_*` par `APPLE_ID`, `APPLE_PASSWORD` (mot de passe pour
app, pas celui du compte) et `APPLE_TEAM_ID`.

Tauri signe avec le runtime renforcé (`bundle.macOS.hardenedRuntime`, actif par défaut), envoie le paquet à la
notarisation, attend la réponse et agrafe le ticket. Alfred n’a pas besoin d’autorisations spéciales (entitlements) :
le trousseau sert par l’API Keychain et les agents sont des processus enfants, ce que le runtime renforcé n’empêche pas.

### En CI (sans trousseau préinstallé)

Exporter le certificat et sa clé en `.p12`, puis fournir en secrets :

```bash
export APPLE_CERTIFICATE="$(base64 -i certificat.p12)"
export APPLE_CERTIFICATE_PASSWORD="<mot de passe du .p12>"
export APPLE_SIGNING_IDENTITY="Developer ID Application: Nom (ABCDE12345)"
# plus les variables de notarisation ci-dessus
pnpm tauri build --bundles app,dmg
```

Tauri crée un trousseau temporaire, y importe le certificat et le supprime à la fin.

### Mac Intel et Apple Silicon dans un seul paquet

```bash
rustup target add x86_64-apple-darwin aarch64-apple-darwin
pnpm tauri build --target universal-apple-darwin --bundles app,dmg
```

Le résultat sort dans `src-tauri/target/universal-apple-darwin/release/bundle/`.

### Vérifier

```bash
codesign --verify --deep --strict --verbose=2 src-tauri/target/release/bundle/macos/Alfred.app
spctl --assess --type execute --verbose=4 src-tauri/target/release/bundle/macos/Alfred.app
xcrun stapler validate src-tauri/target/release/bundle/dmg/Alfred_0.1.0_aarch64.dmg
```

`spctl` doit répondre « accepted, source=Notarized Developer ID ».

## Windows : installeur

### Prérequis (sur une machine Windows 10 ou 11)

- Visual Studio Build Tools avec « Développement Desktop en C++ » (MSVC et SDK Windows).
- Rust (`rustup default stable-msvc`), Node.js et pnpm.
- WebView2 : présent sur Windows 10 et 11 à jour ; l’installeur le télécharge sinon (`bundle.windows.webviewInstallMode`,
  par défaut le programme d’amorçage).

### Construire

```bash
pnpm install
pnpm tauri build --bundles nsis
```

L’installeur sort dans `src-tauri\target\release\bundle\nsis\Alfred_0.1.0_x64-setup.exe`. Pour un `.msi`, utiliser
`--bundles msi` (WiX, téléchargé par Tauri ; demande la fonctionnalité Windows « VBSCRIPT »). Construire depuis macOS
n’est pas pris en charge pour `msi` et reste expérimental pour `nsis` : préférer une machine ou un runner Windows.

Sous Windows, les pages sont servies par `http://alfred-page.localhost`, que la politique de sécurité de
`tauri.conf.json` autorise déjà. Ce chemin n’a pas encore été vérifié dans une vraie fenêtre Windows.

### Signer

Sans signature, SmartScreen avertit l’utilisateur à l’installation. Depuis 2023, les certificats de signature de code
(OV comme EV) sont conservés sur un module matériel ou un service distant : on signe donc par une commande, déclarée dans
`tauri.conf.json`, que Tauri appelle sur chaque binaire et sur l’installeur (`%1` est le fichier à signer).

- **Azure Trusted Signing** :

  ```bash
  cargo install trusted-signing-cli
  ```

  ```json
  "bundle": {
    "windows": {
      "signCommand": "trusted-signing-cli -e https://weu.codesigning.azure.net -a <compte> -c <profil de certificat> -d Alfred %1"
    }
  }
  ```

  avec `AZURE_CLIENT_ID`, `AZURE_CLIENT_SECRET` et `AZURE_TENANT_ID` dans l’environnement.

- **Certificat installé dans le magasin Windows** (jeton matériel branché) :

  ```json
  "bundle": {
    "windows": {
      "certificateThumbprint": "<empreinte SHA-1 du certificat>",
      "digestAlgorithm": "sha256",
      "timestampUrl": "http://timestamp.digicert.com"
    }
  }
  ```

Vérifier :

```bash
signtool verify /pa /v src-tauri\target\release\bundle\nsis\Alfred_0.1.0_x64-setup.exe
```

## À garder en tête

- `identifier` (`app.alfred.desktop`) fixe le dossier de données, le trousseau et le verrou d’instance unique : ne plus
  le changer après la première version publiée. Le binaire de développement partage ce même identifiant, si bien
  qu’une version installée et `pnpm tauri dev` ne peuvent pas tourner en même temps.
- La version vient de `package.json` (`"version": "../package.json"` dans `tauri.conf.json`).
- Pas encore de mise à jour automatique : il faudrait le module `updater` de Tauri et une clé de signature des mises à jour
  (`pnpm tauri signer generate`), distincte des certificats ci-dessus.
