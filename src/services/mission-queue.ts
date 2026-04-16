import type { AppConfig } from "../config.js";
import type { ProjectManifest } from "../domain/types.js";
import type { ManifestStore } from "../store/manifest-store.js";
import type { MissionService } from "./mission-service.js";
import { WorkerLauncher } from "./worker-launcher.js";

export class MissionQueue {
  private readonly missionService: MissionService;
  private readonly manifestStore: ManifestStore;
  private readonly launcher: WorkerLauncher;
  private readonly config: AppConfig;
  private readonly activeStages = new Set<string>();
  private readonly activeRuns = new Map<string, Promise<void>>();
  private timer?: NodeJS.Timeout;
  private draining = false;

  public constructor(params: {
    config: AppConfig;
    missionService: MissionService;
    manifestStore: ManifestStore;
    launcher: WorkerLauncher;
  }) {
    this.config = params.config;
    this.missionService = params.missionService;
    this.manifestStore = params.manifestStore;
    this.launcher = params.launcher;
  }

  public start(): void {
    if (this.timer) {
      return;
    }

    this.timer = setInterval(() => {
      void this.tick();
    }, this.config.QUEUE_POLL_INTERVAL_MS);
  }

  public async stop(): Promise<void> {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = undefined;
    }

    if (this.activeRuns.size > 0) {
      await Promise.allSettled([...this.activeRuns.values()]);
    }
  }

  public async trigger(): Promise<void> {
    await this.tick();
  }

  private async tick(): Promise<void> {
    if (this.draining) {
      return;
    }

    this.draining = true;
    try {
      for (const mission of this.missionService.listMissions()) {
        if (!["ready_to_dispatch", "running"].includes(mission.status)) {
          continue;
        }

        const manifest = this.manifestStore.get(mission.projectId);
        const prepared = await this.missionService.dispatch(mission.id, manifest);
        const runningForMission = prepared.mission.stages.filter((stage) => stage.status === "running").length;
        const availableSlots = Math.max(0, manifest.maxParallelWorkers - runningForMission);
        if (availableSlots === 0) {
          continue;
        }

        const candidates = prepared.envelopes.slice(0, availableSlots);
        for (const candidate of candidates) {
          const stageKey = `${candidate.missionId}:${candidate.stageId}`;
          if (this.activeStages.has(stageKey)) {
            continue;
          }

          this.activeStages.add(stageKey);
          const run = this.runStage(candidate.missionId, candidate.stageId, manifest)
            .catch(() => undefined)
            .finally(() => {
              this.activeStages.delete(stageKey);
              this.activeRuns.delete(stageKey);
            });
          this.activeRuns.set(stageKey, run);
          void run;
        }
      }
    } finally {
      this.draining = false;
    }
  }

  private async runStage(missionId: string, stageId: string, manifest: ProjectManifest): Promise<void> {
    const mission = this.missionService.getMission(missionId);
    if (!mission) {
      return;
    }

    const stage = mission.stages.find((candidate) => candidate.id === stageId);
    if (!stage || stage.status !== "ready") {
      return;
    }

    await this.launcher.launch(mission, stage, manifest);
  }
}
