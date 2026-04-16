import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { loadConfig } from "../src/config.js";

describe("loadConfig", () => {
  let previousEnv: NodeJS.ProcessEnv;
  let previousCwd: string;
  let tmpDir: string;

  beforeEach(async () => {
    previousEnv = { ...process.env };
    previousCwd = process.cwd();
    tmpDir = await mkdtemp(path.join(os.tmpdir(), "solo-factory-config-"));
  });

  afterEach(async () => {
    process.env = previousEnv;
    process.chdir(previousCwd);
    await rm(tmpDir, { recursive: true, force: true });
  });

  it("loads local .env values for process startup without overriding explicit env", async () => {
    await writeFile(
      path.join(tmpDir, ".env"),
      [
        "STATE_BACKEND=file",
        "PORT=4123",
        "HOST=127.0.0.1",
        "SLACK_SIGNING_SECRET=from-dotenv",
        "SLACK_BOT_TOKEN=from-dotenv",
      ].join("\n"),
      "utf8",
    );
    process.chdir(tmpDir);
    delete process.env.PORT;
    delete process.env.SLACK_SIGNING_SECRET;
    process.env.SLACK_BOT_TOKEN = "from-process";

    const config = loadConfig();

    expect(config.PORT).toBe(4123);
    expect(config.SLACK_SIGNING_SECRET).toBe("from-dotenv");
    expect(config.SLACK_BOT_TOKEN).toBe("from-process");
  });
});
