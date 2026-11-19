//! Git sur le réseau : certificats et proxy du système, et traduction de ses échecs en français.
//!
//! Git ne lit ni le magasin de certificats du système ni son proxy. Derrière un réseau d’entreprise (autorité de
//! certification privée, proxy obligatoire), un `git fetch` échoue donc là où le navigateur passe. Alfred lui
//! donne, par des `-c` de la ligne de commande seulement, ce que le poste sait déjà :
//! - sous Windows, le magasin de Windows (`http.sslBackend=schannel`), puis, si ce Git ne le connaît pas ou s’il
//!   refuse encore, les racines du système exportées en PEM avec OpenSSL ;
//! - sur Mac et Linux, les mêmes racines en PEM quand le premier essai échoue sur un certificat ;
//! - sous Windows, le proxy des « Paramètres Internet » quand git n’en a aucun.
//!
//! Un réglage que l’utilisateur a déjà fait (dans sa configuration git ou par l’environnement) est toujours
//! respecté, et la vérification des certificats n’est jamais désactivée.

use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::OnceLock;

/// Fichier PEM des racines du système, celui qu’Alfred écrit déjà pour la voix (`certificats/` des données).
static ROOTS_BUNDLE: OnceLock<PathBuf> = OnceLock::new();
/// Les racines en PEM ont réussi là où le premier essai échouait : on commence par elles la fois suivante.
static PREFER_BUNDLE: AtomicBool = AtomicBool::new(false);

/// Dossier des données d’Alfred, pour y écrire les racines du système quand git en a besoin.
pub fn init(data_dir: &Path) {
    let _ = ROOTS_BUNDLE.set(data_dir.join("certificats").join("racines-du-systeme.pem"));
}

/// Chemin du PEM des racines du système (écrit seulement quand un essai s’en sert, par `write_roots`).
pub(crate) fn roots_bundle() -> PathBuf {
    ROOTS_BUNDLE
        .get()
        .cloned()
        .unwrap_or_else(|| std::env::temp_dir().join("alfred-certificats").join("racines-du-systeme.pem"))
}

/// Racines ajoutées à celles du système dans les tests, comme l’autorité qu’une entreprise installe sur ses postes.
#[cfg(test)]
pub(crate) static TEST_ROOTS: std::sync::Mutex<Vec<Vec<u8>>> = std::sync::Mutex::new(Vec::new());

/// Écrit (ou rafraîchit) le PEM des racines du système, avec le code qui le fait déjà pour la voix.
pub(crate) fn write_roots(path: &Path) -> bool {
    #[cfg(test)]
    {
        let extra = TEST_ROOTS.lock().unwrap().clone();
        if !extra.is_empty() {
            let native = rustls_native_certs::load_native_certs().certs;
            let all = native.iter().map(|cert| cert.as_ref()).chain(extra.iter().map(Vec::as_slice));
            return crate::model_files::write_pem(path, all).is_ok();
        }
    }
    match crate::model_files::write_system_roots(path) {
        Ok(_) => true,
        Err(error) => {
            log::warn!("certificats du système non exportés pour git : {error}");
            false
        }
    }
}

pub(crate) fn prefer_bundle() -> bool {
    PREFER_BUNDLE.load(Ordering::Relaxed)
}

pub(crate) fn remember_bundle(worked: bool) {
    PREFER_BUNDLE.store(worked, Ordering::Relaxed);
}

// ---------------------------------------------------------------------------------------------------------------
// Configuration de l’utilisateur
// ---------------------------------------------------------------------------------------------------------------

/// Ce que l’utilisateur a déjà réglé lui-même pour l’adresse visée.
#[derive(Debug, Default, Clone, Copy, PartialEq, Eq)]
pub(crate) struct UserTls {
    /// `http.sslBackend`, `http.sslCAInfo` ou `http.sslCAPath` (global ou du dépôt), ou `GIT_SSL_CAINFO` /
    /// `GIT_SSL_CAPATH`.
    pub configured: bool,
}

/// Lit, dans la sortie de `git config --global/--local --get-regexp ^http\.` (une ligne « clé valeur »), les
/// réglages de certificats qui valent pour `url`. La configuration du système n’en fait pas partie : Git for
/// Windows y écrit lui-même `http.sslBackend` et `http.sslCAInfo` à l’installation, ce n’est pas un choix de
/// l’utilisateur. Une clé propre à une adresse (`http.https://exemple.fr/.sslCAInfo`) ne compte que pour elle.
pub(crate) fn user_tls(listing: &str, url: &str, env: impl Fn(&str) -> Option<String>) -> UserTls {
    let from_env = ["GIT_SSL_CAINFO", "GIT_SSL_CAPATH"].iter().any(|name| env(name).is_some_and(|v| !v.trim().is_empty()));
    let from_config = listing.lines().filter_map(|line| http_key(line, url)).any(|key| {
        matches!(key.as_str(), "sslbackend" | "sslcainfo" | "sslcapath")
    });
    UserTls { configured: from_env || from_config }
}

