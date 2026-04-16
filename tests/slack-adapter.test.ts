import crypto from "node:crypto";

import { describe, expect, it } from "vitest";

import type { AppConfig } from "../src/config.js";
import type { Mission } from "../src/domain/types.js";
import {
  ensureSlackAuthorized,
  ensureSlackChannelAllowed,
  formatMissionSlackMessage,
  parseSlackActionValue,
  verifySlackRequest,
} from "../src/adapters/slack.js";

const baseConfig: AppConfig = {
  PORT: 4000,
  HOST: "127.0.0.1",
  DATA_FILE: "./data/state.json",
  MANIFESTS_DIR: "./manifests",
  ARTIFACTS_DIR: "./runtime/artifacts",
  DEFAULT_WORKTREE_ROOT: "./runtime/worktrees",
  DEFAULT_CONTAINER_IMAGE: "node:22-bookworm-slim",
  HEARTBEAT_TIMEOUT_SECONDS: 600,
  QUEUE_POLL_INTERVAL_MS: 2000,
  STAGE_TIMEOUT_MS: 900000,
  STATE_BACKEND: "file",
  POSTGRES_URL: undefined,
  GITHUB_TOKEN: undefined,
  SLACK_SOCKET_MODE: false,
  SLACK_COMMAND_NAME: "/codex-factory",
  SLACK_APP_TOKEN: undefined,
  SLACK_SIGNING_SECRET: "topsecret",
  SLACK_BOT_TOKEN: undefined,
  SLACK_IDENTITY_CACHE_TTL_SECONDS: 300,
  SLACK_ALLOWED_TIMESTAMP_AGE_SECONDS: 300,
};

describe("Slack adapter", () => {
  it("verifies a valid Slack signature", () => {
    const timestamp = Math.floor(Date.now() / 1000).toString();
    const rawBody = "token=x&text=status%20mission_123";
    const signature = `v0=${crypto
      .createHmac("sha256", baseConfig.SLACK_SIGNING_SECRET!)
      .update(`v0:${timestamp}:${rawBody}`)
      .digest("hex")}`;

    expect(
      verifySlackRequest({
        rawBody,
        timestamp,
        signature,
        config: baseConfig,
      }),
    ).toBe(true);
  });

  it("rejects malformed Slack signatures without throwing", () => {
    const timestamp = Math.floor(Date.now() / 1000).toString();

    expect(
      verifySlackRequest({
        rawBody: "token=x&text=status%20mission_123",
        timestamp,
        signature: "v0=deadbeef",
        config: baseConfig,
      }),
    ).toBe(false);
  });

  it("formats approve and retry controls for Slack", () => {
    const mission: Mission = {
      id: "mission_123",
      projectId: "client-portal",
      title: "Slack Mission",
      request: "Update reporting output",
      changedPaths: ["src/api/report.ts"],
      autonomyMode: "managed",
      riskLevel: "medium",
      status: "failed",
      plan: {
        summary: "Update reporting output with explicit gates.",
        objectives: ["Change the API output."],
        assumptions: ["One workstream is enough."],
        workstreams: [],
        routeDecisions: [],
      },
      approval: {
        planApproved: false,
        mergeApprovalRequired: true,
        approvedBy: null,
        approvedAt: null,
      },
      stages: [
        {
          id: "stage_failed",
          kind: "implement",
          label: "Implement #1",
          status: "failed",
          required: true,
          dependsOn: [],
          workerHint: "implement-worker",
          notes: [],
          lastHeartbeatAt: null,
          updatedAt: new Date().toISOString(),
        },
      ],
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    };

    const message = formatMissionSlackMessage({
      mission,
      stageRuns: [
        {
          missionId: mission.id,
          stageId: "stage_failed",
          stageKind: "implement",
          status: "failed",
          attempt: 1,
          startedAt: new Date().toISOString(),
          finishedAt: new Date().toISOString(),
          worktreePath: "/tmp/worktree",
          artifactDir: "/tmp/artifacts",
          summary: "First attempt failed.",
        },
      ],
      health: [],
    });

    expect(message.blocks.some((block) => block.type === "actions")).toBe(true);
    expect(JSON.stringify(message.blocks)).toContain("approve_plan");
    expect(JSON.stringify(message.blocks)).toContain("retry_stage");
    expect(JSON.stringify(message.blocks)).toContain("escalate_stage");
  });

  it("parses action values", () => {
    expect(parseSlackActionValue(JSON.stringify({ missionId: "mission_123", stageId: "stage_1" }))).toEqual({
      missionId: "mission_123",
      stageId: "stage_1",
    });
  });

  it("enforces Slack authorization lists when configured", () => {
    expect(() =>
      ensureSlackAuthorized({
        identity: { id: "U_DENIED", username: "denied" },
        manifest: {
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
            operatorUsers: ["U_OK"],
            approverUsers: ["U_APPROVER"],
            responseType: "ephemeral",
            notifications: {
              channelIds: [],
              channelNames: [],
              events: ["mission.created", "plan.approved", "stage.failed", "stage.retry_scheduled", "stage.escalated"],
            },
          },
          retry: {
            maxAttempts: 2,
            retryableStages: ["implement"],
          },
          risk: {
            highRiskGlobs: [],
            architectureGlobs: [],
            securityGlobs: [],
            docsGlobs: [],
          },
        },
        capability: "operate",
      }),
    ).toThrow(/not authorized/i);
  });

  it("enforces Slack channel allow-lists when configured", () => {
    expect(() =>
      ensureSlackChannelAllowed({
        channel: { id: "C_DENIED" },
        manifest: {
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
            allowedChannelIds: ["C_FACTORY"],
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
            retryableStages: ["implement"],
          },
          risk: {
            highRiskGlobs: [],
            architectureGlobs: [],
            securityGlobs: [],
            docsGlobs: [],
          },
        },
      }),
    ).toThrow(/channel is not authorized/i);
  });
});
