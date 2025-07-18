const siteListEl = document.getElementById("siteList");
const siteInput = document.getElementById("siteInput");
const currentSiteStatusEl = document.getElementById("currentSiteStatus");
const siteForm = document.getElementById("siteForm");
const toggleSitesBtn = document.getElementById("toggleSitesBtn");
const addCurrentSiteBtn = document.getElementById("addCurrentSiteBtn");
const currentTabUrlEl = document.getElementById("currentTabUrl");
const checkNowBtn = document.getElementById("checkNowBtn");
const eyeIcon = document.getElementById("eyeIcon");
const watchedSitesWrapper = document.getElementById("watchedSitesWrapper");

/**
 * Updates the displayed status message for the current site or general feedback.
 * @param {string} status - Status message or indicator ('up', 'down', 'unsupported', 'unknown', or custom).
 */
function updateCurrentSiteStatus(status) {
  switch (status) {
    case "up":
      currentSiteStatusEl.textContent = "✅ Current site is UP";
      currentSiteStatusEl.style.color = "#0078d4"; // Blue
      break;
    case "down":
      currentSiteStatusEl.textContent = "⚠️ Current site appears DOWN";
      currentSiteStatusEl.style.color = "#d9534f"; // Red
      break;
    case "unsupported":
      currentSiteStatusEl.textContent =
        "⚠️ Status cannot be checked due to browser restrictions.";
      currentSiteStatusEl.style.color = "#6c757d"; // Gray
      break;
    case "unknown":
    case "":
    case null:
    case undefined:
      currentSiteStatusEl.textContent = "Status unknown";
      currentSiteStatusEl.style.color = "#6c757d"; // Gray
      break;
    default:
      currentSiteStatusEl.textContent = status;
      currentSiteStatusEl.style.color = "#6c757d"; // Gray
      break;
  }
}

/**
 * Renders the list of saved sites along with their statuses.
 * @param {Array} sites - Array of site objects { name, url }.
 * @param {Object} statuses - Map of site URLs to status strings ('up', 'down', etc.).
 */
function renderSiteList(sites, statuses = {}) {
  siteListEl.innerHTML = "";

  if (!sites.length) {
    siteListEl.textContent = "No sites added yet.";
    return;
  }

  sites.forEach((site, index) => {
    const siteDiv = document.createElement("div");
    const status = statuses[site.url] || "unknown";

    // Create span to hold URL text with scrolling style
    const urlSpan = document.createElement("span");
    urlSpan.classList.add("site-url");
    urlSpan.textContent = site.url;

    let color;
    if (status === "down") color = "#d9534f";
    else if (status === "up") color = "#28a745";
    else if (status === "unsupported") color = "#918d0cff";
    else color = "#6c757d";

    urlSpan.style.color = color;
    urlSpan.style.fontWeight = status === "down" ? "700" : "400";
    urlSpan.title = `Status: ${status.toUpperCase()}`;

    const deleteBtn = document.createElement("button");
    deleteBtn.textContent = "Delete";
    deleteBtn.setAttribute("aria-label", `Delete site ${site.name}`);
    deleteBtn.classList.add("delete-btn");
    deleteBtn.addEventListener("click", () => removeSite(index));

    siteDiv.appendChild(urlSpan);
    siteDiv.appendChild(deleteBtn);
    siteListEl.appendChild(siteDiv);
  });
}

/**
 * Loads saved sites and their statuses from storage, then renders the list.
 */
async function loadSites() {
  try {
    const sites = await new Promise((resolve) =>
      chrome.storage.sync.get(["sites"], (data) => resolve(data.sites || []))
    );

    const statuses = await new Promise((resolve) =>
      chrome.storage.local.get(["siteStatuses"], (data) =>
        resolve(data.siteStatuses || {})
      )
    );

    renderSiteList(sites, statuses);

    // Get the current tab URL directly
    chrome.tabs.query({ active: true, currentWindow: true }, (tabs) => {
      if (tabs.length === 0) {
        updateCurrentSiteStatus("No active tab found.");
        currentTabUrlEl.textContent = "";
        addCurrentSiteBtn.style.display = "none";
        return;
      }

      try {
        const currentUrl = new URL(tabs[0].url).origin;

        const currentStatus = statuses[currentUrl] || "unknown";
        updateCurrentSiteStatus(currentStatus);

        const isAlreadyAdded = sites.some((site) => site.url === currentUrl);
        if (isAlreadyAdded) {
          currentTabUrlEl.classList.add("hidden-url");
          currentTabUrlEl.textContent = "";
          addCurrentSiteBtn.style.display = "none";
        } else {
          currentTabUrlEl.classList.remove("hidden-url");
          currentTabUrlEl.textContent = currentUrl;
          addCurrentSiteBtn.style.display = "inline-block";
        }

        chrome.runtime.sendMessage(
          { action: "checkSiteNow", url: currentUrl },
          (updatedStatus) => {
            if (chrome.runtime.lastError) {
              updateCurrentSiteStatus("Live check failed.");
              return;
            }
            updateCurrentSiteStatus(updatedStatus?.status || "unknown");
          }
        );
      } catch {
        updateCurrentSiteStatus("unknown");
        currentTabUrlEl.textContent = "Invalid current tab URL.";
        currentTabUrlEl.classList.remove("hidden-url");
        addCurrentSiteBtn.style.display = "none";
      }
    });
  } catch (error) {
    console.error("Failed to load sites or statuses:", error);
    updateCurrentSiteStatus("Error loading sites.");
  }
}

