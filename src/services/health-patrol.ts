import type { AppConfig } from "../config.js";
import type { Mission } from "../domain/types.js";

export type HealthIncident = {
  severity: "info" | "warning" | "critical";
  message: string;
  stageId?: string;
};

export class HealthPatrol {
  private readonly config: AppConfig;

  public constructor(config: AppConfig) {
    this.config = config;
  }

  public inspect(mission: Mission): HealthIncident[] {
    const incidents: HealthIncident[] = [];
    const now = Date.now();
    const timeoutMs = this.config.HEARTBEAT_TIMEOUT_SECONDS * 1000;

    for (const stage of mission.stages) {
      if (stage.status === "failed") {
        incidents.push({
          severity: "critical",
          message: `Stage ${stage.label} failed and needs retry or escalation.`,
          stageId: stage.id,
        });
        continue;
      }

      if (stage.status !== "running") {
        continue;
      }

      if (!stage.lastHeartbeatAt) {
        incidents.push({
          severity: "warning",
          message: `Stage ${stage.label} is running without a heartbeat.`,
          stageId: stage.id,
        });
        continue;
      }

      const ageMs = now - new Date(stage.lastHeartbeatAt).getTime();
      if (ageMs > timeoutMs) {
        incidents.push({
          severity: "critical",
          message: `Stage ${stage.label} exceeded heartbeat timeout.`,
          stageId: stage.id,
        });
      }
    }

    if (mission.status === "awaiting_plan_approval") {
      incidents.push({
        severity: "info",
        message: "Mission is paused pending plan approval.",
      });
    }

    if (mission.status === "blocked") {
      incidents.push({
        severity: "warning",
        message: "Mission is blocked because no stage is runnable.",
      });
    }

    return incidents;
  }
}
