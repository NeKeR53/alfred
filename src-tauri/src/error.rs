use serde::Serialize;

/// Erreur renvoyée à l’interface : un message en français, affichable tel quel.
#[derive(Debug, Clone, Serialize)]
pub struct AppError {
    pub message: String,
    /// Détail technique (sortie de commande, diagnostics), jamais un secret.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub detail: Option<serde_json::Value>,
}

pub type AppResult<T> = Result<T, AppError>;

impl AppError {
    pub fn new(message: impl Into<String>) -> Self {
        Self { message: message.into(), detail: None }
    }

    pub fn with_detail(message: impl Into<String>, detail: serde_json::Value) -> Self {
        Self { message: message.into(), detail: Some(detail) }
    }
}

impl std::fmt::Display for AppError {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        formatter.write_str(&self.message)
    }
}

impl std::error::Error for AppError {}

impl From<std::io::Error> for AppError {
    fn from(error: std::io::Error) -> Self {
        Self::new(format!("Accès au disque impossible : {error}"))
    }
}

impl From<serde_json::Error> for AppError {
    fn from(error: serde_json::Error) -> Self {
        Self::new(format!("Format JSON invalide : {error}"))
    }
}

impl From<rusqlite::Error> for AppError {
    fn from(error: rusqlite::Error) -> Self {
        Self::new(format!("Base de données : {error}"))
    }
}

/// Lit un champ obligatoire des arguments d’une commande.
pub fn arg<T: serde::de::DeserializeOwned>(args: &serde_json::Value, name: &str) -> AppResult<T> {
    let value = args.get(name).cloned().unwrap_or(serde_json::Value::Null);
    serde_json::from_value(value).map_err(|error| AppError::new(format!("Argument « {name} » invalide : {error}")))
}

/// Lit un champ facultatif des arguments d’une commande.
pub fn opt_arg<T: serde::de::DeserializeOwned>(args: &serde_json::Value, name: &str) -> AppResult<Option<T>> {
    match args.get(name) {
        None | Some(serde_json::Value::Null) => Ok(None),
        Some(value) => serde_json::from_value(value.clone())
            .map(Some)
            .map_err(|error| AppError::new(format!("Argument « {name} » invalide : {error}"))),
    }
}
