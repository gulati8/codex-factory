import { createId } from "../utils/ids.js";
import {
  createMissionInputSchema,
  type CreateMissionInput,
  type Mission,
  type MissionEvent,
  type MissionEventType,
  type MissionStage,
  type ProjectManifest,
  type StageKind,
} from "../domain/types.js";
import type { StateStore } from "../store/state-store.js";
import { PolicyEngine } from "./policy-engine.js";
import { Planner } from "./planner.js";
import { WorkerRuntime, type WorkerEnvelope } from "./worker-runtime.js";

function nowIso(): string {
  return new Date().toISOString();
}

function stageLabel(kind: StageKind, index?: number): string {
  if (kind !== "implement") {
    return kind.charAt(0).toUpperCase() + kind.slice(1);
  }

  return `Implement${index ? ` #${index}` : ""}`;
}

export class MissionService {
  private readonly store: StateStore;
  private readonly policyEngine: PolicyEngine;
  private readonly planner: Planner;
  private readonly workerRuntime: WorkerRuntime;
  private readonly onMissionEvent?: (params: { mission: Mission; event: MissionEvent }) => Promise<void>;

  public constructor(params: {
    store: StateStore;
    policyEngine: PolicyEngine;
    planner: Planner;
    workerRuntime: WorkerRuntime;
    onMissionEvent?: (params: { mission: Mission; event: MissionEvent }) => Promise<void>;
  }) {
    this.store = params.store;
    this.policyEngine = params.policyEngine;
    this.planner = params.planner;
    this.workerRuntime = params.workerRuntime;
    this.onMissionEvent = params.onMissionEvent;
  }

  public listMissions(): Mission[] {
    return this.store.listMissions();
  }

  public getMission(id: string): Mission | undefined {
    return this.store.getMission(id);
  }

  public listEvents(missionId: string): MissionEvent[] {
    return this.store.listEvents(missionId);
  }

  public listStageRuns(missionId: string) {
    return this.store.listStageRuns(missionId);
  }

  public listStageRunsForStage(missionId: string, stageId: string) {
    return this.store.listStageRuns(missionId, stageId);
  }

  public async recordMissionEvent(
    missionId: string,
    input: {
      type: MissionEventType;
      actor: string;
      summary: string;
      metadata: Record<string, unknown>;
    },
  ): Promise<Mission> {
    const mission = this.requireMission(missionId);
    await this.emitMissionEvent(mission, {
      ...input,
      createdAt: nowIso(),
    });
    return this.requireMission(missionId);
  }

  public async createMission(rawInput: CreateMissionInput, manifest: ProjectManifest): Promise<Mission> {
    const input = createMissionInputSchema.parse(rawInput);
    const route = this.policyEngine.evaluate({
      manifest,
      changedPaths: input.changedPaths,
      request: input.request,
      autonomyMode: input.autonomyMode,
    });

    const plan = this.planner.build({
      project: manifest,
      request: input.request,
      changedPaths: input.changedPaths,
      requiredStages: route.requiredStages,
      reasons: route.reasons,
    });

    const timestamp = nowIso();
    const missionId = createId("mission");
    const stages = this.compileStages(route.requiredStages, plan.workstreams);
    const mission: Mission = {
      id: missionId,
      projectId: input.projectId,
      title: input.title,
      request: input.request,
      changedPaths: input.changedPaths,
      autonomyMode: input.autonomyMode,
      riskLevel: route.riskLevel,
      status: manifest.approval.requirePlanApproval ? "awaiting_plan_approval" : "ready_to_dispatch",
      plan,
      approval: {
        planApproved: !manifest.approval.requirePlanApproval,
        mergeApprovalRequired: route.mergeApprovalRequired,
        approvedBy: null,
        approvedAt: null,
      },
      stages,
      createdAt: timestamp,
      updatedAt: timestamp,
    };

    await this.store.saveMission(mission);
    await this.emitMissionEvent(mission, {
      type: "mission.created",
      actor: input.actor,
      summary: `Mission created for project ${input.projectId}.`,
      createdAt: timestamp,
      metadata: {
        route,
      },
    });

    return mission;
  }

  public async approvePlan(missionId: string, actor: string): Promise<Mission> {
    const mission = this.requireMission(missionId);
    const timestamp = nowIso();
    const updated: Mission = {
      ...mission,
      status: "ready_to_dispatch",
      approval: {
        ...mission.approval,
        planApproved: true,
        approvedBy: actor,
        approvedAt: timestamp,
      },
      updatedAt: timestamp,
    };

    await this.store.saveMission(updated);
    await this.emitMissionEvent(updated, {
      type: "plan.approved",
      actor,
      summary: "Plan approved and mission unlocked for dispatch.",
      createdAt: timestamp,
      metadata: {},
    });

    return updated;
  }