/// Variable d’une ligne `http.[<adresse>.]<variable> valeur`, en minuscules, si elle vaut pour `url`.
fn http_key(line: &str, url: &str) -> Option<String> {
    let key = line.split_whitespace().next()?;
    let rest = key.strip_prefix("http.").or_else(|| key.strip_prefix("HTTP."))?;
    let (scope, variable) = match rest.rfind('.') {
        Some(at) => (Some(&rest[..at]), &rest[at + 1..]),
        None => (None, rest),
    };
    if let Some(scope) = scope {
        if !url_matches(scope, url) {
            return None;
        }
    }
    Some(variable.to_ascii_lowercase())
}

/// Adresse d’une sous-section `http.<adresse>.*` qui couvre `url` (préfixe, en ignorant la casse de l’hôte).
fn url_matches(scope: &str, url: &str) -> bool {
    let scope = scope.trim_end_matches('/').to_ascii_lowercase();
    let url = url.to_ascii_lowercase();
    url == scope || url.starts_with(&format!("{scope}/")) || url.starts_with(&format!("{scope}:"))
}

// ---------------------------------------------------------------------------------------------------------------
// Certificats
// ---------------------------------------------------------------------------------------------------------------

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum Platform {
    Windows,
    Other,
}

impl Platform {
    pub fn current() -> Self {
        if cfg!(windows) {
            Platform::Windows
        } else {
            Platform::Other
        }
    }
}

/// Un essai de connexion : les `-c` à passer à git, et ce qu’ils représentent pour le compte rendu d’erreur.
#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) struct TlsAttempt {
    pub options: Vec<String>,
    pub label: &'static str,
}

impl TlsAttempt {
    /// L’essai lit le PEM des racines exporté par Alfred, qu’il faut donc écrire avant.
    pub fn uses_bundle(&self) -> bool {
        self.options.iter().any(|option| option.starts_with("http.sslCAInfo="))
    }
}

/// Essais à faire, dans l’ordre. Le second n’est tenté que si le premier échoue sur un certificat (ou si Git ne
/// connaît pas schannel). `bundle` est le PEM des racines du système ; sans lui, pas de second essai.
pub(crate) fn tls_attempts(platform: Platform, user: UserTls, bundle: Option<&Path>, bundle_first: bool) -> Vec<TlsAttempt> {
    if user.configured {
        return vec![TlsAttempt { options: Vec::new(), label: "réglage git de l’utilisateur" }];
    }
    let primary = match platform {
        Platform::Windows => TlsAttempt {
            options: vec!["http.sslBackend=schannel".to_string()],
            label: "magasin de certificats de Windows",
        },
        Platform::Other => TlsAttempt { options: Vec::new(), label: "certificats de git" },
    };
    let Some(bundle) = bundle else {
        return vec![primary];
    };
    let path = bundle.to_string_lossy().replace('\\', "/");
    let mut options = Vec::new();
    if platform == Platform::Windows {
        // schannel ne lit pas http.sslCAInfo ; OpenSSL, si.
        options.push("http.sslBackend=openssl".to_string());
    }
    options.push(format!("http.sslCAInfo={path}"));
    let fallback = TlsAttempt { options, label: "racines du système exportées par Alfred" };
    if bundle_first {
        vec![fallback, primary]
    } else {
        vec![primary, fallback]
    }
}

/// L’échec tient au certificat du serveur (ou à la vérification de sa révocation) : un autre jeu de racines peut
/// réussir.
pub(crate) fn certificate_failure(stderr: &str) -> bool {
    let lower = stderr.to_lowercase();
    CERTIFICATE.iter().chain(REVOCATION.iter()).chain(UNSUPPORTED_BACKEND.iter()).any(|needle| lower.contains(needle))
}

const CERTIFICATE: [&str; 11] = [
    "ssl certificate problem",
    "unable to get local issuer certificate",
    "self signed certificate",
    "self-signed certificate",
    "certificate verify failed",
    "server certificate verification failed",
    "unable to verify the first certificate",
    "sec_e_untrusted_root",
    "0x80090325",
    "not trusted",
    "cert_trust",
];
const REVOCATION: [&str; 4] = ["crypt_e_no_revocation_check", "crypt_e_revocation_offline", "0x80092012", "revocation"];
const UNSUPPORTED_BACKEND: [&str; 2] = ["unsupported ssl backend", "could not set ssl backend"];

