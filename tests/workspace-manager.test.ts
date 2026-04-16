import { execFile } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import type { AppConfig } from "../src/config.js";
import type { ProjectManifest } from "../src/domain/types.js";
import { WorkspaceManager } from "../src/services/workspace-manager.js";
import type { WorkerEnvelope } from "../src/services/worker-runtime.js";

const execFileAsync = promisify(execFile);

describe("WorkspaceManager", () => {
  let tmpDir: string;
  let config: AppConfig;

  beforeEach(async () => {
    tmpDir = await mkdtemp(path.join(os.tmpdir(), "codex-factory-workspace-"));
    config = {
      PORT: 4000,
      HOST: "127.0.0.1",
      DATA_FILE: path.join(tmpDir, "state.json"),
      MANIFESTS_DIR: path.join(tmpDir, "manifests"),
      ARTIFACTS_DIR: path.join(tmpDir, "artifacts"),
      DEFAULT_WORKTREE_ROOT: path.join(tmpDir, "worktrees"),
      DEFAULT_CONTAINER_IMAGE: "node:22-bookworm-slim",
      HEARTBEAT_TIMEOUT_SECONDS: 600,
      QUEUE_POLL_INTERVAL_MS: 100,
      STAGE_TIMEOUT_MS: 5000,
      STATE_BACKEND: "file",
      POSTGRES_URL: undefined,
      GITHUB_TOKEN: undefined,
      SLACK_SOCKET_MODE: false,
      SLACK_COMMAND_NAME: "/codex-factory",
      SLACK_APP_TOKEN: undefined,
      SLACK_SIGNING_SECRET: undefined,
      SLACK_BOT_TOKEN: undefined,
      SLACK_IDENTITY_CACHE_TTL_SECONDS: 300,
      SLACK_ALLOWED_TIMESTAMP_AGE_SECONDS: 300,
    };
  });

  afterEach(async () => {
    await rm(tmpDir, { recursive: true, force: true });
  });

  it("recreates a stale worktree path when retrying the same stage", async () => {
    const repoPath = path.join(tmpDir, "repo");
    const worktreePath = path.join(tmpDir, "worktrees", "mission_1", "implement_1");
    await execFileAsync("git", ["init", repoPath]);
    await execFileAsync("git", ["-C", repoPath, "config", "user.name", "Codex Factory"]);
    await execFileAsync("git", ["-C", repoPath, "config", "user.email", "factory@example.com"]);
    await writeFile(path.join(repoPath, "README.md"), "hello\n", "utf8");
    await execFileAsync("git", ["-C", repoPath, "add", "README.md"]);
    await execFileAsync("git", ["-C", repoPath, "commit", "-m", "init"]);

    await execFileAsync("git", ["-C", repoPath, "worktree", "add", "--detach", worktreePath, "HEAD"]);
    await writeFile(path.join(worktreePath, "STALE.txt"), "stale\n", "utf8");

    const manifest: ProjectManifest = {
      projectId: "codex-factory",
      displayName: "Codex Factory",
      repoPath,
      runtimeContainer: "node:22-bookworm-slim",
      maxParallelWorkers: 2,
      commands: {
        install: ":",
        lint: "npm run lint",
        test: "npm run test",
        build: "npm run build",
      },
      approval: {
        requirePlanApproval: true,
        allowRiskBasedAutonomy: true,
        allowFireAndForget: false,
      },
      slack: {
        allowedChannelIds: [],
        allowedChannels: [],
        operatorUsers: [],
        approverUsers: [],
        responseType: "ephemeral",
        notifications: {
          channelIds: [],
          channelNames: [],
          events: ["mission.created", "plan.approved", "stage.failed", "stage.retry_scheduled", "stage.escalated"],
        },
      },
      retry: {
        maxAttempts: 2,
        retryableStages: ["implement", "review", "docs", "qa", "integrate"],
      },
      risk: {
        highRiskGlobs: ["src/auth/**"],
        architectureGlobs: ["src/domain/**"],
        securityGlobs: ["src/auth/**"],
        docsGlobs: ["docs/**"],
      },
    };

    const envelope: WorkerEnvelope = {
      missionId: "mission_1",
      stageId: "implement_1",
      stageKind: "implement",
      workerHint: "implement-worker",
      repoPath,
      worktreePath,
      containerImage: "node:22-bookworm-slim",
      successCriteria: [],
    };

    const manager = new WorkspaceManager(config);
    const lease = await manager.prepare(manifest, envelope);

    expect(lease.mode).toBe("git-worktree");
    expect(await readFile(path.join(lease.path, "README.md"), "utf8")).toBe("hello\n");
    await expect(readFile(path.join(lease.path, "STALE.txt"), "utf8")).rejects.toThrow();
  });

  it("installs dependencies with development npm settings in worker worktrees", async () => {
    const repoPath = path.join(tmpDir, "repo");
    const worktreePath = path.join(tmpDir, "worktrees", "mission_2", "qa_1");
    await execFileAsync("git", ["init", repoPath]);
    await execFileAsync("git", ["-C", repoPath, "config", "user.name", "Codex Factory"]);
    await execFileAsync("git", ["-C", repoPath, "config", "user.email", "factory@example.com"]);
    await writeFile(path.join(repoPath, "README.md"), "hello\n", "utf8");
    await execFileAsync("git", ["-C", repoPath, "add", "README.md"]);
    await execFileAsync("git", ["-C", repoPath, "commit", "-m", "init"]);

    const manifest: ProjectManifest = {
      projectId: "codex-factory",
      displayName: "Codex Factory",
      repoPath,
      runtimeContainer: "node:22-bookworm-slim",
      maxParallelWorkers: 2,
      commands: {
        install:
          "node -e \"require('node:fs').writeFileSync('install-env.json', JSON.stringify({NODE_ENV: process.env.NODE_ENV, NPM_CONFIG_PRODUCTION: process.env.NPM_CONFIG_PRODUCTION, npm_config_production: process.env.npm_config_production}))\"",
        lint: "npm run lint",
        test: "npm run test",
        build: "npm run build",
      },
      approval: {
        requirePlanApproval: true,
        allowRiskBasedAutonomy: true,
        allowFireAndForget: false,
      },
      slack: {
        allowedChannelIds: [],
        allowedChannels: [],
        operatorUsers: [],
        approverUsers: [],
        responseType: "ephemeral",
        notifications: {
          channelIds: [],
          channelNames: [],
          events: ["mission.created", "plan.approved", "stage.failed", "stage.retry_scheduled", "stage.escalated"],
        },
      },
      retry: {
        maxAttempts: 2,
        retryableStages: ["implement", "review", "docs", "qa", "integrate"],
      },
      risk: {
        highRiskGlobs: ["src/auth/**"],
        architectureGlobs: ["src/domain/**"],
        securityGlobs: ["src/auth/**"],
        docsGlobs: ["docs/**"],
      },
    };

    const envelope: WorkerEnvelope = {
      missionId: "mission_2",
      stageId: "qa_1",
      stageKind: "qa",
      workerHint: "qa-worker",
      repoPath,
      worktreePath,
      containerImage: "node:22-bookworm-slim",
      successCriteria: [],
    };

    const manager = new WorkspaceManager(config);
    const lease = await manager.prepare(manifest, envelope);
    const installEnv = JSON.parse(await readFile(path.join(lease.path, "install-env.json"), "utf8"));

    expect(installEnv).toMatchObject({
      NODE_ENV: "development",
      NPM_CONFIG_PRODUCTION: "false",
      npm_config_production: "false",
    });
  });
});
