"use strict";

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const root = path.join(__dirname, "..");
const lib = fs
  .readFileSync(path.join(root, "lib", "review_contract.js"), "utf8")
  .replace(/\nmodule\.exports\s*=\s*\{[\s\S]*?\};\s*$/, "\n");
const reviewPrompt = fs.readFileSync(
  path.join(root, "prompts", "review.md"),
  "utf8",
);
const fixPrompt = fs.readFileSync(path.join(root, "prompts", "fix.md"), "utf8");

// Code-node snippet shared by both flows. OLLAMA_MODEL comes from the n8n
// container environment, so changing model is a .env edit, not a workflow edit.
// No response_format: qwen2.5-coder:3b hits Ollama's token-repeat abort under
// JSON-schema constrained decoding. The prompt asks for JSON; parseReview
// still validates and refuses a bad reply.
const modelBodySource = `
function modelBody(system, user) {
  return {
    model: $env.OLLAMA_MODEL,
    stream: false,
    temperature: 0,
    messages: [
      { role: "system", content: system },
      { role: "user", content: user },
    ],
  };
}
function clip(text, max) {
  return text.length > max ? text.slice(0, max) + "\\n... (truncated)" : text;
}
`;

// The model sits on an internal Docker network. n8n reaches it by service name.
function askModel(name, id, x, y) {
  return http(name, id, x, y, {
    method: "POST",
    url: "http://ollama:11434/v1/chat/completions",
    sendBody: true,
    specifyBody: "json",
    jsonBody: "={{ JSON.stringify($json.modelBody) }}",
    options: { timeout: 300000 },
  });
}

const githubHeaders = [
  { name: "Authorization", value: "=Bearer {{$env.GITHUB_TOKEN}}" },
  { name: "User-Agent", value: "course-n8n" },
  { name: "X-GitHub-Api-Version", value: "2022-11-28" },
];

function node(extra) {
  return extra;
}

function code(name, id, x, y, source, withLib) {
  return node({
    parameters: {
      mode: "runOnceForAllItems",
      language: "javaScript",
      jsCode: (withLib ? lib + "\n" : "") + source.trim() + "\n",
    },
    type: "n8n-nodes-base.code",
    typeVersion: 2,
    position: [x, y],
    id,
    name,
  });
}

function http(name, id, x, y, parameters) {
  return node({
    parameters,
    type: "n8n-nodes-base.httpRequest",
    typeVersion: 4.2,
    position: [x, y],
    id,
    name,
    alwaysOutputData: true,
  });
}

function webhook(name, id, hookPath, x, y) {
  return node({
    parameters: {
      httpMethod: "POST",
      path: hookPath,
      responseMode: "onReceived",
      options: { rawBody: true },
    },
    type: "n8n-nodes-base.webhook",
    typeVersion: 2,
    position: [x, y],
    id,
    name,
    webhookId: id,
  });
}

function iff(name, id, x, y, conditions) {
  return node({
    parameters: {
      conditions: {
        options: {
          caseSensitive: true,
          leftValue: "",
          typeValidation: "loose",
          version: 2,
        },
        conditions,
        combinator: "and",
      },
    },
    type: "n8n-nodes-base.if",
    typeVersion: 2.2,
    position: [x, y],
    id,
    name,
  });
}

function equals(id, left, right) {
  return {
    id,
    leftValue: left,
    rightValue: right,
    operator: { type: "string", operation: "equals" },
  };
}

function noop(name, id, x, y) {
  return node({
    parameters: {},
    type: "n8n-nodes-base.noOp",
    typeVersion: 1,
    position: [x, y],
    id,
    name,
  });
}

function link(connections, from, to, output) {
  connections[from] = connections[from] || { main: [] };
  while (connections[from].main.length <= output) connections[from].main.push([]);
  connections[from].main[output].push({ node: to, type: "main", index: 0 });
}

function workflow(name, nodes, connections) {
  return {
    name,
    nodes,
    connections,
    active: false,
    settings: { executionOrder: "v1" },
    pinData: {},
    meta: { templateCredsSetupCompleted: true },
    tags: [],
  };
}

