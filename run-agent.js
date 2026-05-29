const { execSync } = require("child_process");
const fs = require("fs");
const path = require("path");

const config = JSON.parse(fs.readFileSync("config.json", "utf-8"));
const maxTokens =
  Number.isInteger(config.maxTokens) && config.maxTokens > 0
    ? config.maxTokens
    : 4096;
const agentConfigPath =
  (process.env.AGENT_CONFIG_PATH && process.env.AGENT_CONFIG_PATH.trim()) ||
  (typeof config.agentConfigPath === "string" && config.agentConfigPath.trim()
    ? config.agentConfigPath
    : "agent-config.json");
const tasksPath =
  (process.env.AGENT_TASKS_PATH && process.env.AGENT_TASKS_PATH.trim()) ||
  (typeof config.tasksPath === "string" && config.tasksPath.trim()
    ? config.tasksPath
    : "tasks.txt");
const maxFilesToEdit =
  Number.isInteger(config.maxFilesToEdit) && config.maxFilesToEdit > 0
    ? config.maxFilesToEdit
    : 5;
const maxPatchChanges =
  Number.isInteger(config.maxPatchChanges) && config.maxPatchChanges > 0
    ? config.maxPatchChanges
    : 20;
const maxPatchChars =
  Number.isInteger(config.maxPatchChars) && config.maxPatchChars > 0
    ? config.maxPatchChars
    : 20000;
const repoMapMaxFiles =
  Number.isInteger(config.repoMapMaxFiles) && config.repoMapMaxFiles > 0
    ? config.repoMapMaxFiles
    : 2000;
const repoMapCachePath =
  typeof config.repoMapCachePath === "string" && config.repoMapCachePath.trim()
    ? config.repoMapCachePath
    : ".agent-cache\\repo-map.json";
const repoMapCacheTtlMinutes =
  Number.isInteger(config.repoMapCacheTtlMinutes) && config.repoMapCacheTtlMinutes > 0
    ? config.repoMapCacheTtlMinutes
    : 120;
const maxFileBytes =
  Number.isInteger(config.maxFileBytes) && config.maxFileBytes > 0
    ? config.maxFileBytes
    : 40000;
const retryAttempts =
  Number.isInteger(config.retryAttempts) && config.retryAttempts >= 0
    ? config.retryAttempts
    : 2;
const defaultApplyMode =
  typeof config.applyMode === "string" && config.applyMode.trim()
    ? config.applyMode
    : "candidate";
const defaultCandidateDir =
  typeof config.candidateDir === "string" && config.candidateDir.trim()
    ? config.candidateDir
    : ".agent-candidates";
const defaultGitConfig = config.git && typeof config.git === "object" ? config.git : {};

function timestamp() {
  return new Date().toISOString();
}

function log(msg) {
  const line = `[${timestamp()}] ${msg}`;
  console.log(line);
  fs.appendFileSync("logs.txt", line + "\n");
}

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

function selectRepo(agentConfig) {
  if (!agentConfig || typeof agentConfig !== "object") {
    throw new Error("Agent config must be a JSON object.");
  }
  if (!agentConfig.repos || typeof agentConfig.repos !== "object") {
    throw new Error("Agent config missing repos.");
  }

  const repoNames = Object.keys(agentConfig.repos);
  const activeRepo =
    (process.env.AGENT_ACTIVE_REPO && process.env.AGENT_ACTIVE_REPO.trim()) ||
    agentConfig.activeRepo;

  if (activeRepo) {
    if (!agentConfig.repos[activeRepo]) {
      throw new Error(`activeRepo not found: ${activeRepo}`);
    }
    return { repoName: activeRepo, repoConfig: agentConfig.repos[activeRepo] };
  }

  if (repoNames.length === 1) {
    return { repoName: repoNames[0], repoConfig: agentConfig.repos[repoNames[0]] };
  }

  throw new Error("Agent config has multiple repos. Set activeRepo.");
}

function loadInstructions(instructionsPath, repoPath) {
  if (!instructionsPath) return "";
  const resolvedPath = resolvePath(repoPath, instructionsPath);
  if (!fs.existsSync(resolvedPath)) {
    throw new Error(`Instructions path not found: ${resolvedPath}`);
  }

  const stat = fs.statSync(resolvedPath);
  if (stat.isDirectory()) {
    const files = fs
      .readdirSync(resolvedPath)
      .filter((file) => fs.statSync(path.join(resolvedPath, file)).isFile())
      .sort((a, b) => a.localeCompare(b));

    return files
      .map((file) => {
        const filePath = path.join(resolvedPath, file);
        const content = fs.readFileSync(filePath, "utf-8");
        return `--- ${file} ---\n${content}`;
      })
      .join("\n\n");
  }

  return fs.readFileSync(resolvedPath, "utf-8");
}

