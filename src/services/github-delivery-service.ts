import { execFile } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";

import type { AppConfig } from "../config.js";
import type { Mission, MissionEvent, ProjectManifest, StageRun } from "../domain/types.js";
import { ArtifactStore } from "./artifact-store.js";
import type { MissionService } from "./mission-service.js";

const execFileAsync = promisify(execFile);

type GitHubRepo = {
  owner: string;
  name: string;
};

type PullRequest = {
  number: number;
  html_url: string;
  title: string;
  state: string;
};

type DeliveryPathCandidate = {
  stageRun: StageRun;
  changedPaths: string[];
};

type DeliveryPathSelection = {
  stageRun: StageRun;
  selectedPaths: string[];
};

export function buildGitApplyArgs(patchPath: string, selectedPaths: string[]): string[] {
  return [
    "apply",
    "--3way",
    "--whitespace=nowarn",
    ...selectedPaths.map((selectedPath) => `--include=${selectedPath}`),
    patchPath,
  ];
}

function stagePriority(stageKind: StageRun["stageKind"]): number {
  switch (stageKind) {
    case "implement":
      return 10;
    case "architect":
      return 20;
    case "security":
      return 30;
    case "docs":
      return 40;
    case "review":
      return 50;
    default:
      return 100;
  }
}

export function parseGitHubRepo(remoteUrl: string): GitHubRepo | null {
  const normalized = remoteUrl.trim().replace(/\.git$/, "");
  const sshMatch = normalized.match(/^git@github\.com:(?<owner>[^/]+)\/(?<name>[^/]+)$/);
  if (sshMatch?.groups) {
    return {
      owner: sshMatch.groups.owner,
      name: sshMatch.groups.name,
    };
  }

  const httpsMatch = normalized.match(/^https:\/\/github\.com\/(?<owner>[^/]+)\/(?<name>[^/]+)$/);
  if (httpsMatch?.groups) {
    return {
      owner: httpsMatch.groups.owner,
      name: httpsMatch.groups.name,
    };
  }

  return null;
}

export function injectGitHubToken(remoteUrl: string, token: string): string {
  return remoteUrl.replace("https://github.com/", `https://x-access-token:${token}@github.com/`);
}

function redactSecrets(message: string, secrets: Array<string | undefined>): string {
  let redacted = message;
  for (const secret of secrets) {
    if (!secret) {
      continue;
    }

    redacted = redacted.split(secret).join("[REDACTED]");
  }

  return redacted;
}

export function selectDeliveryPathWinners(candidates: DeliveryPathCandidate[]): DeliveryPathSelection[] {
  const claimedPaths = new Set<string>();
  const selected: DeliveryPathSelection[] = [];
  const orderedCandidates = [...candidates].sort((left, right) => {
    const leftFinishedAt = left.stageRun.finishedAt ?? left.stageRun.startedAt;
    const rightFinishedAt = right.stageRun.finishedAt ?? right.stageRun.startedAt;
    const finishedDelta = rightFinishedAt.localeCompare(leftFinishedAt);
    if (finishedDelta !== 0) {
      return finishedDelta;
    }

    const kindDelta = stagePriority(right.stageRun.stageKind) - stagePriority(left.stageRun.stageKind);
    if (kindDelta !== 0) {
      return kindDelta;
    }

    return right.stageRun.stageId.localeCompare(left.stageRun.stageId);
  });

  for (const candidate of orderedCandidates) {
    const selectedPaths = candidate.changedPaths.filter((changedPath) => {
      if (claimedPaths.has(changedPath)) {
        return false;
      }

      claimedPaths.add(changedPath);
      return true;
    });

    if (selectedPaths.length === 0) {
      continue;
    }

    selected.push({
      stageRun: candidate.stageRun,
      selectedPaths,
    });
  }

  return selected.sort((left, right) => {
    const kindDelta = stagePriority(left.stageRun.stageKind) - stagePriority(right.stageRun.stageKind);
    if (kindDelta !== 0) {
      return kindDelta;
    }

    return left.stageRun.startedAt.localeCompare(right.stageRun.startedAt);
  });
}

