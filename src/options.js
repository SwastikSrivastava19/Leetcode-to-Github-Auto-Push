const defaults = {
  repoFullName: "",
  branch: "main",
  baseFolder: "leetcode",
  githubClientId: ""
};

const form = document.getElementById("settings-form");
const statusEl = document.getElementById("status");
const authStatusEl = document.getElementById("authStatus");
const connectBtn = document.getElementById("connectGithub");
const logoutBtn = document.getElementById("logoutGithub");
const testBtn = document.getElementById("testConnection");
const testPushBtn = document.getElementById("testPush");

init();

async function init() {
  const settings = await chrome.storage.sync.get(defaults);
  document.getElementById("githubClientId").value = settings.githubClientId || "";
  document.getElementById("repoFullName").value = settings.repoFullName || "";
  document.getElementById("branch").value = settings.branch || "main";
  document.getElementById("baseFolder").value = settings.baseFolder || "leetcode";

  await chrome.storage.sync.remove(["aiNotesEnabled", "aiModel"]);
  await chrome.storage.local.remove(["aiApiKey", "openaiApiKey"]);
  await refreshAuthStatus();
}

form.addEventListener("submit", async (event) => {
  event.preventDefault();
  await saveSettings();
  setStatus("Saved settings.");
});

connectBtn.addEventListener("click", async () => {
  await saveSettings();
  setStatus("Starting GitHub OAuth device flow...");

  const start = await safeSendMessage({ type: "start_github_device_flow" });
  if (!start?.ok) {
    setStatus(`OAuth start failed: ${start?.error || "Unknown error"}`);
    return;
  }

  const details = start.details;
  const url = details.verificationUriComplete || details.verificationUri;
  if (url) {
    window.open(url, "_blank", "noopener,noreferrer");
  }

  setStatus(`Authorize in GitHub using code: ${details.userCode}`);

  let intervalMs = Math.max(3, Number(details.interval || 5)) * 1000;
  const deadline = Date.now() + Math.max(60, Number(details.expiresIn || 900)) * 1000;

  while (Date.now() < deadline) {
    await delay(intervalMs);

    const poll = await safeSendMessage({
      type: "poll_github_device_flow",
      deviceCode: details.deviceCode
    });

    if (!poll?.ok) {
      setStatus(`OAuth poll failed: ${poll?.error || "Unknown error"}`);
      return;
    }

    const result = poll.result;
    if (result.status === "pending") {
      continue;
    }

    if (result.status === "slow_down") {
      intervalMs += 5000;
      continue;
    }

    if (result.status === "authorized") {
      setStatus(`GitHub connected${result.username ? ` as ${result.username}` : ""}.`);
      await refreshAuthStatus();
      return;
    }

    setStatus(`OAuth failed: ${result.message || result.status}`);
    await refreshAuthStatus();
    return;
  }

  setStatus("OAuth timed out. Start connect again.");
});

logoutBtn.addEventListener("click", async () => {
  const res = await safeSendMessage({ type: "logout_github" });
  if (!res?.ok) {
    setStatus(`Logout failed: ${res?.error || "Unknown error"}`);
    return;
  }

  setStatus("GitHub disconnected.");
  await refreshAuthStatus();
});

testBtn.addEventListener("click", async () => {
  await saveSettings();
  setStatus("Testing GitHub connection...");

  const response = await safeSendMessage({ type: "test_github_connection" });
  if (!response?.ok) {
    setStatus(`Connection failed: ${response?.error || "Unknown error"}`);
    return;
  }

  setStatus(`Connected to ${response.details.repo} (${response.details.branch})`);
});

testPushBtn.addEventListener("click", async () => {
  await saveSettings();
  setStatus("Testing GitHub push...");

  const response = await safeSendMessage({ type: "test_github_push" });
  if (!response?.ok) {
    setStatus(`Push failed: ${response?.error || "Unknown error"}`);
    return;
  }

  setStatus(`Push ok: ${response.details.path}`);
});

async function refreshAuthStatus() {
  const response = await safeSendMessage({ type: "get_auth_status" });
  if (!response?.ok) {
    authStatusEl.textContent = `Auth status error: ${response?.error || "Unknown error"}`;
    return;
  }

  const details = response.details;
  authStatusEl.textContent = details.authenticated
    ? `GitHub: connected${details.username ? ` as ${details.username}` : ""}`
    : "GitHub: not connected";
}

async function saveSettings() {
  const payload = {
    githubClientId: String(document.getElementById("githubClientId").value || "").trim(),
    repoFullName: String(document.getElementById("repoFullName").value || "").trim(),
    branch: String(document.getElementById("branch").value || "main").trim() || "main",
    baseFolder: String(document.getElementById("baseFolder").value || "leetcode").trim() || "leetcode"
  };

  await chrome.storage.sync.set(payload);
}

function setStatus(message) {
  statusEl.textContent = message;
}

function delay(ms) {
  return new Promise((resolve) => window.setTimeout(resolve, ms));
}

async function safeSendMessage(message) {
  try {
    if (!chrome?.runtime?.id) {
      throw new Error("Extension context invalidated");
    }
    return await chrome.runtime.sendMessage(message);
  } catch (error) {
    if (String(error?.message || "").toLowerCase().includes("context invalidated")) {
      setStatus("Extension was reloaded. Reopen this options page.");
      return { ok: false, error: "Extension context invalidated" };
    }
    throw error;
  }
}