function formatRuntimeContext(runtimeContext) {
  if (runtimeContext === null || runtimeContext === undefined) return "";
  if (typeof runtimeContext === "string") {
    return runtimeContext.trim();
  }
  if (typeof runtimeContext === "object") {
    return JSON.stringify(runtimeContext, null, 2);
  }
  return String(runtimeContext).trim();
}

function runPreflightCommand(command, workDir, repoPath, repoName, instructionsPath) {
  const output = execSync(command, {
    cwd: workDir,
    encoding: "utf-8",
    stdio: ["pipe", "pipe", "pipe"],
    env: {
      ...process.env,
      AGENT_CONFIG_DIR: workDir,
      AGENT_REPO_PATH: repoPath,
      AGENT_REPO_NAME: repoName,
      AGENT_INSTRUCTIONS_PATH: instructionsPath || ""
    }
  });
  return (output || "").trim();
}

function parseTaskContent(content) {
  const lines = content.split(/\r?\n/);
  let role = "";
  if (lines[0] && lines[0].startsWith("Role:")) {
    role = lines[0].replace("Role:", "").trim();
    lines.shift();
    if (lines[0] === "") {
      lines.shift();
    }
  }
  return { role, task: lines.join("\n").trim() };
}

function readTaskFile(filePath) {
  if (!fs.existsSync(filePath)) {
    throw new Error(`Tasks file not found: ${filePath}`);
  }
  const content = fs.readFileSync(filePath, "utf-8");
  return parseTaskContent(content);
}

function getToken() {
  return execSync(
    "az account get-access-token --resource https://cognitiveservices.azure.com/ --query accessToken -o tsv",
    { encoding: "utf-8" }
  ).trim();
}

function safeReadDir(dirPath) {
  try {
    const entries = fs.readdirSync(dirPath, { withFileTypes: true });
    return entries
      .map((entry) => `${entry.isDirectory() ? "[DIR]" : "[FILE]"} ${entry.name}`)
      .join("\n");
  } catch (err) {
    return `Could not read directory: ${err.message}`;
  }
}

function safeGitStatus(repoPath) {
  try {
    return execSync(`git -C "${repoPath}" status --short`, {
      encoding: "utf-8",
      stdio: ["pipe", "pipe", "pipe"]
    }).trim();
  } catch (err) {
    return "Git status not available (this is okay for now).";
  }
}

