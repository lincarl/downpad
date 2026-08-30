// A single serializable error type for all Tauri commands. The frontend
// receives `{ kind, message }` (see src/ipc/contracts.ts).

use serde::Serialize;

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AppError {
    pub kind: String,
    pub message: String,
}

impl AppError {
    pub fn new(kind: &str, message: impl Into<String>) -> Self {
        AppError {
            kind: kind.into(),
            message: message.into(),
        }
    }

    pub fn io(message: impl Into<String>) -> Self {
        AppError::new("io", message)
    }

    pub fn encoding(message: impl Into<String>) -> Self {
        AppError::new("encoding", message)
    }
}

impl std::fmt::Display for AppError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(f, "{}: {}", self.kind, self.message)
    }
}

impl std::error::Error for AppError {}

impl From<std::io::Error> for AppError {
    fn from(e: std::io::Error) -> Self {
        AppError::io(e.to_string())
    }
}