// ---------------------------------------------------------------------------------------------------------------
// Proxy
// ---------------------------------------------------------------------------------------------------------------

/// Proxy des « Paramètres Internet » de Windows (clés `ProxyEnable`, `ProxyServer`, `ProxyOverride`,
/// `AutoConfigURL` de `HKCU\Software\Microsoft\Windows\CurrentVersion\Internet Settings`).
#[derive(Debug, Default, Clone, PartialEq, Eq)]
pub(crate) struct SystemProxy {
    pub enabled: bool,
    pub server: Option<String>,
    pub bypass: Option<String>,
    /// Fichier PAC désigné par `AutoConfigURL`, et le proxy unique qu’il nomme quand il n’en nomme qu’un.
    pub pac_proxy: Option<String>,
}

/// Le proxy à passer à git pour `url`, ou `None` : git en a déjà un (`git_proxy`, de sa configuration ou de
/// l’environnement), l’adresse n’est pas en HTTP(S), le système n’en a pas, ou l’hôte en est exempté (`NO_PROXY`,
/// `ProxyOverride`).
pub(crate) fn proxy_for(url: &str, git_proxy: bool, system: &SystemProxy, no_proxy: Option<&str>) -> Option<String> {
    if git_proxy {
        return None;
    }
    let (scheme, host) = scheme_and_host(url)?;
    if no_proxy.is_some_and(|list| no_proxy_matches(list, &host)) {
        return None;
    }
    if system.bypass.as_deref().is_some_and(|list| bypass_matches(list, &host)) {
        return None;
    }
    let chosen = if system.enabled { system.server.as_deref().and_then(|server| pick_server(server, &scheme)) } else { None };
    let chosen = chosen.or_else(|| system.pac_proxy.clone())?;
    Some(if chosen.contains("://") { chosen } else { format!("http://{chosen}") })
}

/// Variable d’environnement qui donne déjà un proxy à git (curl lit les minuscules, git aussi les majuscules).
pub(crate) fn env_proxy(env: impl Fn(&str) -> Option<String>) -> bool {
    ["HTTPS_PROXY", "https_proxy", "HTTP_PROXY", "http_proxy", "ALL_PROXY", "all_proxy"]
        .iter()
        .any(|name| env(name).is_some_and(|value| !value.trim().is_empty()))
}

/// `ProxyServer` : « hôte:port » pour tout, ou « http=a:80;https=b:443;… » par protocole.
fn pick_server(server: &str, scheme: &str) -> Option<String> {
    let server = server.trim();
    if server.is_empty() {
        return None;
    }
    if !server.contains('=') {
        return Some(server.to_string());
    }
    let entries: Vec<(String, String)> = server
        .split(';')
        .filter_map(|entry| entry.split_once('='))
        .map(|(protocol, address)| (protocol.trim().to_ascii_lowercase(), address.trim().to_string()))
        .filter(|(_, address)| !address.is_empty())
        .collect();
    let find = |protocol: &str| entries.iter().find(|(name, _)| name == protocol).map(|(_, address)| address.clone());
    if scheme == "https" {
        find("https").or_else(|| find("http"))
    } else {
        find("http")
    }
}

/// Protocole (http ou https) et hôte d’une adresse, sans identifiants ni port.
pub(crate) fn scheme_and_host(url: &str) -> Option<(String, String)> {
    let (scheme, rest) = url.split_once("://")?;
    let scheme = scheme.to_ascii_lowercase();
    if scheme != "http" && scheme != "https" {
        return None;
    }
    let authority = rest.split(['/', '?', '#']).next().unwrap_or_default();
    let authority = authority.rsplit_once('@').map_or(authority, |(_, host)| host);
    let host = if let Some(bracketed) = authority.strip_prefix('[') {
        bracketed.split(']').next().unwrap_or_default()
    } else {
        authority.split(':').next().unwrap_or_default()
    };
    (!host.is_empty()).then(|| (scheme, host.to_ascii_lowercase()))
}

