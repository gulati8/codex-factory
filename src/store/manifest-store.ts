import { readdir, readFile } from "node:fs/promises";
import path from "node:path";

import { projectManifestSchema, type ProjectManifest } from "../domain/types.js";

export class ManifestStore {
  private readonly manifestsDir: string;
  private cache = new Map<string, ProjectManifest>();

  public constructor(manifestsDir: string) {
    this.manifestsDir = manifestsDir;
  }

  public async init(): Promise<void> {
    const entries = await readdir(this.manifestsDir, { withFileTypes: true });
    for (const entry of entries) {
      if (!entry.isFile() || !entry.name.endsWith(".json")) {
        continue;
      }

      const fullPath = path.join(this.manifestsDir, entry.name);
      const raw = await readFile(fullPath, "utf8");
      const parsed = projectManifestSchema.parse(JSON.parse(raw));
      this.cache.set(parsed.projectId, parsed);
    }
  }

  public list(): ProjectManifest[] {
    return [...this.cache.values()].sort((left, right) => left.projectId.localeCompare(right.projectId));
  }

  public get(projectId: string): ProjectManifest {
    const manifest = this.cache.get(projectId);
    if (!manifest) {
      throw new Error(`Unknown project manifest: ${projectId}`);
    }

    return manifest;
  }
}