const verifySource = `
const crypto = require("crypto");

function same(a, b) {
  const left = Buffer.from(String(a));
  const right = Buffer.from(String(b));
  if (left.length !== right.length) return false;
  return crypto.timingSafeEqual(left, right);
}

const item = $input.first();
let raw;
if (item.binary && item.binary.data) {
  raw = await this.helpers.getBinaryDataBuffer(0, "data");
} else if (typeof item.json.body === "string") {
  raw = Buffer.from(item.json.body, "utf8");
} else {
  throw new Error("Raw body missing. On the Webhook node, open Options and enable Raw Body.");
}

const headers = item.json.headers || {};
const header = String(headers["x-hub-signature-256"] || "");
const secret = $env.GITHUB_WEBHOOK_SECRET || "";
if (!secret) throw new Error("GITHUB_WEBHOOK_SECRET is empty in the n8n container.");
const expected = "sha256=" + crypto.createHmac("sha256", secret).update(raw).digest("hex");
if (!same(header, expected)) {
  throw new Error("Webhook signature did not match. Compare the GitHub webhook secret with platform/.env, then recreate the n8n container.");
}

return [{
  json: {
    event: String(headers["x-github-event"] || ""),
    payload: JSON.parse(raw.toString("utf8")),
  },
}];
`;

function buildRequestSource(prompt) {
  return `
const meta = $("Verify signature").first().json;
const diff = typeof $json.data === "string"
  ? $json.data
  : typeof $json.body === "string"
    ? $json.body
    : JSON.stringify($json);
const pr = meta.payload.pull_request;
const prompt = ${JSON.stringify(prompt)};
${modelBodySource}
return [{
  json: {
    modelBody: modelBody(prompt, "Diff:\\n\\n" + clip(diff, 8000)),
    owner: meta.payload.repository.owner.login,
    repo: meta.payload.repository.name,
    number: pr.number,
  },
}];
`;
}

const readReviewSource = `
const meta = $("Build request").first().json;
const content = $json.choices?.[0]?.message?.content ?? "";
const base = {
  owner: meta.owner,
  repo: meta.repo,
  number: meta.number,
  branch: meta.branch || "",
};
let review;
try {
  review = parseReview(content);
} catch (err) {
  return [{
    json: {
      ...base,
      commentBody: "Agent reply could not be read: " + err.message,
      commit: "no",
      edit: null,
      path: "",
      pathEncoded: "",
    },
  }];
}
let filePath = "";
let refusal = "";
try {
  filePath = assertSafeEdit(review.edit);
} catch (err) {
  refusal = err.message;
}
const wantCommit = review.verdict === "request_changes" && filePath !== "" && !refusal;
const commit = meta.branch && wantCommit ? "yes" : "no";
const note = !meta.branch
  ? (refusal || "Review only. A later workflow commits if the test job fails.")
  : commit === "yes"
    ? "n8n will try to apply this edit and commit it onto the pull request branch."
    : (refusal || "No commit.");
return [{
  json: {
    ...base,
    edit: review.edit,
    path: filePath,
    pathEncoded: filePath.split("/").map(encodeURIComponent).join("/"),
    commit,
    commentBody: commentBody(review, note),
  },
}];
`;

function githubGet(url, accept, timeout) {
  return {
    method: "GET",
    url,
    sendHeaders: true,
    headerParameters: {
      parameters: [{ name: "Accept", value: accept }, ...githubHeaders],
    },
    options: {
      timeout: timeout || 30000,
      response: {
        response: {
          responseFormat: accept.includes("diff") ? "text" : "json",
        },
      },
    },
  };
}

function githubPost(url, bodyExpr) {
  return {
    method: "POST",
    url,
    sendHeaders: true,
    headerParameters: {
      parameters: [
        { name: "Accept", value: "application/vnd.github+json" },
        ...githubHeaders,
      ],
    },
    sendBody: true,
    specifyBody: "json",
    jsonBody: bodyExpr,
    options: { timeout: 30000 },
  };
}

const reviewConnections = {};
link(reviewConnections, "GitHub PR", "Verify signature", 0);
link(reviewConnections, "Verify signature", "Is opened PR", 0);
link(reviewConnections, "Is opened PR", "Fetch diff", 0);
link(reviewConnections, "Is opened PR", "Ignore event", 1);
link(reviewConnections, "Fetch diff", "Build request", 0);
link(reviewConnections, "Build request", "Ask model", 0);
link(reviewConnections, "Ask model", "Read review", 0);
link(reviewConnections, "Read review", "Post comment", 0);

