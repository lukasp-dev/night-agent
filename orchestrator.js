const { execSync } = require("child_process");
const crypto = require("crypto");
const fs = require("fs");
const path = require("path");

const baseConfig = JSON.parse(fs.readFileSync("config.json", "utf-8"));
const maxTokens =
  Number.isInteger(baseConfig.maxTokens) && baseConfig.maxTokens > 0
    ? baseConfig.maxTokens
    : 4096;
const orchestratorConfigPath =
  (process.env.ORCH_CONFIG_PATH && process.env.ORCH_CONFIG_PATH.trim()) ||
  (typeof baseConfig.orchestratorConfigPath === "string" &&
  baseConfig.orchestratorConfigPath.trim()
    ? baseConfig.orchestratorConfigPath
    : "orchestrator-config.json");

function resolvePath(basePath, targetPath) {
  return path.isAbsolute(targetPath) ? targetPath : path.join(basePath, targetPath);
}

function readJsonFile(filePath, label) {
  if (!fs.existsSync(filePath)) {
    throw new Error(`${label} not found: ${filePath}`);
  }
  const content = fs.readFileSync(filePath, "utf-8");
  try {
    return JSON.parse(content);
  } catch (err) {
    throw new Error(`${label} contains invalid JSON: ${err.message}`);
  }
}

function extractJsonOnly(text) {
  if (!text) return "";
  const fenced = text.match(/```json\s*([\s\S]*?)```/i);
  if (fenced && fenced[1]) {
    return fenced[1].trim();
  }
  return text.trim();
}

function log(msg) {
  const line = `[${new Date().toISOString()}] ${msg}`;
  console.log(line);
}

function getToken() {
  return execSync(
    "az account get-access-token --resource https://cognitiveservices.azure.com/ --query accessToken -o tsv",
    { encoding: "utf-8" }
  ).trim();
}

async function callModel(messages) {
  const token = getToken();
  const body = {
    model: baseConfig.model,
    messages,
    temperature: 0.2,
    max_tokens: maxTokens
  };

  const response = await fetch(baseConfig.endpoint, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json"
    },
    body: JSON.stringify(body)
  });

  if (!response.ok) {
    const errorText = await response.text();
    throw new Error(
      `Model call failed: ${response.status} ${response.statusText}\n${errorText}`
    );
  }

  return response.json();
}

function writeTaskFile(workDir, role, taskText) {
  if (!fs.existsSync(workDir)) {
    fs.mkdirSync(workDir, { recursive: true });
  }
  const filePath = path.join(workDir, `task-${role}.txt`);
  const content = `Role: ${role}\n\n${taskText}\n`;
  fs.writeFileSync(filePath, content, "utf-8");
  return filePath;
}

function hashTasks(tasks, roleRepoMap) {
  return crypto
    .createHash("sha256")
    .update(JSON.stringify({ tasks, roleRepoMap }))
    .digest("hex");
}

function loadOrInitializeState(statePath, taskHash, roleRepoMap, resumeEnabled) {
  if (resumeEnabled && fs.existsSync(statePath)) {
    try {
      const existing = JSON.parse(fs.readFileSync(statePath, "utf-8"));
      if (
        existing &&
        existing.taskHash === taskHash &&
        existing.status !== "completed"
      ) {
        return existing;
      }
    } catch {
      // fall through to create a new state
    }
  }

  return {
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    taskHash,
    roleRepoMap,
    status: "running",
    roles: {},
    finalChecks: {},
    completedRoles: []
  };
}

function persistState(statePath, state) {
  state.updatedAt = new Date().toISOString();
  fs.mkdirSync(path.dirname(statePath), { recursive: true });
  fs.writeFileSync(statePath, JSON.stringify(state, null, 2), "utf-8");
}

function runAgent(role, repoName, targetFile, env) {
  const envVars = {
    ...process.env,
    ...env,
    AGENT_ACTIVE_REPO: repoName,
    AGENT_TARGET_FILE: targetFile,
    AGENT_ROLE: role,
    AGENT_TASKS_PATH: env.AGENT_TASKS_PATH
  };

  const command = "node .\\run-agent.js";
  log(`Running ${role} on ${repoName} (${targetFile || "default target"})`);
  execSync(command, {
    cwd: process.cwd(),
    env: envVars,
    stdio: "inherit"
  });
}

