import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { AppConfig } from "../src/config.js";
import { SlackIdentityService } from "../src/services/slack-identity-service.js";

const config: AppConfig = {
  STATE_BACKEND: "file",
  PORT: 4000,
  HOST: "127.0.0.1",
  DATA_FILE: "./data/state.json",
  POSTGRES_URL: undefined,
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

describe("SlackIdentityService", () => {
  const fetchMock = vi.fn();

  beforeEach(() => {
    fetchMock.mockReset();
    vi.stubGlobal("fetch", fetchMock);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("resolves Slack users with workspace profile data", async () => {
    fetchMock.mockResolvedValueOnce({
      ok: true,
      json: async () => ({
        ok: true,
        user: {
          id: "U123",
          name: "amit",
          real_name: "Amit Gulati",
          profile: {
            display_name: "amitg",
            real_name: "Amit Gulati",
            email: "amit@example.com",
          },
        },
      }),
    });

    const service = new SlackIdentityService(config);
    const identity = await service.resolveUser({
      id: "U123",
      username: "amit",
    });

    expect(identity.email).toBe("amit@example.com");
    expect(identity.displayName).toBe("amitg");
    expect(identity.realName).toBe("Amit Gulati");
  });

  it("resolves Slack channels with workspace metadata", async () => {
    fetchMock.mockResolvedValueOnce({
      ok: true,
      json: async () => ({
        ok: true,
        channel: {
          id: "C123",
          name: "factory-ops",
        },
      }),
    });

    const service = new SlackIdentityService(config);
    const channel = await service.resolveChannel("C123");

    expect(channel).toEqual({
      id: "C123",
      name: "factory-ops",
    });
  });

  it("resolves Slack channel names to channel ids", async () => {
    fetchMock.mockResolvedValueOnce({
      ok: true,
      json: async () => ({
        ok: true,
        channels: [
          {
            id: "C123",
            name: "factory-ops",
          },
        ],
        response_metadata: {
          next_cursor: "",
        },
      }),
    });

    const service = new SlackIdentityService(config);
    const channel = await service.resolveChannelName("factory-ops");

    expect(channel).toEqual({
      id: "C123",
      name: "factory-ops",
    });
  });
});
