const INJECTED_SCRIPT_ID = "lc2gh-page-bridge";
const TOAST_ID = "lc2gh-toast";

function injectBridgeScript() {
  if (!isRuntimeAvailable()) {
    return;
  }

  if (document.getElementById(INJECTED_SCRIPT_ID)) {
    return;
  }

  const script = document.createElement("script");
  script.id = INJECTED_SCRIPT_ID;
  script.src = chrome.runtime.getURL("src/injected.js");
  script.async = false;
  (document.head || document.documentElement).appendChild(script);
  script.onload = () => script.remove();
}

window.addEventListener("message", async (event) => {
  if (event.source !== window) {
    return;
  }

  const payload = event.data;
  if (!payload || payload.source !== "lc2gh" || payload.type !== "accepted_submission") {
    return;
  }

  try {
    const response = await safeSendMessage({
      type: "accepted_submission",
      data: payload.data
    });

    if (!response?.ok) {
      showToast(`GitHub push failed: ${response?.error || "Unknown error"}`, "error");
      return;
    }

    const status = response?.result?.status;
    if (status === "pushed") {
      const streak = Number(response?.result?.currentStreak || 0);
      const uniqueSolved = Number(response?.result?.uniqueSolved || 0);
      showToast(`Code pushed. Streak: ${streak} day(s). Unique solved: ${uniqueSolved}.`, "success");
      return;
    }

    if (status === "skipped_unchanged") {
      showToast("No changes detected. Skipped GitHub commit.", "info");
      return;
    }
  } catch (error) {
    if (isContextInvalidated(error)) {
      showToast("Extension updated. Refresh this tab once.", "info");
      return;
    }
    console.error("[LC2GH] Failed to send message to background:", error);
    showToast(`GitHub push failed: ${error.message}`, "error");
  }
});

injectBridgeScript();

function showToast(message, kind = "info") {
  let toast = document.getElementById(TOAST_ID);
  if (!toast) {
    toast = document.createElement("div");
    toast.id = TOAST_ID;
    toast.style.position = "fixed";
    toast.style.top = "20px";
    toast.style.right = "20px";
    toast.style.zIndex = "2147483647";
    toast.style.padding = "10px 14px";
    toast.style.borderRadius = "8px";
    toast.style.fontSize = "13px";
    toast.style.fontWeight = "600";
    toast.style.color = "#fff";
    toast.style.boxShadow = "0 8px 20px rgba(0,0,0,0.25)";
    toast.style.transition = "opacity 0.2s ease";
    document.documentElement.appendChild(toast);
  }

  toast.textContent = message;
  toast.style.background = kind === "success" ? "#0f7b53" : kind === "error" ? "#b42318" : "#1d4f8f";
  toast.style.opacity = "1";

  window.clearTimeout(showToast.__timer);
  showToast.__timer = window.setTimeout(() => {
    const active = document.getElementById(TOAST_ID);
    if (active) {
      active.style.opacity = "0";
    }
  }, 3500);
}

function isRuntimeAvailable() {
  return Boolean(chrome?.runtime?.id);
}

function isContextInvalidated(error) {
  return String(error?.message || "").toLowerCase().includes("context invalidated");
}

async function safeSendMessage(message) {
  if (!isRuntimeAvailable()) {
    throw new Error("Extension context invalidated");
  }
  return chrome.runtime.sendMessage(message);
}
