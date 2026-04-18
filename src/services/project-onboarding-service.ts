import { execFile } from "node:child_process";
import { access, mkdir, readFile } from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";

import type { AppConfig } from "../config.js";
import {
  connectProjectInputSchema,
  type ConnectProjectInput,
  type ProjectManifest,
  type ProjectRecord,
} from "../domain/types.js";
import type { SlackChannelIdentity } from "../adapters/slack.js";
import { ManifestStore } from "../store/manifest-store.js";

const execFileAsync = promisify(execFile);

type RepoIdentity = {
  owner: string;
  name: string;
};

type InferredConfig = {
  manifest: ProjectManifest;
  confidence: number;
  notes: string[];
};

function nowIso(): string {
  return new Date().toISOString();
}

function normalizeRepoUrl(repoUrl: string): string {
  return repoUrl.trim().replace(/\/+$/, "").replace(/\.git$/, "");
}

function parseGitHubRepoUrl(repoUrl: string): RepoIdentity | null {
  const normalized = normalizeRepoUrl(repoUrl);
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

function toProjectId(identity: RepoIdentity): string {
  return `${identity.owner}-${identity.name}`
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
}

async function pathExists(candidate: string): Promise<boolean> {
  try {
    await access(candidate);
    return true;
  } catch {
    return false;
  }
}

function remediationForAccessFailure(repoUrl: string, error: string): string {
  const normalized = normalizeRepoUrl(repoUrl);
  if (/permission denied \(publickey\)/i.test(error)) {
    return `Factory could not access ${normalized} over SSH. Grant the server's GitHub identity write access to the repo and make sure its SSH key is authorized, then retry connect.`;
  }

  if (/repository .* not found/i.test(error) || /could not read from remote repository/i.test(error)) {
    return `Factory could not reach ${normalized}. Verify the repo URL is correct and that the server's GitHub identity can clone it over SSH or via gh-authenticated git.`;
  }

  return `Factory could not access ${normalized}. Confirm the repo is reachable from the server with the current Git credentials, then retry connect.`;
}

async function detectDefaultBranch(repoUrl: string): Promise<string | null> {
  try {
    const { stdout } = await execFileAsync("git", ["ls-remote", "--symref", repoUrl, "HEAD"], {
      maxBuffer: 1024 * 1024,
    });
    const line = stdout
      .split("\n")
      .map((candidate) => candidate.trim())
      .find((candidate) => candidate.startsWith("ref: "));
    if (!line) {
      return null;
    }

    const match = line.match(/^ref:\s+refs\/heads\/(?<branch>[^\s]+)\s+HEAD$/);
    return match?.groups?.branch ?? null;
  } catch {
    return null;
  }
}

async function detectCheckedOutBranch(repoPath: string): Promise<string | null> {
  try {
    const { stdout } = await execFileAsync("git", ["-C", repoPath, "rev-parse", "--abbrev-ref", "HEAD"], {
      maxBuffer: 1024 * 1024,
    });
    const branch = stdout.trim();
    return branch && branch !== "HEAD" ? branch : null;
  } catch {
    return null;
  }
}

export class ProjectOnboardingService {
  private readonly config: AppConfig;
  private readonly manifestStore: ManifestStore;

  public constructor(params: { config: AppConfig; manifestStore: ManifestStore }) {
    this.config = params.config;
    this.manifestStore = params.manifestStore;
  }

  public ensureAdmin(actorCandidates: string[]): void {
    if (this.config.FACTORY_ADMIN_USERS.length === 0) {
      return;
    }

    const normalizedCandidates = actorCandidates.map((candidate) => candidate.trim().toLowerCase()).filter(Boolean);
    const authorized = this.config.FACTORY_ADMIN_USERS.some((candidate) =>
      normalizedCandidates.includes(candidate.trim().toLowerCase()),
    );
    if (!authorized) {
      throw new Error("Only factory admins can onboard new projects.");
    }
  }

  public async connect(input: ConnectProjectInput): Promise<ProjectRecord> {
    const parsed = connectProjectInputSchema.parse(input);
    this.ensureAdmin(parsed.actorCandidates);

    const identity = parseGitHubRepoUrl(parsed.repoUrl);
    if (!identity) {
      throw new Error("Only GitHub SSH or HTTPS repo URLs are supported right now.");
    }

    const repoUrl = normalizeRepoUrl(parsed.repoUrl);
    const projectId = toProjectId(identity);
    const clonePath = path.join(this.config.PROJECTS_ROOT, projectId);
    const timestamp = nowIso();
    const channelName = parsed.channelName?.replace(/^#/, "").trim() || undefined;
    const approverUsers = parsed.actorCandidates.length > 0 ? parsed.actorCandidates : [parsed.actor];

    const existing = this.manifestStore.listRecords().find(
      (record) => record.projectId === projectId || normalizeRepoUrl(record.access.repoUrl) === repoUrl,
    );

    const accessResult = await this.validateAccess(repoUrl);
    if (!accessResult.accessible) {
      const manifest = this.buildManifest({
        projectId,
        displayName: identity.name,
        repoPath: clonePath,
        approverUsers,
        channelId: parsed.channelId,
        channelName,
        inference: null,
      });
      const record: ProjectRecord = {
        projectId,
        status: "pending_access",
        manifest,
        access: {
          repoUrl,
          clonePath,
          defaultBranch: null,
          validationStatus: "inaccessible",
          lastValidatedAt: timestamp,
          remediation: remediationForAccessFailure(repoUrl, accessResult.error),
        },
        binding: {
          defaultChannelId: parsed.channelId ?? null,
          defaultChannelName: channelName ?? null,
        },
        inference: {
          confidence: 0,
          notes: ["Repo access failed during onboarding."],
        },
        createdBy: existing?.createdBy ?? parsed.actor,
        createdAt: existing?.createdAt ?? timestamp,
        updatedAt: timestamp,
      };

      return this.manifestStore.saveRecord(record);
    }

    const defaultBranch = await detectDefaultBranch(repoUrl);
    await this.syncRepo(repoUrl, clonePath, defaultBranch);
    const inferred = await this.inferManifest({
      projectId,
      repoPath: clonePath,
      displayName: identity.name,
      approverUsers,
      channelId: parsed.channelId,
      channelName,
    });

    const record: ProjectRecord = {
      projectId,
      status: "pending_approval",
      manifest: inferred.manifest,
      access: {
        repoUrl,
        clonePath,
        defaultBranch,
        validationStatus: "accessible",
        lastValidatedAt: timestamp,
        remediation: null,
      },
      binding: {
        defaultChannelId: parsed.channelId ?? null,
        defaultChannelName: channelName ?? null,
      },
      inference: {
        confidence: inferred.confidence,
        notes: inferred.notes,
      },
      createdBy: existing?.createdBy ?? parsed.actor,
      createdAt: existing?.createdAt ?? timestamp,
      updatedAt: timestamp,
    };

    return this.manifestStore.saveRecord(record);
  }

  public async approve(projectId: string): Promise<ProjectRecord> {
    const record = this.manifestStore.getRecord(projectId);
    if (record.status === "pending_access") {
      throw new Error("Project access must be fixed before setup can be approved.");
    }

    return this.manifestStore.activateProject(projectId);
  }

  private async validateAccess(repoUrl: string): Promise<{ accessible: boolean; error: string }> {
    try {
      await execFileAsync("git", ["ls-remote", repoUrl, "HEAD"], {
        timeout: this.config.STAGE_TIMEOUT_MS,
        maxBuffer: 1024 * 1024,
      });
      return {
        accessible: true,
        error: "",
      };
    } catch (error) {
      const message =
        error instanceof Error
          ? error.message
          : typeof error === "object" && error && "stderr" in error
            ? String((error as { stderr?: string }).stderr ?? "Unknown git access failure")
            : "Unknown git access failure";
      return {
        accessible: false,
        error: message,
      };
    }
  }

  private async syncRepo(repoUrl: string, clonePath: string, defaultBranch: string | null): Promise<void> {
    await mkdir(this.config.PROJECTS_ROOT, { recursive: true });
    if (!(await pathExists(path.join(clonePath, ".git")))) {
      await execFileAsync("git", ["clone", repoUrl, clonePath], {
        timeout: this.config.STAGE_TIMEOUT_MS,
        maxBuffer: 1024 * 1024 * 8,
      });
      return;
    }

    await execFileAsync("git", ["-C", clonePath, "remote", "set-url", "origin", repoUrl], {
      timeout: this.config.STAGE_TIMEOUT_MS,
      maxBuffer: 1024 * 1024,
    });
    await execFileAsync("git", ["-C", clonePath, "fetch", "origin"], {
      timeout: this.config.STAGE_TIMEOUT_MS,
      maxBuffer: 1024 * 1024 * 8,
    });

    const targetBranch = defaultBranch ?? (await detectCheckedOutBranch(clonePath)) ?? "main";
    await execFileAsync("git", ["-C", clonePath, "checkout", targetBranch], {
      timeout: this.config.STAGE_TIMEOUT_MS,
      maxBuffer: 1024 * 1024,
    }).catch(async () => {
      await execFileAsync("git", ["-C", clonePath, "checkout", "-B", targetBranch, `origin/${targetBranch}`], {
        timeout: this.config.STAGE_TIMEOUT_MS,
        maxBuffer: 1024 * 1024,
      });
    });
    await execFileAsync("git", ["-C", clonePath, "reset", "--hard", `origin/${targetBranch}`], {
      timeout: this.config.STAGE_TIMEOUT_MS,
      maxBuffer: 1024 * 1024,
    });
  }

  private async inferManifest(params: {
    projectId: string;
    repoPath: string;
    displayName: string;
    approverUsers: string[];
    channelId?: string;
    channelName?: string;
  }): Promise<InferredConfig> {
    const packageJsonPath = path.join(params.repoPath, "package.json");
    const pyprojectPath = path.join(params.repoPath, "pyproject.toml");
    const requirementsPath = path.join(params.repoPath, "requirements.txt");

    if (await pathExists(packageJsonPath)) {
      return this.inferNodeManifest({
        ...params,
        packageJsonPath,
      });
    }

    if ((await pathExists(pyprojectPath)) || (await pathExists(requirementsPath))) {
      return this.inferPythonManifest(params);
    }

    return {
      manifest: this.buildManifest({
        projectId: params.projectId,
        displayName: params.displayName,
        repoPath: params.repoPath,
        approverUsers: params.approverUsers,
        channelId: params.channelId,
        channelName: params.channelName,
        inference: {
          commands: {
            install: "true",
            lint: "true",
            test: "true",
            build: "true",
          },
          runtimeContainer: this.config.DEFAULT_CONTAINER_IMAGE,
          risk: {
            highRiskGlobs: [".github/workflows/**", "deploy/**", "infra/**", "auth/**", "payments/**"],
            architectureGlobs: ["src/**", "app/**", "server/**"],
            securityGlobs: [".github/workflows/**", "deploy/**", "auth/**", "security/**"],
            docsGlobs: ["README.md", "docs/**"],
          },
        },
      }),
      confidence: 0.3,
      notes: [
        "Could not confidently identify the stack. Defaulted commands to no-op placeholders.",
        "A human review of inferred commands is required before activation.",
      ],
    };
  }

  private async inferNodeManifest(params: {
    projectId: string;
    repoPath: string;
    displayName: string;
    approverUsers: string[];
    channelId?: string;
    channelName?: string;
    packageJsonPath: string;
  }): Promise<InferredConfig> {
    const packageJson = JSON.parse(await readFile(params.packageJsonPath, "utf8")) as {
      scripts?: Record<string, string>;
    };
    const scripts = packageJson.scripts ?? {};

    const manager = (await pathExists(path.join(params.repoPath, "pnpm-lock.yaml")))
      ? "pnpm"
      : (await pathExists(path.join(params.repoPath, "yarn.lock")))
        ? "yarn"
        : "npm";

    const install =
      manager === "pnpm"
        ? "pnpm install --frozen-lockfile"
        : manager === "yarn"
          ? "yarn install --immutable"
          : (await pathExists(path.join(params.repoPath, "package-lock.json")))
            ? "npm ci --include=dev"
            : "npm install";
    const commandPrefix = manager === "yarn" ? "yarn" : `${manager} run`;

    const notes: string[] = [`Detected a Node-based project using ${manager}.`];
    const missingScripts = ["lint", "test", "build"].filter((candidate) => !scripts[candidate]);
    if (missingScripts.length > 0) {
      notes.push(`Missing package scripts for: ${missingScripts.join(", ")}. Defaulted those commands to no-op placeholders.`);
    }

    return {
      manifest: this.buildManifest({
        projectId: params.projectId,
        displayName: params.displayName,
        repoPath: params.repoPath,
        approverUsers: params.approverUsers,
        channelId: params.channelId,
        channelName: params.channelName,
        inference: {
          commands: {
            install,
            lint: scripts.lint ? `${commandPrefix} lint` : "true",
            test: scripts.test ? `${commandPrefix} test` : "true",
            build: scripts.build ? `${commandPrefix} build` : "true",
          },
          runtimeContainer: "node:22-bookworm-slim",
          risk: {
            highRiskGlobs: [".github/workflows/**", "deploy/**", "infra/**", "src/auth/**", "src/payments/**"],
            architectureGlobs: ["src/domain/**", "src/services/**", "src/store/**", "app/**", "server/**"],
            securityGlobs: [".github/workflows/**", "deploy/**", "src/auth/**", "security/**"],
            docsGlobs: ["README.md", "docs/**", "ARCHITECTURE.md"],
          },
        },
      }),
      confidence: missingScripts.length === 0 ? 0.92 : 0.74,
      notes,
    };
  }

  private async inferPythonManifest(params: {
    projectId: string;
    repoPath: string;
    displayName: string;
    approverUsers: string[];
    channelId?: string;
    channelName?: string;
  }): Promise<InferredConfig> {
    const usesRequirements = await pathExists(path.join(params.repoPath, "requirements.txt"));
    const usesPoetry = await pathExists(path.join(params.repoPath, "poetry.lock"));
    const install = usesPoetry
      ? "pip install poetry && poetry install"
      : usesRequirements
        ? "python -m pip install -r requirements.txt"
        : "python -m pip install -e .";

    return {
      manifest: this.buildManifest({
        projectId: params.projectId,
        displayName: params.displayName,
        repoPath: params.repoPath,
        approverUsers: params.approverUsers,
        channelId: params.channelId,
        channelName: params.channelName,
        inference: {
          commands: {
            install,
            lint: "python -m pytest --collect-only >/dev/null 2>&1 || true",
            test: "pytest",
            build: "python -m compileall .",
          },
          runtimeContainer: "python:3.12-slim",
          risk: {
            highRiskGlobs: [".github/workflows/**", "deploy/**", "infra/**", "auth/**", "payments/**"],
            architectureGlobs: ["src/**", "app/**", "server/**"],
            securityGlobs: [".github/workflows/**", "deploy/**", "auth/**", "security/**"],
            docsGlobs: ["README.md", "docs/**"],
          },
        },
      }),
      confidence: 0.68,
      notes: [
        "Detected a Python-based project.",
        "Python command inference is less confident than Node inference and should be reviewed before activation.",
      ],
    };
  }

  private buildManifest(params: {
    projectId: string;
    displayName: string;
    repoPath: string;
    approverUsers: string[];
    channelId?: string;
    channelName?: string;
    inference: {
      commands: {
        install: string;
        lint: string;
        test: string;
        build: string;
      };
      runtimeContainer: string;
      risk: ProjectManifest["risk"];
    } | null;
  }): ProjectManifest {
    return {
      projectId: params.projectId,
      displayName: params.displayName,
      repoPath: params.repoPath,
      runtimeContainer: params.inference?.runtimeContainer ?? this.config.DEFAULT_CONTAINER_IMAGE,
      maxParallelWorkers: 2,
      commands: params.inference?.commands ?? {
        install: "true",
        lint: "true",
        test: "true",
        build: "true",
      },
      approval: {
        requirePlanApproval: true,
        allowRiskBasedAutonomy: true,
        allowFireAndForget: false,
      },
      slack: {
        allowedChannelIds: [],
        allowedChannels: [],
        operatorUsers: [],
        approverUsers: params.approverUsers,
        responseType: "ephemeral",
        notifications: {
          channelIds: params.channelId ? [params.channelId] : [],
          channelNames: params.channelName ? [params.channelName] : [],
          events: [
            "mission.created",
            "mission.pr_opened",
            "mission.delivery_failed",
            "plan.approved",
            "stage.failed",
            "stage.retry_scheduled",
            "stage.escalated",
          ],
        },
      },
      agentRunner: {
        enabled: true,
        command: "node",
        args: ["{serviceRoot}/scripts/openai-shell-runner.mjs"],
        env: {
          FACTORY_OPENAI_MODEL: "gpt-5.2-codex",
          FACTORY_OPENAI_COMMAND_TIMEOUT_MS: "120000",
          FACTORY_OPENAI_MAX_TURNS: "12",
        },
        stages: ["architect", "implement", "review", "docs", "security"],
      },
      retry: {
        maxAttempts: 2,
        retryableStages: ["architect", "implement", "review", "docs", "qa", "integrate", "security"],
      },
      risk: params.inference?.risk ?? {
        highRiskGlobs: [".github/workflows/**", "deploy/**", "infra/**", "auth/**", "payments/**"],
        architectureGlobs: ["src/**", "app/**", "server/**"],
        securityGlobs: [".github/workflows/**", "deploy/**", "auth/**", "security/**"],
        docsGlobs: ["README.md", "docs/**"],
      },
    };
  }
}
