import { Pool } from "pg";

import {
  missionEventSchema,
  missionSchema,
  stageRunSchema,
  type Mission,
  type MissionEvent,
  type StageRun,
} from "../domain/types.js";
import type { StateStore } from "./state-store.js";

type PersistedState = {
  missions: Mission[];
  events: MissionEvent[];
  stageRuns: StageRun[];
};

const emptyState: PersistedState = {
  missions: [],
  events: [],
  stageRuns: [],
};

export class PostgresStateStore implements StateStore {
  private readonly pool: Pool;
  private readonly shouldClosePool: boolean;
  private state: PersistedState = emptyState;

  public constructor(database: string | Pool) {
    if (typeof database === "string") {
      this.pool = new Pool({
        connectionString: database,
      });
      this.shouldClosePool = true;
      return;
    }

    this.pool = database;
    this.shouldClosePool = false;
  }

  public async init(): Promise<void> {
    await this.pool.query(`
      create table if not exists missions (
        id text primary key,
        created_at timestamptz not null,
        updated_at timestamptz not null,
        payload jsonb not null
      );
    `);
    await this.pool.query(`
      create table if not exists mission_events (
        id text primary key,
        mission_id text not null,
        created_at timestamptz not null,
        payload jsonb not null
      );
    `);
    await this.pool.query(`
      create index if not exists mission_events_mission_id_created_at_idx
      on mission_events (mission_id, created_at desc);
    `);
    await this.pool.query(`
      create table if not exists stage_runs (
        mission_id text not null,
        stage_id text not null,
        attempt integer not null,
        started_at timestamptz not null,
        payload jsonb not null,
        primary key (mission_id, stage_id, attempt)
      );
    `);
    await this.pool.query(`
      create index if not exists stage_runs_mission_id_started_at_idx
      on stage_runs (mission_id, started_at desc);
    `);

    const [missionsResult, eventsResult, stageRunsResult] = await Promise.all([
      this.pool.query<{ payload: Mission }>("select payload from missions"),
      this.pool.query<{ payload: MissionEvent }>("select payload from mission_events"),
      this.pool.query<{ payload: StageRun }>("select payload from stage_runs"),
    ]);

    this.state = {
      missions: missionsResult.rows.map((row) => missionSchema.parse(row.payload)),
      events: eventsResult.rows.map((row) => missionEventSchema.parse(row.payload)),
      stageRuns: stageRunsResult.rows.map((row) => stageRunSchema.parse(row.payload)),
    };
  }

  public async close(): Promise<void> {
    if (this.shouldClosePool) {
      await this.pool.end();
    }
  }

  public listMissions(): Mission[] {
    return [...this.state.missions].sort((left, right) => right.createdAt.localeCompare(left.createdAt));
  }

  public getMission(id: string): Mission | undefined {
    return this.state.missions.find((mission) => mission.id === id);
  }

  public listEvents(missionId: string): MissionEvent[] {
    return this.state.events.filter((event) => event.missionId === missionId);
  }

  public listStageRuns(missionId: string, stageId?: string): StageRun[] {
    return this.state.stageRuns.filter(
      (stageRun) => stageRun.missionId === missionId && (!stageId || stageRun.stageId === stageId),
    );
  }

  public async saveMission(mission: Mission): Promise<void> {
    const index = this.state.missions.findIndex((existing) => existing.id === mission.id);
    if (index === -1) {
      this.state.missions.push(mission);
    } else {
      this.state.missions[index] = mission;
    }

    await this.pool.query(
      `
        insert into missions (id, created_at, updated_at, payload)
        values ($1, $2::timestamptz, $3::timestamptz, $4::jsonb)
        on conflict (id)
        do update set updated_at = excluded.updated_at, payload = excluded.payload
      `,
      [mission.id, mission.createdAt, mission.updatedAt, JSON.stringify(mission)],
    );
  }

  public async appendEvent(event: MissionEvent): Promise<void> {
    this.state.events.push(event);
    await this.pool.query(
      `
        insert into mission_events (id, mission_id, created_at, payload)
        values ($1, $2, $3::timestamptz, $4::jsonb)
        on conflict (id) do update set payload = excluded.payload
      `,
      [event.id, event.missionId, event.createdAt, JSON.stringify(event)],
    );
  }

  public async saveStageRun(stageRun: StageRun): Promise<void> {
    const index = this.state.stageRuns.findIndex(
      (existing) =>
        existing.missionId === stageRun.missionId &&
        existing.stageId === stageRun.stageId &&
        existing.attempt === stageRun.attempt,
    );

    if (index === -1) {
      this.state.stageRuns.push(stageRun);
    } else {
      this.state.stageRuns[index] = stageRun;
    }

    await this.pool.query(
      `
        insert into stage_runs (mission_id, stage_id, attempt, started_at, payload)
        values ($1, $2, $3, $4::timestamptz, $5::jsonb)
        on conflict (mission_id, stage_id, attempt)
        do update set payload = excluded.payload
      `,
      [stageRun.missionId, stageRun.stageId, stageRun.attempt, stageRun.startedAt, JSON.stringify(stageRun)],
    );
  }
}
