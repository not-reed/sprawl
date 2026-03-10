/** Error during database operations (connection, query, dialect). */
export class DatabaseError extends Error {
  override name = "DatabaseError" as const;
}

/** Error during migration execution. */
export class MigrationError extends Error {
  override name = "MigrationError" as const;
}