/// `NO_PROXY` : liste séparée par des virgules ; `*` exempte tout, `exemple.fr` et `.exemple.fr` exemptent
/// l’hôte et ses sous-domaines.
fn no_proxy_matches(list: &str, host: &str) -> bool {
    list.split([',', ' ']).map(str::trim).filter(|entry| !entry.is_empty()).any(|entry| {
        let entry = entry.to_ascii_lowercase();
        let entry = entry.split(':').next().unwrap_or_default();
        if entry == "*" {
            return true;
        }
        let domain = entry.trim_start_matches("*.").trim_start_matches('.');
        host == domain || host.ends_with(&format!(".{domain}"))
    })
}

/// `ProxyOverride` : liste séparée par des points-virgules, avec jokers `*` ; `<local>` exempte les noms sans
/// point.
fn bypass_matches(list: &str, host: &str) -> bool {
    list.split(';').map(str::trim).filter(|entry| !entry.is_empty()).any(|entry| {
        let entry = entry.to_ascii_lowercase();
        if entry == "<local>" {
            return !host.contains('.');
        }
        let entry = entry.split_once("://").map_or(entry.as_str(), |(_, rest)| rest);
        wildcard(entry, host)
    })
}

fn wildcard(pattern: &str, text: &str) -> bool {
    let parts: Vec<&str> = pattern.split('*').collect();
    if parts.len() == 1 {
        return pattern == text;
    }
    let (first, last) = (parts[0], parts[parts.len() - 1]);
    if !text.starts_with(first) || !text.ends_with(last) || text.len() < first.len() + last.len() {
        return false;
    }
    let mut rest = &text[first.len()..text.len() - last.len()];
    for part in &parts[1..parts.len() - 1] {
        match rest.find(part) {
            Some(at) => rest = &rest[at + part.len()..],
            None => return false,
        }
    }
    true
}

/// Le proxy d’un fichier PAC quand il n’en nomme qu’un (le cas courant : `DIRECT` pour le réseau interne, ce
/// proxy pour Internet). Plusieurs proxys, ou aucun : `None`, la logique du fichier n’est pas exécutée.
pub(crate) fn pac_single_proxy(script: &str) -> Option<String> {
    let mut found: Vec<String> = Vec::new();
    let upper = script.to_ascii_uppercase();
    let mut from = 0;
    while let Some(at) = upper[from..].find("PROXY ") {
        let start = from + at + "PROXY ".len();
        let address: String = script[start..]
            .trim_start()
            .chars()
            .take_while(|c| c.is_ascii_alphanumeric() || matches!(c, '.' | '-' | ':' | '_'))
            .collect();
        // « PROXY " + variable » ou un nom sans port ne disent pas l’adresse.
        if address.contains(':') && !found.contains(&address) {
            found.push(address);
        }
        from = start;
    }
    (found.len() == 1).then(|| found.remove(0))
}

/// Interprète la sortie de `reg query "HKCU\…\Internet Settings"`, dont les noms et les types ne sont pas traduits.
pub(crate) fn parse_internet_settings(output: &str) -> SystemProxy {
    let mut proxy = SystemProxy::default();
    for line in output.lines() {
        let mut fields = line.split_whitespace();
        let (Some(name), Some(kind)) = (fields.next(), fields.next()) else { continue };
        if !kind.starts_with("REG_") {
            continue;
        }
        let value = fields.collect::<Vec<_>>().join(" ");
        match name {
            "ProxyEnable" => proxy.enabled = u32::from_str_radix(value.trim_start_matches("0x"), 16).is_ok_and(|v| v != 0),
            "ProxyServer" if !value.is_empty() => proxy.server = Some(value),
            "ProxyOverride" if !value.is_empty() => proxy.bypass = Some(value),
            "AutoConfigURL" if !value.is_empty() => proxy.pac_proxy = Some(value),
            _ => {}
        }
    }
    proxy
}

/// Proxy du système sous Windows (vide ailleurs). L’adresse du PAC, s’il y en a une, est remplacée par le proxy
/// qu’il nomme quand il n’en nomme qu’un ; le PAC n’est lu qu’une fois par lancement d’Alfred.
pub(crate) fn system_proxy() -> SystemProxy {
    if !cfg!(windows) {
        return SystemProxy::default();
    }
    let output = hidden_command("reg")
        .args(["query", r"HKCU\Software\Microsoft\Windows\CurrentVersion\Internet Settings"])
        .output();
    let Ok(output) = output else { return SystemProxy::default() };
    let mut proxy = parse_internet_settings(&String::from_utf8_lossy(&output.stdout));
    proxy.pac_proxy = proxy.pac_proxy.take().and_then(|url| pac_proxy_of(&url));
    proxy
}

/// Proxy trouvé (ou non) pour chaque adresse de PAC déjà lue.
type PacCache = std::sync::Mutex<Vec<(String, Option<String>)>>;