function runFinalCheck(repoName, repoPath, checkCommand) {
  if (!checkCommand) {
    return;
  }
  log(`Final check (${repoName}): ${checkCommand}`);
  execSync(checkCommand, {
    cwd: repoPath,
    stdio: "inherit",
    env: process.env
  });
}

async function buildPlan(ceoTask, agentConfig, roleRepoMap) {
  const repoList = Object.entries(agentConfig.repos).map(([name, cfg]) => ({
    name,
    path: cfg.path,
    allowedPaths: Array.isArray(cfg.allowedPaths) ? cfg.allowedPaths : []
  }));

  const prompt = `
CEO Task:
${ceoTask}

Repositories:
${JSON.stringify(repoList, null, 2)}

Roles:
${JSON.stringify(roleRepoMap, null, 2)}

Return ONLY valid JSON with this schema:
{
  "tasks": {
    "swe1": { "repo": "backend", "targetFile": "optional", "task": "..." },
    "swe2": { "repo": "frontend", "targetFile": "optional", "task": "..." },
    "swe3": { "repo": "backend", "targetFile": "optional", "task": "..." }
  }
}

Rules:
- Use only repos listed above.
- Keep each task scoped to a single targetFile.
- Task text must describe a concrete user-visible or test-visible issue and expected outcome.
- Avoid generic cleanup/refactor-only tasks without acceptance behavior.
- Return JSON only (no markdown).
`;

  const messages = [
    {
      role: "system",
      content:
        "You are the CEO agent. You only decide and delegate. Return valid JSON only."
    },
    {
      role: "user",
      content: prompt
    }
  ];

  const response = await callModel(messages);
  const output = response?.choices?.[0]?.message?.content ?? "";
  const jsonText = extractJsonOnly(output);
  let plan;
  try {
    plan = JSON.parse(jsonText);
  } catch (err) {
    throw new Error("CEO output is not valid JSON.");
  }

  if (!plan.tasks || typeof plan.tasks !== "object") {
    throw new Error("CEO output missing tasks object.");
  }

  return plan.tasks;
}