function readTargetFile(repoPath, fileName) {
  try {
    return fs.readFileSync(resolvePath(repoPath, fileName), "utf-8");
  } catch (err) {
    return `Could not read target file: ${err.message}`;
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

function detectNewlineStyle(text) {
  return text.includes("\r\n") ? "\r\n" : "\n";
}

function normalizeNewlines(text) {
  return text.replace(/\r\n/g, "\n");
}

function normalizeRepoPath(filePath) {
  return filePath.replace(/\//g, "\\").replace(/^[.][\\/]/, "");
}

function isPathAllowed(filePath, allowedPaths) {
  if (!allowedPaths || allowedPaths.length === 0) return true;
  const normalized = normalizeRepoPath(filePath).toLowerCase();
  return allowedPaths.some((allowed) => {
    const base = normalizeRepoPath(allowed).toLowerCase().replace(/[\\\/]+$/, "");
    return normalized === base || normalized.startsWith(base + "\\");
  });
}

function normalizeAllowedPaths(allowedPaths) {
  if (!Array.isArray(allowedPaths)) return [];
  return allowedPaths
    .map((entry) => normalizeRepoPath(entry).toLowerCase().replace(/[\\\/]+$/, ""))
    .sort();
}

function readRepoMapCache(cachePath, ttlMinutes, meta) {
  if (!fs.existsSync(cachePath)) return null;
  try {
    const content = fs.readFileSync(cachePath, "utf-8");
    const parsed = JSON.parse(content);
    if (!parsed || typeof parsed !== "object") return null;
    if (parsed.repoPath !== meta.repoPath) return null;
    if (parsed.maxFiles !== meta.maxFiles) return null;
    if (JSON.stringify(parsed.allowedPaths) !== JSON.stringify(meta.allowedPaths)) {
      return null;
    }
    if (!parsed.generatedAt) return null;
    const ageMs = Date.now() - new Date(parsed.generatedAt).getTime();
    if (Number.isFinite(ageMs) && ageMs > ttlMinutes * 60 * 1000) return null;
    if (!Array.isArray(parsed.files)) return null;
    return { files: parsed.files, truncated: parsed.truncated === true };
  } catch {
    return null;
  }
}

function writeRepoMapCache(cachePath, meta, files, truncated) {
  fs.mkdirSync(path.dirname(cachePath), { recursive: true });
  const payload = {
    repoPath: meta.repoPath,
    allowedPaths: meta.allowedPaths,
    maxFiles: meta.maxFiles,
    generatedAt: new Date().toISOString(),
    truncated: truncated === true,
    files
  };
  fs.writeFileSync(cachePath, JSON.stringify(payload, null, 2), "utf-8");
}

function listRepoFiles(repoPath, allowedPaths, maxFiles) {
  const ignoreDirs = new Set([
    ".git",
    ".next",
    ".idea",
    ".vscode",
    "node_modules",
    "dist",
    "build",
    "out",
    "coverage",
    "target",
    ".gradle"
  ]);
  const ignoreExts = new Set([
    ".png",
    ".jpg",
    ".jpeg",
    ".gif",
    ".webp",
    ".svg",
    ".ico",
    ".zip",
    ".jar",
    ".class",
    ".pdf",
    ".mp4",
    ".mov",
    ".mp3",
    ".wav"
  ]);

  const results = [];
  const roots =
    allowedPaths && allowedPaths.length > 0
      ? allowedPaths.map((p) => resolvePath(repoPath, p))
      : [repoPath];
  let truncated = false;

  const stack = roots.map((dir) => ({ dir }));
  while (stack.length > 0) {
    const { dir } = stack.pop();
    let entries;
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      continue;
    }

    for (const entry of entries) {
      const fullPath = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        if (ignoreDirs.has(entry.name)) continue;
        stack.push({ dir: fullPath });
        continue;
      }
      if (!entry.isFile()) continue;
      const ext = path.extname(entry.name).toLowerCase();
      if (ignoreExts.has(ext)) continue;

      const rel = normalizeRepoPath(path.relative(repoPath, fullPath));
      if (!isPathAllowed(rel, allowedPaths)) continue;

      results.push(rel);
      if (results.length >= maxFiles) {
        truncated = true;
        return { files: results, truncated };
      }
    }
  }

  return { files: results, truncated };
}

function buildRepoSummary(files, truncated) {
  const topCounts = new Map();
  const extCounts = new Map();

  for (const file of files) {
    const parts = file.split("\\");
    const top = parts[0] || ".";
    const ext = path.extname(file).toLowerCase() || "(none)";
    topCounts.set(top, (topCounts.get(top) || 0) + 1);
    extCounts.set(ext, (extCounts.get(ext) || 0) + 1);
  }

  const topSummary = Array.from(topCounts.entries())
    .sort((a, b) => b[1] - a[1])
    .slice(0, 12)
    .map(([name, count]) => `${name}:${count}`)
    .join(", ");

  const extSummary = Array.from(extCounts.entries())
    .sort((a, b) => b[1] - a[1])
    .slice(0, 12)
    .map(([name, count]) => `${name}:${count}`)
    .join(", ");

  return [
    `Indexed files: ${files.length}${truncated ? " (truncated)" : ""}`,
    `Top-level: ${topSummary || "(none)"}`,
    `Extensions: ${extSummary || "(none)"}`,
    "Files:",
    ...files.map((file) => `- ${file}`)
  ].join("\n");
}

async function selectFilesForTask(task, guidance, repoSummary, allowedPaths, maxFiles) {
  const basePrompt = `
Task:
${task}

${guidance ? `Harness guidance:\n${guidance}\n` : ""}

Repository summary:
${repoSummary}

Return ONLY valid JSON with this schema:
{
  "files": ["path\\to\\file.ext"],
  "reason": "short rationale"
}

Rules:
- Select 1 to ${maxFiles} files.
- Use repo-relative paths exactly as shown above.
- Only choose files under these allowed paths: ${allowedPaths.length ? allowedPaths.join(", ") : "(any)"}
- Return JSON only.
`;

  const messages = [
    {
      role: "system",
      content:
        "You select files to edit. Return ONLY valid JSON. Do not return markdown."
    },
    {
      role: "user",
      content: basePrompt
    }
  ];

  const response = await callModel(messages);
  const output = response?.choices?.[0]?.message?.content ?? "";
  const jsonText = extractJsonOnly(output);
  let selection;
  try {
    selection = JSON.parse(jsonText);
  } catch (err) {
    throw new Error("File selection output is not valid JSON.");
  }

  if (!selection.files || !Array.isArray(selection.files)) {
    throw new Error("File selection missing files array.");
  }

  const normalized = selection.files
    .map((file) => normalizeRepoPath(file))
    .filter((file) => file);

  return normalized.slice(0, maxFiles);
}

function readFileWithLimit(repoPath, filePath, byteLimit) {
  const absolutePath = resolvePath(repoPath, filePath);
  const stat = fs.statSync(absolutePath);
  if (stat.size > byteLimit) {
    throw new Error(`File too large: ${filePath} (${stat.size} bytes)`);
  }
  return fs.readFileSync(absolutePath, "utf-8");
}

function buildFileContext(files, fileContents) {
  return files
    .map((file) => `--- file: ${file} ---\n${fileContents[file]}`)
    .join("\n\n");
}

function applyPatchToFiles(originalFiles, patch) {
  if (!patch || !Array.isArray(patch.changes)) {
    throw new Error("Invalid patch format: missing changes array");
  }

  const changesByFile = new Map();
  for (const change of patch.changes) {
    if (change.type !== "replace") {
      throw new Error(`Unsupported change type: ${change.type}`);
    }
    if (typeof change.file !== "string" || !change.file.trim()) {
      throw new Error("Invalid replace change: missing file");
    }
    if (typeof change.find !== "string" || typeof change.replace !== "string") {
      throw new Error("Invalid replace change: find/replace must be strings");
    }

    const file = normalizeRepoPath(change.file);
    if (!changesByFile.has(file)) {
      changesByFile.set(file, []);
    }
    changesByFile.get(file).push({
      type: "replace",
      find: change.find,
      replace: change.replace
    });
  }

  const updatedFiles = {};
  for (const [file, changes] of changesByFile.entries()) {
    const original = originalFiles[file];
    if (typeof original !== "string") {
      throw new Error(`Patch refers to unknown file: ${file}`);
    }
    updatedFiles[file] = applyPatchToContent(original, { changes });
  }

  return updatedFiles;
}

function ensureGitRepo(repoPath) {
  execSync(`git -C "${repoPath}" rev-parse --is-inside-work-tree`, {
    encoding: "utf-8",
    stdio: ["pipe", "pipe", "pipe"]
  });
}

function getGitStatus(repoPath) {
  return execSync(`git -C "${repoPath}" status --porcelain`, {
    encoding: "utf-8",
    stdio: ["pipe", "pipe", "pipe"]
  }).trim();
}

function buildBranchName(prefix, role, repoName) {
  const stamp = new Date()
    .toISOString()
    .replace(/[-:]/g, "")
    .replace(/\..+/, "")
    .replace("T", "-");
  const safeRole = (role || "agent").toLowerCase().replace(/[^a-z0-9-]+/g, "-");
  const safeRepo = repoName.toLowerCase().replace(/[^a-z0-9-]+/g, "-");
  return `${prefix}/${safeRole}-${safeRepo}-${stamp}`;
}

function formatCommitMessage(template, role, repoName, taskText) {
  const firstLine = taskText.split(/\r?\n/).find((line) => line.trim()) || "update";
  const shortTask = firstLine.trim().slice(0, 72);
  const fallback = `agent(${role || "agent"}): ${shortTask}`;
  if (!template) return fallback;
  return template
    .replace("{role}", role || "agent")
    .replace("{repo}", repoName)
    .replace("{task}", shortTask);
}
async function callModel(messages) {
  const token = getToken();

  const body = {
    model: config.model,
    messages,
    temperature: 0.2,
    max_tokens: maxTokens
  };

  const response = await fetch(config.endpoint, {
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

function applyPatchToContent(original, patch) {
  if (!patch || !Array.isArray(patch.changes)) {
    throw new Error("Invalid patch format: missing changes array");
  }

  const newline = detectNewlineStyle(original);
  let updated = normalizeNewlines(original);

  for (const change of patch.changes) {
    if (change.type !== "replace") {
      throw new Error(`Unsupported change type: ${change.type}`);
    }

    if (typeof change.find !== "string" || typeof change.replace !== "string") {
      throw new Error("Invalid replace change: find/replace must be strings");
    }

    const find = normalizeNewlines(change.find);
    const replace = normalizeNewlines(change.replace);
    const index = updated.indexOf(find);
    if (index === -1) {
      throw new Error(
        "Patch apply failed: target snippet not found (check line endings)"
      );
    }

    updated =
      updated.slice(0, index) +
      replace +
      updated.slice(index + find.length);
  }

  return newline === "\r\n" ? updated.replace(/\n/g, "\r\n") : updated;
}

async function run() {
  fs.writeFileSync("logs.txt", "");
  log("=== Night Agent Start ===");
  log(`Model: ${config.model}`);

  const resolvedAgentConfigPath = resolvePath(process.cwd(), agentConfigPath);
  const agentConfig = readJsonFile(resolvedAgentConfigPath, "Agent config");
  const { repoName, repoConfig } = selectRepo(agentConfig);

  if (!repoConfig || typeof repoConfig !== "object") {
    throw new Error(`Invalid repo config for ${repoName}`);
  }

  if (!repoConfig.path) {
    throw new Error(`Repo path is missing for ${repoName}`);
  }

  const repoPath = resolvePath(path.dirname(resolvedAgentConfigPath), repoConfig.path);
  if (!fs.existsSync(repoPath)) {
    throw new Error(`Repo path does not exist: ${repoPath}`);
  }

  const role = (process.env.AGENT_ROLE && process.env.AGENT_ROLE.trim()) || "";
  const javaHome =
    (process.env.AGENT_JAVA_HOME && process.env.AGENT_JAVA_HOME.trim()) ||
    (typeof repoConfig.javaHome === "string" && repoConfig.javaHome.trim()
      ? repoConfig.javaHome.trim()
      : "");
  const targetFileRaw =
    (process.env.AGENT_TARGET_FILE && process.env.AGENT_TARGET_FILE.trim()) ||
    (typeof repoConfig.targetFile === "string" && repoConfig.targetFile.trim()
      ? repoConfig.targetFile
      : config.targetFile);
  const targetFile = typeof targetFileRaw === "string" ? targetFileRaw.trim() : "";
  const fileDiscovery =
    (process.env.AGENT_FILE_DISCOVERY && process.env.AGENT_FILE_DISCOVERY.trim()) ||
    (typeof repoConfig.fileDiscovery === "string" && repoConfig.fileDiscovery.trim()
      ? repoConfig.fileDiscovery
      : typeof config.fileDiscovery === "string" && config.fileDiscovery.trim()
      ? config.fileDiscovery
      : "auto");
  const candidateFile =
    (process.env.AGENT_CANDIDATE_FILE && process.env.AGENT_CANDIDATE_FILE.trim()) ||
    (typeof repoConfig.candidateFile === "string" && repoConfig.candidateFile.trim()
      ? repoConfig.candidateFile
      : config.candidateFile);
  const patchFile =
    (process.env.AGENT_PATCH_FILE && process.env.AGENT_PATCH_FILE.trim()) ||
    (typeof repoConfig.patchFile === "string" && repoConfig.patchFile.trim()
      ? repoConfig.patchFile
      : typeof config.patchFile === "string" && config.patchFile.trim()
      ? config.patchFile
      : "run-agent.patch.json");
  const allowedPaths = Array.isArray(repoConfig.allowedPaths) ? repoConfig.allowedPaths : [];
  const testCommand =
    (process.env.AGENT_TEST_COMMAND && process.env.AGENT_TEST_COMMAND.trim()) ||
    (typeof repoConfig.testCommand === "string" ? repoConfig.testCommand.trim() : "");
  const runTests =
    typeof process.env.AGENT_RUN_TESTS === "string"
      ? process.env.AGENT_RUN_TESTS === "true"
      : repoConfig.runTests === true;
  const instructionsPath =
    typeof repoConfig.instructionsPath === "string" && repoConfig.instructionsPath.trim()
      ? repoConfig.instructionsPath
      : "";
  const preflightCommand =
    (process.env.AGENT_PREFLIGHT_COMMAND && process.env.AGENT_PREFLIGHT_COMMAND.trim()) ||
    (typeof repoConfig.preflightCommand === "string" && repoConfig.preflightCommand.trim()
      ? repoConfig.preflightCommand
      : "");
  const preflightRequired =
    typeof process.env.AGENT_PREFLIGHT_REQUIRED === "string"
      ? process.env.AGENT_PREFLIGHT_REQUIRED === "true"
      : repoConfig.preflightRequired === true;

  if (javaHome) {
    process.env.JAVA_HOME = javaHome;
    const javaBin = path.join(javaHome, "bin");
    const currentPath = process.env.PATH || "";
    if (!currentPath.toLowerCase().includes(javaBin.toLowerCase())) {
      process.env.PATH = `${javaBin};${currentPath}`;
    }
  }

  const applyMode =
    (process.env.AGENT_APPLY_MODE && process.env.AGENT_APPLY_MODE.trim()) ||
    (typeof repoConfig.applyMode === "string" && repoConfig.applyMode.trim()
      ? repoConfig.applyMode
      : defaultApplyMode);
  const candidateDir =
    (process.env.AGENT_CANDIDATE_DIR && process.env.AGENT_CANDIDATE_DIR.trim()) ||
    (typeof repoConfig.candidateDir === "string" && repoConfig.candidateDir.trim()
      ? repoConfig.candidateDir
      : defaultCandidateDir);
  const gitConfig = {
    createBranch:
      typeof process.env.AGENT_GIT_CREATE_BRANCH === "string"
        ? process.env.AGENT_GIT_CREATE_BRANCH === "true"
        : repoConfig.git && typeof repoConfig.git.createBranch === "boolean"
        ? repoConfig.git.createBranch
        : typeof defaultGitConfig.createBranch === "boolean"
        ? defaultGitConfig.createBranch
        : false,
    commit:
      typeof process.env.AGENT_GIT_COMMIT === "string"
        ? process.env.AGENT_GIT_COMMIT === "true"
        : repoConfig.git && typeof repoConfig.git.commit === "boolean"
        ? repoConfig.git.commit
        : typeof defaultGitConfig.commit === "boolean"
        ? defaultGitConfig.commit
        : false,
    branchPrefix:
      (process.env.AGENT_GIT_BRANCH_PREFIX &&
        process.env.AGENT_GIT_BRANCH_PREFIX.trim()) ||
      (repoConfig.git && typeof repoConfig.git.branchPrefix === "string"
        ? repoConfig.git.branchPrefix
        : typeof defaultGitConfig.branchPrefix === "string"
        ? defaultGitConfig.branchPrefix
        : "night-agent"),
    commitMessage:
      (process.env.AGENT_GIT_COMMIT_MESSAGE &&
        process.env.AGENT_GIT_COMMIT_MESSAGE.trim()) ||
      (repoConfig.git && typeof repoConfig.git.commitMessage === "string"
        ? repoConfig.git.commitMessage
        : typeof defaultGitConfig.commitMessage === "string"
        ? defaultGitConfig.commitMessage
        : "")
  };

  let instructions = "";
  if (instructionsPath) {
    try {
      instructions = loadInstructions(instructionsPath, repoPath);
      log(`Instructions loaded: ${instructions.length} chars`);
    } catch (err) {
      log(`Instructions load failed: ${err.message}`);
    }
  }
  let preflightNotes = "";
  if (preflightCommand) {
    log(`Running preflight command: ${preflightCommand}`);
    try {
      preflightNotes = runPreflightCommand(
        preflightCommand,
        path.dirname(resolvedAgentConfigPath),
        repoPath,
        repoName,
        instructionsPath
      );
      if (preflightNotes) {
        log(`Preflight notes loaded: ${preflightNotes.length} chars`);
      } else {
        log("Preflight command returned no output.");
      }
    } catch (err) {
      if (preflightRequired) {
        throw new Error(`Preflight command failed: ${err.message}`);
      }
      log(`Preflight command failed: ${err.message}`);
    }
  }
  const runtimeContext = formatRuntimeContext(repoConfig.runtimeContext);
  if (runtimeContext) {
    log(`Runtime context loaded: ${runtimeContext.length} chars`);
  }
  const guidance = [instructions, runtimeContext, preflightNotes]
    .filter((entry) => typeof entry === "string" && entry.trim())
    .join("\n\n");

  const resolvedTasksPath = resolvePath(process.cwd(), tasksPath);
  const taskInfo = readTaskFile(resolvedTasksPath);
  const task = taskInfo.task;
  const effectiveRole = role || taskInfo.role || "agent";

  log(`Agent config: ${resolvedAgentConfigPath}`);
  log(`Tasks file: ${resolvedTasksPath}`);
  log(`Role: ${effectiveRole}`);
  log(`Active repo: ${repoName}`);
  log(`Repo path: ${repoPath}`);
  log(`Java home: ${javaHome || "(default)"}`);
  log(`Target file: ${targetFile || "(auto)"}`);
  log(`Candidate output: ${applyMode === "candidate" ? candidateDir : "(working tree)"}`);
  log(`Patch file: ${patchFile}`);
  log(`Allowed paths: ${allowedPaths.length ? allowedPaths.join(", ") : "(none)"}`);
  log(`File discovery: ${fileDiscovery}`);
  log(`Apply mode: ${applyMode}`);
  log(`Candidate dir: ${candidateDir}`);
  log(`Repo map cache: ${repoMapCachePath} (ttl ${repoMapCacheTtlMinutes}m)`);
  log(`Change budget: ${maxFilesToEdit} files, ${maxPatchChanges} changes, ${maxPatchChars} chars`);
  log(`Retry attempts: ${retryAttempts}`);
  log(`Git branch: ${gitConfig.createBranch ? "yes" : "no"}`);
  log(`Git commit: ${gitConfig.commit ? "yes" : "no"}`);
  log(`Test command: ${testCommand || "(none)"}`);
  log(`Run tests: ${runTests ? "yes" : "no"}`);
  log(`Preflight command: ${preflightCommand || "(none)"}`);
  log(`Preflight required: ${preflightRequired ? "yes" : "no"}`);
  log(`Max tokens: ${maxTokens}`);
  log("");

  for (let i = 0; i < config.maxIterations; i++) {
    log(`--- Iteration ${i + 1} ---`);

    const shouldAutoSelect =
      !targetFile || fileDiscovery.toLowerCase() === "auto" || targetFile === "auto";
    let selectedFiles = [];

    if (shouldAutoSelect) {
      const cacheMeta = {
        repoPath,
        allowedPaths: normalizeAllowedPaths(allowedPaths),
        maxFiles: repoMapMaxFiles
      };
      const cachePath = resolvePath(repoPath, repoMapCachePath);
      const cached = readRepoMapCache(cachePath, repoMapCacheTtlMinutes, cacheMeta);
      const repoListing = cached || listRepoFiles(repoPath, allowedPaths, repoMapMaxFiles);
      if (!cached) {
        writeRepoMapCache(cachePath, cacheMeta, repoListing.files, repoListing.truncated);
        log(`Repo map cache written: ${cachePath}`);
      } else {
        log(`Repo map cache hit: ${cachePath}`);
      }
      const repoSummary = buildRepoSummary(repoListing.files, repoListing.truncated);
      const selected = await selectFilesForTask(
        task,
        guidance,
        repoSummary,
        allowedPaths,
        maxFilesToEdit
      );
      selectedFiles = selected.filter((file) => isPathAllowed(file, allowedPaths));
    } else {
      selectedFiles = [normalizeRepoPath(targetFile)];
    }

    const uniqueFiles = Array.from(new Set(selectedFiles));
    if (uniqueFiles.length === 0) {
      throw new Error("No files selected for editing.");
    }

    const fileContents = {};
    for (const file of uniqueFiles) {
      if (!isPathAllowed(file, allowedPaths)) {
        throw new Error(`Selected file is outside allowed paths: ${file}`);
      }
      if (!fs.existsSync(resolvePath(repoPath, file))) {
        throw new Error(`Selected file does not exist: ${file}`);
      }
      fileContents[file] = readFileWithLimit(repoPath, file, maxFileBytes);
    }

    const fileContext = buildFileContext(uniqueFiles, fileContents);

    const basePrompt = `
Task:
${task}

${guidance ? `Harness guidance:\n${guidance}\n` : ""}

Selected files:
${uniqueFiles.map((file) => `- ${file}`).join("\n")}

File contents:
${fileContext}

Return ONLY valid JSON with this schema:
{
  "changes": [
    {
      "type": "replace",
      "file": "path\\to\\file.ext",
      "find": "exact old code snippet",
      "replace": "new code snippet"
    }
  ]
}

Rules:
- Do not rewrite whole files.
- Only include minimal changes needed.
- "find" must exactly match existing code.
- "file" must be one of the selected files above.
- Use \\n for line breaks inside JSON strings.
- Return JSON only.
${allowedPaths.length ? `- Allowed paths: ${allowedPaths.join(", ")}` : ""}
`;

    const maxAttempts = retryAttempts + 1;
    let lastError = "";
    let lastPatch = null;
    let branchReady = false;
    let branchName = "";

    const ensureBranch = () => {
      if (branchReady) return;
      ensureGitRepo(repoPath);
      branchName = buildBranchName(gitConfig.branchPrefix, effectiveRole, repoName);
      const gitStatus = getGitStatus(repoPath);
      if (gitStatus) {
        log("⚠️ Repo has uncommitted changes before applying patch.");
      }
      try {
        execSync(`git -C "${repoPath}" checkout -b "${branchName}"`, {
          encoding: "utf-8",
          stdio: ["pipe", "pipe", "pipe"]
        });
      } catch (err) {
        execSync(`git -C "${repoPath}" checkout "${branchName}"`, {
          encoding: "utf-8",
          stdio: ["pipe", "pipe", "pipe"]
        });
      }
      branchReady = true;
      log(`✅ Branch ready: ${branchName}`);
    };

    for (let attempt = 1; attempt <= maxAttempts; attempt++) {
      const retryContext = lastError
        ? `\nPrevious error:\n${lastError}\n${
            lastPatch ? `Previous patch:\n${JSON.stringify(lastPatch, null, 2)}\n` : ""
          }`
        : "";
      const prompt = `${basePrompt}${retryContext}`;

      log(`Patch attempt ${attempt}/${maxAttempts}`);

      let patch = null;
      let updatedFiles = null;
      let changedFiles = [];
      let wroteWorkingFiles = false;

      try {
        const messages = [
          {
            role: "system",
            content:
              "You are a careful coding agent. Return ONLY valid JSON. Do not return markdown. Do not rewrite the whole file. Only propose minimal replace operations."
          },
          {
            role: "user",
            content: prompt
          }
        ];

        const response = await callModel(messages);
        const choice = response?.choices?.[0];
        const finishReason = choice?.finish_reason ?? "unknown";
        const output = choice?.message?.content ?? "";

        log(`Finish reason: ${finishReason}`);

        if (finishReason === "length") {
          throw new Error("Model output was truncated.");
        }

        const jsonText = extractJsonOnly(output);
        try {
          patch = JSON.parse(jsonText);
        } catch (err) {
          throw new Error("Model did not return valid JSON patch.");
        }

        if (!patch || !Array.isArray(patch.changes)) {
          throw new Error("Patch missing changes array.");
        }
        if (patch.changes.length > maxPatchChanges) {
          throw new Error(`Patch exceeds max changes (${maxPatchChanges}).`);
        }
        const totalChars = patch.changes.reduce(
          (sum, change) =>
            sum +
            (typeof change.find === "string" ? change.find.length : 0) +
            (typeof change.replace === "string" ? change.replace.length : 0),
          0
        );
        if (totalChars > maxPatchChars) {
          throw new Error(`Patch exceeds max size (${maxPatchChars} chars).`);
        }

        const patchPath = resolvePath(repoPath, patchFile);
        fs.writeFileSync(patchPath, JSON.stringify(patch, null, 2), "utf-8");

        const allowedSet = new Set(uniqueFiles.map((file) => normalizeRepoPath(file)));
        for (const change of patch.changes) {
          const file = normalizeRepoPath(change.file || "");
          if (!allowedSet.has(file)) {
            throw new Error(`Patch refers to file outside selection: ${file}`);
          }
        }

        updatedFiles = applyPatchToFiles(fileContents, patch);
        changedFiles = Object.keys(updatedFiles);
        log(`Files changed: ${changedFiles.join(", ")}`);

        if (
          applyMode.toLowerCase() !== "candidate" &&
          (gitConfig.createBranch || gitConfig.commit)
        ) {
          ensureBranch();
        }

        if (applyMode.toLowerCase() === "candidate") {
          const candidateRoot = resolvePath(repoPath, candidateDir);
          for (const file of changedFiles) {
            const candidatePath = resolvePath(candidateRoot, file);
            fs.mkdirSync(path.dirname(candidatePath), { recursive: true });
            fs.writeFileSync(candidatePath, updatedFiles[file], "utf-8");
          }
          log(`✅ Candidate files written under: ${candidateDir}`);
        } else {
          for (const file of changedFiles) {
            const targetPath = resolvePath(repoPath, file);
            fs.writeFileSync(targetPath, updatedFiles[file], "utf-8");
          }
          wroteWorkingFiles = true;
        }

        const jsFiles = changedFiles.filter((file) =>
          [".js", ".cjs", ".mjs"].includes(path.extname(file).toLowerCase())
        );
        if (jsFiles.length > 0) {
          for (const file of jsFiles) {
            const checkPath =
              applyMode.toLowerCase() === "candidate"
                ? resolvePath(resolvePath(repoPath, candidateDir), file)
                : resolvePath(repoPath, file);
            execSync(`node --check "${checkPath}"`, {
              encoding: "utf-8",
              stdio: ["pipe", "pipe", "pipe"]
            });
          }
          log("✅ Syntax check passed");
        } else {
          log("⚠️ Skipped syntax check (no JS targets)");
        }

        if (runTests && testCommand && applyMode.toLowerCase() !== "candidate") {
          log(`Running tests: ${testCommand}`);
          execSync(testCommand, {
            cwd: repoPath,
            encoding: "utf-8",
            stdio: ["pipe", "pipe", "pipe"]
          });
          log("✅ Tests passed");
        }

        log(`✅ Patch file written: ${patchFile}`);

        if (applyMode.toLowerCase() !== "candidate" && gitConfig.commit) {
          for (const file of changedFiles) {
            execSync(`git -C "${repoPath}" add -- "${file}"`, {
              encoding: "utf-8",
              stdio: ["pipe", "pipe", "pipe"]
            });
          }
          const commitMessage = formatCommitMessage(
            gitConfig.commitMessage,
            effectiveRole,
            repoName,
            task
          );
          execSync(`git -C "${repoPath}" commit -m "${commitMessage}"`, {
            encoding: "utf-8",
            stdio: ["pipe", "pipe", "pipe"]
          });
          log("✅ Commit created");
        }

        log("");
        break;
      } catch (err) {
        lastError = err.message;
        lastPatch = patch;
        if (wroteWorkingFiles && attempt < maxAttempts) {
          for (const file of changedFiles) {
            const targetPath = resolvePath(repoPath, file);
            fs.writeFileSync(targetPath, fileContents[file], "utf-8");
          }
          log("⚠️ Reverted working files after failure.");
        }
        if (attempt >= maxAttempts) {
          log(`❌ Error: ${err.message}`);
          log("");
          break;
        }
        log(`⚠️ Attempt failed: ${err.message}`);
      }
    }
  }

  log("=== Night Agent End ===");
}

run().catch((err) => {
  log(`Fatal error: ${err.message}`);
  process.exit(1);
});