const review = workflow(
  "PR review",
  [
    webhook("GitHub PR", "c0ffee00-0001-4000-8000-000000000001", "github-pr", 0, 0),
    code("Verify signature", "c0ffee00-0001-4000-8000-000000000002", 260, 0, verifySource, false),
    iff("Is opened PR", "c0ffee00-0001-4000-8000-000000000003", 520, 0, [
      equals("event", "={{ $json.event }}", "pull_request"),
      equals("action", "={{ $json.payload.action }}", "opened"),
    ]),
    noop("Ignore event", "c0ffee00-0001-4000-8000-000000000004", 780, 180),
    http(
      "Fetch diff",
      "c0ffee00-0001-4000-8000-000000000005",
      780,
      0,
      githubGet(
        "=https://api.github.com/repos/{{ $json.payload.repository.full_name }}/pulls/{{ $json.payload.pull_request.number }}",
        "application/vnd.github.diff",
      ),
    ),
    code(
      "Build request",
      "c0ffee00-0001-4000-8000-000000000006",
      1040,
      0,
      buildRequestSource(reviewPrompt),
      false,
    ),
    askModel("Ask model", "c0ffee00-0001-4000-8000-000000000007", 1300, 0),
    code("Read review", "c0ffee00-0001-4000-8000-000000000008", 1560, 0, readReviewSource, true),
    http(
      "Post comment",
      "c0ffee00-0001-4000-8000-000000000009",
      1820,
      0,
      githubPost(
        "=https://api.github.com/repos/{{ $json.owner }}/{{ $json.repo }}/issues/{{ $json.number }}/comments",
        "={{ JSON.stringify({ body: $json.commentBody }) }}",
      ),
    ),
  ],
  reviewConnections,
);

const fixConnections = {};
link(fixConnections, "GitHub check", "Verify signature", 0);
link(fixConnections, "Verify signature", "Is test failure", 0);
link(fixConnections, "Is test failure", "Remember failure", 0);
link(fixConnections, "Is test failure", "Ignore event", 1);
link(fixConnections, "Remember failure", "List commits", 0);
link(fixConnections, "List commits", "Should fix", 0);
link(fixConnections, "Should fix", "Still our turn", 0);
link(fixConnections, "Still our turn", "Fetch diff", 0);
link(fixConnections, "Still our turn", "Stop loop comment", 1);
link(fixConnections, "Fetch diff", "PR context", 0);
link(fixConnections, "PR context", "List PR files", 0);
link(fixConnections, "List PR files", "Pick app files", 0);
link(fixConnections, "Pick app files", "Get app file", 0);
link(fixConnections, "Get app file", "Collect files", 0);
link(fixConnections, "Collect files", "Build request", 0);
link(fixConnections, "Build request", "Ask model", 0);
link(fixConnections, "Ask model", "Read review", 0);
link(fixConnections, "Read review", "Post comment", 0);
link(fixConnections, "Read review", "Has a safe edit", 0);
link(fixConnections, "Has a safe edit", "Get file", 0);
link(fixConnections, "Has a safe edit", "Skip commit", 1);
link(fixConnections, "Get file", "Apply edit", 0);
link(fixConnections, "Apply edit", "Edit applied", 0);
link(fixConnections, "Edit applied", "Commit file", 0);
link(fixConnections, "Edit applied", "Edit failed comment", 1);

const issueComments =
  "=https://api.github.com/repos/{{ $json.owner }}/{{ $json.repo }}/issues/{{ $json.number }}/comments";

