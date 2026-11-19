const RULESET_ID = "puretube_adblock_rules";

const DEFAULT_PREFS = {
  adblock: true,
  sponsorBlock: true,
  backgroundPlay: true,
  antiIdle: true,
};

const DEFAULT_STATS = {
  adsBlocked: 0,
  sponsorsSkipped: 0,
  secondsSaved: 0,
};

function formatBadgeCount(num) {
  if (!num || num <= 0) return "";
  if (num >= 1000000) return `${(num / 1000000).toFixed(1).replace(/\.0$/, "")}M`;
  if (num >= 1000) return `${(num / 1000).toFixed(1).replace(/\.0$/, "")}K`;
  return String(num);
}

async function applyRulesetAndBadge(prefs, stats) {
  const p = Object.assign({}, DEFAULT_PREFS, prefs || {});
  const s = Object.assign({}, DEFAULT_STATS, stats || {});

  try {
    await chrome.declarativeNetRequest.updateEnabledRulesets(
      p.adblock
        ? { enableRulesetIds: [RULESET_ID], disableRulesetIds: [] }
        : { enableRulesetIds: [], disableRulesetIds: [RULESET_ID] }
    );
  } catch (_) {}

  try {
    const total = (s.adsBlocked || 0) + (s.sponsorsSkipped || 0);
    await chrome.action.setBadgeBackgroundColor({
      color: p.adblock ? "#2BA640" : "#717171",
    });
    await chrome.action.setBadgeText({
      text: p.adblock ? formatBadgeCount(total) : "OFF",
    });
  } catch (_) {}
}

async function ensureDefaults() {
  const data = await chrome.storage.local.get(["prefs", "stats"]);
  const prefs = Object.assign({}, DEFAULT_PREFS, data.prefs || {});
  const stats = Object.assign({}, DEFAULT_STATS, data.stats || {});
  await chrome.storage.local.set({ prefs, stats });
  await applyRulesetAndBadge(prefs, stats);
}

let pendingAds = 0;
let pendingSponsors = 0;
let pendingSeconds = 0;
let flushTimer = null;

async function flushPendingStats() {
  flushTimer = null;
  const dAds = pendingAds;
  const dSp = pendingSponsors;
  const dSec = pendingSeconds;
  pendingAds = 0;
  pendingSponsors = 0;
  pendingSeconds = 0;
  if (!dAds && !dSp && !dSec) return;

  const data = await chrome.storage.local.get(["prefs", "stats"]);
  const prefs = Object.assign({}, DEFAULT_PREFS, data.prefs || {});
  const stats = Object.assign({}, DEFAULT_STATS, data.stats || {});
  stats.adsBlocked += dAds;
  stats.sponsorsSkipped += dSp;
  stats.secondsSaved += dSec;
  await chrome.storage.local.set({ stats });
  await applyRulesetAndBadge(prefs, stats);
}

chrome.runtime.onInstalled.addListener(() => {
  ensureDefaults();
});

chrome.runtime.onStartup.addListener(() => {
  ensureDefaults();
});

chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  if (!msg || typeof msg !== "object") return false;

  if (msg.type === "PURETUBE_STAT_INC") {
    pendingAds += Number(msg.adsDelta || 0);
    pendingSponsors += Number(msg.sponsorsDelta || 0);
    pendingSeconds += Number(msg.secondsDelta || 0);
    if (!flushTimer) {
      flushTimer = setTimeout(flushPendingStats, 250);
    }
    sendResponse({ ok: true });
    return false;
  }

  if (msg.type === "PURETUBE_SYNC_RULES") {
    chrome.storage.local.get(["prefs", "stats"]).then(async (data) => {
      await applyRulesetAndBadge(data.prefs, data.stats);
      sendResponse({ ok: true });
    });
    return true;
  }

  if (msg.type === "PURETUBE_RESET_STATS") {
    pendingAds = 0;
    pendingSponsors = 0;
    pendingSeconds = 0;
    chrome.storage.local.get(["prefs"]).then(async (data) => {
      const resetStats = Object.assign({}, DEFAULT_STATS);
      await chrome.storage.local.set({ stats: resetStats });
      await applyRulesetAndBadge(data.prefs, resetStats);
      sendResponse({ ok: true, stats: resetStats });
    });
    return true;
  }

  return false;
});