fn pac_proxy_of(url: &str) -> Option<String> {
    static PAC: OnceLock<PacCache> = OnceLock::new();
    let cache = PAC.get_or_init(Default::default);
    if let Some((_, known)) = cache.lock().ok()?.iter().find(|(known, _)| known == url) {
        return known.clone();
    }
    let script = if let Some(path) = url.strip_prefix("file:///").or_else(|| url.strip_prefix("file://")) {
        std::fs::read_to_string(path).ok()
    } else {
        // curl.exe est livré avec Windows 10 et 11 ; il prend le proxy et les certificats du système (schannel).
        hidden_command("curl")
            .args(["--silent", "--fail", "--location", "--max-time", "5", "--", url])
            .output()
            .ok()
            .filter(|output| output.status.success())
            .map(|output| String::from_utf8_lossy(&output.stdout).into_owned())
    };
    let found = script.as_deref().and_then(pac_single_proxy);
    if let Ok(mut cache) = cache.lock() {
        cache.push((url.to_string(), found.clone()));
    }
    found
}

fn hidden_command(program: &str) -> std::process::Command {
    #[allow(unused_mut)]
    let mut command = std::process::Command::new(program);
    command.stdin(std::process::Stdio::null());
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        command.creation_flags(0x0800_0000);
    }
    command
}

// ---------------------------------------------------------------------------------------------------------------
// Messages
// ---------------------------------------------------------------------------------------------------------------

/// Retire les identifiants d’une adresse (`https://jeton@hôte`, `http://nom:mot@proxy`) partout dans un texte.
pub(crate) fn redact(text: &str) -> String {
    let mut out = String::with_capacity(text.len());
    let mut rest = text;
    while let Some(at) = rest.find("://") {
        let (before, after) = rest.split_at(at + 3);
        out.push_str(before);
        let end = after.find(|c: char| c.is_whitespace() || matches!(c, '/' | '\'' | '"' | '>' | ')')).unwrap_or(after.len());
        let authority = &after[..end];
        match authority.rfind('@') {
            Some(arobase) => {
                out.push_str("***");
                out.push_str(&authority[arobase..]);
            }
            None => out.push_str(authority),
        }
        rest = &after[end..];
    }
    out.push_str(rest);
    out
}

/// Ce que l’on sait de la tentative, pour rédiger le message.
#[derive(Debug, Default, Clone)]
pub(crate) struct Context {
    pub host: Option<String>,
    pub proxy: Option<String>,
    /// Le proxy vient du système (et non de la configuration de l’utilisateur).
    pub system_proxy: bool,
}