  public async markStageStarted(missionId: string, stageId: string, actor: string): Promise<Mission> {
    const mission = this.requireMission(missionId);
    const timestamp = nowIso();
    const stages: MissionStage[] = mission.stages.map((stage) => {
      if (stage.id !== stageId) {
        return stage;
      }

      return {
        ...stage,
        status: "running",
        lastHeartbeatAt: timestamp,
        updatedAt: timestamp,
      };
    });

    const updated: Mission = {
      ...mission,
      stages,
      status: "running",
      updatedAt: timestamp,
    };

    await this.store.saveMission(updated);
    await this.emitMissionEvent(updated, {
      type: "stage.started",
      actor,
      summary: `Stage ${stageId} started.`,
      createdAt: timestamp,
      metadata: {
        stageId,
      },
    });

    return updated;
  }

  public async dispatch(missionId: string, manifest: ProjectManifest): Promise<{ mission: Mission; envelopes: WorkerEnvelope[] }> {
    const mission = this.requireMission(missionId);
    if (!mission.approval.planApproved) {
      throw new Error("Mission cannot dispatch before plan approval.");
    }

    const timestamp = nowIso();
    const readyStageIds = new Set(
      mission.stages
        .filter((stage) => stage.status === "pending" && stage.dependsOn.every((dependency) => this.stageById(mission, dependency).status === "completed"))
        .map((stage) => stage.id),
    );

    const updatedStages: MissionStage[] = mission.stages.map((stage) => {
      if (stage.status === "pending" && readyStageIds.has(stage.id)) {
        return {
          ...stage,
          status: "ready" as const,
          updatedAt: timestamp,
        };
      }

      return stage;
    });

    const hasReadyStages = updatedStages.some((stage) => stage.status === "ready");
    const hasRunningStages = updatedStages.some((stage) => stage.status === "running");
    const hasFailures = updatedStages.some((stage) => stage.status === "failed");
    const allClosed = updatedStages.every((stage) => ["completed", "skipped"].includes(stage.status));

    const updatedMission: Mission = {
      ...mission,
      status: hasFailures ? "failed" : allClosed ? "completed" : hasReadyStages || hasRunningStages ? "running" : "ready_to_dispatch",
      stages: updatedStages,
      updatedAt: timestamp,
    };

    const changed =
      mission.status !== updatedMission.status ||
      updatedStages.some((stage, index) => stage.status !== mission.stages[index]?.status);

    if (changed || readyStageIds.size > 0) {
      await this.store.saveMission(updatedMission);
      await this.emitMissionEvent(updatedMission, {
        type: "mission.dispatched",
        actor: "system",
        summary: "Mission dispatched to ready worker lanes.",
        createdAt: timestamp,
        metadata: {
          readyStageIds: [...readyStageIds],
        },
      });
    }

    return {
      mission: updatedMission,
      envelopes: this.workerRuntime.buildEnvelopes(updatedMission, manifest),
    };
  }

  public async recordHeartbeat(missionId: string, stageId: string, actor: string, summary: string): Promise<Mission> {
    const mission = this.requireMission(missionId);
    const timestamp = nowIso();
    const stages: MissionStage[] = mission.stages.map((stage) => {
      if (stage.id !== stageId) {
        return stage;
      }

      return {
        ...stage,
        status: "running" as const,
        lastHeartbeatAt: timestamp,
        updatedAt: timestamp,
      };
    });

    const updated: Mission = {
      ...mission,
      stages,
      status: "running",
      updatedAt: timestamp,
    };

    await this.store.saveMission(updated);
    await this.emitMissionEvent(updated, {
      type: "stage.heartbeat",
      actor,
      summary,
      createdAt: timestamp,
      metadata: {
        stageId,
      },
    });

    return updated;
  }

  public async completeStage(
    missionId: string,
    stageId: string,
    actor: string,
    summary: string,
    failed = false,
  ): Promise<Mission> {
    const mission = this.requireMission(missionId);
    const timestamp = nowIso();
    const nextStatus: MissionStage["status"] = failed ? "failed" : "completed";
    const stages: MissionStage[] = mission.stages.map((stage) => {
      if (stage.id !== stageId) {
        return stage;
      }

      return {
        ...stage,
        status: nextStatus,
        lastHeartbeatAt: timestamp,
        updatedAt: timestamp,
      };
    });
    const promotedStages: MissionStage[] = stages.map((stage) => {
      if (
        stage.status === "pending" &&
        stage.dependsOn.every((dependency) => {
          const dependencyStage = stages.find((candidate) => candidate.id === dependency);
          return dependencyStage?.status === "completed";
        })
      ) {
        return {
          ...stage,
          status: "ready",
          updatedAt: timestamp,
        };
      }

      return stage;
    });

    const anyFailed = promotedStages.some((stage) => stage.status === "failed");
    const anyRunning = promotedStages.some((stage) => stage.status === "running");
    const anyReady = promotedStages.some((stage) => stage.status === "ready");
    const allClosed = promotedStages.every((stage) => ["completed", "skipped"].includes(stage.status));

    const updated: Mission = {
      ...mission,
      stages: promotedStages,
      status: anyFailed ? "failed" : allClosed ? "completed" : anyRunning || anyReady ? "running" : "blocked",
      updatedAt: timestamp,
    };

    await this.store.saveMission(updated);
    await this.emitMissionEvent(updated, {
      type: failed ? "stage.failed" : "stage.completed",
      actor,
      summary,
      createdAt: timestamp,
      metadata: {
        stageId,
      },
    });

    return updated;
  }

