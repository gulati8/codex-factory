import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";

const workspacePath = process.env.FACTORY_WORKSPACE_PATH;
const artifactDir = process.env.FACTORY_ARTIFACT_DIR;
const promptPath = process.env.FACTORY_STAGE_PROMPT_PATH;
const stageKind = process.env.FACTORY_STAGE_KIND ?? "unknown";
const stageId = process.env.FACTORY_STAGE_ID ?? "unknown";

if (!workspacePath || !artifactDir || !promptPath) {
  console.error("Missing required FACTORY_* environment variables.");
  process.exit(1);
}

await mkdir(workspacePath, { recursive: true });
await mkdir(artifactDir, { recursive: true });

const prompt = await readFile(promptPath, "utf8");
const outputPath = path.join(workspacePath, `${stageKind}-agent-output.md`);

await writeFile(
  outputPath,
  [
    `# Example Agent Output`,
    ``,
    `Stage: ${stageId}`,
    `Kind: ${stageKind}`,
    ``,
    `This file was produced by the example external runner.`,
    ``,
    `## Prompt Excerpt`,
    prompt.split("\n").slice(0, 12).join("\n"),
  ].join("\n"),
);

await writeFile(
  path.join(artifactDir, "external-runner.json"),
  JSON.stringify(
    {
      ok: true,
      stageId,
      stageKind,
      outputPath,
    },
    null,
    2,
  ),
);

console.log(`External runner wrote ${outputPath}`);
