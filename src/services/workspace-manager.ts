import { access, mkdir, rm, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";

import type { AppConfig } from "../config.js";
import type { ProjectManifest } from "../domain/types.js";
import type { WorkerEnvelope } from "./worker-runtime.js";

const execFileAsync = promisify(execFile);

export type WorkspaceLease = {
  path: string;
  mode: "git-worktree" | "ephemeral";
};

export class WorkspaceManager {
  private readonly config: AppConfig;

  public constructor(config: AppConfig) {
    this.config = config;
  }

  public async prepare(manifest: ProjectManifest, envelope: WorkerEnvelope): Promise<WorkspaceLease> {
    await mkdir(path.dirname(envelope.worktreePath), { recursive: true });
    const hasGitRepo = await this.hasGitRepo(manifest.repoPath);
    await this.resetWorkspace(manifest.repoPath, envelope.worktreePath, hasGitRepo);

    if (hasGitRepo) {
      await execFileAsync("git", ["-C", manifest.repoPath, "worktree", "add", "--detach", envelope.worktreePath, "HEAD"]);
      await this.installDependencies(manifest, envelope.worktreePath);
      return {
        path: envelope.worktreePath,
        mode: "git-worktree",
      };
    }

    await mkdir(envelope.worktreePath, { recursive: true });
    await writeFile(
      path.join(envelope.worktreePath, "WORKSPACE.md"),
      [
        `# Workspace`,
        ``,
        `Source repo path: ${manifest.repoPath}`,
        `This workspace was created without a git worktree because the repo path was unavailable or not a git repository.`,
      ].join("\n"),
    );

    return {
      path: envelope.worktreePath,
      mode: "ephemeral",
    };
  }

  private async resetWorkspace(repoPath: string, workspacePath: string, hasGitRepo: boolean): Promise<void> {
    if (hasGitRepo) {
      try {
        await execFileAsync("git", ["-C", repoPath, "worktree", "remove", "--force", workspacePath]);
      } catch {
        // Ignore cleanup misses; the workspace may only exist on disk.
      }
    }

    await rm(workspacePath, { recursive: true, force: true });
  }

  private async hasGitRepo(repoPath: string): Promise<boolean> {
    try {
      await access(repoPath);
      const result = await stat(path.join(repoPath, ".git"));
      return result.isDirectory() || result.isFile();
    } catch {
      return false;
    }
  }

  private async installDependencies(manifest: ProjectManifest, workspacePath: string): Promise<void> {
    const command = manifest.commands.install.trim();
    if (!command) {
      return;
    }

    await execFileAsync("bash", ["-lc", command], {
      cwd: workspacePath,
      timeout: this.config.STAGE_TIMEOUT_MS,
      maxBuffer: 1024 * 1024,
      env: process.env,
    });
  }
}