/// Phrase en français pour l’échec d’une opération distante, d’après la sortie d’erreur de git (déjà expurgée).
pub(crate) fn explain(stderr: &str, action: &str, context: &Context) -> String {
    let lower = stderr.to_lowercase();
    let mentions = |needles: &[&str]| needles.iter().any(|needle| lower.contains(needle));
    let host = context.host.as_deref().unwrap_or("le serveur");
    let via = match (&context.proxy, context.system_proxy) {
        (Some(proxy), true) => format!(" Git est passé par le proxy du système, {proxy}."),
        (Some(proxy), false) => format!(" Git est passé par le proxy {proxy}."),
        (None, _) => String::new(),
    };
    if mentions(&["detected dubious ownership"]) {
        return format!(
            "Git refuse le dossier du clone ({action}) : il appartient à un autre utilisateur du poste. Retirez puis rebranchez le marketplace."
        );
    }
    if mentions(&["http code 407", "error: 407", "proxy authentication required"]) {
        return format!(
            "Le proxy demande une identification ({action}).{via} Git ne peut pas la donner seul : indiquez votre identifiant dans le proxy de git (git config --global http.proxy http://identifiant@proxy:port) ou demandez à votre service informatique d’ouvrir {host}."
        );
    }
    if mentions(&["could not resolve proxy", "proxy connect aborted", "from proxy after connect", "connect tunnel failed"]) {
        return format!("Le proxy ne répond pas ({action}).{via} Vérifiez le proxy réglé sur ce poste.");
    }
    if mentions(&REVOCATION) {
        return format!(
            "Git n’a pas pu vérifier la révocation du certificat de {host} ({action}) : le serveur de révocation est injoignable depuis ce réseau. Alfred a aussi essayé les racines du système, sans succès.{via} Voyez « Derrière un réseau d’entreprise » dans la documentation d’Alfred."
        );
    }
    if mentions(&CERTIFICATE) {
        return format!(
            "Le certificat de {host} n’est pas reconnu ({action}) : le réseau passe sans doute par une autorité de certification d’entreprise. Alfred a essayé les certificats du système, sans succès.{via} Demandez le certificat racine à votre service informatique, puis réglez-le avec git config --global http.sslCAInfo <fichier>."
        );
    }
    if mentions(&UNSUPPORTED_BACKEND) {
        return format!(
            "Cette version de Git ne sait pas lire les certificats du système ({action}). Mettez Git à jour, ou réglez git config --global http.sslCAInfo <fichier>."
        );
    }
    if mentions(&[
        "authentication failed",
        "permission denied",
        "could not read username",
        "could not read password",
        "terminal prompts disabled",
        "access denied",
        "error: 401",
        "error: 403",
        "returned error: 401",
        "returned error: 403",
        "publickey",
    ]) {
        return format!(
            "Accès refusé ({action}). Les identifiants git configurés sur ce poste ne donnent pas accès à ce dépôt."
        );
    }
    if mentions(&["repository not found", "does not appear to be a git repository", "does not exist", "error: 404"]) {
        return format!("Dépôt introuvable ({action}). Vérifiez l’adresse.");
    }
    if mentions(&[
        "could not resolve host",
        "failed to connect",
        "couldn't connect",
        "connection timed out",
        "operation timed out",
        "timed out",
        "network is unreachable",
        "connection refused",
        "connection reset",
        "unable to access",
    ]) {
        let advice = if context.proxy.is_none() {
            " Git y est allé sans proxy : si votre réseau en impose un, réglez-le avec git config --global http.proxy http://proxy:port."
        } else {
            ""
        };
        return format!("{host} est injoignable ({action}).{via}{advice} Vérifiez aussi le réseau et l’adresse.");
    }
    match last_line(stderr) {
        Some(line) => format!("Git a échoué ({action}) : {line}"),
        None => format!("Git a échoué ({action})."),
    }
}