export class GitHubDeliveryService {
  private readonly config: AppConfig;
  private readonly missionService: MissionService;
  private readonly artifactStore: ArtifactStore;
  private readonly inFlightMissionIds = new Set<string>();

  public constructor(config: AppConfig, missionService: MissionService) {
    this.config = config;
    this.missionService = missionService;
    this.artifactStore = new ArtifactStore(config);
  }

  public async reconcileCompletedMissions(manifests: ProjectManifest[]): Promise<void> {
    for (const mission of this.missionService.listMissions()) {
      if (mission.status !== "completed") {
        continue;
      }

      const manifest = manifests.find((candidate) => candidate.projectId === mission.projectId);
      if (!manifest) {
        continue;
      }

      await this.deliverMission(mission, manifest);
    }
  }

  public async deliverMission(mission: Mission, manifest: ProjectManifest): Promise<void> {
    if (mission.status !== "completed" || !this.config.GITHUB_TOKEN) {
      return;
    }

    const events = this.missionService.listEvents(mission.id);
    if (events.some((event) => event.type === "mission.pr_opened")) {
      return;
    }

    if (this.inFlightMissionIds.has(mission.id)) {
      return;
    }

    this.inFlightMissionIds.add(mission.id);
    try {
      const result = await this.preparePullRequest(mission, manifest, events);
      await this.missionService.recordMissionEvent(mission.id, {
        type: "mission.pr_opened",
        actor: "delivery",
        summary: `Opened delivery PR #${result.number}.`,
        metadata: {
          branch: result.branch,
          pullRequest: {
            number: result.number,
            url: result.url,
            title: result.title,
          },
        },
      });
    } catch (error) {
      const message = redactSecrets(error instanceof Error ? error.message : "Unknown delivery failure", [
        this.config.GITHUB_TOKEN,
      ]);
      await this.missionService.recordMissionEvent(mission.id, {
        type: "mission.delivery_failed",
        actor: "delivery",
        summary: message,
        metadata: {},
      });
    } finally {
      this.inFlightMissionIds.delete(mission.id);
    }
  }

