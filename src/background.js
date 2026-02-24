const DEFAULT_CONFIG = {
  repoFullName: "",
  branch: "main",
  baseFolder: "leetcode"
};

const GITHUB_PAT_STORAGE_KEY = "githubPatToken";
const LEGACY_OAUTH_TOKEN_STORAGE_KEY = "githubOAuthToken";
const LEGACY_OAUTH_META_STORAGE_KEY = "githubOAuthTokenMeta";
const ANALYTICS_EVENTS_STORAGE_KEY = "lc2ghAnalyticsEvents";

const README_INDEX_START = "<!-- LC2GH_INDEX_START -->";
const README_INDEX_END = "<!-- LC2GH_INDEX_END -->";
const README_ANALYTICS_START = "<!-- LC2GH_ANALYTICS_START -->";
const README_ANALYTICS_END = "<!-- LC2GH_ANALYTICS_END -->";

const processedSubmissionIds = new Set();

chrome.storage.sync.remove(["githubToken", "githubClientId", "aiNotesEnabled", "aiModel"]);
chrome.storage.local.remove(["aiApiKey", "openaiApiKey"]);
chrome.storage.local.get([GITHUB_PAT_STORAGE_KEY, LEGACY_OAUTH_TOKEN_STORAGE_KEY], (saved) => {
  if (!saved[GITHUB_PAT_STORAGE_KEY] && saved[LEGACY_OAUTH_TOKEN_STORAGE_KEY]) {
    chrome.storage.local.set({ [GITHUB_PAT_STORAGE_KEY]: saved[LEGACY_OAUTH_TOKEN_STORAGE_KEY] }, () => {
      chrome.storage.local.remove([LEGACY_OAUTH_TOKEN_STORAGE_KEY, LEGACY_OAUTH_META_STORAGE_KEY]);
    });
  }
});

chrome.runtime.onInstalled.addListener(() => {
  chrome.storage.sync.get(DEFAULT_CONFIG, (saved) => {
    chrome.storage.sync.set({ ...DEFAULT_CONFIG, ...saved }, () => {
      chrome.storage.sync.remove(["githubToken", "githubClientId", "aiNotesEnabled", "aiModel"]);
    });
  });
});

chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  if (message?.type === "accepted_submission" && message?.data) {
    handleAcceptedSubmission(message.data)
      .then((result) => sendResponse({ ok: true, result }))
      .catch((error) => {
        console.error("[LC2GH] Failed processing accepted submission:", error);
        notify("LeetCode to GitHub", `Failed: ${error.message}`);
        sendResponse({ ok: false, error: error.message });
      });
    return true;
  }

  if (message?.type === "test_github_connection") {
    testGitHubConnection()
      .then((details) => sendResponse({ ok: true, details }))
      .catch((error) => sendResponse({ ok: false, error: error.message }));
    return true;
  }

  if (message?.type === "test_github_push") {
    testGitHubPush()
      .then((details) => sendResponse({ ok: true, details }))
      .catch((error) => sendResponse({ ok: false, error: error.message }));
    return true;
  }

  if (message?.type === "get_auth_status") {
    getAuthStatus()
      .then((details) => sendResponse({ ok: true, details }))
      .catch((error) => sendResponse({ ok: false, error: error.message }));
    return true;
  }

  if (message?.type === "clear_github_pat") {
    clearGitHubPat()
      .then(() => sendResponse({ ok: true }))
      .catch((error) => sendResponse({ ok: false, error: error.message }));
    return true;
  }

  return undefined;
});