const fix = workflow(
  "CI fix",
  [
    webhook("GitHub check", "c0ffee00-0002-4000-8000-000000000001", "github-check", 0, 0),
    code("Verify signature", "c0ffee00-0002-4000-8000-000000000002", 260, 0, verifySource, false),
    iff("Is test failure", "c0ffee00-0002-4000-8000-000000000003", 520, 0, [
      equals("event", "={{ $json.event }}", "check_run"),
      equals("action", "={{ $json.payload.action }}", "completed"),
      equals(
        "conclusion",
        "={{ $json.payload.check_run ? $json.payload.check_run.conclusion : '' }}",
        "failure",
      ),
      equals(
        "name",
        "={{ $json.payload.check_run ? $json.payload.check_run.name : '' }}",
        "test",
      ),
      {
        id: "prs",
        leftValue:
          "={{ $json.payload.check_run && $json.payload.check_run.pull_requests ? $json.payload.check_run.pull_requests.length : 0 }}",
        rightValue: 0,
        operator: { type: "number", operation: "gt" },
      },
    ]),
    noop("Ignore event", "c0ffee00-0002-4000-8000-000000000004", 780, 220),
    code(
      "Remember failure",
      "c0ffee00-0002-4000-8000-000000000005",
      780,
      0,
      `
const item = $input.first().json;
const run = item.payload.check_run;
const pr = run.pull_requests[0];
if (!pr || !pr.head || !pr.head.ref) {
  throw new Error("check_run did not include a pull request head branch.");
}
return [{
  json: {
    owner: item.payload.repository.owner.login,
    repo: item.payload.repository.name,
    fullName: item.payload.repository.full_name,
    number: pr.number,
    branch: pr.head.ref,
    notes: [run.output && run.output.title, run.output && run.output.summary, run.output && run.output.text]
      .filter((text) => typeof text === "string" && text.trim()),
  },
}];
`,
      false,
    ),
    http(
      "List commits",
      "c0ffee00-0002-4000-8000-000000000006",
      1040,
      0,
      githubGet(
        "=https://api.github.com/repos/{{ $json.fullName }}/pulls/{{ $json.number }}/commits",
        "application/vnd.github+json",
      ),
    ),
    code(
      "Should fix",
      "c0ffee00-0002-4000-8000-000000000007",
      1300,
      0,
      `
const remembered = $("Remember failure").first().json;
const messages = $input.all().map((item) => (item.json.commit && item.json.commit.message) || "");
const already = messages.some((message) => message.includes("course bot"));
return [{ json: { ...remembered, gate: already ? "stop" : "continue" } }];
`,
      false,
    ),
    iff("Still our turn", "c0ffee00-0002-4000-8000-000000000008", 1560, 0, [
      equals("gate", "={{ $json.gate }}", "continue"),
    ]),
    http(
      "Stop loop comment",
      "c0ffee00-0002-4000-8000-000000000009",
      1820,
      220,
      githubPost(
        issueComments,
        '={{ JSON.stringify({ body: "A course-bot commit is already on this branch. Stopping so the agent does not loop. A person takes it from here." }) }}',
      ),
    ),
    http(
      "Fetch diff",
      "c0ffee00-0002-4000-8000-00000000000a",
      1820,
      0,
      githubGet(
        "=https://api.github.com/repos/{{ $json.fullName }}/pulls/{{ $json.number }}",
        "application/vnd.github.diff",
      ),
    ),
    // Fetch diff returns only the diff text. Restore the PR identity here so the
    // next HTTP node reads it from $json instead of reaching across nodes.
    code(
      "PR context",
      "c0ffee00-0002-4000-8000-000000000020",
      1950,
      140,
      `
const remembered = $("Remember failure").first().json;
return [{ json: { fullName: remembered.fullName, number: remembered.number } }];
`,
      false,
    ),
    // The model sees only what n8n sends. A small model fixes a file it can
    // read, so n8n sends the full current content of the changed app/ files.
    http(
      "List PR files",
      "c0ffee00-0002-4000-8000-000000000017",
      2080,
      0,
      githubGet(
        "=https://api.github.com/repos/{{ $json.fullName }}/pulls/{{ $json.number }}/files?per_page=100",
        "application/vnd.github+json",
      ),
    ),
    code(
      "Pick app files",
      "c0ffee00-0002-4000-8000-000000000018",
      2340,
      0,
      `
const remembered = $("Remember failure").first().json;
const picked = $input.all()
  .map((item) => item.json)
  .filter((file) => file && typeof file.filename === "string")
  .filter((file) => file.status !== "removed" && /^app\\//.test(file.filename))
  .slice(0, 3)
  .map((file) => ({
    json: {
      fullName: remembered.fullName,
      branch: remembered.branch,
      pathEncoded: file.filename.split("/").map(encodeURIComponent).join("/"),
    },
  }));
// Keep the flow alive when the PR touched nothing under app/. The directory
// listing that comes back has no file content and Collect files drops it.
return picked.length
  ? picked
  : [{ json: { fullName: remembered.fullName, branch: remembered.branch, pathEncoded: "app" } }];
`,
      false,
    ),
    http(
      "Get app file",
      "c0ffee00-0002-4000-8000-000000000019",
      2600,
      0,
      githubGet(
        "=https://api.github.com/repos/{{ $json.fullName }}/contents/{{ $json.pathEncoded }}?ref={{ encodeURIComponent($json.branch) }}",
        "application/vnd.github+json",
      ),
    ),
    code(
      "Collect files",
      "c0ffee00-0002-4000-8000-00000000001a",
      2860,
      0,
      `
const files = $input.all()
  .map((item) => item.json)
  .filter((file) => file && file.encoding === "base64" && typeof file.content === "string")
  .filter((file) => /^app\\//.test(String(file.path)))
  .map((file) => ({
    path: file.path,
    text: Buffer.from(file.content.replace(/\\s/g, ""), "base64").toString("utf8"),
  }));
return [{ json: { files } }];
`,
      false,
    ),
    code(
      "Build request",
      "c0ffee00-0002-4000-8000-00000000000c",
      3380,
      0,
      `
const remembered = $("Remember failure").first().json;
const diffItem = $("Fetch diff").first().json;
const diff = typeof diffItem.data === "string"
  ? diffItem.data
  : typeof diffItem.body === "string"
    ? diffItem.body
    : JSON.stringify(diffItem);
const files = $("Collect files").first().json.files || [];
const notes = remembered.notes || [];
const prompt = ${JSON.stringify(fixPrompt)};
${modelBodySource}
const user = [
  "Failure notes:",
  notes.length ? notes.join("\\n") : "(none)",
  "",
  "Current content of the changed files:",
  files.length
    ? files.map((file) => "=== " + file.path + " ===\\n" + clip(file.text, 4000)).join("\\n\\n")
    : "(none)",
  "",
  "Diff:",
  clip(diff, 6000),
].join("\\n");
return [{
  json: {
    modelBody: modelBody(prompt, user),
    owner: remembered.owner,
    repo: remembered.repo,
    number: remembered.number,
    branch: remembered.branch,
  },
}];
`,
      false,
    ),
    askModel("Ask model", "c0ffee00-0002-4000-8000-00000000000d", 3640, 0),
    code("Read review", "c0ffee00-0002-4000-8000-00000000000e", 3900, 0, readReviewSource, true),
    http(
      "Post comment",
      "c0ffee00-0002-4000-8000-00000000000f",
      4160,
      180,
      githubPost(issueComments, "={{ JSON.stringify({ body: $json.commentBody }) }}"),
    ),
    iff("Has a safe edit", "c0ffee00-0002-4000-8000-000000000010", 4160, 0, [
      equals("commit", "={{ $json.commit }}", "yes"),
    ]),
    noop("Skip commit", "c0ffee00-0002-4000-8000-000000000011", 4420, 220),
    http(
      "Get file",
      "c0ffee00-0002-4000-8000-000000000013",
      4420,
      0,
      githubGet(
        "=https://api.github.com/repos/{{ $json.owner }}/{{ $json.repo }}/contents/{{ $json.pathEncoded }}?ref={{ encodeURIComponent($json.branch) }}",
        "application/vnd.github+json",
      ),
    ),
    code(
      "Apply edit",
      "c0ffee00-0002-4000-8000-000000000014",
      4680,
      0,
      `
const spec = $("Read review").first().json;
const encoded = String($json.content || "").replace(/\\s/g, "");
const original = Buffer.from(encoded, "base64").toString("utf8");
try {
  const next = applyEdit(original, spec.edit);
  return [{
    json: {
      ...spec,
      ok: "yes",
      sha: $json.sha,
      newContentBase64: Buffer.from(next, "utf8").toString("base64"),
    },
  }];
} catch (err) {
  return [{ json: { ...spec, ok: "no", error: err.message } }];
}
`,
      true,
    ),
    iff("Edit applied", "c0ffee00-0002-4000-8000-000000000015", 4940, 0, [
      equals("ok", "={{ $json.ok }}", "yes"),
    ]),
    http(
      "Commit file",
      "c0ffee00-0002-4000-8000-000000000016",
      5200,
      0,
      {
        method: "PUT",
        url: "=https://api.github.com/repos/{{ $json.owner }}/{{ $json.repo }}/contents/{{ $json.pathEncoded }}",
        sendHeaders: true,
        headerParameters: {
          parameters: [
            { name: "Accept", value: "application/vnd.github+json" },
            ...githubHeaders,
          ],
        },
        sendBody: true,
        specifyBody: "json",
        jsonBody:
          '={{ JSON.stringify({ message: "fix: restore health check (course bot)", content: $json.newContentBase64, sha: $json.sha, branch: $json.branch }) }}',
        options: { timeout: 30000 },
      },
    ),
    http(
      "Edit failed comment",
      "c0ffee00-0002-4000-8000-00000000001b",
      5200,
      220,
      githubPost(
        issueComments,
        '={{ JSON.stringify({ body: "n8n could not apply the suggested edit, so nothing was committed: " + $json.error }) }}',
      ),
    ),
  ],
  fixConnections,
);

const outDir = path.join(__dirname);
fs.writeFileSync(path.join(outDir, "pr-review.json"), JSON.stringify(review, null, 2) + "\n");
fs.writeFileSync(path.join(outDir, "ci-fix.json"), JSON.stringify(fix, null, 2) + "\n");
console.log("wrote pr-review.json and ci-fix.json");
