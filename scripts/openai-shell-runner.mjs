#!/usr/bin/env node

import { exec as execCallback } from "node:child_process";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";

import OpenAI from "openai";

const REQUIRED_ENV = [
  "OPENAI_API_KEY",
  "FACTORY_MISSION_ID",
  "FACTORY_STAGE_ID",
  "FACTORY_STAGE_KIND",
  "FACTORY_WORKSPACE_PATH",
  "FACTORY_ARTIFACT_DIR",
  "FACTORY_MISSION_PACKET_PATH",
  "FACTORY_STAGE_PROMPT_PATH",
];

const BLOCKED_PATTERNS = [
  /\bsudo\b/i,
  /\bssh\b/i,
  /\bscp\b/i,
  /\bsftp\b/i,
  /\bcurl\b/i,
  /\bwget\b/i,
  /\bnc\b/i,
  /\bncat\b/i,
  /\btelnet\b/i,
  /\bdocker\b/i,
  /\bkubectl\b/i,
  /\baws\b/i,
  /\bgh\b/i,
  /\bgit\s+push\b/i,
  /\brm\s+-rf\s+\/\b/i,
  /\bshutdown\b/i,
  /\breboot\b/i,
];

const MAX_TURNS = Number(process.env.FACTORY_OPENAI_MAX_TURNS || 12);
const COMMAND_TIMEOUT_MS = Number(process.env.FACTORY_OPENAI_COMMAND_TIMEOUT_MS || 120_000);
const MODEL = process.env.FACTORY_OPENAI_MODEL || "gpt-5.2-codex";
const exec = promisify(execCallback);

function requireEnv(name) {
  const value = process.env[name];
  if (!value) {
    throw new Error(`Missing required environment variable: ${name}`);
  }

  return value;
}

function truncate(value, limit = 4_000) {
  if (value.length <= limit) {
    return value;
  }

  return `${value.slice(0, limit - 16)}\n...[truncated]`;
}

function extractShellCalls(response) {
  const items = Array.isArray(response.output) ? response.output : [];
  return items.filter((item) => item?.type === "shell_call");
}

function extractCommand(shellCall) {
  return (
    shellCall?.action?.command ||
    shellCall?.command ||
    shellCall?.input?.command ||
    shellCall?.input ||
    ""
  );
}

function isBlocked(command) {
  return BLOCKED_PATTERNS.some((pattern) => pattern.test(command));
}

async function runCommand(command, cwd) {
  if (isBlocked(command)) {
    return {
      stdout: "",
      stderr: `Blocked command by factory policy: ${command}`,
      exitCode: 126,
      timedOut: false,
    };
  }

  try {
    const { stdout, stderr } = await exec(command, {
      cwd,
      timeout: COMMAND_TIMEOUT_MS,
      maxBuffer: 1024 * 1024,
      env: process.env,
    });
    return {
      stdout,
      stderr,
      exitCode: 0,
      timedOut: false,
    };
  } catch (error) {
    const timedOut = Boolean(error?.killed) && error?.signal === "SIGTERM";
    return {
      stdout: error?.stdout ?? "",
      stderr: error?.stderr ?? String(error),
      exitCode: timedOut ? null : error?.code ?? 1,
      timedOut,
    };
  }
}

function renderSummary(turns, finalText) {
  const lines = [
    "# OpenAI Shell Runner Summary",
    "",
    finalText || "The runner completed without a final textual summary.",
    "",
    "## Commands",
  ];

  if (turns.length === 0) {
    lines.push("- No shell commands were executed.");
  } else {
    for (const turn of turns) {
      lines.push(`- \`${turn.command}\` → ${turn.outcome}`);
    }
  }

  return `${lines.join("\n")}\n`;
}

async function main() {
  for (const name of REQUIRED_ENV) {
    requireEnv(name);
  }

  const workspacePath = requireEnv("FACTORY_WORKSPACE_PATH");
  const artifactDir = requireEnv("FACTORY_ARTIFACT_DIR");
  const missionPacketPath = requireEnv("FACTORY_MISSION_PACKET_PATH");
  const promptPath = requireEnv("FACTORY_STAGE_PROMPT_PATH");

  const missionPacket = await readFile(missionPacketPath, "utf8");
  const stagePrompt = await readFile(promptPath, "utf8");
  await mkdir(artifactDir, { recursive: true });

  const client = new OpenAI({
    apiKey: requireEnv("OPENAI_API_KEY"),
  });

  const instructions = [
    "You are the execution worker for a deterministic software factory.",
    "Operate only inside the provided workspace path.",
    "Use shell commands to inspect, edit, and verify the code.",
    "Do not use network access, remote shells, package publishing, cloud CLIs, or git push.",
    "Before editing, inspect the workspace and understand the target files.",
    "Prefer minimal, focused changes that satisfy the stage prompt.",
    "Run relevant verification commands before finishing when feasible.",
    "Leave a concise final summary of the work completed and the verification performed.",
    `Workspace path: ${workspacePath}`,
    `Artifact directory: ${artifactDir}`,
  ].join("\n");

  let response = await client.responses.create({
    model: MODEL,
    instructions,
    input: [
      {
        role: "user",
        content: [
          {
            type: "input_text",
            text: `${stagePrompt}\n\n## Mission Packet\n${missionPacket}`,
          },
        ],
      },
    ],
    tools: [{ type: "shell", environment: { type: "local" } }],
  });

  const turns = [];

  for (let turn = 0; turn < MAX_TURNS; turn += 1) {
    const shellCalls = extractShellCalls(response);
    if (shellCalls.length === 0) {
      break;
    }

    const outputs = [];
    for (const shellCall of shellCalls) {
      const command = extractCommand(shellCall).trim();
      const callId = shellCall?.call_id || shellCall?.id;
      if (!command || !callId) {
        continue;
      }

      const result = await runCommand(command, workspacePath);
      turns.push({
        command,
        outcome: result.timedOut ? "timeout" : `exit:${result.exitCode ?? "unknown"}`,
      });

      outputs.push({
        type: "shell_call_output",
        call_id: callId,
        max_output_length: 4096,
        output: [
          {
            stdout: truncate(result.stdout),
            stderr: truncate(result.stderr),
            outcome: result.timedOut
              ? { type: "timeout" }
              : {
                  type: "exit",
                  exit_code: Number.isInteger(result.exitCode) ? result.exitCode : 1,
                },
          },
        ],
      });
    }

    response = await client.responses.create({
      model: MODEL,
      previous_response_id: response.id,
      input: outputs,
      tools: [{ type: "shell", environment: { type: "local" } }],
    });
  }

  const finalText = response.output_text?.trim() || "";
  const summary = renderSummary(turns, finalText);
  await writeFile(path.join(artifactDir, "openai-runner-summary.md"), summary, "utf8");

  process.stdout.write(`${summary}\n`);
}

main().catch(async (error) => {
  const artifactDir = process.env.FACTORY_ARTIFACT_DIR;
  const message = error instanceof Error ? error.stack || error.message : String(error);
  if (artifactDir) {
    await mkdir(artifactDir, { recursive: true });
    await writeFile(path.join(artifactDir, "openai-runner-error.log"), `${message}\n`, "utf8");
  }
  process.stderr.write(`${message}\n`);
  process.exit(1);
});