async function handleAcceptedSubmission(submission) {
  const submissionId = String(submission.submissionId || "");
  if (!submissionId) {
    throw new Error("Missing submission ID");
  }

  if (processedSubmissionIds.has(submissionId)) {
    return { status: "duplicate_submission_ignored" };
  }
  processedSubmissionIds.add(submissionId);

  const config = await getConfig();
  validateConfig(config);
  const token = await requireGitHubToken();
  const ownerRepo = parseOwnerRepo(config.repoFullName);

  const title = submission.title || submission.slug || "untitled-problem";
  const slug = sanitizePathSegment(submission.slug || title);
  const safeTitle = sanitizePathSegment(title);
  const language = String(submission.lang || "unknown");
  const ext = languageToExtension(language);
  const problemUrl = submission.problemUrl || `https://leetcode.com/problems/${slug}/`;

  const folder = trimSlashes(config.baseFolder || "leetcode");
  const problemDir = folder ? `${folder}/${slug}-${safeTitle}` : `${slug}-${safeTitle}`;
  const solutionPath = `${problemDir}/solution.${ext}`;
  const nowIso = new Date().toISOString();

  const solutionContent = buildCodeFile({ title, problemUrl, language, code: submission.typedCode });
  const solutionResult = await upsertFileInGitHub({
    token,
    owner: ownerRepo.owner,
    repo: ownerRepo.repo,
    branch: config.branch,
    path: solutionPath,
    content: solutionContent,
    commitMessage: `LeetCode: ${title} (${slug})`
  });

  if (!solutionResult.updated) {
    notify("LeetCode to GitHub", `Skipped unchanged: ${title}`);
    return { status: "skipped_unchanged", title, path: solutionPath };
  }

  const analytics = await recordAndBuildAnalytics({
    submissionId,
    slug,
    title,
    language,
    problemUrl,
    solutionPath,
    timestamp: nowIso
  });

  const analyticsPath = folder ? `${folder}/analytics/progress.json` : "analytics/progress.json";
  await upsertFileInGitHub({
    token,
    owner: ownerRepo.owner,
    repo: ownerRepo.repo,
    branch: config.branch,
    path: analyticsPath,
    content: `${JSON.stringify(analytics, null, 2)}\n`,
    commitMessage: `Analytics: ${title} (${slug})`
  });

  await updateReadmeSections({
    token,
    owner: ownerRepo.owner,
    repo: ownerRepo.repo,
    branch: config.branch,
    indexEntry: {
      title,
      problemUrl,
      language,
      path: solutionPath,
      updatedAt: nowIso
    },
    analytics
  });

  notify("LeetCode to GitHub", `Pushed: ${title}`);
  return {
    status: "pushed",
    title,
    path: solutionPath,
    currentStreak: analytics.currentStreak,
    uniqueSolved: analytics.uniqueProblemsSolved
  };
}

async function testGitHubConnection() {
  const config = await getConfig();
  validateConfig(config);
  const token = await requireGitHubToken();

  const ownerRepo = parseOwnerRepo(config.repoFullName);
  const branchRefUrl = `https://api.github.com/repos/${ownerRepo.owner}/${ownerRepo.repo}/git/ref/heads/${encodeURIComponent(config.branch)}`;
  const response = await fetch(branchRefUrl, {
    method: "GET",
    headers: getGitHubApiHeaders(token)
  });

  if (!response.ok) {
    const text = await response.text();
    throw new Error(`GitHub check failed (${response.status}): ${text}`);
  }

  return { repo: config.repoFullName, branch: config.branch };
}

async function testGitHubPush() {
  const config = await getConfig();
  validateConfig(config);
  const token = await requireGitHubToken();

  const ownerRepo = parseOwnerRepo(config.repoFullName);
  const folder = trimSlashes(config.baseFolder || "leetcode");
  const ts = new Date().toISOString().replace(/[:.]/g, "-");
  const path = folder ? `${folder}/lc2gh-test-${ts}.txt` : `lc2gh-test-${ts}.txt`;
  const content = `LeetCode->GitHub test push at ${new Date().toISOString()}\n`;

  await upsertFileInGitHub({
    token,
    owner: ownerRepo.owner,
    repo: ownerRepo.repo,
    branch: config.branch,
    path,
    content,
    commitMessage: `LC2GH test push ${ts}`
  });

  return { path, repo: config.repoFullName, branch: config.branch };
}

