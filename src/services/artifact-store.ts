import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";

import type { AppConfig } from "../config.js";
import type { Mission, MissionStage, StageRun } from "../domain/types.js";
import type { WorkerEnvelope } from "./worker-runtime.js";

export class ArtifactStore {
  private readonly artifactsDir: string;

  public constructor(config: AppConfig) {
    this.artifactsDir = config.ARTIFACTS_DIR;
  }

  public artifactDirForStage(missionId: string, stageId: string): string {
    return path.join(this.artifactsDir, missionId, stageId);
  }

  public missionPacketPathForStage(missionId: string, stageId: string): string {
    return path.join(this.artifactDirForStage(missionId, stageId), "mission-packet.json");
  }

  public stagePromptPathForStage(missionId: string, stageId: string): string {
    return path.join(this.artifactDirForStage(missionId, stageId), "stage-prompt.md");
  }

  public async initStage(mission: Mission, stage: MissionStage, envelope: WorkerEnvelope): Promise<string> {
    const artifactDir = this.artifactDirForStage(mission.id, stage.id);
    await mkdir(artifactDir, { recursive: true });

    await writeFile(
      this.missionPacketPathForStage(mission.id, stage.id),
      JSON.stringify(
        {
          missionId: mission.id,
          missionTitle: mission.title,
          stage,
          envelope,
          plan: mission.plan,
          request: mission.request,
          changedPaths: mission.changedPaths,
        },
        null,
        2,
      ),
    );

    return artifactDir;
  }

  public async writeStagePrompt(stageRun: StageRun, prompt: string): Promise<string> {
    await mkdir(stageRun.artifactDir, { recursive: true });
    const promptPath = this.stagePromptPathForStage(stageRun.missionId, stageRun.stageId);
    await writeFile(promptPath, prompt);
    return promptPath;
  }

  public async writeEvidence(stageRun: StageRun, evidence: { summary: string; details: Record<string, unknown> }): Promise<void> {
    await mkdir(stageRun.artifactDir, { recursive: true });
    await writeFile(
      path.join(stageRun.artifactDir, "evidence.json"),
      JSON.stringify(
        {
          missionId: stageRun.missionId,
          stageId: stageRun.stageId,
          attempt: stageRun.attempt,
          summary: evidence.summary,
          details: evidence.details,
        },
        null,
        2,
      ),
    );
  }

  public async appendStageLog(stageRun: StageRun, content: string): Promise<void> {
    await mkdir(stageRun.artifactDir, { recursive: true });
    const logPath = path.join(stageRun.artifactDir, "execution.log");
    let previous = "";
    try {
      previous = await readFile(logPath, "utf8");
    } catch {
      previous = "";
    }

    const next = `${previous}${previous ? "\n" : ""}${content}`;
    await writeFile(logPath, next);
  }

  public async writeEscalation(missionId: string, stageId: string, payload: Record<string, unknown>): Promise<string> {
    const artifactDir = this.artifactDirForStage(missionId, stageId);
    await mkdir(artifactDir, { recursive: true });
    const escalationPath = path.join(artifactDir, "escalation.json");
    await writeFile(escalationPath, JSON.stringify(payload, null, 2));
    return escalationPath;
  }
}
