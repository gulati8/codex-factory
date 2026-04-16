import type { AppConfig } from "../config.js";
import type { Mission, MissionStage, ProjectManifest, StageRun } from "../domain/types.js";
import type { StateStore } from "../store/state-store.js";
import { ArtifactStore } from "./artifact-store.js";
import { StageExecutor } from "./stage-executor.js";
import type { MissionService } from "./mission-service.js";
import { WorkspaceManager } from "./workspace-manager.js";
import { WorkerRuntime, type WorkerEnvelope } from "./worker-runtime.js";

function nowIso(): string {
  return new Date().toISOString();
}

export class WorkerLauncher {
  private readonly missionService: MissionService;
  private readonly store: StateStore;
  private readonly workerRuntime: WorkerRuntime;
  private readonly artifactStore: ArtifactStore;
  private readonly workspaceManager: WorkspaceManager;
  private readonly executor: StageExecutor;

  public constructor(params: {
    config: AppConfig;
    missionService: MissionService;
    store: StateStore;
    workerRuntime: WorkerRuntime;
  }) {
    this.missionService = params.missionService;
    this.store = params.store;
    this.workerRuntime = params.workerRuntime;
    this.artifactStore = new ArtifactStore(params.config);
    this.workspaceManager = new WorkspaceManager();
    this.executor = new StageExecutor(params.config);
  }

  public async launch(mission: Mission, stage: MissionStage, manifest: ProjectManifest): Promise<void> {
    const envelope = this.workerRuntime.buildEnvelopeForStage(mission, manifest, stage);
    const artifactDir = await this.artifactStore.initStage(mission, stage, envelope);
    const attempt = this.store.listStageRuns(mission.id, stage.id).length + 1;
    const stageRun: StageRun = {
      missionId: mission.id,
      stageId: stage.id,
      stageKind: stage.kind,
      status: "running",
      attempt,
      startedAt: nowIso(),
      finishedAt: null,
      worktreePath: envelope.worktreePath,
      artifactDir,
      summary: `Running ${stage.label}.`,
    };

    await this.store.saveStageRun(stageRun);
    await this.missionService.markStageStarted(mission.id, stage.id, "launcher");
    try {
      const workspace = await this.workspaceManager.prepare(manifest, envelope);
      const result = await this.executor.execute({
        mission,
        stage,
        manifest,
        stageRun,
        workspace,
        artifactStore: this.artifactStore,
      });

      const finishedRun: StageRun = {
        ...stageRun,
        status: result.status,
        finishedAt: nowIso(),
        summary: result.summary,
      };

      await this.artifactStore.writeEvidence(finishedRun, {
        summary: result.summary,
        details: result.details,
      });
      await this.store.saveStageRun(finishedRun);
      if (result.status === "failed" && this.shouldRetry(stage, manifest, attempt)) {
        await this.missionService.scheduleRetry(
          mission.id,
          stage.id,
          "launcher",
          `Retry scheduled for ${stage.label} after attempt ${attempt}.`,
        );
        return;
      }
      await this.missionService.completeStage(
        mission.id,
        stage.id,
        "launcher",
        result.summary,
        result.status === "failed",
      );
    } catch (error) {
      const message = error instanceof Error ? error.message : "Unknown launcher failure";
      const failedRun: StageRun = {
        ...stageRun,
        status: "failed",
        finishedAt: nowIso(),
        summary: message,
      };

      await this.artifactStore.appendStageLog(failedRun, message);
      await this.artifactStore.writeEvidence(failedRun, {
        summary: message,
        details: {
          launcherFailure: true,
        },
      });
      await this.store.saveStageRun(failedRun);
      if (this.shouldRetry(stage, manifest, attempt)) {
        await this.missionService.scheduleRetry(
          mission.id,
          stage.id,
          "launcher",
          `Retry scheduled for ${stage.label} after launcher failure on attempt ${attempt}.`,
        );
        return;
      }
      await this.missionService.completeStage(mission.id, stage.id, "launcher", message, true);
    }
  }

  private shouldRetry(stage: MissionStage, manifest: ProjectManifest, attempt: number): boolean {
    return manifest.retry.retryableStages.includes(stage.kind) && attempt < manifest.retry.maxAttempts;
  }
}
