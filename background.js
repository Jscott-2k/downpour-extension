// Initialize or load persistent list of uncheckable domains
let UNCHECKABLE_DOMAINS = [];

chrome.storage.local.get(["uncheckableDomains"], (data) => {
  UNCHECKABLE_DOMAINS = data.uncheckableDomains || [];
});

const ICON_PATH = "icons/48.png";
let lastStatus = {};

/**
 * Persistently adds a hostname to the uncheckable domains list.
 * @param {string} rawHostname
 */
function addToUncheckableDomains(rawHostname) {
  let hostname;

  try {
    const url = new URL(rawHostname);
    // Skip unsupported schemes (like chrome://)
    if (!["http:", "https:"].includes(url.protocol)) {
      throw new Error("Unsupported URL scheme");
    }
    hostname = url.hostname.trim();
  } catch {
    // fallback: extract manually, or treat as a plain hostname
    hostname = rawHostname.trim();
  }

  if (!hostname || UNCHECKABLE_DOMAINS.includes(hostname)) return;

  UNCHECKABLE_DOMAINS.push(hostname);
  chrome.storage.local.set({ uncheckableDomains: UNCHECKABLE_DOMAINS });

  chrome.notifications.create(`uncheckable-${hostname}`, {
    type: "basic",
    iconUrl: ICON_PATH,
    title: "Domain Marked as Unsupported",
    message: `${hostname} has been added to the list of unsupported domains. Status checks will be skipped due to browser limitations.`,
  });
}

/**
 * Retrieves user-defined sites from Chrome sync storage.
 * @returns {Promise<Array<{ name: string, url: string }>>}
 */
async function getSites() {
  return new Promise((resolve) => {
    chrome.storage.sync.get(["sites"], (data) => {
      resolve(data.sites || []);
    });
  });
}

/**
 * Attempts to check site status via a HEAD request.
 * @param {{ name: string, url: string }} site
 * @returns {Promise<'up' | 'down' | 'unsupported'>}
 */
async function checkSiteViaFetch(site) {
  try {
    const url = new URL(site.url);

    // Skip unsupported URL schemes (e.g., chrome://)
    const unsupportedProtocols = ["chrome:", "about:", "file:"];
    if (unsupportedProtocols.includes(url.protocol)) {
      return "unsupported";
    }

    const response = await fetch(site.url, {
      method: "HEAD",
      cache: "no-store",
    });

    return response.ok ? "up" : "down";
  } catch (error) {
    // Handle CORS and network errors gracefully
    if (
      error instanceof TypeError &&
      (error.message.includes("Failed to fetch") ||
        error.message.includes("No 'Access-Control-Allow-Origin'"))
    ) {
      console.warn(
        `CORS or network issue accessing ${site.url}: ${error.message}`
      );
      return "unsupported";
    }

    // Default to 'down' on other errors
    console.error(`Error checking site ${site.url}:`, error);
    return "down";
  }
}

/**
 * Uses the scripting API to run a fetch within an open tab context to bypass CORS.
 * @param {string} url - Origin URL (e.g. "https://example.com")
 * @returns {Promise<'up' | 'down' | 'unsupported'>}
 */
async function checkSiteViaContentScript(url) {
  return new Promise((resolve) => {
    chrome.tabs.query({ url: `${url}/*` }, (tabs) => {
      if (!tabs.length) {
        resolve("down");
        return;
      }

      // Filter out tabs with restricted URLs (chrome://, file://, etc.)
      const allowedTab = tabs.find((tab) => {
        try {
          const tabUrl = new URL(tab.url);
          if (tabUrl.protocol !== "http:" && tabUrl.protocol !== "https:") {
            return false;
          }
          // Exclude known error page URLs
          if (
            tab.url.startsWith("chrome-error://") ||
            tab.url.startsWith("chrome://") ||
            tab.url.startsWith("about:")
          ) {
            return false;
          }
          return true;
        } catch {
          return false;
        }
      });

      if (!allowedTab) {
        // No accessible or valid tab found
        resolve("down");
        return;
      }

      chrome.scripting.executeScript(
        {
          target: { tabId: allowedTab.id },
          func: async () => {
            try {
              const resp = await fetch(window.location.origin, {
                method: "GET",
                credentials: "include",
                cache: "no-store",
              });
              return resp.ok ? "up" : "down";
            } catch (err) {
              if (
                err.message.includes("Failed to fetch") ||
                err.message.includes("Access-Control-Allow-Origin")
              ) {
                return "unsupported";
              }
              return "down";
            }
          },
        },
        (results) => {
          if (chrome.runtime.lastError) {
            console.error("Scripting error:", chrome.runtime.lastError.message);
            resolve("unsupported");
            return;
          }
          if (!results || !results.length) {
            resolve("down");
            return;
          }
          resolve(results[0].result);
        }
      );
    });
  });
}

