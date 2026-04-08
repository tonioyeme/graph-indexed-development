pub mod error;
pub mod trait_def;
pub mod schema;

#[cfg(feature = "sqlite")]
pub mod sqlite;

#[cfg(feature = "sqlite")]
pub mod migration;

// Re-export key types for convenience.
pub use error::{StorageError, StorageOp, StorageResult};
pub use trait_def::{BatchOp, GraphStorage, NodeFilter};
pub use schema::SCHEMA_SQL;

#[cfg(feature = "sqlite")]
pub use sqlite::SqliteStorage;

#[cfg(feature = "sqlite")]
pub use migration::{migrate, MigrationConfig, MigrationReport, MigrationError, MigrationStatus, ValidationLevel};
