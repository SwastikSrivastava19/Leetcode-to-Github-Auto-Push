(() => {
  const pendingBySubmissionId = new Map();
  const emittedAcceptedSubmissions = new Set();
  let latestPendingMeta = null;

  function getProblemSlugFromUrl(urlValue) {
    try {
      const url = new URL(urlValue, location.origin);
      const match = url.pathname.match(/\/problems\/([^/]+)\//);
      return match ? match[1] : null;
    } catch {
      return null;
    }
  }

  function normalizeUrl(urlValue) {
    try {
      return new URL(urlValue, location.origin).href;
    } catch {
      return String(urlValue || "");
    }
  }

  function getCurrentTitle() {
    const candidates = [
      '[data-cy="question-title"]',
      "div.text-title-large a",
      "h4",
      "h1"
    ];

    for (const selector of candidates) {
      const element = document.querySelector(selector);
      const text = element?.textContent?.trim();
      if (text) {
        return text;
      }
    }

    return getProblemSlugFromUrl(location.href) || "unknown-problem";
  }

  function notifyAccepted(data) {
    if (!data || !data.submissionId) {
      return;
    }

    const submissionId = String(data.submissionId);
    if (emittedAcceptedSubmissions.has(submissionId)) {
      return;
    }

    emittedAcceptedSubmissions.add(submissionId);

    window.postMessage(
      {
        source: "lc2gh",
        type: "accepted_submission",
        data: { ...data, submissionId }
      },
      "*"
    );
  }

  function parseBody(body) {
    if (!body) {
      return null;
    }

    if (typeof body === "string") {
      try {
        return JSON.parse(body);
      } catch {
        return null;
      }
    }

    if (body instanceof URLSearchParams) {
      try {
        return JSON.parse(body.get("data") || "{}");
      } catch {
        return null;
      }
    }

    if (body instanceof FormData) {
      try {
        const data = body.get("data");
        return typeof data === "string" ? JSON.parse(data) : null;
      } catch {
        return null;
      }
    }

    if (typeof body === "object") {
      return body;
    }

    return null;
  }

  async function parseResponseJson(response) {
    try {
      return await response.clone().json();
    } catch {
      return null;
    }
  }

  async function extractRequestBody(input, init) {
    if (init?.body) {
      return init.body;
    }

    if (input instanceof Request) {
      try {
        const text = await input.clone().text();
        return text || null;
      } catch {
        return null;
      }
    }

    return null;
  }

  function extractSubmissionMeta(slug, parsedBody) {
    const safeSlug = slug || getProblemSlugFromUrl(location.href);
    if (!safeSlug || !parsedBody) {
      return null;
    }

    const typedCode = parsedBody.typed_code || parsedBody?.variables?.typedCode;
    const lang = parsedBody.lang || parsedBody?.variables?.lang;

    if (!typedCode || !lang) {
      return null;
    }

    return {
      slug: safeSlug,
      title: getCurrentTitle(),
      typedCode,
      lang,
      problemUrl: `${location.origin}/problems/${safeSlug}/`
    };
  }

  function maybeTrackRestSubmit(url, init, json) {
    if (!/\/problems\/[^/]+\/submit\/?/.test(url)) {
      return;
    }

    const submissionId = json?.submission_id || json?.submissionId;
    if (!submissionId) {
      return;
    }

    const slug = getProblemSlugFromUrl(url) || getProblemSlugFromUrl(location.href);
    const parsedBody = parseBody(init?.body);
    const meta = extractSubmissionMeta(slug, parsedBody);

    if (!meta) {
      return;
    }

    pendingBySubmissionId.set(String(submissionId), {
      submissionId: String(submissionId),
      ...meta
    });
    latestPendingMeta = {
      submissionId: String(submissionId),
      ...meta
    };
  }

  function maybeHandleRestCheck(url, json) {
    const checkMatch = url.match(/\/submissions\/detail\/(\d+)\/check\/?/);
    if (!checkMatch) {
      return;
    }

    const submissionId = String(checkMatch[1]);
    const status = String(json?.status_msg || json?.statusMsg || "");
    if (status !== "Accepted") {
      return;
    }

    const meta = pendingBySubmissionId.get(submissionId);
    const fallbackMeta = latestPendingMeta?.submissionId === submissionId ? latestPendingMeta : null;
    const finalMeta = meta || fallbackMeta;
    if (!finalMeta) {
      return;
    }

    notifyAccepted(finalMeta);
    pendingBySubmissionId.delete(submissionId);
    if (latestPendingMeta?.submissionId === submissionId) {
      latestPendingMeta = null;
    }
  }

  function maybeHandleGraphql(url, init, json) {
    if (!url.includes("/graphql")) {
      return;
    }

    const parsedBody = parseBody(init?.body);
    const operationName = parsedBody?.operationName || "";

    if (operationName.toLowerCase().includes("submit")) {
      const submissionId =
        json?.data?.submitQuestion?.submissionId ||
        json?.data?.submitQuestion?.submission_id ||
        json?.data?.submitSolution?.submissionId ||
        json?.data?.submitSolution?.submission_id;

      if (!submissionId) {
        return;
      }

      const slug =
        parsedBody?.variables?.questionSlug ||
        parsedBody?.variables?.titleSlug ||
        getProblemSlugFromUrl(location.href);

      const meta = extractSubmissionMeta(slug, parsedBody?.variables || parsedBody);
      if (!meta) {
        return;
      }

      pendingBySubmissionId.set(String(submissionId), {
        submissionId: String(submissionId),
        ...meta
      });
      latestPendingMeta = {
        submissionId: String(submissionId),
        ...meta
      };
      return;
    }

    if (operationName.toLowerCase().includes("check")) {
      const submissionId =
        String(parsedBody?.variables?.submissionId || "") ||
        String(json?.data?.checkSubmission?.submissionId || "");

      if (!submissionId) {
        return;
      }

      const status = String(
        json?.data?.checkSubmission?.statusMsg ||
          json?.data?.submissionResult?.statusMsg ||
          ""
      );

      if (status !== "Accepted") {
        return;
      }

      const meta = pendingBySubmissionId.get(submissionId);
      const fallbackMeta = latestPendingMeta?.submissionId === submissionId ? latestPendingMeta : null;
      const finalMeta = meta || fallbackMeta;
      if (!finalMeta) {
        return;
      }

      notifyAccepted(finalMeta);
      pendingBySubmissionId.delete(submissionId);
      if (latestPendingMeta?.submissionId === submissionId) {
        latestPendingMeta = null;
      }
    }
  }

  function processRequestResult(url, init, json) {
    maybeTrackRestSubmit(url, init, json);
    maybeHandleRestCheck(url, json);
    maybeHandleGraphql(url, init, json);
  }

  const originalFetch = window.fetch;
  window.fetch = async function patchedFetch(input, init) {
    const response = await originalFetch.call(this, input, init);

    try {
      const url = normalizeUrl(typeof input === "string" ? input : input?.url || "");
      if (!url.includes("leetcode.com")) {
        return response;
      }

      const json = await parseResponseJson(response);
      if (!json) {
        return response;
      }

      const body = await extractRequestBody(input, init);
      processRequestResult(url, { ...(init || {}), body }, json);
    } catch (error) {
      console.warn("[LC2GH] fetch patch error:", error);
    }

    return response;
  };

  const originalXhrOpen = XMLHttpRequest.prototype.open;
  const originalXhrSend = XMLHttpRequest.prototype.send;

  XMLHttpRequest.prototype.open = function patchedOpen(method, url, ...rest) {
    this.__lc2gh = { method, url: normalizeUrl(url), body: null };
    return originalXhrOpen.call(this, method, url, ...rest);
  };

  XMLHttpRequest.prototype.send = function patchedSend(body) {
    if (this.__lc2gh) {
      this.__lc2gh.body = body;
    }

    this.addEventListener("load", function onLoad() {
      try {
        const url = this.__lc2gh?.url || "";
        if (!url.includes("leetcode.com")) {
          return;
        }

        const json = JSON.parse(this.responseText || "null");
        const init = { body: this.__lc2gh?.body };
        processRequestResult(url, init, json);
      } catch {
      }
    });

    return originalXhrSend.call(this, body);
  };
})();
