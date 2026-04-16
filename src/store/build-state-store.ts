import type { AppConfig } from "../config.js";
import { FileStateStore } from "./file-state-store.js";
import { PostgresStateStore } from "./postgres-state-store.js";
import type { StateStore } from "./state-store.js";

export function buildStateStore(config: AppConfig): StateStore {
  if (config.STATE_BACKEND === "postgres") {
    if (!config.POSTGRES_URL) {
      throw new Error("POSTGRES_URL is required when STATE_BACKEND=postgres.");
    }

    return new PostgresStateStore(config.POSTGRES_URL);
  }

  return new FileStateStore(config.DATA_FILE);
}
