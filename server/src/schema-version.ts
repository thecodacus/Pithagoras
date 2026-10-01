import path from "node:path";
import { DATA_DIR } from "./data-dir.js";

/**
 * The schema's version, kept in SQLite's `user_version`. Raise it with any
 * change to what getDb creates or migrate() does: a database below it is
 * checked and backed up before the change is made (see db-upgrade.ts), and one
 * already at it starts without either.
 *
 * In a file of its own so that the check at startup can read it without
 * loading the database module, which opens the database as it is used.
 */
export const SCHEMA_VERSION = 2;

/** The database file. */
export const dbFile = () => path.join(DATA_DIR, "portal.db");