  public async scheduleRetry(missionId: string, stageId: string, actor: string, summary: string): Promise<Mission> {
    const mission = this.requireMission(missionId);
    const timestamp = nowIso();

    const stages: MissionStage[] = mission.stages.map((stage) => {
      if (stage.id !== stageId) {
        return stage;
      }

      return {
        ...stage,
        status: "ready",
        lastHeartbeatAt: null,
        updatedAt: timestamp,
      };
    });

    const updated: Mission = {
      ...mission,
      stages,
      status: "running",
      updatedAt: timestamp,
    };

    await this.store.saveMission(updated);
    await this.emitMissionEvent(updated, {
      type: "stage.retry_scheduled",
      actor,
      summary,
      createdAt: timestamp,
      metadata: {
        stageId,
        previousStatus: mission.stages.find((stage) => stage.id === stageId)?.status,
      },
    });

    return updated;
  }

  public async escalateStage(missionId: string, stageId: string, actor: string, summary: string): Promise<Mission> {
    const mission = this.requireMission(missionId);
    const timestamp = nowIso();

    const stages: MissionStage[] = mission.stages.map((stage) => {
      if (stage.id !== stageId) {
        return stage;
      }

      return {
        ...stage,
        status: "blocked",
        updatedAt: timestamp,
      };
    });

    const updated: Mission = {
      ...mission,
      stages,
      status: "blocked",
      updatedAt: timestamp,
    };

    await this.store.saveMission(updated);
    await this.emitMissionEvent(updated, {
      type: "stage.escalated",
      actor,
      summary,
      createdAt: timestamp,
      metadata: {
        stageId,
      },
    });

    return updated;
  }

  private compileStages(requiredStages: StageKind[], workstreams: { id: string; title: string }[]): MissionStage[] {
    const timestamp = nowIso();
    const stages: MissionStage[] = [];
    const stageIdsByKind = new Map<StageKind, string[]>();

    const addStage = (kind: StageKind, dependsOn: string[], notes: string[], workstreamId?: string): string => {
      const count = stageIdsByKind.get(kind)?.length ?? 0;
      const id = createId(kind);
      const next = stageIdsByKind.get(kind) ?? [];
      next.push(id);
      stageIdsByKind.set(kind, next);

      stages.push({
        id,
        kind,
        label: stageLabel(kind, kind === "implement" ? count + 1 : undefined),
        status: "pending",
        required: true,
        dependsOn,
        workstreamId,
        workerHint: `${kind}-worker`,
        notes,
        lastHeartbeatAt: null,
        updatedAt: timestamp,
      });

      return id;
    };

    const researchId = requiredStages.includes("research")
      ? addStage("research", [], ["Gather missing information before design and execution."])
      : undefined;
    const architectId = requiredStages.includes("architect")
      ? addStage("architect", researchId ? [researchId] : [], ["Decide structural changes before implementation."])
      : undefined;

    const implementDependsOn = [researchId, architectId].filter(Boolean) as string[];
    const implementIds = workstreams.map((workstream) =>
      addStage("implement", implementDependsOn, [`Own only the declared workstream ${workstream.title}.`], workstream.id),
    );

    const integrateId = addStage("integrate", implementIds, ["Merge isolated workstreams into a single branch."]);

    if (requiredStages.includes("review")) {
      addStage("review", [integrateId], ["Review correctness, scope fit, and regression risk."]);
    }

    if (requiredStages.includes("qa")) {
      addStage("qa", [integrateId], ["Run targeted tests and produce machine-readable evidence."]);
    }

    if (requiredStages.includes("security")) {
      addStage("security", [integrateId], ["Inspect high-risk surfaces for misuse and secrets exposure."]);
    }

    if (requiredStages.includes("docs")) {
      addStage("docs", [integrateId], ["Update public-facing or operational documentation where needed."]);
    }

    return stages;
  }

  private requireMission(id: string): Mission {
    const mission = this.getMission(id);
    if (!mission) {
      throw new Error(`Unknown mission: ${id}`);
    }

    return mission;
  }

  private stageById(mission: Mission, stageId: string): MissionStage {
    const stage = mission.stages.find((candidate) => candidate.id === stageId);
    if (!stage) {
      throw new Error(`Unknown stage ${stageId} for mission ${mission.id}`);
    }

    return stage;
  }

  private async emitMissionEvent(
    mission: Mission,
    input: {
      type: MissionEventType;
      actor: string;
      summary: string;
      createdAt: string;
      metadata: Record<string, unknown>;
    },
  ): Promise<void> {
    const event: MissionEvent = {
      id: createId("event"),
      missionId: mission.id,
      type: input.type,
      actor: input.actor,
      summary: input.summary,
      createdAt: input.createdAt,
      metadata: input.metadata,
    };

    await this.store.appendEvent(event);
    await this.onMissionEvent?.({ mission, event });
  }
}
