import path from "node:path";

import type { AppConfig } from "../config.js";
import type { Mission, MissionStage, ProjectManifest } from "../domain/types.js";

export type WorkerEnvelope = {
  missionId: string;
  stageId: string;
  stageKind: string;
  workerHint: string;
  repoPath: string;
  worktreePath: string;
  containerImage: string;
  successCriteria: string[];
};

export class WorkerRuntime {
  private readonly config: AppConfig;

  public constructor(config: AppConfig) {
    this.config = config;
  }

  public buildEnvelopes(mission: Mission, manifest: ProjectManifest): WorkerEnvelope[] {
    return mission.stages
      .filter((stage) => stage.status === "ready")
      .map((stage) => this.toEnvelope(mission, manifest, stage));
  }

  public buildEnvelopeForStage(mission: Mission, manifest: ProjectManifest, stage: MissionStage): WorkerEnvelope {
    return this.toEnvelope(mission, manifest, stage);
  }

  private toEnvelope(mission: Mission, manifest: ProjectManifest, stage: MissionStage): WorkerEnvelope {
    return {
      missionId: mission.id,
      stageId: stage.id,
      stageKind: stage.kind,
      workerHint: stage.workerHint,
      repoPath: manifest.repoPath,
      worktreePath: path.join(this.config.DEFAULT_WORKTREE_ROOT, mission.id, stage.id),
      containerImage: manifest.runtimeContainer || this.config.DEFAULT_CONTAINER_IMAGE,
      successCriteria: [
        "Write outputs only through declared mission artifacts.",
        "Avoid touching files outside the assigned workstream when a workstream is present.",
        "Leave a concise evidence summary on completion.",
      ],
    };
  }
}
