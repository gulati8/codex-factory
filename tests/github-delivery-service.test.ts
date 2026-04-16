import { describe, expect, it } from "vitest";

import type { StageRun } from "../src/domain/types.js";
import {
  buildGitApplyArgs,
  injectGitHubToken,
  parseGitHubRepo,
  selectDeliveryPathWinners,
} from "../src/services/github-delivery-service.js";

function makeStageRun(input: Partial<StageRun> & Pick<StageRun, "stageId" | "stageKind">): StageRun {
  return {
    missionId: "mission_test",
    stageId: input.stageId,
    stageKind: input.stageKind,
    status: "completed",
    attempt: 1,
    startedAt: input.startedAt ?? "2026-04-16T18:00:00.000Z",
    finishedAt: input.finishedAt ?? "2026-04-16T18:00:10.000Z",
    worktreePath: input.worktreePath ?? "/tmp/worktree",
    artifactDir: input.artifactDir ?? "/tmp/artifacts",
    summary: input.summary ?? `${input.stageKind} done`,
  };
}

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

  it("keeps only the latest authoritative stage for overlapping paths", () => {
    const implement = makeStageRun({
      stageId: "implement_1",
      stageKind: "implement",
      finishedAt: "2026-04-16T18:01:00.000Z",
    });
    const docs = makeStageRun({
      stageId: "docs_1",
      stageKind: "docs",
      finishedAt: "2026-04-16T18:02:00.000Z",
    });

    const selections = selectDeliveryPathWinners([
      {
        stageRun: implement,
        changedPaths: ["README.md", "src/app.ts"],
      },
      {
        stageRun: docs,
        changedPaths: ["README.md"],
      },
    ]);

    expect(selections).toEqual([
      {
        stageRun: implement,
        selectedPaths: ["src/app.ts"],
      },
      {
        stageRun: docs,
        selectedPaths: ["README.md"],
      },
    ]);
  });

  it("builds git apply args that scope bundle patches to the selected repo paths", () => {
    expect(buildGitApplyArgs("/tmp/delivery.patch", ["README.md", "src/app.ts"])).toEqual([
      "apply",
      "--3way",
      "--whitespace=nowarn",
      "--include=README.md",
      "--include=src/app.ts",
      "/tmp/delivery.patch",
    ]);
  });
});