async function getAuthStatus() {
  const token = await getGitHubToken();
  if (!token) {
    return { authenticated: false };
  }

  const response = await fetch("https://api.github.com/user", {
    method: "GET",
    headers: getGitHubApiHeaders(token)
  });

  if (!response.ok) {
    await chrome.storage.local.remove([GITHUB_PAT_STORAGE_KEY]);
    return { authenticated: false };
  }

  const user = await response.json();
  return { authenticated: true, username: user.login || null };
}

async function clearGitHubPat() {
  await chrome.storage.local.remove([GITHUB_PAT_STORAGE_KEY, LEGACY_OAUTH_TOKEN_STORAGE_KEY, LEGACY_OAUTH_META_STORAGE_KEY]);
}

async function recordAndBuildAnalytics(event) {
  const saved = await new Promise((resolve) => {
    chrome.storage.local.get([ANALYTICS_EVENTS_STORAGE_KEY], (data) => resolve(data[ANALYTICS_EVENTS_STORAGE_KEY] || []));
  });

  const list = Array.isArray(saved) ? saved : [];
  const next = list.filter((item) => item.submissionId !== event.submissionId);
  const day = event.timestamp.slice(0, 10);
  next.push({
    submissionId: event.submissionId,
    slug: event.slug,
    title: event.title,
    language: event.language,
    problemUrl: event.problemUrl,
    solutionPath: event.solutionPath,
    timestamp: event.timestamp,
    day
  });

  await chrome.storage.local.set({ [ANALYTICS_EVENTS_STORAGE_KEY]: next.slice(-5000) });
  return buildAnalyticsSummary(next);
}

function buildAnalyticsSummary(events) {
  const sorted = [...events].sort((a, b) => a.timestamp.localeCompare(b.timestamp));
  const uniqueProblems = new Set(sorted.map((e) => e.slug));
  const dayCounts = new Map();
  const langCounts = new Map();
  const topicCounts = new Map();

  for (const e of sorted) {
    dayCounts.set(e.day, (dayCounts.get(e.day) || 0) + 1);
    const lang = String(e.language || "unknown").toLowerCase();
    langCounts.set(lang, (langCounts.get(lang) || 0) + 1);
    const topic = inferTopic(e.title, e.slug);
    topicCounts.set(topic, (topicCounts.get(topic) || 0) + 1);
  }

  const today = new Date().toISOString().slice(0, 10);
  const currentStreak = computeCurrentStreak(dayCounts, today);
  const longestStreak = computeLongestStreak(dayCounts);
  const last7Days = buildLast7Days(dayCounts);
  const recentProblems = buildRecentProblems(sorted);
  const revisionQueue = buildRevisionQueue(sorted, today);
  const recommendations = buildRecommendations(topicCounts);

  return {
    generatedAt: new Date().toISOString(),
    totalAcceptedSubmissions: sorted.length,
    uniqueProblemsSolved: uniqueProblems.size,
    solvedToday: dayCounts.get(today) || 0,
    currentStreak,
    longestStreak,
    languageBreakdown: Object.fromEntries([...langCounts.entries()].sort((a, b) => b[1] - a[1])),
    topicBreakdown: Object.fromEntries([...topicCounts.entries()].sort((a, b) => b[1] - a[1])),
    last7Days,
    recentProblems,
    revisionQueue,
    recommendations
  };
}

function buildRecentProblems(sortedEvents) {
  const seen = new Set();
  const out = [];
  for (let i = sortedEvents.length - 1; i >= 0; i -= 1) {
    const e = sortedEvents[i];
    if (seen.has(e.slug)) continue;
    seen.add(e.slug);
    out.push({
      title: e.title,
      slug: e.slug,
      language: e.language,
      day: e.day,
      problemUrl: e.problemUrl,
      solutionPath: e.solutionPath
    });
    if (out.length >= 10) break;
  }
  return out;
}

function buildLast7Days(dayCounts) {
  const out = [];
  const today = new Date();
  for (let i = 6; i >= 0; i -= 1) {
    const d = new Date(today);
    d.setUTCDate(today.getUTCDate() - i);
    const key = d.toISOString().slice(0, 10);
    out.push({ date: key, count: dayCounts.get(key) || 0 });
  }
  return out;
}

