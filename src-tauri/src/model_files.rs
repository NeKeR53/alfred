//! Modèles locaux téléchargés à la demande depuis Hugging Face (recherche par le sens, décisions) : chaque fichier à
//! une révision figée, son empreinte SHA-256 vérifiée avant d’être mis en place, dans le dossier de données d’Alfred.
//! Rien de tout cela n’est dans le dépôt ni dans l’installeur.

use std::path::Path;

use crate::error::{AppError, AppResult};

/// Un modèle : le dépôt Hugging Face, sa révision figée, et chaque fichier avec son empreinte.
pub struct ModelSpec {
    pub repo: &'static str,
    pub revision: &'static str,
    /// Chemin dans le dépôt (et sous le dossier du modèle), empreinte SHA-256.
    pub files: &'static [(&'static str, &'static str)],
}

impl ModelSpec {
    /// Tous les fichiers sont là (leur empreinte n’est pas relue ici : c’est au chargement).
    pub fn installed(&self, dir: &Path) -> bool {
        self.files.iter().all(|(file, _)| dir.join(file).is_file())
    }
}

pub fn sha256_file(path: &Path) -> AppResult<String> {
    use sha2::{Digest, Sha256};
    let mut file = std::fs::File::open(path)?;
    let mut hasher = Sha256::new();
    std::io::copy(&mut file, &mut hasher)?;
    Ok(hasher.finalize().iter().map(|byte| format!("{byte:02x}")).collect())
}

/// Télécharge les fichiers manquants ou abîmés, l’un après l’autre. `progress(reçu, total)` suit l’ensemble ;
/// `total_hint` est la taille annoncée, tant que les tailles réelles ne sont pas connues.
pub async fn fetch(
    spec: &ModelSpec,
    dir: &Path,
    total_hint: u64,
    error: impl Fn(String) -> AppError,
    progress: impl Fn(u64, u64),
) -> AppResult<()> {
    use sha2::{Digest, Sha256};
    use tokio::io::AsyncWriteExt;
    tokio::fs::create_dir_all(dir).await?;
    let http = reqwest::Client::builder().user_agent("Alfred").build().map_err(|failure| error(failure.to_string()))?;
    let mut received_before = 0u64;
    for (file, expected) in spec.files {
        let target = dir.join(file);
        if target.is_file() {
            let path = target.clone();
            let digest = tokio::task::spawn_blocking(move || sha256_file(&path)).await.map_err(|failure| error(failure.to_string()))??;
            if digest == *expected {
                continue;
            }
            tokio::fs::remove_file(&target).await?;
        }
        if let Some(parent) = target.parent() {
            tokio::fs::create_dir_all(parent).await?;
        }
        let url = format!("https://huggingface.co/{}/resolve/{}/{file}", spec.repo, spec.revision);
        let mut response = http.get(&url).send().await.map_err(|failure| error(failure.to_string()))?;
        if !response.status().is_success() {
            return Err(error(format!("{file} : réponse {}", response.status())));
        }
        let total = response.content_length().unwrap_or(0);
        let partial = target.with_file_name(format!("{}.part", target.file_name().and_then(|name| name.to_str()).unwrap_or("modele")));
        let mut out = tokio::fs::File::create(&partial).await?;
        let mut hasher = Sha256::new();
        let mut received = 0u64;
        while let Some(chunk) = response.chunk().await.map_err(|failure| error(failure.to_string()))? {
            hasher.update(&chunk);
            out.write_all(&chunk).await?;
            received += chunk.len() as u64;
            progress(received_before + received, (received_before + total).max(total_hint));
        }
        out.flush().await?;
        drop(out);
        let digest: String = hasher.finalize().iter().map(|byte| format!("{byte:02x}")).collect();
        if digest != *expected {
            let _ = tokio::fs::remove_file(&partial).await;
            return Err(error(format!("{file} : empreinte inattendue, fichier écarté.")));
        }
        tokio::fs::rename(&partial, &target).await?;
        received_before += received;
    }
    Ok(())
}
