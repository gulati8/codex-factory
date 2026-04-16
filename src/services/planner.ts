import type { PlanArtifact, ProjectManifest, StageKind, Workstream } from "../domain/types.js";

function inferWorkstreams(changedPaths: string[]): Workstream[] {
  if (changedPaths.length === 0) {
    return [
      {
        id: "primary",
        title: "Primary implementation lane",
        paths: [],
        goal: "Implement the request in a single bounded workstream.",
      },
    ];
  }

  const grouped = new Map<string, string[]>();
  for (const candidate of changedPaths) {
    const [topLevel = "root"] = candidate.split("/");
    const paths = grouped.get(topLevel) ?? [];
    paths.push(candidate);
    grouped.set(topLevel, paths);
  }

  return [...grouped.entries()].map(([bucket, paths], index) => ({
    id: `lane-${index + 1}`,
    title: `Workstream: ${bucket}`,
    paths,
    goal: `Change the files under ${bucket} without colliding with adjacent workstreams.`,
  }));
}

export class Planner {
  public build(params: {
    project: ProjectManifest;
    request: string;
    changedPaths: string[];
    requiredStages: StageKind[];
    reasons: string[];
  }): PlanArtifact {
    const { request, changedPaths, requiredStages, reasons } = params;
    const workstreams = inferWorkstreams(changedPaths);

    return {
      summary: `Execute the request "${request}" with explicit quality gates and artifact handoffs.`,
      objectives: [
        "Produce a plan that decomposes the work into isolated execution lanes.",
        "Route only the specialist stages justified by the current risk profile.",
        "Preserve evidence and reviewability at every transition.",
      ],
      assumptions: [
        "The project manifest is the authority for commands, risk zones, and runtime defaults.",
        "Parallel implementers must not share a mutable worktree.",
        "Integration happens after all implementation lanes complete.",
      ],
      workstreams,
      routeDecisions: [
        ...reasons,
        `Compiled required stages: ${requiredStages.join(", ")}.`,
      ],
    };
  }
}