  private async preparePullRequest(
    mission: Mission,
    manifest: ProjectManifest,
    events: MissionEvent[],
  ): Promise<{ branch: string; number: number; title: string; url: string }> {
    const githubToken = this.config.GITHUB_TOKEN;
    if (!githubToken) {
      throw new Error("GitHub delivery requires GITHUB_TOKEN.");
    }

    const remoteUrl = await this.getRemoteUrl(manifest.repoPath);
    const repo = parseGitHubRepo(remoteUrl);
    if (!repo) {
      throw new Error(`Unsupported GitHub remote URL: ${remoteUrl}`);
    }

    const branch = `factory/${mission.id}`;
    const existingPr = await this.findPullRequest(repo, branch);
    if (existingPr) {
      return {
        branch,
        number: existingPr.number,
        title: existingPr.title,
        url: existingPr.html_url,
      };
    }

    const deliverySelections = await this.selectDeliveryStageRuns(mission.id);
    if (deliverySelections.length === 0) {
      throw new Error("No completed delivery stage outputs were available to publish.");
    }

    const baseBranch = await this.getBaseBranch(manifest.repoPath);
    const deliveryDir = await mkdtemp(path.join(os.tmpdir(), `codex-factory-delivery-${mission.id}-`));

    try {
      await execFileAsync("git", ["clone", manifest.repoPath, deliveryDir], {
        timeout: this.config.STAGE_TIMEOUT_MS,
        maxBuffer: 1024 * 1024 * 8,
      });
      await execFileAsync("git", ["-C", deliveryDir, "remote", "set-url", "origin", remoteUrl], {
        timeout: this.config.STAGE_TIMEOUT_MS,
        maxBuffer: 1024 * 1024,
      });
      await execFileAsync("git", ["-C", deliveryDir, "checkout", "-b", branch], {
        timeout: this.config.STAGE_TIMEOUT_MS,
        maxBuffer: 1024 * 1024,
      });
      await execFileAsync("git", ["-C", deliveryDir, "remote", "set-url", "origin", injectGitHubToken(remoteUrl, githubToken)], {
        timeout: this.config.STAGE_TIMEOUT_MS,
        maxBuffer: 1024 * 1024,
      });

      for (const selection of deliverySelections) {
        const patch = await this.buildPatch(selection.stageRun, selection.selectedPaths);
        if (!patch.trim()) {
          continue;
        }

        const patchPath = path.join(os.tmpdir(), `codex-factory-delivery-${selection.stageRun.stageId}.patch`);
        try {
          await writeFile(patchPath, patch, "utf8");
          await execFileAsync("git", ["-C", deliveryDir, ...buildGitApplyArgs(patchPath, selection.selectedPaths)], {
            timeout: this.config.STAGE_TIMEOUT_MS,
            maxBuffer: 1024 * 1024 * 8,
          });
        } finally {
          await rm(patchPath, { force: true });
        }
      }

      const status = await execFileAsync("git", ["-C", deliveryDir, "status", "--short"], {
        timeout: this.config.STAGE_TIMEOUT_MS,
        maxBuffer: 1024 * 1024,
      });
      if (!status.stdout.trim()) {
        throw new Error("Mission delivery produced no publishable changes.");
      }

      await execFileAsync("git", ["-C", deliveryDir, "config", "user.name", "Codex Factory"], {
        timeout: this.config.STAGE_TIMEOUT_MS,
        maxBuffer: 1024 * 1024,
      });
      await execFileAsync("git", ["-C", deliveryDir, "config", "user.email", "factory@gulatilabs.me"], {
        timeout: this.config.STAGE_TIMEOUT_MS,
        maxBuffer: 1024 * 1024,
      });
      await execFileAsync("git", ["-C", deliveryDir, "add", "-A"], {
        timeout: this.config.STAGE_TIMEOUT_MS,
        maxBuffer: 1024 * 1024,
      });
      await execFileAsync("git", ["-C", deliveryDir, "commit", "-m", `Factory mission ${mission.id}: ${mission.title}`], {
        timeout: this.config.STAGE_TIMEOUT_MS,
        maxBuffer: 1024 * 1024,
      });
      await execFileAsync(
        "git",
        ["-C", deliveryDir, "push", "origin", `${branch}:${branch}`],
        {
          timeout: this.config.STAGE_TIMEOUT_MS,
          maxBuffer: 1024 * 1024 * 8,
        },
      );

      const createdPr = await this.createPullRequest(repo, {
        title: `Factory mission: ${mission.title}`,
        head: branch,
        base: baseBranch,
        body: this.buildPullRequestBody(mission, deliverySelections, events),
      });

      return {
        branch,
        number: createdPr.number,
        title: createdPr.title,
        url: createdPr.html_url,
      };
    } finally {
      await rm(deliveryDir, { recursive: true, force: true });
    }
  }

  private async selectDeliveryStageRuns(missionId: string): Promise<DeliveryPathSelection[]> {
    const stageRuns = this.missionService.listStageRuns(missionId);
    const latestCompletedByStage = new Map<string, StageRun>();
    for (const stageRun of stageRuns) {
      if (stageRun.status !== "completed" || ["qa", "integrate"].includes(stageRun.stageKind)) {
        continue;
      }

      const existing = latestCompletedByStage.get(stageRun.stageId);
      if (!existing || existing.attempt < stageRun.attempt) {
        latestCompletedByStage.set(stageRun.stageId, stageRun);
      }
    }

    const candidates: DeliveryPathCandidate[] = [];
    for (const stageRun of latestCompletedByStage.values()) {
      const changedPaths = await this.listChangedPaths(stageRun);
      if (changedPaths.length === 0) {
        continue;
      }

      candidates.push({
        stageRun,
        changedPaths,
      });
    }

    return selectDeliveryPathWinners(candidates);
  }

