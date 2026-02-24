const DEFAULT_CONFIG = {
  repoFullName: "",
  branch: "main",
  baseFolder: "leetcode"
};

const GITHUB_PAT_STORAGE_KEY = "githubPatToken";
const LEGACY_OAUTH_TOKEN_STORAGE_KEY = "githubOAuthToken";
const LEGACY_OAUTH_META_STORAGE_KEY = "githubOAuthTokenMeta";
const ANALYTICS_EVENTS_STORAGE_KEY = "lc2ghAnalyticsEvents";

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

  const solutionUpdated = Boolean(solutionResult.updated);

  await deleteFileInGitHubIfExists({
    token,
    owner: ownerRepo.owner,
    repo: ownerRepo.repo,
    branch: config.branch,
    path: `${problemDir}/meta.json`,
    commitMessage: `Cleanup legacy file: ${title} (${slug})`
  });

  await deleteFileInGitHubIfExists({
    token,
    owner: ownerRepo.owner,
    repo: ownerRepo.repo,
    branch: config.branch,
    path: `${problemDir}/notes.md`,
    commitMessage: `Cleanup legacy file: ${title} (${slug})`
  });

  const revisionPlanPath = folder ? `${folder}/analytics/revision-plan.md` : "analytics/revision-plan.md";
  await deleteFileInGitHubIfExists({
    token,
    owner: ownerRepo.owner,
    repo: ownerRepo.repo,
    branch: config.branch,
    path: revisionPlanPath,
    commitMessage: `Cleanup legacy revision plan: ${title} (${slug})`
  });

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
    title,
    analytics
  });

  notify("LeetCode to GitHub", `Pushed: ${title}`);
  return {
    status: solutionUpdated ? "pushed" : "solution_unchanged_analytics_updated",
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
  const day = getLocalDayKey(new Date(event.timestamp));
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

  const today = getLocalDayKey(new Date());
  const currentStreak = computeCurrentStreak(dayCounts, today);
  const longestStreak = computeLongestStreak(dayCounts);
  const last7Days = buildLast7Days(dayCounts);
  const recentProblems = buildRecentProblems(sorted);

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
    recentProblems
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
    d.setDate(today.getDate() - i);
    const key = getLocalDayKey(d);
    out.push({ date: key, count: dayCounts.get(key) || 0 });
  }
  return out;
}

function computeCurrentStreak(dayCounts, todayKey) {
  let streak = 0;
  let key = todayKey;
  while (true) {
    if (!dayCounts.get(key)) break;
    streak += 1;
    key = addDaysIso(key, -1);
  }
  return streak;
}

function computeLongestStreak(dayCounts) {
  const days = [...dayCounts.keys()].sort();
  if (days.length === 0) return 0;

  let longest = 1;
  let current = 1;

  for (let i = 1; i < days.length; i += 1) {
    const expected = addDaysIso(days[i - 1], 1);

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

function addDaysIso(day, daysToAdd) {
  const [year, month, date] = String(day).split("-").map(Number);
  const d = new Date(Date.UTC(year, (month || 1) - 1, date || 1));
  d.setUTCDate(d.getUTCDate() + daysToAdd);
  return d.toISOString().slice(0, 10);
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

async function deleteFileInGitHubIfExists({ token, owner, repo, branch, path, commitMessage }) {
  const existing = await getExistingFileInfo({ token, owner, repo, branch, path });
  if (!existing?.sha) {
    return false;
  }

  const url = `https://api.github.com/repos/${owner}/${repo}/contents/${encodeURIComponent(path).replace(/%2F/g, "/")}`;
  const response = await fetch(url, {
    method: "DELETE",
    headers: {
      ...getGitHubApiHeaders(token),
      "Content-Type": "application/json"
    },
    body: JSON.stringify({
      message: commitMessage,
      sha: existing.sha,
      branch
    })
  });

  if (!response.ok) {
    const text = await response.text();
    throw new Error(`GitHub delete failed (${response.status}): ${text}`);
  }

  return true;
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

async function updateReadmeSections({ token, owner, repo, branch, title, analytics }) {
  const path = "README.md";
  const existing = await getExistingFileInfo({ token, owner, repo, branch, path });
  let current = existing?.content || "# LeetCode Solutions\n";

  current = removeReadmeIndexSection(current);
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
    commitMessage: `Update README stats: ${title}`
  });
}

function removeReadmeIndexSection(readme) {
  // Backward cleanup for old versions that added a large index table.
  const markerRegex = /(?:\n{0,2})<!-- LC2GH_INDEX_START -->[\s\S]*?<!-- LC2GH_INDEX_END -->(?:\n{0,2})/m;
  return readme.replace(markerRegex, "\n\n").replace(/\n{3,}/g, "\n\n").trimEnd() + "\n";
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
    "| Date | Accepted |",
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

  return [...top, ...days, ...langHeader, ...langRows, README_ANALYTICS_END].join("\n");
}

function getLocalDayKey(date) {
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, "0");
  const day = String(date.getDate()).padStart(2, "0");
  return `${year}-${month}-${day}`;
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
