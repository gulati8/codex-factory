import { describe, expect, it } from "vitest";

import { injectGitHubToken, parseGitHubRepo } from "../src/services/github-delivery-service.js";

describe("GitHubDeliveryService helpers", () => {
  it("parses GitHub HTTPS and SSH remotes", () => {
    expect(parseGitHubRepo("https://github.com/gulati8/codex-factory.git")).toEqual({
      owner: "gulati8",
      name: "codex-factory",
    });
    expect(parseGitHubRepo("git@github.com:gulati8/codex-factory.git")).toEqual({
      owner: "gulati8",
      name: "codex-factory",
    });
  });

  it("returns null for unsupported remotes", () => {
    expect(parseGitHubRepo("https://gitlab.com/gulati8/codex-factory.git")).toBeNull();
  });

  it("injects a GitHub token into HTTPS remotes", () => {
    expect(injectGitHubToken("https://github.com/gulati8/codex-factory.git", "secret-token")).toBe(
      "https://x-access-token:secret-token@github.com/gulati8/codex-factory.git",
    );
  });
});
