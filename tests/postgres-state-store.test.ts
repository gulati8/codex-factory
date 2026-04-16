import { newDb } from "pg-mem";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import type { Mission, MissionEvent, StageRun } from "../src/domain/types.js";
import { PostgresStateStore } from "../src/store/postgres-state-store.js";

describe("PostgresStateStore", () => {
  let store: PostgresStateStore;

  beforeEach(async () => {
    const db = newDb();
    const { Pool } = db.adapters.createPg();
    store = new PostgresStateStore(new Pool());
    await store.init();
  });

  afterEach(async () => {
    await store.close();
  });

  it("persists and reads missions, events, and stage runs", async () => {
    const mission: Mission = {
      id: "mission_pg",
      projectId: "client-portal",
      title: "Postgres mission",
      request: "Exercise the Postgres state store.",
      changedPaths: ["src/api/report.ts"],
      autonomyMode: "managed",
      riskLevel: "medium",
      status: "running",
      plan: {
        summary: "Persist everything.",
        objectives: ["Save mission state."],
        assumptions: ["Single workstream."],
        workstreams: [],
        routeDecisions: [],
      },
      approval: {
        planApproved: true,
        mergeApprovalRequired: true,
        approvedBy: "amit",
        approvedAt: new Date().toISOString(),
      },
      stages: [],
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    };
    const event: MissionEvent = {
      id: "event_pg",
      missionId: mission.id,
      type: "mission.created",
      actor: "test",
      summary: "Created for test.",
      createdAt: new Date().toISOString(),
      metadata: {},
    };
    const stageRun: StageRun = {
      missionId: mission.id,
      stageId: "implement_pg",
      stageKind: "implement",
      status: "running",
      attempt: 1,
      startedAt: new Date().toISOString(),
      finishedAt: null,
      worktreePath: "/tmp/worktree",
      artifactDir: "/tmp/artifacts",
      summary: "Running implement stage.",
    };

    await store.saveMission(mission);
    await store.appendEvent(event);
    await store.saveStageRun(stageRun);

    expect(store.getMission(mission.id)?.title).toBe("Postgres mission");
    expect(store.listMissions()).toHaveLength(1);
    expect(store.listEvents(mission.id)).toEqual([event]);
    expect(store.listStageRuns(mission.id)).toEqual([stageRun]);
  });
});
