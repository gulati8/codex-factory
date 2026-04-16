import { execFile } from "node:child_process";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import type { AppConfig } from "../src/config.js";
import type { Mission, MissionStage, ProjectManifest, StageRun } from "../src/domain/types.js";
import { ArtifactStore } from "../src/services/artifact-store.js";
import { StageExecutor } from "../src/services/stage-executor.js";
import { WorkerRuntime } from "../src/services/worker-runtime.js";

const execFileAsync = promisify(execFile);

describe("StageExecutor", () => {
  let tmpDir: string;
  let config: AppConfig;

  beforeEach(async () => {
    tmpDir = await mkdtemp(path.join(os.tmpdir(), "solo-factory-executor-"));
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

  async function initializeGitWorkspace(workspacePath: string): Promise<void> {
    await execFileAsync("git", ["init", workspacePath]);
    await execFileAsync("git", ["-C", workspacePath, "config", "user.name", "Codex Factory"]);
    await execFileAsync("git", ["-C", workspacePath, "config", "user.email", "factory@example.com"]);
    await writeFile(path.join(workspacePath, "README.md"), "seed\n", "utf8");
    await execFileAsync("git", ["-C", workspacePath, "add", "README.md"]);
    await execFileAsync("git", ["-C", workspacePath, "commit", "-m", "init"]);
  }

  it("runs an external agent command when the manifest enables it", async () => {
    const manifest: ProjectManifest = {
      projectId: "client-portal",
      displayName: "Client Portal",
      repoPath: "/repos/client-portal",
      runtimeContainer: "node:22-bookworm-slim",
      maxParallelWorkers: 2,
      commands: {
        install: "npm install",
        lint: "npm run lint",
        test: "npm run test",
        build: "npm run build",
      },
      approval: {
        requirePlanApproval: true,
        allowRiskBasedAutonomy: true,
        allowFireAndForget: true,
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
      agentRunner: {
        enabled: true,
        command: "node",
        args: [path.resolve(process.cwd(), "scripts/example-agent-runner.mjs")],
        env: {},
        stages: ["implement"],
      },
      risk: {
        highRiskGlobs: ["src/auth/**"],
        architectureGlobs: ["src/domain/**"],
        securityGlobs: ["src/auth/**"],
        docsGlobs: ["docs/**"],
      },
    };

    const mission: Mission = {
      id: "mission_test",
      projectId: "client-portal",
      title: "Implement report update",
      request: "Update the usage report response shape.",
      changedPaths: ["implement-agent-output.md"],
      autonomyMode: "managed",
      riskLevel: "medium",
      status: "running",
      plan: {
        summary: "Update the usage report response shape.",
        objectives: ["Change the API output."],
        assumptions: ["One workstream is enough."],
        workstreams: [
          {
            id: "lane-1",
            title: "Workstream: src",
            paths: ["implement-agent-output.md"],
            goal: "Modify the implementation artifact.",
          },
        ],
        routeDecisions: ["Implementation only for test."],
      },
      approval: {
        planApproved: true,
        mergeApprovalRequired: true,
        approvedBy: "amit",
        approvedAt: new Date().toISOString(),
      },
      stages: [],
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    };

    const stage: MissionStage = {
      id: "implement_test",
      kind: "implement",
      label: "Implement #1",
      status: "ready",
      required: true,
      dependsOn: [],
      workstreamId: "lane-1",
      workerHint: "implement-worker",
      notes: ["Own the implementation lane."],
      lastHeartbeatAt: null,
      updatedAt: new Date().toISOString(),
    };

    const workerRuntime = new WorkerRuntime(config);
    const artifactStore = new ArtifactStore(config);
    const envelope = workerRuntime.buildEnvelopeForStage(mission, manifest, stage);
    await mkdir(envelope.worktreePath, { recursive: true });
    await initializeGitWorkspace(envelope.worktreePath);
    await artifactStore.initStage(mission, stage, envelope);

    const stageRun: StageRun = {
      missionId: mission.id,
      stageId: stage.id,
      stageKind: stage.kind,
      status: "running",
      attempt: 1,
      startedAt: new Date().toISOString(),
      finishedAt: null,
      worktreePath: envelope.worktreePath,
      artifactDir: artifactStore.artifactDirForStage(mission.id, stage.id),
      summary: "Running implement stage.",
    };

    const executor = new StageExecutor(config);
    const result = await executor.execute({
      mission,
      stage,
      manifest,
      stageRun,
      workspace: {
        path: envelope.worktreePath,
        mode: "git-worktree",
      },
      artifactStore,
    });

    expect(result.status).toBe("completed");
    expect(result.summary).toContain("External agent runner completed");

    const output = await readFile(path.join(envelope.worktreePath, "implement-agent-output.md"), "utf8");
    expect(output).toContain("Example Agent Output");

    const prompt = await readFile(artifactStore.stagePromptPathForStage(mission.id, stage.id), "utf8");
    expect(prompt).toContain("Stage Prompt");
  });

  it("fails implement stages when the external runner leaves assigned paths untouched", async () => {
    const manifest: ProjectManifest = {
      projectId: "client-portal",
      displayName: "Client Portal",
      repoPath: "/repos/client-portal",
      runtimeContainer: "node:22-bookworm-slim",
      maxParallelWorkers: 2,
      commands: {
        install: "npm install",
        lint: "npm run lint",
        test: "npm run test",
        build: "npm run build",
      },
      approval: {
        requirePlanApproval: true,
        allowRiskBasedAutonomy: true,
        allowFireAndForget: true,
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
      agentRunner: {
        enabled: true,
        command: "node",
        args: [path.resolve(process.cwd(), "scripts/example-agent-runner.mjs")],
        env: {},
        stages: ["implement"],
      },
      risk: {
        highRiskGlobs: ["src/auth/**"],
        architectureGlobs: ["src/domain/**"],
        securityGlobs: ["src/auth/**"],
        docsGlobs: ["docs/**"],
      },
    };

    const mission: Mission = {
      id: "mission_test",
      projectId: "client-portal",
      title: "Implement report update",
      request: "Update the usage report response shape.",
      changedPaths: ["src/api/report.ts"],
      autonomyMode: "managed",
      riskLevel: "medium",
      status: "running",
      plan: {
        summary: "Update the usage report response shape.",
        objectives: ["Change the API output."],
        assumptions: ["One workstream is enough."],
        workstreams: [
          {
            id: "lane-1",
            title: "Workstream: src",
            paths: ["src/api/report.ts"],
            goal: "Modify the API response implementation.",
          },
        ],
        routeDecisions: ["Implementation only for test."],
      },
      approval: {
        planApproved: true,
        mergeApprovalRequired: true,
        approvedBy: "amit",
        approvedAt: new Date().toISOString(),
      },
      stages: [],
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    };

    const stage: MissionStage = {
      id: "implement_test",
      kind: "implement",
      label: "Implement #1",
      status: "ready",
      required: true,
      dependsOn: [],
      workstreamId: "lane-1",
      workerHint: "implement-worker",
      notes: ["Own the implementation lane."],
      lastHeartbeatAt: null,
      updatedAt: new Date().toISOString(),
    };

    const workerRuntime = new WorkerRuntime(config);
    const artifactStore = new ArtifactStore(config);
    const envelope = workerRuntime.buildEnvelopeForStage(mission, manifest, stage);
    await mkdir(path.join(envelope.worktreePath, "src", "api"), { recursive: true });
    await initializeGitWorkspace(envelope.worktreePath);
    await writeFile(path.join(envelope.worktreePath, "src", "api", "report.ts"), "export const report = true;\n", "utf8");
    await execFileAsync("git", ["-C", envelope.worktreePath, "add", "src/api/report.ts"]);
    await execFileAsync("git", ["-C", envelope.worktreePath, "commit", "-m", "add report"]);
    await artifactStore.initStage(mission, stage, envelope);

    const stageRun: StageRun = {
      missionId: mission.id,
      stageId: stage.id,
      stageKind: stage.kind,
      status: "running",
      attempt: 1,
      startedAt: new Date().toISOString(),
      finishedAt: null,
      worktreePath: envelope.worktreePath,
      artifactDir: artifactStore.artifactDirForStage(mission.id, stage.id),
      summary: "Running implement stage.",
    };

    const executor = new StageExecutor(config);
    const result = await executor.execute({
      mission,
      stage,
      manifest,
      stageRun,
      workspace: {
        path: envelope.worktreePath,
        mode: "git-worktree",
      },
      artifactStore,
    });

    expect(result.status).toBe("failed");
    expect(result.summary).toContain("without changing assigned paths");
  });
});