  private async buildPatch(stageRun: StageRun, changedPaths: string[]): Promise<string> {
    const bundle = await this.artifactStore.readDeliveryBundle(stageRun);
    if (bundle) {
      return bundle.patch;
    }

    const result = await execFileAsync("git", ["-C", stageRun.worktreePath, "diff", "--binary", "HEAD", "--", ...changedPaths], {
      timeout: this.config.STAGE_TIMEOUT_MS,
      maxBuffer: 1024 * 1024 * 8,
    });
    return result.stdout;
  }

  private async listChangedPaths(stageRun: StageRun): Promise<string[]> {
    const bundle = await this.artifactStore.readDeliveryBundle(stageRun);
    if (bundle) {
      return bundle.changedPaths;
    }

    const result = await execFileAsync("git", ["-C", stageRun.worktreePath, "diff", "--name-only", "HEAD"], {
      timeout: this.config.STAGE_TIMEOUT_MS,
      maxBuffer: 1024 * 1024,
    });

    return result.stdout
      .split("\n")
      .map((line) => line.trim())
      .filter(Boolean);
  }

  private async getRemoteUrl(repoPath: string): Promise<string> {
    const result = await execFileAsync("git", ["-C", repoPath, "remote", "get-url", "origin"], {
      timeout: this.config.STAGE_TIMEOUT_MS,
      maxBuffer: 1024 * 1024,
    });
    return result.stdout.trim();
  }

  private async getBaseBranch(repoPath: string): Promise<string> {
    const head = await execFileAsync("git", ["-C", repoPath, "rev-parse", "--abbrev-ref", "HEAD"], {
      timeout: this.config.STAGE_TIMEOUT_MS,
      maxBuffer: 1024 * 1024,
    });
    return head.stdout.trim() || "main";
  }

  private async findPullRequest(repo: GitHubRepo, branch: string): Promise<PullRequest | null> {
    const response = await fetch(
      `https://api.github.com/repos/${repo.owner}/${repo.name}/pulls?head=${repo.owner}:${encodeURIComponent(branch)}&state=open`,
      {
        headers: {
          Accept: "application/vnd.github+json",
          Authorization: `Bearer ${this.config.GITHUB_TOKEN}`,
          "User-Agent": "codex-factory",
        },
      },
    );
    if (!response.ok) {
      throw new Error(`Unable to list GitHub pull requests (${response.status}).`);
    }

    const pulls = (await response.json()) as PullRequest[];
    return pulls[0] ?? null;
  }

  private async createPullRequest(
    repo: GitHubRepo,
    input: { title: string; body: string; head: string; base: string },
  ): Promise<PullRequest> {
    const response = await fetch(`https://api.github.com/repos/${repo.owner}/${repo.name}/pulls`, {
      method: "POST",
      headers: {
        Accept: "application/vnd.github+json",
        Authorization: `Bearer ${this.config.GITHUB_TOKEN}`,
        "Content-Type": "application/json",
        "User-Agent": "codex-factory",
      },
      body: JSON.stringify(input),
    });
    if (!response.ok) {
      const body = await response.text();
      throw new Error(`Unable to create GitHub pull request (${response.status}): ${body}`);
    }

    return (await response.json()) as PullRequest;
  }

  private buildPullRequestBody(mission: Mission, selections: DeliveryPathSelection[], events: MissionEvent[]): string {
    const stageSummary = selections
      .map(
        (selection) =>
          `- ${selection.stageRun.stageKind}: ${selection.stageRun.summary} (${selection.selectedPaths.join(", ")})`,
      )
      .join("\n");
    const eventCount = events.length;
    return [
      `## Mission`,
      mission.title,
      "",
      `## Request`,
      mission.request,
      "",
      `## Delivery Notes`,
      `- Mission ID: \`${mission.id}\``,
      `- Risk level: \`${mission.riskLevel}\``,
      `- Events recorded: ${eventCount}`,
      "",
      `## Applied Stage Outputs`,
      stageSummary || "- No stage outputs were applied.",
    ].join("\n");
  }
}
