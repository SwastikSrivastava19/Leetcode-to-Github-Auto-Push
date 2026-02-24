const defaults = {
  repoFullName: "",
  branch: "main",
  baseFolder: "leetcode"
};

const form = document.getElementById("settings-form");
const statusEl = document.getElementById("status");
const authStatusEl = document.getElementById("authStatus");
const clearPatBtn = document.getElementById("clearPat");
const testBtn = document.getElementById("testConnection");
const testPushBtn = document.getElementById("testPush");

init();

async function init() {
  const settings = await chrome.storage.sync.get(defaults);
  const local = await chrome.storage.local.get({ githubPatToken: "", githubOAuthToken: "" });
  const token = local.githubPatToken || local.githubOAuthToken || "";

  if (!local.githubPatToken && local.githubOAuthToken) {
    await chrome.storage.local.set({ githubPatToken: local.githubOAuthToken });
    await chrome.storage.local.remove(["githubOAuthToken", "githubOAuthTokenMeta"]);
  }

  document.getElementById("githubPatToken").value = token;
  document.getElementById("repoFullName").value = settings.repoFullName || "";
  document.getElementById("branch").value = settings.branch || "main";
  document.getElementById("baseFolder").value = settings.baseFolder || "leetcode";

  await chrome.storage.sync.remove(["githubClientId", "aiNotesEnabled", "aiModel"]);
  await chrome.storage.local.remove(["aiApiKey", "openaiApiKey"]);
  await refreshAuthStatus();
}

form.addEventListener("submit", async (event) => {
  event.preventDefault();
  await saveSettings();
  setStatus("Saved settings.");
  await refreshAuthStatus();
});

clearPatBtn.addEventListener("click", async () => {
  const res = await safeSendMessage({ type: "clear_github_pat" });
  if (!res?.ok) {
    setStatus(`Clear failed: ${res?.error || "Unknown error"}`);
    return;
  }

  document.getElementById("githubPatToken").value = "";
  setStatus("Cleared PAT.");
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
    ? `GitHub PAT valid${details.username ? ` as ${details.username}` : ""}`
    : "GitHub PAT not set/invalid";
}

async function saveSettings() {
  const payload = {
    repoFullName: String(document.getElementById("repoFullName").value || "").trim(),
    branch: String(document.getElementById("branch").value || "main").trim() || "main",
    baseFolder: String(document.getElementById("baseFolder").value || "leetcode").trim() || "leetcode"
  };

  await chrome.storage.sync.set(payload);
  await chrome.storage.local.set({
    githubPatToken: String(document.getElementById("githubPatToken").value || "").trim()
  });
  await chrome.storage.local.remove(["githubOAuthToken", "githubOAuthTokenMeta"]);
}

function setStatus(message) {
  statusEl.textContent = message;
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