async function main() {
  const resolvedOrchConfigPath = resolvePath(process.cwd(), orchestratorConfigPath);
  const orchConfig = readJsonFile(resolvedOrchConfigPath, "Orchestrator config");

  const agentConfigPath = resolvePath(
    path.dirname(resolvedOrchConfigPath),
    orchConfig.agentConfigPath || baseConfig.agentConfigPath || "agent-config.json"
  );
  const agentConfig = readJsonFile(agentConfigPath, "Agent config");

  const tasksPath = resolvePath(
    path.dirname(resolvedOrchConfigPath),
    orchConfig.tasksPath || "orchestrator-tasks.json"
  );
  const tasksConfig = readJsonFile(tasksPath, "Orchestrator tasks");

  const planPath = resolvePath(
    path.dirname(resolvedOrchConfigPath),
    orchConfig.planPath || "orchestrator-plan.json"
  );
  const workDir = resolvePath(
    path.dirname(resolvedOrchConfigPath),
    orchConfig.workDir || ".orchestrator"
  );
  const statePath = resolvePath(
    path.dirname(resolvedOrchConfigPath),
    orchConfig.statePath || path.join(workDir, "run-state.json")
  );
  const resumeEnabled = orchConfig.resume !== false;

  const roleRepoMap = orchConfig.roleRepoMap || {
    swe1: "backend",
    swe2: "frontend",
    swe3: "backend"
  };

  let tasks = tasksConfig.tasks;
  if (!tasks) {
    if (!tasksConfig.ceoTask) {
      throw new Error("orchestrator-tasks.json must include ceoTask or tasks.");
    }
    log("Generating tasks from CEO...");
    tasks = await buildPlan(tasksConfig.ceoTask, agentConfig, roleRepoMap);
    fs.writeFileSync(planPath, JSON.stringify({ tasks }, null, 2), "utf-8");
    log(`Plan saved: ${planPath}`);
  }

  const taskHash = hashTasks(tasks, roleRepoMap);
  const state = loadOrInitializeState(statePath, taskHash, roleRepoMap, resumeEnabled);
  persistState(statePath, state);
  log(`Run state: ${statePath}`);

  const touchedRepos = new Set();

  for (const role of ["swe1", "swe2", "swe3"]) {
    const taskEntry = tasks[role];
    if (!taskEntry) {
      log(`Skipping ${role}: no task`);
      continue;
    }

    if (state.roles[role]?.status === "done") {
      log(`Skipping ${role}: already completed in previous run`);
      touchedRepos.add(state.roles[role].repo);
      continue;
    }

    const repoName =
      (taskEntry.repo && taskEntry.repo.trim()) || roleRepoMap[role] || "";
    if (!repoName) {
      throw new Error(`Missing repo for ${role}`);
    }
    if (!agentConfig.repos[repoName]) {
      throw new Error(`Unknown repo "${repoName}" for ${role}`);
    }

    const taskText =
      typeof taskEntry === "string" ? taskEntry : taskEntry.task || "";
    if (!taskText) {
      throw new Error(`Missing task text for ${role}`);
    }

    const targetFile =
      typeof taskEntry === "string" ? "" : taskEntry.targetFile || "";

    const taskFile = writeTaskFile(workDir, role, taskText);
    state.roles[role] = {
      status: "running",
      repo: repoName,
      targetFile,
      taskFile,
      startedAt: new Date().toISOString()
    };
    persistState(statePath, state);

    try {
      runAgent(role, repoName, targetFile, {
        AGENT_CONFIG_PATH: agentConfigPath,
        AGENT_TASKS_PATH: taskFile
      });
      state.roles[role] = {
        ...state.roles[role],
        status: "done",
        finishedAt: new Date().toISOString()
      };
      if (!state.completedRoles.includes(role)) {
        state.completedRoles.push(role);
      }
      persistState(statePath, state);
      touchedRepos.add(repoName);
    } catch (err) {
      state.roles[role] = {
        ...state.roles[role],
        status: "failed",
        error: err.message,
        failedAt: new Date().toISOString()
      };
      state.status = "failed";
      persistState(statePath, state);
      throw err;
    }
  }

  const configuredChecks =
    orchConfig.finalChecks && typeof orchConfig.finalChecks === "object"
      ? orchConfig.finalChecks
      : {};

  for (const repoName of touchedRepos) {
    const repoConfig = agentConfig.repos[repoName];
    if (!repoConfig) {
      throw new Error(`Final check repo config not found: ${repoName}`);
    }
    const checkCommand =
      (typeof configuredChecks[repoName] === "string" && configuredChecks[repoName].trim()) ||
      (repoConfig.runTests === true &&
      typeof repoConfig.testCommand === "string" &&
      repoConfig.testCommand.trim()
        ? repoConfig.testCommand.trim()
        : "");

    if (!checkCommand) {
      log(`Skipping final check (${repoName}): no command configured`);
      continue;
    }

    if (state.finalChecks[repoName]?.status === "passed") {
      log(`Skipping final check (${repoName}): already passed in previous run`);
      continue;
    }

    const repoPath = resolvePath(path.dirname(agentConfigPath), repoConfig.path);
    state.finalChecks[repoName] = {
      status: "running",
      command: checkCommand,
      startedAt: new Date().toISOString()
    };
    persistState(statePath, state);

    try {
      runFinalCheck(repoName, repoPath, checkCommand);
      state.finalChecks[repoName] = {
        status: "passed",
        command: checkCommand,
        finishedAt: new Date().toISOString()
      };
      persistState(statePath, state);
    } catch (err) {
      state.finalChecks[repoName] = {
        status: "failed",
        command: checkCommand,
        error: err.message,
        failedAt: new Date().toISOString()
      };
      state.status = "failed";
      persistState(statePath, state);
      throw err;
    }
  }

  state.status = "completed";
  state.completedAt = new Date().toISOString();
  persistState(statePath, state);
  log("Orchestration completed.");
}

main().catch((err) => {
  log(`Fatal error: ${err.message}`);
  process.exit(1);
});
