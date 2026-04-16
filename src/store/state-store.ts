import type { Mission, MissionEvent, StageRun } from "../domain/types.js";

export interface StateStore {
  init(): Promise<void>;
  close(): Promise<void>;
  listMissions(): Mission[];
  getMission(id: string): Mission | undefined;
  listEvents(missionId: string): MissionEvent[];
  listStageRuns(missionId: string, stageId?: string): StageRun[];
  saveMission(mission: Mission): Promise<void>;
  appendEvent(event: MissionEvent): Promise<void>;
  saveStageRun(stageRun: StageRun): Promise<void>;
}