/**
 * Checks a single site's status using fetch, with fallback and persistent unsupported tracking.
 * @param {{ name: string, url: string }} site
 * @returns {Promise<'up' | 'down' | 'unsupported'>}
 */
async function checkSite(site) {
  try {
    const urlObj = new URL(site.url);
    if (UNCHECKABLE_DOMAINS.includes(urlObj.hostname)) {
      console.warn(`Skipping check for unsupported domain: ${urlObj.hostname}`);
      return "unsupported";
    }
  } catch {
    // Proceed even if URL parsing fails
  }

  const fetchStatus = await checkSiteViaFetch(site);
  if (fetchStatus !== "unsupported") {
    return fetchStatus;
  }

  const contentScriptStatus = await checkSiteViaContentScript(site.url);

  if (contentScriptStatus === "unsupported") {
    try {
      const hostname = new URL(site.url).hostname;
      addToUncheckableDomains(hostname);
    } catch {
      // Ignore errors parsing hostname here
    }
  }

  return contentScriptStatus;
}

/**
 * Checks all stored sites and updates statuses, sending notifications on status recovery.
 */
async function checkAllSites() {
  // Load last known statuses from storage first
  const stored = await new Promise((resolve) =>
    chrome.storage.local.get(["siteStatuses"], resolve)
  );
  lastStatus = stored.siteStatuses || {};

  const sites = await getSites();
  const updatedStatus = {};

  for (const site of sites) {
    const currentStatus = await checkSite(site);
    const prevStatus = lastStatus[site.url];
    updatedStatus[site.url] = currentStatus;

    if (prevStatus === "down" && currentStatus === "up") {
      chrome.notifications.create(`${site.url}-recovery`, {
        type: "basic",
        iconUrl: ICON_PATH,
        title: `${site.name} is back ONLINE`,
        message: `${site.name} has recovered and is reachable again.`,
      });
    }
  }

  lastStatus = updatedStatus;
  chrome.storage.local.set({ siteStatuses: updatedStatus });
}

/**
 * Immediately checks a specific site's status by URL.
 * @param {string} siteUrl
 * @returns {Promise<{ success: boolean, status?: string, error?: string }>}
 */
async function checkSiteNow(siteUrl) {
  const sites = await getSites();
  const site = sites.find((s) => s.url === siteUrl);
  if (!site) return { success: false, error: "Site not found" };

  const currentStatus = await checkSite(site);
  const prevStatus = lastStatus[site.url];
  lastStatus[site.url] = currentStatus;

  if (
    prevStatus !== currentStatus &&
    currentStatus === "up" &&
    prevStatus === "down"
  ) {
    chrome.notifications.create(`${site.url}-recovery`, {
      type: "basic",
      iconUrl: ICON_PATH,
      title: `${site.name} is back ONLINE`,
      message: `${site.name} has recovered and is reachable again.`,
    });
  }

  chrome.storage.local.set({ siteStatuses: lastStatus });
  return { success: true, status: currentStatus };
}

// Initialize periodic checks on startup and installation
chrome.runtime.onStartup.addListener(() => {
  chrome.alarms.create("periodicCheck", { periodInMinutes: 5 });
});

// Alarm event listener triggers periodic site status checks
chrome.alarms.onAlarm.addListener((alarm) => {
  if (alarm.name === "periodicCheck") {
    checkAllSites();
  }
});

// Handle messages from popup or content scripts
chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message.action === "checkAllSites") {
    checkAllSites().then(() => sendResponse({ success: true }));
    return true; // Keep message channel open for async response
  }

  if (message.action === "checkSiteNow" && message.url) {
    checkSiteNow(message.url).then((result) => sendResponse(result));
    return true;
  }

  if (message.action === "notifySiteAdded" && message.hostname) {
    chrome.notifications.create(`site-added-${message.hostname}`, {
      type: "basic",
      iconUrl: ICON_PATH,
      title: "Site Added",
      message: `${message.hostname} has been added to your watch list.`,
    });
  }
});
