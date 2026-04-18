import { readdir, readFile } from "node:fs/promises";
import path from "node:path";

import { Pool } from "pg";

import {
  projectManifestSchema,
  projectRecordSchema,
  type ProjectManifest,
  type ProjectRecord,
} from "../domain/types.js";

function nowIso(): string {
  return new Date().toISOString();
}

export class ManifestStore {
  private readonly manifestsDir: string;
  private readonly pool?: Pool;
  private readonly shouldClosePool: boolean;
  private cache = new Map<string, ProjectRecord>();

  public constructor(manifestsDir: string, options?: { postgresUrl?: string }) {
    this.manifestsDir = manifestsDir;
    if (options?.postgresUrl) {
      this.pool = new Pool({
        connectionString: options.postgresUrl,
      });
      this.shouldClosePool = true;
      return;
    }

    this.shouldClosePool = false;
  }

  public async init(): Promise<void> {
    if (this.pool) {
      await this.pool.query(`
        create table if not exists projects (
          project_id text primary key,
          created_at timestamptz not null,
          updated_at timestamptz not null,
          payload jsonb not null
        );
      `);

      const result = await this.pool.query<{ payload: ProjectRecord }>("select payload from projects");
      for (const row of result.rows) {
        const record = projectRecordSchema.parse(row.payload);
        this.cache.set(record.projectId, record);
      }
    }

    await this.bootstrapManifests();
  }

  public async close(): Promise<void> {
    if (this.shouldClosePool && this.pool) {
      await this.pool.end();
    }
  }

  public list(): ProjectManifest[] {
    return this.listRecords()
      .filter((record) => record.status === "active")
      .map((record) => record.manifest);
  }

  public listRecords(): ProjectRecord[] {
    return [...this.cache.values()].sort((left, right) => left.projectId.localeCompare(right.projectId));
  }

  public get(projectId: string): ProjectManifest {
    const record = this.getRecord(projectId);
    if (record.status !== "active") {
      throw new Error(`Project ${projectId} is not active yet.`);
    }

    return record.manifest;
  }

  public getRecord(projectId: string): ProjectRecord {
    const record = this.cache.get(projectId);
    if (!record) {
      throw new Error(`Unknown project: ${projectId}`);
    }

    return record;
  }

  public findActiveByChannel(channel: { id?: string; name?: string }): ProjectRecord | undefined {
    const channelId = channel.id?.trim().toLowerCase();
    const channelName = channel.name?.trim().toLowerCase().replace(/^#/, "");

    return this.listRecords().find((record) => {
      if (record.status !== "active") {
        return false;
      }

      if (channelId && record.binding.defaultChannelId?.toLowerCase() === channelId) {
        return true;
      }

      if (channelName && record.binding.defaultChannelName?.toLowerCase() === channelName) {
        return true;
      }

      return false;
    });
  }

  public async saveRecord(record: ProjectRecord): Promise<ProjectRecord> {
    const parsed = projectRecordSchema.parse(record);
    this.cache.set(parsed.projectId, parsed);

    if (this.pool) {
      await this.pool.query(
        `
          insert into projects (project_id, created_at, updated_at, payload)
          values ($1, $2::timestamptz, $3::timestamptz, $4::jsonb)
          on conflict (project_id)
          do update set updated_at = excluded.updated_at, payload = excluded.payload
        `,
        [parsed.projectId, parsed.createdAt, parsed.updatedAt, JSON.stringify(parsed)],
      );
    }

    return parsed;
  }

  public async activateProject(projectId: string): Promise<ProjectRecord> {
    const record = this.getRecord(projectId);
    const updated: ProjectRecord = {
      ...record,
      status: "active",
      updatedAt: nowIso(),
    };

    return this.saveRecord(updated);
  }

  private async bootstrapManifests(): Promise<void> {
    let entries: Array<{ isFile(): boolean; name: string }>;
    try {
      entries = await readdir(this.manifestsDir, { withFileTypes: true });
    } catch {
      return;
    }

    for (const entry of entries) {
      if (!entry.isFile() || !entry.name.endsWith(".json")) {
        continue;
      }

      const fullPath = path.join(this.manifestsDir, entry.name);
      const raw = await readFile(fullPath, "utf8");
      const parsedManifest = projectManifestSchema.parse(JSON.parse(raw));
      if (this.cache.has(parsedManifest.projectId)) {
        continue;
      }

      const timestamp = nowIso();
      const seedRecord: ProjectRecord = {
        projectId: parsedManifest.projectId,
        status: "active",
        manifest: parsedManifest,
        access: {
          repoUrl: parsedManifest.repoPath,
          clonePath: parsedManifest.repoPath,
          defaultBranch: null,
          validationStatus: "accessible",
          lastValidatedAt: timestamp,
          remediation: null,
        },
        binding: {
          defaultChannelId: parsedManifest.slack.notifications.channelIds[0] ?? parsedManifest.slack.allowedChannelIds[0] ?? null,
          defaultChannelName:
            parsedManifest.slack.notifications.channelNames[0] ?? parsedManifest.slack.allowedChannels[0] ?? null,
        },
        inference: {
          confidence: 1,
          notes: ["Bootstrapped from a static manifest."],
        },
        createdBy: "manifest-bootstrap",
        createdAt: timestamp,
        updatedAt: timestamp,
      };

      await this.saveRecord(seedRecord);
    }
  }
}
