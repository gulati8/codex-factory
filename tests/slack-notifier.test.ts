import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { AppConfig } from "../src/config.js";
import type { Mission, MissionEvent, ProjectManifest } from "../src/domain/types.js";
import { SlackIdentityService } from "../src/services/slack-identity-service.js";
import { SlackNotifier } from "../src/services/slack-notifier.js";

const config: AppConfig = {
  STATE_BACKEND: "file",
  PORT: 4000,
  HOST: "127.0.0.1",
  DATA_FILE: "./data/state.json",
  POSTGRES_URL: undefined,
  GITHUB_TOKEN: undefined,
  MANIFESTS_DIR: "./manifests",
  ARTIFACTS_DIR: "./runtime/artifacts",
  DEFAULT_WORKTREE_ROOT: "./runtime/worktrees",
  DEFAULT_CONTAINER_IMAGE: "node:22-bookworm-slim",
  HEARTBEAT_TIMEOUT_SECONDS: 600,
  QUEUE_POLL_INTERVAL_MS: 2000,
  STAGE_TIMEOUT_MS: 900000,
  SLACK_SOCKET_MODE: false,
  SLACK_COMMAND_NAME: "/codex-factory",
  SLACK_APP_TOKEN: undefined,
  SLACK_SIGNING_SECRET: undefined,
  SLACK_BOT_TOKEN: "xoxb-test-token",
  SLACK_IDENTITY_CACHE_TTL_SECONDS: 300,
  SLACK_ALLOWED_TIMESTAMP_AGE_SECONDS: 300,
};

const mission: Mission = {
  id: "mission_notify",
  projectId: "client-portal",
  title: "Notify mission",
  request: "Exercise outbound Slack notification",
  changedPaths: ["src/api/report.ts"],
  autonomyMode: "managed",
  riskLevel: "medium",
  status: "awaiting_plan_approval",
  plan: {
    summary: "Exercise outbound Slack notification.",
    objectives: ["Post to Slack."],
    assumptions: ["No real network."],
    workstreams: [],
    routeDecisions: [],
  },
  approval: {
    planApproved: false,
    mergeApprovalRequired: true,
    approvedBy: null,
    approvedAt: null,
  },
  stages: [],
  createdAt: new Date().toISOString(),
  updatedAt: new Date().toISOString(),
};

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
      channelIds: ["C_NOTIFY"],
      channelNames: [],
      events: ["mission.created", "stage.failed"],
    },
  },
  retry: {
    maxAttempts: 2,
    retryableStages: ["implement", "review", "docs", "qa", "integrate"],
  },
  risk: {
    highRiskGlobs: [],
    architectureGlobs: [],
    securityGlobs: [],
    docsGlobs: [],
  },
};

describe("SlackNotifier", () => {
  const fetchMock = vi.fn();

  beforeEach(() => {
    fetchMock.mockReset();
    vi.stubGlobal("fetch", fetchMock);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("posts configured mission events to Slack channels", async () => {
    fetchMock.mockResolvedValue({
      ok: true,
      json: async () => ({ ok: true }),
    });

    const notifier = new SlackNotifier(config);
    const event: MissionEvent = {
      id: "event_notify",
      missionId: mission.id,
      type: "mission.created",
      actor: "test",
      summary: "Mission created for project client-portal.",
      createdAt: new Date().toISOString(),
      metadata: {},
    };

    await notifier.notify({
      mission,
      event,
      manifest,
      health: [],
    });

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [, request] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(request.method).toBe("POST");
    expect(request.headers).toMatchObject({
      Authorization: "Bearer xoxb-test-token",
    });
    expect(String(request.body)).toContain("Mission created for project client-portal.");
    expect(String(request.body)).toContain("C_NOTIFY");
  });

  it("resolves configured notification channel names before posting", async () => {
    fetchMock
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          ok: true,
          channels: [{ id: "C_RESOLVED", name: "factory-ops" }],
          response_metadata: { next_cursor: "" },
        }),
      })
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({ ok: true }),
      });

    const notifier = new SlackNotifier(config, new SlackIdentityService(config));
    const event: MissionEvent = {
      id: "event_named_channel",
      missionId: mission.id,
      type: "mission.created",
      actor: "test",
      summary: "Mission created for project client-portal.",
      createdAt: new Date().toISOString(),
      metadata: {},
    };

    await notifier.notify({
      mission,
      event,
      manifest: {
        ...manifest,
        slack: {
          ...manifest.slack,
          notifications: {
            channelIds: [],
            channelNames: ["factory-ops"],
            events: ["mission.created"],
          },
        },
      },
      health: [],
    });

    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(fetchMock.mock.calls[0]?.[0]).toContain("conversations.list");
    const [, request] = fetchMock.mock.calls[1] as [string, RequestInit];
    expect(String(request.body)).toContain("C_RESOLVED");
  });

  it("skips events that are not configured for notification", async () => {
    const notifier = new SlackNotifier(config);
    const event: MissionEvent = {
      id: "event_ignore",
      missionId: mission.id,
      type: "plan.approved",
      actor: "test",
      summary: "Plan approved.",
      createdAt: new Date().toISOString(),
      metadata: {},
    };

    await notifier.notify({
      mission,
      event,
      manifest,
      health: [],
    });

    expect(fetchMock).not.toHaveBeenCalled();
  });
});