function computeCurrentStreak(dayCounts, todayKey) {
  let streak = 0;
  const d = new Date(`${todayKey}T00:00:00.000Z`);
  while (true) {
    const key = d.toISOString().slice(0, 10);
    if (!dayCounts.get(key)) break;
    streak += 1;
    d.setUTCDate(d.getUTCDate() - 1);
  }
  return streak;
}

function computeLongestStreak(dayCounts) {
  const days = [...dayCounts.keys()].sort();
  if (days.length === 0) return 0;

  let longest = 1;
  let current = 1;

  for (let i = 1; i < days.length; i += 1) {
    const prev = new Date(`${days[i - 1]}T00:00:00.000Z`);
    prev.setUTCDate(prev.getUTCDate() + 1);
    const expected = prev.toISOString().slice(0, 10);

    if (days[i] === expected) {
      current += 1;
      if (current > longest) longest = current;
    } else {
      current = 1;
    }
  }

  return longest;
}

function inferTopic(title, slug) {
  const text = `${title || ""} ${slug || ""}`.toLowerCase();
  const rules = [
    { topic: "array", keys: ["array", "sum", "subarray", "prefix"] },
    { topic: "string", keys: ["string", "substring", "palindrome", "anagram"] },
    { topic: "hash-map", keys: ["hash", "map", "set", "dictionary"] },
    { topic: "two-pointers", keys: ["two-sum", "two", "pointer"] },
    { topic: "sliding-window", keys: ["window"] },
    { topic: "binary-search", keys: ["binary search", "search", "sorted"] },
    { topic: "linked-list", keys: ["linked list", "list node"] },
    { topic: "tree", keys: ["tree", "bst", "binary tree", "traversal"] },
    { topic: "graph", keys: ["graph", "bfs", "dfs", "topological"] },
    { topic: "dp", keys: ["dynamic programming", "dp"] },
    { topic: "greedy", keys: ["greedy"] },
    { topic: "backtracking", keys: ["backtracking", "subset", "permutation"] },
    { topic: "heap", keys: ["heap", "priority queue"] },
    { topic: "stack-queue", keys: ["stack", "queue", "monotonic"] }
  ];

  for (const rule of rules) {
    if (rule.keys.some((k) => text.includes(k))) {
      return rule.topic;
    }
  }

  return "misc";
}

function buildRecommendations(topicCounts) {
  const baseline = [
    { topic: "array", query: "array" },
    { topic: "string", query: "string" },
    { topic: "hash-map", query: "hash map" },
    { topic: "two-pointers", query: "two pointers" },
    { topic: "sliding-window", query: "sliding window" },
    { topic: "binary-search", query: "binary search" },
    { topic: "tree", query: "tree" },
    { topic: "graph", query: "graph" },
    { topic: "dp", query: "dynamic programming" },
    { topic: "greedy", query: "greedy" }
  ];

  const scored = baseline.map((item) => ({
    ...item,
    solved: topicCounts.get(item.topic) || 0
  }));

  scored.sort((a, b) => a.solved - b.solved);
  return scored.slice(0, 5).map((item) => ({
    topic: item.topic,
    solved: item.solved,
    suggestion: `Practice more ${item.topic} problems`,
    url: `https://leetcode.com/problemset/?search=${encodeURIComponent(item.query)}`
  }));
}

function buildRevisionQueue(sortedEvents, todayKey) {
  const perProblem = new Map();
  for (const e of sortedEvents) {
    const curr = perProblem.get(e.slug);
    if (!curr) {
      perProblem.set(e.slug, {
        slug: e.slug,
        title: e.title,
        problemUrl: e.problemUrl,
        solutionPath: e.solutionPath,
        attempts: 1,
        lastDay: e.day
      });
    } else {
      curr.attempts += 1;
      curr.lastDay = e.day;
    }
  }

  const queue = [];
  for (const item of perProblem.values()) {
    const intervalDays = item.attempts >= 4 ? 7 : item.attempts === 3 ? 3 : item.attempts === 2 ? 1 : 0;
    const dueDate = addDaysIso(item.lastDay, intervalDays);
    const dueInDays = diffIsoDays(todayKey, dueDate);
    queue.push({
      slug: item.slug,
      title: item.title,
      problemUrl: item.problemUrl,
      solutionPath: item.solutionPath,
      attempts: item.attempts,
      nextReviewDate: dueDate,
      dueInDays,
      status: dueInDays <= 0 ? "due" : "upcoming"
    });
  }

  queue.sort((a, b) => a.dueInDays - b.dueInDays);
  return queue.slice(0, 25);
}

