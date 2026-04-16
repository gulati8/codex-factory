import { access, writeFile } from "node:fs/promises";
import path from "node:path";
import { exec } from "node:child_process";
import { promisify } from "node:util";

import type { AppConfig } from "../config.js";
import type { Mission, MissionStage, ProjectManifest, StageRun } from "../domain/types.js";
import { AgentRunner } from "./agent-runner.js";
import type { ArtifactStore } from "./artifact-store.js";
import type { WorkspaceLease } from "./workspace-manager.js";

const execAsync = promisify(exec);

export type StageExecutionResult = {
  status: "completed" | "failed";
  summary: string;
  details: Record<string, unknown>;
};

type ExecutionContext = {
  mission: Mission;
  stage: MissionStage;
  manifest: ProjectManifest;
  stageRun: StageRun;
  workspace: WorkspaceLease;
  artifactStore: ArtifactStore;
  config: AppConfig;
};

async function tryCommand(command: string, cwd: string, timeout: number) {
  return execAsync(command, {
    cwd,
    timeout,
    maxBuffer: 1024 * 1024,
  });
}

export class StageExecutor {
  private readonly config: AppConfig;
  private readonly agentRunner: AgentRunner;

  public constructor(config: AppConfig) {
    this.config = config;
    this.agentRunner = new AgentRunner(config);
  }

  public async execute(context: Omit<ExecutionContext, "config">): Promise<StageExecutionResult> {
    const fullContext: ExecutionContext = {
      ...context,
      config: this.config,
    };

    const agentResult = await this.agentRunner.execute({
      mission: fullContext.mission,
      stage: fullContext.stage,
      manifest: fullContext.manifest,
      stageRun: fullContext.stageRun,
      workspace: fullContext.workspace,
      artifactStore: fullContext.artifactStore,
    });
    if (agentResult) {
      return agentResult;
    }

    switch (fullContext.stage.kind) {
      case "qa":
        return this.runQa(fullContext);
      case "integrate":
        return this.runIntegrate(fullContext);
      default:
        return this.runArtifactStage(fullContext);
    }
  }

  private async runQa(context: ExecutionContext): Promise<StageExecutionResult> {
    const { manifest, workspace, artifactStore, stageRun, stage } = context;
    const command = manifest.commands.test;

    try {
      await access(workspace.path);
      const result = await tryCommand(command, workspace.path, context.config.STAGE_TIMEOUT_MS);
      await artifactStore.appendStageLog(stageRun, result.stdout.trim());
      if (result.stderr.trim()) {
        await artifactStore.appendStageLog(stageRun, result.stderr.trim());
      }

      return {
        status: "completed",
        summary: `Executed QA command for ${stage.label}.`,
        details: {
          command,
          workspace: workspace.path,
          mode: workspace.mode,
        },
      };
    } catch (error) {
      const message = error instanceof Error ? error.message : "Unknown QA execution failure";
      await artifactStore.appendStageLog(stageRun, message);
      return {
        status: "failed",
        summary: `QA command failed for ${stage.label}.`,
        details: {
          command,
          workspace: workspace.path,
          error: message,
        },
      };
    }
  }

  private async runIntegrate(context: ExecutionContext): Promise<StageExecutionResult> {
    const integrationNote = [
      "# Integration Summary",
      "",
      `Mission: ${context.mission.title}`,
      `Stage: ${context.stage.label}`,
      `Workstreams merged conceptually into ${context.workspace.path}.`,
      "Real branch integration logic belongs in the next production adapter.",
    ].join("\n");

    await writeFile(path.join(context.workspace.path, "INTEGRATION.md"), integrationNote);

    return {
      status: "completed",
      summary: `Prepared integration artifact for ${context.stage.label}.`,
      details: {
        workspace: context.workspace.path,
        mode: context.workspace.mode,
      },
    };
  }

  private async runArtifactStage(context: ExecutionContext): Promise<StageExecutionResult> {
    const content = [
      `# ${context.stage.label}`,
      "",
      `Mission: ${context.mission.title}`,
      `Request: ${context.mission.request}`,
      `Stage kind: ${context.stage.kind}`,
      `Workstream: ${context.stage.workstreamId ?? "none"}`,
      "",
      "This artifact is a bounded execution placeholder for the control plane.",
      "Attach a coding-agent adapter here in the next phase to turn this stage into model-backed work.",
    ].join("\n");

    await writeFile(path.join(context.workspace.path, `${context.stage.kind}.md`), content);

    return {
      status: "completed",
      summary: `Produced bounded stage artifact for ${context.stage.label}.`,
      details: {
        workspace: context.workspace.path,
        mode: context.workspace.mode,
        stageKind: context.stage.kind,
      },
    };
  }
}
