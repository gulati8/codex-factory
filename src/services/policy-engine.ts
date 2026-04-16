import picomatch from "picomatch";

import type { AutonomyMode, ProjectManifest, RiskLevel, StageKind } from "../domain/types.js";

export type RouteDecision = {
  riskLevel: RiskLevel;
  requiredStages: StageKind[];
  mergeApprovalRequired: boolean;
  reasons: string[];
};

function matchesAny(paths: string[], patterns: string[]): boolean {
  return patterns.some((pattern) => {
    const matcher = picomatch(pattern);
    return paths.some((candidate) => matcher(candidate));
  });
}

function requestIncludes(request: string, terms: string[]): boolean {
  const lower = request.toLowerCase();
  return terms.some((term) => lower.includes(term));
}

export class PolicyEngine {
  public evaluate(params: {
    manifest: ProjectManifest;
    changedPaths: string[];
    request: string;
    autonomyMode: AutonomyMode;
  }): RouteDecision {
    const { manifest, changedPaths, request, autonomyMode } = params;
    const reasons: string[] = [];

    const docsOnly = changedPaths.length > 0 && changedPaths.every((candidate) => candidate.startsWith("docs/"));
    const architectureTouched =
      matchesAny(changedPaths, manifest.risk.architectureGlobs) ||
      requestIncludes(request, ["architecture", "refactor", "schema", "migration"]);
    const securityTouched =
      matchesAny(changedPaths, manifest.risk.securityGlobs) ||
      requestIncludes(request, ["auth", "secret", "security", "token", "payment"]);
    const highRiskTouched =
      matchesAny(changedPaths, manifest.risk.highRiskGlobs) ||
      securityTouched ||
      requestIncludes(request, ["deploy", "billing", "permissions"]);
    const docsTouched =
      matchesAny(changedPaths, manifest.risk.docsGlobs) ||
      requestIncludes(request, ["docs", "guide", "readme", "api"]);
    const researchNeeded = requestIncludes(request, ["investigate", "research", "compare", "survey"]);

    let riskLevel: RiskLevel = "medium";
    if (docsOnly && !highRiskTouched && !architectureTouched) {
      riskLevel = "low";
      reasons.push("Only documentation paths were supplied.");
    } else if (highRiskTouched || architectureTouched) {
      riskLevel = "high";
      reasons.push("High-risk paths or structural change indicators were detected.");
    } else {
      reasons.push("Defaulting to medium risk because the change alters code paths without high-risk signals.");
    }

    const requiredStages = new Set<StageKind>(["implement", "integrate"]);

    if (researchNeeded) {
      requiredStages.add("research");
      reasons.push("Request language suggests up-front research.");
    }

    if (architectureTouched) {
      requiredStages.add("architect");
      reasons.push("Architecture review is required for structural changes.");
    }

    if (!docsOnly) {
      requiredStages.add("review");
      requiredStages.add("qa");
    }

    if (securityTouched) {
      requiredStages.add("security");
      reasons.push("Security-sensitive surfaces were touched.");
    }

    if (docsTouched) {
      requiredStages.add("docs");
      reasons.push("Docs should be updated for the affected surfaces.");
    }

    const mergeApprovalRequired =
      riskLevel === "high" || (autonomyMode === "managed" && manifest.approval.requirePlanApproval);

    return {
      riskLevel,
      requiredStages: [...requiredStages],
      mergeApprovalRequired,
      reasons,
    };
  }
}