function addDaysIso(day, daysToAdd) {
  const d = new Date(`${day}T00:00:00.000Z`);
  d.setUTCDate(d.getUTCDate() + daysToAdd);
  return d.toISOString().slice(0, 10);
}

function diffIsoDays(fromDay, toDay) {
  const a = new Date(`${fromDay}T00:00:00.000Z`);
  const b = new Date(`${toDay}T00:00:00.000Z`);
  return Math.round((b.getTime() - a.getTime()) / 86400000);
}

function validateConfig(config) {
  if (!config.repoFullName || !config.repoFullName.includes("/")) {
    throw new Error("Invalid repo. Use owner/repo in extension options.");
  }
}

function getConfig() {
  return new Promise((resolve) => {
    chrome.storage.sync.get(DEFAULT_CONFIG, (saved) => resolve(saved));
  });
}

function parseOwnerRepo(repoFullName) {
  const [owner, repo] = repoFullName.split("/").map((part) => part.trim());
  if (!owner || !repo) {
    throw new Error("Repo must be in owner/repo format");
  }
  return { owner, repo };
}

function languageToExtension(lang) {
  const map = {
    "c++": "cpp",
    cpp: "cpp",
    c: "c",
    java: "java",
    javascript: "js",
    typescript: "ts",
    python: "py",
    python3: "py",
    csharp: "cs",
    "c#": "cs",
    golang: "go",
    go: "go",
    kotlin: "kt",
    swift: "swift",
    rust: "rs",
    ruby: "rb",
    scala: "scala",
    php: "php",
    dart: "dart",
    mysql: "sql",
    mssql: "sql",
    oraclesql: "sql"
  };
  return map[String(lang || "").toLowerCase()] || "txt";
}

function commentPrefixForLanguage(language) {
  const key = String(language || "").toLowerCase();
  const slashSlash = new Set([
    "c++", "cpp", "c", "java", "javascript", "typescript", "c#", "csharp", "golang", "go", "kotlin", "swift", "rust", "scala", "php", "dart"
  ]);
  const hash = new Set(["python", "python3", "ruby"]);
  const sql = new Set(["mysql", "mssql", "oraclesql"]);

  if (slashSlash.has(key)) return "//";
  if (hash.has(key)) return "#";
  if (sql.has(key)) return "--";
  return "//";
}

function buildCodeFile({ title, problemUrl, language, code }) {
  const marker = commentPrefixForLanguage(language);
  const header = [
    `${marker} Problem: ${title}`,
    `${marker} URL: ${problemUrl || "https://leetcode.com"}`,
    `${marker} Language: ${language}`,
    ""
  ].join("\n");
  return `${header}${code || ""}\n`;
}

async function upsertFileInGitHub({ token, owner, repo, branch, path, content, commitMessage }) {
  const existing = await getExistingFileInfo({ token, owner, repo, branch, path });
  if (existing && existing.content === content) {
    return { updated: false, path };
  }

  const url = `https://api.github.com/repos/${owner}/${repo}/contents/${encodeURIComponent(path).replace(/%2F/g, "/")}`;
  const body = { message: commitMessage, content: encodeBase64Utf8(content), branch };
  if (existing?.sha) body.sha = existing.sha;

  const response = await fetch(url, {
    method: "PUT",
    headers: {
      ...getGitHubApiHeaders(token),
      "Content-Type": "application/json"
    },
    body: JSON.stringify(body)
  });

  if (!response.ok) {
    const text = await response.text();
    throw new Error(`GitHub update failed (${response.status}): ${text}`);
  }

  return { updated: true, path };
}