/// Dernière ligne parlante de git (« fatal: … », « error: … »), sans son préfixe.
fn last_line(stderr: &str) -> Option<String> {
    let lines: Vec<&str> = stderr.lines().map(str::trim).filter(|line| !line.is_empty()).collect();
    let pick = lines
        .iter()
        .rev()
        .find(|line| line.starts_with("fatal:") || line.starts_with("error:"))
        .or(lines.last())?;
    let text = pick.trim_start_matches("fatal:").trim_start_matches("error:").trim();
    let text: String = text.chars().take(240).collect();
    (!text.is_empty()).then_some(text)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn no_env(_: &str) -> Option<String> {
        None
    }

    #[test]
    fn the_user_s_own_certificate_settings_are_kept() {
        let url = "https://github.com/NeKeR53/alfred.place";
        assert!(!user_tls("", url, no_env).configured);
        assert!(!user_tls("http.lowspeedlimit 1000\nhttp.postbuffer 524288000", url, no_env).configured);
        assert!(user_tls("http.sslbackend openssl", url, no_env).configured);
        assert!(user_tls("http.sslcainfo C:/certs/entreprise.pem", url, no_env).configured);
        assert!(user_tls("http.https://github.com/.sslcainfo /etc/ca.pem", url, no_env).configured);
        assert!(!user_tls("http.https://gitlab.exemple.fr/.sslcainfo /etc/ca.pem", url, no_env).configured);
        assert!(!user_tls("http.https://github.com.evil/.sslcainfo /etc/ca.pem", url, no_env).configured);
        let env = |name: &str| (name == "GIT_SSL_CAINFO").then(|| "/etc/ca.pem".to_string());
        assert!(user_tls("", url, env).configured);
    }

    #[test]
    fn windows_tries_its_store_then_the_exported_roots_and_never_skips_verification() {
        let bundle = Path::new(r"C:\Users\camille\AppData\Roaming\alfred\certificats\racines-du-systeme.pem");
        let windows = tls_attempts(Platform::Windows, UserTls::default(), Some(bundle), false);
        assert_eq!(windows[0].options, ["http.sslBackend=schannel"]);
        assert_eq!(
            windows[1].options,
            ["http.sslBackend=openssl", "http.sslCAInfo=C:/Users/camille/AppData/Roaming/alfred/certificats/racines-du-systeme.pem"]
        );
        let unix = tls_attempts(Platform::Other, UserTls::default(), Some(Path::new("/d/racines.pem")), false);
        assert!(unix[0].options.is_empty(), "Mac et Linux gardent d’abord le réglage de git");
        assert_eq!(unix[1].options, ["http.sslCAInfo=/d/racines.pem"]);
        let remembered = tls_attempts(Platform::Other, UserTls::default(), Some(Path::new("/d/racines.pem")), true);
        assert_eq!(remembered[0].options, ["http.sslCAInfo=/d/racines.pem"]);
        let user = tls_attempts(Platform::Windows, UserTls { configured: true }, Some(bundle), false);
        assert_eq!(user.len(), 1);
        assert!(user[0].options.is_empty(), "réglage de l’utilisateur respecté");
        assert_eq!(tls_attempts(Platform::Windows, UserTls::default(), None, false).len(), 1);
        for attempt in windows.iter().chain(&unix).chain(&user) {
            assert!(attempt.options.iter().all(|option| !option.to_lowercase().contains("sslverify")));
        }
    }

    #[test]
    fn only_certificate_failures_call_for_other_roots() {
        assert!(certificate_failure(
            "fatal: unable to access 'https://github.com/x/': SSL certificate problem: unable to get local issuer certificate"
        ));
        assert!(certificate_failure(
            "fatal: unable to access 'https://github.com/x/': schannel: next InitializeSecurityContext failed: SEC_E_UNTRUSTED_ROOT (0x80090325)"
        ));
        assert!(certificate_failure("fatal: unable to access 'https://github.com/x/': schannel: next InitializeSecurityContext failed: Unknown error (0x80092012) - The revocation function was unable to check revocation for the certificate."));
        assert!(certificate_failure("fatal: unable to access 'https://github.com/x/': Unsupported SSL backend 'schannel'. Supported SSL backends:\n\topenssl"));
        assert!(!certificate_failure("fatal: unable to access 'https://github.com/x/': Could not resolve host: github.com"));
        assert!(!certificate_failure("remote: Repository not found."));
    }

    #[test]
    fn the_windows_proxy_is_read_and_its_exemptions_respected() {
        let reg = "\r\nHKEY_CURRENT_USER\\Software\\Microsoft\\Windows\\CurrentVersion\\Internet Settings\r\n    \
                   DisableCachingOfSSLPages    REG_DWORD    0x0\r\n    ProxyEnable    REG_DWORD    0x1\r\n    \
                   ProxyServer    REG_SZ    proxy.entreprise.fr:8080\r\n    \
                   ProxyOverride    REG_SZ    *.entreprise.fr;10.*;<local>\r\n";
        let system = parse_internet_settings(reg);
        assert_eq!(
            system,
            SystemProxy {
                enabled: true,
                server: Some("proxy.entreprise.fr:8080".into()),
                bypass: Some("*.entreprise.fr;10.*;<local>".into()),
                pac_proxy: None,
            }
        );
        let github = "https://github.com/NeKeR53/alfred.place";
        assert_eq!(proxy_for(github, false, &system, None).as_deref(), Some("http://proxy.entreprise.fr:8080"));
        assert_eq!(proxy_for(github, true, &system, None), None, "le proxy de git l’emporte");
        assert_eq!(proxy_for("https://git.entreprise.fr/modules.git", false, &system, None), None);
        assert_eq!(proxy_for("https://10.0.0.4/modules.git", false, &system, None), None);
        assert_eq!(proxy_for("http://forge/modules.git", false, &system, None), None, "<local>");
        assert_eq!(proxy_for(github, false, &system, Some("localhost,.github.com")), None, "NO_PROXY");
        assert_eq!(proxy_for(github, false, &system, Some("*")), None);
        assert_eq!(proxy_for("git@github.com:NeKeR53/alfred.place.git", false, &system, None), None, "SSH");
        assert_eq!(proxy_for("/tmp/depot.git", false, &system, None), None);
        let disabled = SystemProxy { enabled: false, ..system.clone() };
        assert_eq!(proxy_for(github, false, &disabled, None), None);
        let per_protocol = SystemProxy { server: Some("http=p1:80;https=p2:3128;ftp=p3:21".into()), ..system.clone() };
        assert_eq!(proxy_for(github, false, &per_protocol, None).as_deref(), Some("http://p2:3128"));
        assert_eq!(proxy_for("http://exemple.org/x", false, &per_protocol, None).as_deref(), Some("http://p1:80"));
        let pac = SystemProxy { enabled: false, pac_proxy: Some("proxy.pac.fr:3128".into()), ..Default::default() };
        assert_eq!(proxy_for(github, false, &pac, None).as_deref(), Some("http://proxy.pac.fr:3128"));
        assert!(!parse_internet_settings("    ProxyEnable    REG_DWORD    0x0\r\n").enabled);
        assert!(env_proxy(|name| (name == "https_proxy").then(|| "http://p:1".to_string())));
        assert!(!env_proxy(no_env));
    }

    #[test]
    fn a_pac_file_is_used_only_when_it_names_a_single_proxy() {
        let simple = r#"function FindProxyForURL(url, host) {
            if (isPlainHostName(host) || dnsDomainIs(host, ".entreprise.fr")) return "DIRECT";
            return "PROXY proxy.entreprise.fr:8080; DIRECT";
        }"#;
        assert_eq!(pac_single_proxy(simple).as_deref(), Some("proxy.entreprise.fr:8080"));
        let two = r#"if (x) return "PROXY a.fr:8080"; return "PROXY b.fr:8080";"#;
        assert_eq!(pac_single_proxy(two), None);
        assert_eq!(pac_single_proxy(r#"return "PROXY " + p;"#), None);
        assert_eq!(pac_single_proxy("return \"DIRECT\";"), None);
    }

    #[test]
    fn tokens_never_reach_a_message() {
        assert_eq!(
            redact("fatal: unable to access 'https://ghp_abc123@github.com/x/': Failed to connect"),
            "fatal: unable to access 'https://***@github.com/x/': Failed to connect"
        );
        assert_eq!(redact("proxy http://camille:secret@proxy:8080 refuse"), "proxy http://***@proxy:8080 refuse");
        assert_eq!(redact("https://github.com/x et rien d’autre"), "https://github.com/x et rien d’autre");
    }

    #[test]
    fn git_failures_are_explained_in_french() {
        let github = Context { host: Some("github.com".into()), ..Default::default() };
        let via = Context { host: Some("github.com".into()), proxy: Some("http://proxy:8080".into()), system_proxy: true };
        let cert = explain(
            "fatal: unable to access 'https://github.com/NeKeR53/alfred.place/': SSL certificate problem: unable to get local issuer certificate",
            "rafraîchissement",
            &github,
        );
        assert!(cert.starts_with("Le certificat de github.com n’est pas reconnu (rafraîchissement)"), "{cert}");
        let schannel = explain(
            "fatal: unable to access 'https://github.com/x/': schannel: SEC_E_UNTRUSTED_ROOT (0x80090325) - The certificate chain was issued by an authority that is not trusted.",
            "clonage",
            &github,
        );
        assert!(schannel.starts_with("Le certificat de github.com"), "{schannel}");
        let revoke = explain("fatal: unable to access 'x': schannel: ... (0x80092012) - The revocation function was unable to check revocation", "rafraîchissement", &via);
        assert!(revoke.contains("révocation") && revoke.contains("http://proxy:8080"), "{revoke}");
        let auth = explain("fatal: unable to access 'x': Received HTTP code 407 from proxy after CONNECT", "rafraîchissement", &via);
        assert!(auth.starts_with("Le proxy demande une identification"), "{auth}");
        let resolve = explain("fatal: unable to access 'https://github.com/x/': Could not resolve host: github.com", "rafraîchissement", &github);
        assert!(resolve.starts_with("github.com est injoignable (rafraîchissement).") && resolve.contains("sans proxy"), "{resolve}");
        let timeout = explain("fatal: unable to access 'x': Failed to connect to github.com port 443 after 21040 ms: Timed out", "publication", &via);
        assert!(timeout.contains("injoignable") && timeout.contains("proxy du système") && !timeout.contains("sans proxy"), "{timeout}");
        let proxy_down = explain("fatal: unable to access 'x': Could not resolve proxy: proxy.entreprise.fr", "rafraîchissement", &via);
        assert!(proxy_down.starts_with("Le proxy ne répond pas"), "{proxy_down}");
        let denied = explain("remote: Invalid username or password.\nfatal: Authentication failed for 'https://github.com/x/'", "publication", &github);
        assert!(denied.starts_with("Accès refusé (publication)"), "{denied}");
        let missing = explain("remote: Repository not found.\nfatal: repository 'https://github.com/x/' not found", "clonage", &github);
        assert!(missing.starts_with("Dépôt introuvable (clonage)"), "{missing}");
        let owner = explain("fatal: detected dubious ownership in repository at 'C:/x'", "rafraîchissement", &github);
        assert!(owner.starts_with("Git refuse le dossier"), "{owner}");
        let other = explain("warning: quelque chose\nfatal: early EOF", "rafraîchissement", &github);
        assert_eq!(other, "Git a échoué (rafraîchissement) : early EOF");
    }
}
