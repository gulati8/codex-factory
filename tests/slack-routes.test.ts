import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { buildApp } from "../src/app.js";
import type { ProjectManifest } from "../src/domain/types.js";

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
    allowedChannelIds: ["C_FACTORY"],
    allowedChannels: ["factory-ops"],
    operatorUsers: ["U_OPERATOR"],
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
    retryableStages: ["implement", "review", "docs", "qa", "integrate"],
  },
  risk: {
    highRiskGlobs: ["src/auth/**"],
    architectureGlobs: ["src/domain/**"],
    securityGlobs: ["src/auth/**"],
    docsGlobs: ["docs/**", "src/api/**"],
  },
};

describe("Slack routes", () => {
  let tmpDir: string;
  let previousEnv: NodeJS.ProcessEnv;

  beforeEach(async () => {
    tmpDir = await mkdtemp(path.join(os.tmpdir(), "solo-factory-slack-routes-"));
    await mkdir(path.join(tmpDir, "manifests"), { recursive: true });
    await mkdir(path.join(tmpDir, "runtime"), { recursive: true });
    await mkdir(path.join(tmpDir, "data"), { recursive: true });
    await writeFile(
      path.join(tmpDir, "manifests", "client-portal.json"),
      JSON.stringify(manifest, null, 2),
      "utf8",
    );

    previousEnv = { ...process.env };
    process.env.STATE_BACKEND = "file";
    process.env.PORT = "4100";
    process.env.HOST = "127.0.0.1";
    process.env.DATA_FILE = path.join(tmpDir, "data", "state.json");
    delete process.env.POSTGRES_URL;
    process.env.MANIFESTS_DIR = path.join(tmpDir, "manifests");
    process.env.ARTIFACTS_DIR = path.join(tmpDir, "runtime", "artifacts");
    process.env.DEFAULT_WORKTREE_ROOT = path.join(tmpDir, "runtime", "worktrees");
    process.env.DEFAULT_CONTAINER_IMAGE = "node:22-bookworm-slim";
    process.env.HEARTBEAT_TIMEOUT_SECONDS = "600";
    process.env.QUEUE_POLL_INTERVAL_MS = "100";
    process.env.STAGE_TIMEOUT_MS = "1000";
    delete process.env.SLACK_SIGNING_SECRET;
    delete process.env.SLACK_BOT_TOKEN;
    process.env.SLACK_IDENTITY_CACHE_TTL_SECONDS = "300";
    process.env.SLACK_ALLOWED_TIMESTAMP_AGE_SECONDS = "300";
  });

  afterEach(async () => {
    process.env = previousEnv;
    await rm(tmpDir, { recursive: true, force: true });
  });

  it("rejects mission creation from an unauthorized Slack operator", async () => {
    const app = await buildApp();

    try {
      const response = await app.inject({
        method: "POST",
        url: "/slack/commands/intake",
        headers: {
          "content-type": "application/x-www-form-urlencoded",
        },
        payload: "text=client-portal%20Add%20audit%20trail&user_id=U_DENIED&user_name=denied&channel_id=C_FACTORY",
      });

      expect(response.statusCode).toBe(400);
      expect(response.json().text).toMatch(/not authorized/i);
    } finally {
      await app.close();
    }
  });

  it("rejects mission creation from a Slack channel outside the project policy", async () => {
    const app = await buildApp();

    try {
      const response = await app.inject({
        method: "POST",
        url: "/slack/commands/intake",
        headers: {
          "content-type": "application/x-www-form-urlencoded",
        },
        payload: "text=client-portal%20Add%20audit%20trail&user_id=U_OPERATOR&user_name=operator&channel_id=C_RANDOM",
      });

      expect(response.statusCode).toBe(400);
      expect(response.json().text).toMatch(/channel is not authorized/i);
    } finally {
      await app.close();
    }
  });

  it("rejects plan approval from an unauthorized Slack approver", async () => {
    const app = await buildApp();

    try {
      const created = await app.inject({
        method: "POST",
        url: "/api/missions",
        payload: {
          projectId: "client-portal",
          title: "Add audit trail",
          request: "Add an audit trail endpoint for billing actions",
          changedPaths: ["src/api/audit.ts"],
          autonomyMode: "managed",
          actor: "test",
        },
      });
      expect(created.statusCode).toBe(201);
      const missionId = created.json().mission.id as string;

      const response = await app.inject({
        method: "POST",
        url: "/slack/actions",
        headers: {
          "content-type": "application/x-www-form-urlencoded",
        },
        payload: `payload=${encodeURIComponent(
          JSON.stringify({
            type: "block_actions",
            user: { id: "U_OPERATOR", username: "operator" },
            channel: { id: "C_FACTORY" },
            actions: [
              {
                action_id: "approve_plan",
                value: JSON.stringify({ missionId }),
              },
            ],
          }),
        )}`,
      });

      expect(response.statusCode).toBe(400);
      expect(response.json().text).toMatch(/not authorized/i);
    } finally {
      await app.close();
    }
  });

  it("allows a configured Slack approver to approve a plan", async () => {
    const app = await buildApp();

    try {
      const created = await app.inject({
        method: "POST",
        url: "/api/missions",
        payload: {
          projectId: "client-portal",
          title: "Add audit trail",
          request: "Add an audit trail endpoint for billing actions",
          changedPaths: ["src/api/audit.ts"],
          autonomyMode: "managed",
          actor: "test",
        },
      });
      expect(created.statusCode).toBe(201);
      const missionId = created.json().mission.id as string;

      const response = await app.inject({
        method: "POST",
        url: "/slack/actions",
        headers: {
          "content-type": "application/x-www-form-urlencoded",
        },
        payload: `payload=${encodeURIComponent(
          JSON.stringify({
            type: "block_actions",
            user: { id: "U_APPROVER", username: "approver" },
            channel: { id: "C_FACTORY" },
            actions: [
              {
                action_id: "approve_plan",
                value: JSON.stringify({ missionId }),
              },
            ],
          }),
        )}`,
      });

      expect(response.statusCode).toBe(200);
      expect(response.json().text).toContain("running");

      const missionResponse = await app.inject({
        method: "GET",
        url: `/api/missions/${missionId}`,
      });
      expect(missionResponse.statusCode).toBe(200);
      expect(missionResponse.json().mission.approval.planApproved).toBe(true);
    } finally {
      await app.close();
    }
  });
});