async function getExistingFileInfo({ token, owner, repo, branch, path }) {
  const url = `https://api.github.com/repos/${owner}/${repo}/contents/${encodeURIComponent(path).replace(/%2F/g, "/")}?ref=${encodeURIComponent(branch)}`;
  const response = await fetch(url, {
    method: "GET",
    headers: getGitHubApiHeaders(token)
  });

  if (response.status === 404) {
    return null;
  }

  if (!response.ok) {
    const text = await response.text();
    throw new Error(`Failed to read existing file (${response.status}): ${text}`);
  }

  const json = await response.json();
  return {
    sha: json.sha || null,
    content: json.content ? decodeBase64Utf8(json.content) : null
  };
}

async function updateReadmeSections({ token, owner, repo, branch, indexEntry, analytics }) {
  const path = "README.md";
  const existing = await getExistingFileInfo({ token, owner, repo, branch, path });
  let current = existing?.content || "# LeetCode Solutions\n";

  current = upsertReadmeIndex(current, indexEntry);
  current = upsertReadmeAnalytics(current, analytics);

  const previous = existing?.content || "# LeetCode Solutions\n";
  if (current === previous) {
    return;
  }

  await upsertFileInGitHub({
    token,
    owner,
    repo,
    branch,
    path,
    content: current,
    commitMessage: `Update README stats: ${indexEntry.title}`
  });
}

function upsertReadmeIndex(readme, entry) {
  const existingEntries = parseReadmeIndexEntries(readme);
  const merged = new Map(existingEntries.map((item) => [item.path, item]));
  merged.set(entry.path, {
    title: entry.title,
    problemUrl: entry.problemUrl,
    language: entry.language,
    path: entry.path,
    updatedAt: entry.updatedAt
  });

  const entries = Array.from(merged.values()).sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
  const section = buildReadmeIndexSection(entries);
  const markerRegex = new RegExp(`${README_INDEX_START}[\\s\\S]*?${README_INDEX_END}`, "m");

  if (markerRegex.test(readme)) {
    return readme.replace(markerRegex, section);
  }

  const trimmed = readme.trimEnd();
  return `${trimmed}\n\n${section}\n`;
}

function parseReadmeIndexEntries(readme) {
  const markerRegex = new RegExp(`${README_INDEX_START}[\\s\\S]*?${README_INDEX_END}`, "m");
  const match = readme.match(markerRegex);
  if (!match) return [];

  const lines = match[0].split("\n");
  const rows = lines.filter((line) => line.startsWith("| ["));
  const entries = [];

  for (const row of rows) {
    const parts = row.split("|").map((part) => part.trim());
    if (parts.length < 6) continue;

    const problemMatch = parts[1].match(/^\[(.*)\]\((.*)\)$/);
    const pathMatch = parts[3].match(/^`(.*)`$/);
    if (!problemMatch || !pathMatch) continue;

    entries.push({
      title: problemMatch[1],
      problemUrl: problemMatch[2],
      language: parts[2],
      path: pathMatch[1],
      updatedAt: parts[4]
    });
  }

  return entries;
}

function buildReadmeIndexSection(entries) {
  const header = [
    README_INDEX_START,
    "## LeetCode Solutions Index",
    "",
    "| Problem | Language | File | Last Updated (UTC) |",
    "| --- | --- | --- | --- |"
  ];

  const rows = entries.map((entry) => {
    const safeTitle = escapeMd(entry.title);
    const safeUrl = entry.problemUrl || "https://leetcode.com";
    const safeLang = escapeMd(String(entry.language || "unknown"));
    const safePath = escapeMd(entry.path);
    const safeUpdated = escapeMd(entry.updatedAt);
    return `| [${safeTitle}](${safeUrl}) | ${safeLang} | \`${safePath}\` | ${safeUpdated} |`;
  });

  return [...header, ...rows, README_INDEX_END].join("\n");
}

