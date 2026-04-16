import { access, mkdir, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";

import type { ProjectManifest } from "../domain/types.js";
import type { WorkerEnvelope } from "./worker-runtime.js";

const execFileAsync = promisify(execFile);

export type WorkspaceLease = {
  path: string;
  mode: "git-worktree" | "ephemeral";
};

export class WorkspaceManager {
  public async prepare(manifest: ProjectManifest, envelope: WorkerEnvelope): Promise<WorkspaceLease> {
    await mkdir(path.dirname(envelope.worktreePath), { recursive: true });

    if (await this.hasGitRepo(manifest.repoPath)) {
      await execFileAsync("git", ["-C", manifest.repoPath, "worktree", "add", "--detach", envelope.worktreePath, "HEAD"]);
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

  private async hasGitRepo(repoPath: string): Promise<boolean> {
    try {
      await access(repoPath);
      const result = await stat(path.join(repoPath, ".git"));
      return result.isDirectory() || result.isFile();
    } catch {
      return false;
    }
  }
}
