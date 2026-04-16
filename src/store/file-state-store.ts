import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";

import { missionEventSchema, missionSchema, stageRunSchema, type Mission, type MissionEvent, type StageRun } from "../domain/types.js";
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

export class FileStateStore implements StateStore {
  private readonly stateFile: string;
  private state: PersistedState = emptyState;

  public constructor(stateFile: string) {
    this.stateFile = stateFile;
  }

  public async init(): Promise<void> {
    await mkdir(path.dirname(this.stateFile), { recursive: true });

    try {
      const raw = await readFile(this.stateFile, "utf8");
      const parsed = JSON.parse(raw) as PersistedState;
      this.state = {
        missions: parsed.missions.map((mission) => missionSchema.parse(mission)),
        events: parsed.events.map((event) => missionEventSchema.parse(event)),
        stageRuns: (parsed.stageRuns ?? []).map((stageRun) => stageRunSchema.parse(stageRun)),
      };
    } catch {
      this.state = {
        missions: [],
        events: [],
        stageRuns: [],
      };
      await this.flush();
    }
  }

  public async close(): Promise<void> {}

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
    await this.flush();
  }

  public async appendEvent(event: MissionEvent): Promise<void> {
    this.state.events.push(event);
    await this.flush();
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

    await this.flush();
  }

  private async flush(): Promise<void> {
    await writeFile(this.stateFile, JSON.stringify(this.state, null, 2));
  }
}
