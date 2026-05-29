const { execSync } = require("child_process");
const fs = require("fs");
const path = require("path");

const config = JSON.parse(fs.readFileSync("config.json", "utf-8"));
const maxTokens =
  Number.isInteger(config.maxTokens) && config.maxTokens > 0
    ? config.maxTokens
    : 4096;
const patchFile =
  typeof config.patchFile === "string" && config.patchFile.trim()
    ? config.patchFile
    : "run-agent.patch.json";
const task = fs.readFileSync("tasks.txt", "utf-8");

function timestamp() {
  return new Date().toISOString();
}

function log(level, msg) {
  const line = `[${timestamp()}] [${level}] ${msg}`;
  console.log(line);
  fs.appendFileSync("logs.txt", line + "\n");
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
    return fs.readFileSync(path.join(repoPath, fileName), "utf-8");
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
  log("INFO", "=== Night Agent Start ===");
  log("INFO", `Model: ${config.model}`);
  log("INFO", `Repo path: ${config.repoPath}`);
  log("INFO", `Target file: ${config.targetFile}`);
  log("INFO", `Candidate file: ${config.candidateFile}`);
  log("INFO", `Patch file: ${patchFile}`);
  log("INFO", `Max tokens: ${maxTokens}`);
  log("");

  for (let i = 0; i < config.maxIterations; i++) {
    log("INFO", `--- Iteration ${i + 1} ---`);

    const currentCode = readTargetFile(config.repoPath, config.targetFile);

    const prompt = `
Task:
${task}

Current file (${config.targetFile}):
${currentCode}

Return ONLY valid JSON with this schema:
{
  "targetFile": "${config.targetFile}",
  "changes": [
    {
      "type": "replace",
      "find": "exact old code snippet",
      "replace": "new code snippet"
    }
  ]
}

Rules:
- Do not rewrite the whole file
- Only include the minimal changes needed
- "find" must exactly match existing code
- Use \\n for line breaks inside JSON strings
- Return JSON only
`;

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

      log("INFO", `Finish reason: ${finishReason}`);

      if (finishReason === "length") {
        throw new Error("Model output was truncated.");
      }

      const jsonText = extractJsonOnly(output);
      let patch;
      try {
        patch = JSON.parse(jsonText);
      } catch (err) {
        throw new Error("Model did not return valid JSON patch.");
      }

      if (patch.targetFile && patch.targetFile !== config.targetFile) {
        throw new Error(
          `Patch targetFile mismatch: ${patch.targetFile} (expected ${config.targetFile})`
        );
      }

      const patchPath = path.join(config.repoPath, patchFile);
      fs.writeFileSync(patchPath, JSON.stringify(patch, null, 2), "utf-8");

      const updatedContent = applyPatchToContent(currentCode, patch);
      const candidatePath = path.join(config.repoPath, config.candidateFile);
      fs.writeFileSync(candidatePath, updatedContent, "utf-8");

      execSync(`node --check "${candidatePath}"`, {
        encoding: "utf-8",
        stdio: ["pipe", "pipe", "pipe"]
      });

      log("INFO", `✅ Candidate file written: ${config.candidateFile}`);
      log("INFO", `✅ Patch file written: ${patchFile}`);
      log("INFO", "✅ Syntax check passed");
      log("");
    } catch (err) {
      log("ERROR", `❌ Error: ${err.message}`);
      log("");
    }
  }

  log("INFO", "=== Night Agent End ===");
}

run().catch((err) => {
  log("ERROR", `Fatal error: ${err.message}`);
  process.exit(1);
});