function upsertReadmeAnalytics(readme, analytics) {
  const section = buildReadmeAnalyticsSection(analytics);
  const markerRegex = new RegExp(`${README_ANALYTICS_START}[\\s\\S]*?${README_ANALYTICS_END}`, "m");

  if (markerRegex.test(readme)) {
    return readme.replace(markerRegex, section);
  }

  const trimmed = readme.trimEnd();
  return `${trimmed}\n\n${section}\n`;
}

function buildReadmeAnalyticsSection(analytics) {
  const top = [
    README_ANALYTICS_START,
    "## Progress Analytics",
    "",
    `- Total accepted submissions: **${analytics.totalAcceptedSubmissions}**`,
    `- Unique problems solved: **${analytics.uniqueProblemsSolved}**`,
    `- Current daily streak: **${analytics.currentStreak}** day(s)`,
    `- Longest streak: **${analytics.longestStreak}** day(s)`,
    `- Solved today: **${analytics.solvedToday}**`,
    "",
    "### Last 7 Days",
    "",
    "| Date (UTC) | Accepted |",
    "| --- | --- |"
  ];

  const days = analytics.last7Days.map((d) => `| ${d.date} | ${d.count} |`);

  const langs = Object.entries(analytics.languageBreakdown || {});
  const langHeader = [
    "",
    "### Language Breakdown",
    "",
    "| Language | Count |",
    "| --- | --- |"
  ];
  const langRows = langs.length ? langs.map(([lang, count]) => `| ${escapeMd(lang)} | ${count} |`) : ["| n/a | 0 |"];

  const recHeader = [
    "",
    "### Recommended Next Practice",
    "",
    "| Topic | Solved | Suggested Action |",
    "| --- | --- | --- |"
  ];
  const recRows = (analytics.recommendations || []).map(
    (r) => `| [${escapeMd(r.topic)}](${r.url}) | ${r.solved} | ${escapeMd(r.suggestion)} |`
  );

  const revHeader = [
    "",
    "### Revision Queue",
    "",
    "| Problem | Next Review (UTC) | Status |",
    "| --- | --- | --- |"
  ];
  const revRows = (analytics.revisionQueue || [])
    .slice(0, 10)
    .map((r) => `| [${escapeMd(r.title)}](${r.problemUrl}) | ${r.nextReviewDate} | ${r.status} |`);

  return [...top, ...days, ...langHeader, ...langRows, ...recHeader, ...recRows, ...revHeader, ...revRows, README_ANALYTICS_END].join("\n");
}

function escapeMd(value) {
  return String(value || "").replace(/\|/g, "\\|");
}

function sanitizePathSegment(value) {
  return String(value || "")
    .trim()
    .toLowerCase()
    .replace(/\s+/g, "-")
    .replace(/[^a-z0-9._-]/g, "")
    .replace(/-+/g, "-")
    .replace(/^-|-$/g, "") || "unknown";
}

function trimSlashes(value) {
  return String(value || "").replace(/^\/+|\/+$/g, "");
}

function encodeBase64Utf8(value) {
  return btoa(unescape(encodeURIComponent(value)));
}

function decodeBase64Utf8(value) {
  const normalized = String(value || "").replace(/\n/g, "");
  return decodeURIComponent(escape(atob(normalized)));
}

function getGitHubApiHeaders(token) {
  return {
    Accept: "application/vnd.github+json",
    Authorization: `Bearer ${token}`
  };
}

function getGitHubToken() {
  return new Promise((resolve) => {
    chrome.storage.local.get([GITHUB_PAT_STORAGE_KEY], (saved) => {
      resolve(saved[GITHUB_PAT_STORAGE_KEY] || "");
    });
  });
}

async function requireGitHubToken() {
  const token = await getGitHubToken();
  if (!token) {
    throw new Error("Missing GitHub PAT. Set a Fine-grained PAT in extension options.");
  }
  return token;
}

function notify(title, message) {
  const iconUrl = chrome.runtime.getURL("assets/icons/icon128.png");
  chrome.notifications
    .create({
      type: "basic",
      iconUrl,
      title,
      message
    })
    .catch((error) => {
      console.warn("[LC2GH] Notification failed:", error);
    });
}
