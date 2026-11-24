//! Python dans Alfred : le SDK `import alfred` et son pont vers le cœur (`bridge`), un noyau vivant par module
//! (`kernel`) et les objets que les pages y créent (`objects`).

pub mod bridge;
pub mod env;
pub mod kernel;
pub mod objects;
