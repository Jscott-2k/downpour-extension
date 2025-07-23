const ICON_PATH = "icons/48.png";
let lastStatus = {};
let UNCHECKABLE_DOMAINS = [];

// Load uncheckable domains from storage
chrome.storage.local.get(["uncheckableDomains"], (data) => {
  UNCHECKABLE_DOMAINS = data.uncheckableDomains || [];
});

/**
 * Adds a hostname to the persistent list of uncheckable domains.
 * @param {string} rawHostname
 */
function addToUncheckableDomains(rawHostname) {
  let hostname;

  try {
    const url = new URL(rawHostname);
    if (!["http:", "https:"].includes(url.protocol)) {
      throw new Error("Unsupported URL scheme");
    }
    hostname = url.hostname.trim();
  } catch {
    hostname = rawHostname.trim();
  }

  if (!hostname || UNCHECKABLE_DOMAINS.includes(hostname)) return;

  UNCHECKABLE_DOMAINS.push(hostname);
  chrome.storage.local.set({ uncheckableDomains: UNCHECKABLE_DOMAINS });

  chrome.notifications.create(`uncheckable-${hostname}`, {
    type: "basic",
    iconUrl: ICON_PATH,
    title: "Domain Marked as Unsupported",
    message: `${hostname} has been added to the list of unsupported domains. Status checks will be skipped.`,
  });
}

/**
 * Retrieves the user's saved sites.
 * @returns {Promise<Array<{ name: string, url: string }>>}
 */
function getSites() {
  return new Promise((resolve) => {
    chrome.storage.sync.get(["sites"], (data) => {
      resolve(data.sites || []);
    });
  });
}

/**
 * Attempts a HEAD request to check site status.
 * @param {{ name: string, url: string }} site
 * @returns {Promise<'up' | 'down' | 'unsupported'>}
 */
async function checkSiteViaFetch(site) {
  try {
    const url = new URL(site.url);
    const unsupportedProtocols = ["chrome:", "about:", "file:", "edge:"];

    if (unsupportedProtocols.includes(url.protocol)) {
      return "unsupported";
    }

    const response = await fetch(site.url, {
      method: "HEAD",
      cache: "no-store",
    });

    return response.ok ? "up" : "down";
  } catch (error) {
    if (
      error instanceof TypeError &&
      (error.message.includes("Failed to fetch") ||
        error.message.includes("No 'Access-Control-Allow-Origin'"))
    ) {
      console.warn(`CORS or network issue for ${site.url}: ${error.message}`);
      return "unsupported";
    }

    console.error(`Error checking site ${site.url}:`, error);
    return "down";
  }
}

/**
 * Checks site availability via content script as a fallback.
 * @param {string} url
 * @returns {Promise<'up' | 'down' | 'unsupported'>}
 */
async function checkSiteViaContentScript(url) {
  return new Promise((resolve) => {
    chrome.tabs.query({ url: `${url}/*` }, (tabs) => {
      const validTab = tabs.find((tab) => {
        try {
          const tabUrl = new URL(tab.url);
          return (
            ["http:", "https:"].includes(tabUrl.protocol) &&
            !tabUrl.href.startsWith("chrome://") &&
            !tabUrl.href.startsWith("edge://") &&
            !tabUrl.href.startsWith("about:") &&
            !tabUrl.href.startsWith("chrome-error://")
          );
        } catch {
          return false;
        }
      });

      if (!validTab) {
        resolve("down");
        return;
      }

      chrome.scripting.executeScript(
        {
          target: { tabId: validTab.id },
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

          resolve(results?.[0]?.result || "down");
        }
      );
    });
  });
}

/**
 * Checks a single site with fallback methods and persistence.
 * @param {{ name: string, url: string }} site
 * @returns {Promise<'up' | 'down' | 'unsupported'>}
 */
async function checkSite(site) {
  let urlObj;
  try {
    urlObj = new URL(site.url);
    if (UNCHECKABLE_DOMAINS.includes(urlObj.hostname)) {
      console.warn(`Skipping unsupported domain: ${urlObj.hostname}`);
      return "unsupported";
    }

    const unsupportedProtocols = ["chrome:", "about:", "file:", "edge:"];

    if (unsupportedProtocols.includes(urlObj.protocol)) {
      addToUncheckableDomains(urlObj.hostname);
      return "unsupported";
    }
  } catch {
    // If URL is malformed
    return "unsupported";
  }

  const fetchStatus = await checkSiteViaFetch(site);
  if (fetchStatus !== "unsupported") return fetchStatus;

  const fallbackStatus = await checkSiteViaContentScript(site.url);

  if (fallbackStatus === "unsupported") {
    addToUncheckableDomains(urlObj.hostname);
  }

  return fallbackStatus;
}

/**
 * Runs a check across all saved sites and updates local state.
 */
async function checkAllSites() {
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
 * Immediately checks a single site.
 * @param {string} siteUrl
 * @returns {Promise<{ success: boolean, status?: string, error?: string }>}
 */
async function checkSiteNow(siteUrl) {
  const sites = await getSites();
  const site = sites.find((s) => s.url === siteUrl);
  if (!site) return { success: false, error: "Site not found" };

  const currentStatus = await checkSite(site);
  const previousStatus = lastStatus[site.url];
  lastStatus[site.url] = currentStatus;

  if (previousStatus === "down" && currentStatus === "up") {
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

// Periodic checking setup
chrome.runtime.onStartup.addListener(() => {
  chrome.alarms.create("periodicCheck", { periodInMinutes: 5 });
});

chrome.alarms.onAlarm.addListener((alarm) => {
  if (alarm.name === "periodicCheck") {
    checkAllSites();
  }
});

// Message handling
chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message.action === "checkAllSites") {
    checkAllSites().then(() => sendResponse({ success: true }));
    return true;
  }

  if (message.action === "checkSiteNow" && message.url) {
    checkSiteNow(message.url).then(sendResponse);
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
