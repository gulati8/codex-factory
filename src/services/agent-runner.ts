import { execFile } from "node:child_process";
import { promisify } from "node:util";

import type { AppConfig } from "../config.js";
import type { AgentRunnerConfig, Mission, MissionStage, ProjectManifest, StageRun } from "../domain/types.js";
import type { ArtifactStore } from "./artifact-store.js";
import type { StageExecutionResult } from "./stage-executor.js";
import type { WorkspaceLease } from "./workspace-manager.js";

const execFileAsync = promisify(execFile);

type AgentExecutionContext = {
  mission: Mission;
  stage: MissionStage;
  manifest: ProjectManifest;
  stageRun: StageRun;
  workspace: WorkspaceLease;
  artifactStore: ArtifactStore;
};

function interpolate(template: string, values: Record<string, string>): string {
  return template.replace(/\{([a-zA-Z0-9_]+)\}/g, (_, key: string) => values[key] ?? "");
}

export class AgentRunner {
  private readonly config: AppConfig;

  public constructor(config: AppConfig) {
    this.config = config;
  }

  public canHandle(stage: MissionStage, manifest: ProjectManifest): boolean {
    return Boolean(manifest.agentRunner?.enabled && manifest.agentRunner.stages.includes(stage.kind));
  }

  public async execute(context: AgentExecutionContext): Promise<StageExecutionResult | null> {
    const runner = context.manifest.agentRunner;
    if (!runner || !this.canHandle(context.stage, context.manifest)) {
      return null;
    }

    const prompt = this.buildPrompt(context);
    const promptPath = await context.artifactStore.writeStagePrompt(context.stageRun, prompt);
    const missionPacketPath = context.artifactStore.missionPacketPathForStage(context.stageRun.missionId, context.stageRun.stageId);

    const substitutions = {
      missionId: context.mission.id,
      projectId: context.manifest.projectId,
      stageId: context.stage.id,
      stageKind: context.stage.kind,
      serviceRoot: process.cwd(),
      workspacePath: context.workspace.path,
      artifactDir: context.stageRun.artifactDir,
      missionPacketPath,
      promptPath,
      repoPath: context.manifest.repoPath,
    };

    const args = runner.args.map((arg) => interpolate(arg, substitutions));
    const env = this.buildEnv(runner, substitutions);

    try {
      const result = await execFileAsync(runner.command, args, {
        cwd: context.workspace.path,
        env,
        timeout: this.config.STAGE_TIMEOUT_MS,
        maxBuffer: 1024 * 1024,
      });

      if (result.stdout.trim()) {
        await context.artifactStore.appendStageLog(context.stageRun, result.stdout.trim());
      }
      if (result.stderr.trim()) {
        await context.artifactStore.appendStageLog(context.stageRun, result.stderr.trim());
      }

      return {
        status: "completed",
        summary: `External agent runner completed ${context.stage.label}.`,
        details: {
          command: runner.command,
          args,
          promptPath,
          missionPacketPath,
          workspace: context.workspace.path,
          mode: context.workspace.mode,
        },
      };
    } catch (error) {
      const message = error instanceof Error ? error.message : "Unknown external agent failure";
      await context.artifactStore.appendStageLog(context.stageRun, message);
      return {
        status: "failed",
        summary: `External agent runner failed for ${context.stage.label}.`,
        details: {
          command: runner.command,
          args,
          promptPath,
          missionPacketPath,
          workspace: context.workspace.path,
          error: message,
        },
      };
    }
  }

  private buildEnv(runner: AgentRunnerConfig, substitutions: Record<string, string>): NodeJS.ProcessEnv {
    const customEnv = Object.fromEntries(
      Object.entries(runner.env).map(([key, value]) => [key, interpolate(value, substitutions)]),
    );

    return {
      ...process.env,
      ...customEnv,
      FACTORY_MISSION_ID: substitutions.missionId,
      FACTORY_PROJECT_ID: substitutions.projectId,
      FACTORY_STAGE_ID: substitutions.stageId,
      FACTORY_STAGE_KIND: substitutions.stageKind,
      FACTORY_SERVICE_ROOT: substitutions.serviceRoot,
      FACTORY_WORKSPACE_PATH: substitutions.workspacePath,
      FACTORY_ARTIFACT_DIR: substitutions.artifactDir,
      FACTORY_MISSION_PACKET_PATH: substitutions.missionPacketPath,
      FACTORY_STAGE_PROMPT_PATH: substitutions.promptPath,
      FACTORY_REPO_PATH: substitutions.repoPath,
    };
  }

  private buildPrompt(context: AgentExecutionContext): string {
    const workstream = context.stage.workstreamId
      ? context.mission.plan.workstreams.find((candidate) => candidate.id === context.stage.workstreamId)
      : undefined;

    return [
      `# Stage Prompt`,
      ``,
      `Mission: ${context.mission.title}`,
      `Project: ${context.manifest.projectId}`,
      `Stage: ${context.stage.label} (${context.stage.kind})`,
      `Request: ${context.mission.request}`,
      ``,
      `## Plan Summary`,
      context.mission.plan.summary,
      ``,
      `## Objectives`,
      ...context.mission.plan.objectives.map((objective) => `- ${objective}`),
      ``,
      `## Stage Notes`,
      ...context.stage.notes.map((note) => `- ${note}`),
      ...(workstream
        ? [
            ``,
            `## Assigned Workstream`,
            `- ${workstream.title}`,
            `- Goal: ${workstream.goal}`,
            ...workstream.paths.map((candidate) => `- Path: ${candidate}`),
          ]
        : []),
      ``,
      `## Success Criteria`,
      `- Work only inside the assigned workspace and stage scope.`,
      `- Persist outputs in the workspace and summarize evidence in the artifact directory.`,
      `- Leave the mission packet and prompt intact for traceability.`,
      ``,
      `Mission packet: ${context.artifactStore.missionPacketPathForStage(context.stageRun.missionId, context.stageRun.stageId)}`,
      `Artifact directory: ${context.stageRun.artifactDir}`,
      `Workspace: ${context.workspace.path}`,
    ].join("\n");
  }
}