/**
 * Adds a new site to storage if the URL is valid and not a duplicate.
 */
function addSite() {
  const url = siteInput.value.trim();
  if (!url) {
    updateCurrentSiteStatus("Please enter a site URL.");
    return;
  }

  let hostname;
  try {
    hostname = new URL(url).hostname;
  } catch {
    updateCurrentSiteStatus("Invalid URL format.");
    return;
  }

  chrome.storage.sync.get(["sites"], (data) => {
    const sites = data.sites || [];

    if (sites.some((site) => site.url === url)) {
      updateCurrentSiteStatus("Site already added.");
      return;
    }

    sites.push({ name: hostname, url });
    chrome.storage.sync.set({ sites }, () => {
      siteInput.value = "";
      loadSites();
      updateCurrentSiteStatus("Site added successfully.");

      chrome.runtime.sendMessage({
        action: "notifySiteAdded",
        hostname: hostname,
      });
    });
  });
}

/**
 * Removes a site from storage by its index and refreshes the UI.
 * @param {number} index - Index of the site to remove.
 */
function removeSite(index) {
  chrome.storage.sync.get(["sites"], (data) => {
    const sites = data.sites || [];
    if (index < 0 || index >= sites.length) return;

    const removedSite = sites.splice(index, 1)[0]; // Remove site

    chrome.storage.sync.set({ sites }, () => {
      const hostnameToRemove = new URL(removedSite.url).hostname;
      chrome.storage.local.get(["uncheckableDomains"], (data) => {
        let uncheckable = data.uncheckableDomains || [];
        uncheckable = uncheckable.filter((host) => host !== hostnameToRemove);

        chrome.storage.local.set({ uncheckableDomains: uncheckable }, () => {
          if (typeof UNCHECKABLE_DOMAINS !== "undefined") {
            UNCHECKABLE_DOMAINS = uncheckable;
          }
          loadSites();
          updateCurrentSiteStatus("Site removed.");
        });
      });
    });
  });
}

document.addEventListener("DOMContentLoaded", () => {
  loadSites();

  if (currentTabUrlEl) {
    chrome.tabs.query({ active: true, currentWindow: true }, (tabs) => {
      if (tabs.length > 0) {
        try {
          currentTabUrlEl.textContent = tabs[0].url;
        } catch {
          currentTabUrlEl.textContent = "Unable to get current site URL";
        }
      } else {
        currentTabUrlEl.textContent = "No active tab found";
      }
    });
  }

  if (addCurrentSiteBtn) {
    addCurrentSiteBtn.addEventListener("click", () => {
      chrome.tabs.query({ active: true, currentWindow: true }, (tabs) => {
        if (tabs.length === 0) {
          updateCurrentSiteStatus("No active tab found.");
          return;
        }

        try {
          const url = new URL(tabs[0].url).origin;
          siteInput.value = url;
          addSite();
        } catch {
          updateCurrentSiteStatus("Invalid current tab URL.");
        }
      });
    });
  }

  if (toggleSitesBtn && watchedSitesWrapper) {
    let siteListVisible = false;
    watchedSitesWrapper.style.display = "none";

    const eyeIcon = document.getElementById("eyeIcon");

    toggleSitesBtn.addEventListener("click", () => {
      siteListVisible = !siteListVisible;

      if (siteListVisible) {
        watchedSitesWrapper.style.display = "block";
        eyeIcon.textContent = "🙈";
        loadSites();
      } else {
        watchedSitesWrapper.style.display = "none";
        eyeIcon.textContent = "👁️";
      }
    });
  }

  if (siteForm) {
    siteForm.addEventListener("submit", (event) => {
      event.preventDefault();
      addSite();
    });
  }

if (checkNowBtn) {
  const countdownEl = document.createElement("div");
  countdownEl.style.fontSize = "0.9em";
  countdownEl.style.marginTop = "4px";
  countdownEl.style.color = "#0078d4";
  countdownEl.style.minHeight = "1.2em"; // prevent layout jump
  checkNowBtn.insertAdjacentElement("afterend", countdownEl);

  function startCountdown(seconds, message = "Next check available in") {
    return new Promise((resolve) => {
      let remaining = seconds;
      countdownEl.textContent = `${message} ${remaining}s`;

      const intervalId = setInterval(() => {
        remaining = Math.max(remaining - 1, 0);
        if (remaining === 0) {
          clearInterval(intervalId);
          countdownEl.textContent = "";
          resolve();
        } else {
          countdownEl.textContent = `${message} ${remaining}s`;
        }
      }, 1000);
    });
  }

  checkNowBtn.addEventListener("click", async () => {
    if (checkNowBtn.disabled) return;

    checkNowBtn.disabled = true;
    const originalText = checkNowBtn.textContent;
    checkNowBtn.textContent = "Checking...";
    updateCurrentSiteStatus("Checking sites...");

    try {
      await new Promise((resolve, reject) => {
        chrome.runtime.sendMessage({ action: "checkAllSites" }, (response) => {
          if (chrome.runtime.lastError) reject(chrome.runtime.lastError);
          else resolve(response);
        });
      });

      updateCurrentSiteStatus("Site check complete.");
      await loadSites();
    } catch (error) {
      console.error("Check failed:", error);
      updateCurrentSiteStatus("Error during site check.");
    }

    await startCountdown(30);

    checkNowBtn.disabled = false;
    checkNowBtn.textContent = originalText;
  });
}

});
