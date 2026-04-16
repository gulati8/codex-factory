import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import type { AppConfig } from "../src/config.js";
import type { ProjectManifest } from "../src/domain/types.js";
import { FileStateStore } from "../src/store/file-state-store.js";
import { MissionService } from "../src/services/mission-service.js";
import { Planner } from "../src/services/planner.js";
import { PolicyEngine } from "../src/services/policy-engine.js";
import { WorkerRuntime } from "../src/services/worker-runtime.js";

describe("MissionService", () => {
  let tmpDir: string;
  let store: FileStateStore;
  let service: MissionService;

  const manifest: ProjectManifest = {
    projectId: "client-portal",
    displayName: "Client Portal",
    repoPath: "/repos/client-portal",
    runtimeContainer: "node:22-bookworm-slim",
    maxParallelWorkers: 3,
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
    risk: {
      highRiskGlobs: ["src/auth/**", "db/migrations/**"],
      architectureGlobs: ["src/domain/**", "db/schema/**"],
      securityGlobs: ["src/auth/**"],
      docsGlobs: ["docs/**", "src/api/**"],
    },
  };

  beforeEach(async () => {
    tmpDir = await mkdtemp(path.join(os.tmpdir(), "solo-factory-"));
    store = new FileStateStore(path.join(tmpDir, "state.json"));
    await store.init();

    const config: AppConfig = {
      PORT: 4000,
      HOST: "127.0.0.1",
      DATA_FILE: path.join(tmpDir, "state.json"),
      MANIFESTS_DIR: path.join(tmpDir, "manifests"),
      ARTIFACTS_DIR: path.join(tmpDir, "artifacts"),
      DEFAULT_WORKTREE_ROOT: path.join(tmpDir, "worktrees"),
      DEFAULT_CONTAINER_IMAGE: "node:22-bookworm-slim",
      HEARTBEAT_TIMEOUT_SECONDS: 600,
      QUEUE_POLL_INTERVAL_MS: 100,
      STAGE_TIMEOUT_MS: 1000,
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

    service = new MissionService({
      store,
      policyEngine: new PolicyEngine(),
      planner: new Planner(),
      workerRuntime: new WorkerRuntime(config),
    });
  });

  afterEach(async () => {
    await rm(tmpDir, { recursive: true, force: true });
  });

  it("creates a mission that pauses for plan approval", async () => {
    const mission = await service.createMission(
      {
        projectId: "client-portal",
        title: "Add audit trail",
        request: "Add an audit trail endpoint for billing actions",
        changedPaths: ["src/payments/ledger.ts", "src/api/audit.ts"],
        autonomyMode: "managed",
        actor: "test",
      },
      manifest,
    );

    expect(mission.status).toBe("awaiting_plan_approval");
    expect(mission.approval.planApproved).toBe(false);
    expect(mission.stages.some((stage) => stage.kind === "review")).toBe(true);
    expect(mission.stages.some((stage) => stage.kind === "qa")).toBe(true);
    expect(mission.stages.some((stage) => stage.kind === "docs")).toBe(true);
  });

  it("emits mission events through the listener seam", async () => {
    const received: string[] = [];
    const config: AppConfig = {
      PORT: 4000,
      HOST: "127.0.0.1",
      DATA_FILE: path.join(tmpDir, "listener-state.json"),
      MANIFESTS_DIR: path.join(tmpDir, "manifests"),
      ARTIFACTS_DIR: path.join(tmpDir, "artifacts"),
      DEFAULT_WORKTREE_ROOT: path.join(tmpDir, "worktrees"),
      DEFAULT_CONTAINER_IMAGE: "node:22-bookworm-slim",
      HEARTBEAT_TIMEOUT_SECONDS: 600,
      QUEUE_POLL_INTERVAL_MS: 100,
      STAGE_TIMEOUT_MS: 1000,
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

    const listenerService = new MissionService({
      store,
      policyEngine: new PolicyEngine(),
      planner: new Planner(),
      workerRuntime: new WorkerRuntime(config),
      onMissionEvent: async ({ event }) => {
        received.push(event.type);
      },
    });

    await listenerService.createMission(
      {
        projectId: "client-portal",
        title: "Listener mission",
        request: "Create a mission and observe the callback",
        changedPaths: ["src/api/report.ts"],
        autonomyMode: "managed",
        actor: "test",
      },
      manifest,
    );

    expect(received).toEqual(["mission.created"]);
  });

  it("dispatches independent implementation lanes after approval", async () => {
    const mission = await service.createMission(
      {
        projectId: "client-portal",
        title: "Update API and docs",
        request: "Update the API response and docs for the usage report",
        changedPaths: ["src/api/report.ts", "docs/reports.md"],
        autonomyMode: "managed",
        actor: "test",
      },
      manifest,
    );

    await service.approvePlan(mission.id, "amit");
    const { mission: dispatched, envelopes } = await service.dispatch(mission.id, manifest);

    expect(dispatched.status).toBe("running");
    expect(envelopes.length).toBeGreaterThan(0);
    expect(envelopes.every((envelope) => envelope.worktreePath.includes(mission.id))).toBe(true);
  });

  it("promotes dependent stages when an implementation lane completes", async () => {
    const mission = await service.createMission(
      {
        projectId: "client-portal",
        title: "Update reports",
        request: "Update the API response for the usage report",
        changedPaths: ["src/api/report.ts"],
        autonomyMode: "managed",
        actor: "test",
      },
      manifest,
    );

    await service.approvePlan(mission.id, "amit");
    const { mission: dispatched } = await service.dispatch(mission.id, manifest);
    const implementStage = dispatched.stages.find((stage) => stage.kind === "implement");
    expect(implementStage).toBeTruthy();

    await service.markStageStarted(mission.id, implementStage!.id, "worker");
    const updated = await service.completeStage(mission.id, implementStage!.id, "worker", "Implementation done.");

    expect(updated.stages.some((stage) => stage.kind === "integrate" && stage.status === "ready")).toBe(true);
  });

  it("can reschedule a failed stage for retry", async () => {
    const mission = await service.createMission(
      {
        projectId: "client-portal",
        title: "Retry reports",
        request: "Update the API response for the usage report",
        changedPaths: ["src/api/report.ts"],
        autonomyMode: "managed",
        actor: "test",
      },
      manifest,
    );

    await service.approvePlan(mission.id, "amit");
    const { mission: dispatched } = await service.dispatch(mission.id, manifest);
    const implementStage = dispatched.stages.find((stage) => stage.kind === "implement");
    expect(implementStage).toBeTruthy();

    await service.markStageStarted(mission.id, implementStage!.id, "worker");
    await service.completeStage(mission.id, implementStage!.id, "worker", "First attempt failed.", true);
    const retried = await service.scheduleRetry(mission.id, implementStage!.id, "system", "Retry scheduled.");
    const failedEvents = service.listEvents(mission.id).filter((event) => event.type === "stage.failed");

    expect(retried.stages.find((stage) => stage.id === implementStage!.id)?.status).toBe("ready");
    expect(failedEvents).toHaveLength(1);
    expect(service.listEvents(mission.id).some((event) => event.type === "stage.retry_scheduled")).toBe(true);
  });

  it("can escalate a failed stage into blocked state", async () => {
    const mission = await service.createMission(
      {
        projectId: "client-portal",
        title: "Escalate reports",
        request: "Update the API response for the usage report",
        changedPaths: ["src/api/report.ts"],
        autonomyMode: "managed",
        actor: "test",
      },
      manifest,
    );

    await service.approvePlan(mission.id, "amit");
    const { mission: dispatched } = await service.dispatch(mission.id, manifest);
    const implementStage = dispatched.stages.find((stage) => stage.kind === "implement");
    expect(implementStage).toBeTruthy();

    await service.markStageStarted(mission.id, implementStage!.id, "worker");
    await service.completeStage(mission.id, implementStage!.id, "worker", "First attempt failed.", true);
    const escalated = await service.escalateStage(mission.id, implementStage!.id, "amit", "Needs human input.");

    expect(escalated.status).toBe("blocked");
    expect(escalated.stages.find((stage) => stage.id === implementStage!.id)?.status).toBe("blocked");
    expect(service.listEvents(mission.id).some((event) => event.type === "stage.escalated")).toBe(true);
  });
});
