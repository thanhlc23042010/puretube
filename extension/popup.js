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

function formatDuration(sec) {
  const s = Math.max(0, Math.round(sec || 0));
  if (s >= 3600) {
    const h = Math.floor(s / 3600);
    const m = Math.floor((s % 3600) / 60);
    return `${h} giờ ${m} phút`;
  }
  if (s >= 60) {
    const m = Math.floor(s / 60);
    const rem = s % 60;
    return `${m} phút ${rem} giây`;
  }
  return `${s} giây`;
}

function renderState(prefs, stats) {
  const p = Object.assign({}, DEFAULT_PREFS, prefs || {});
  const s = Object.assign({}, DEFAULT_STATS, stats || {});

  document.getElementById("opt-adblock").checked = Boolean(p.adblock);
  document.getElementById("opt-sponsorblock").checked = Boolean(p.sponsorBlock);
  document.getElementById("opt-background").checked = Boolean(p.backgroundPlay);
  document.getElementById("opt-anti-idle").checked = Boolean(p.antiIdle);

  document.getElementById("stat-ads-blocked").textContent = String(s.adsBlocked || 0);
  document.getElementById("stat-sponsors-skipped").textContent = String(s.sponsorsSkipped || 0);
  document.getElementById("stat-time-saved").textContent = formatDuration(s.secondsSaved);

  const pill = document.getElementById("shield-status-pill");
  if (pill) {
    pill.textContent = p.adblock ? "Đang bảo vệ" : "Đang tạm tắt";
    pill.classList.toggle("paused", !p.adblock);
  }
}

async function savePref(key, value) {
  const data = await chrome.storage.local.get(["prefs", "stats"]);
  const nextPrefs = Object.assign({}, DEFAULT_PREFS, data.prefs || {}, { [key]: value });
  await chrome.storage.local.set({ prefs: nextPrefs });
  renderState(nextPrefs, data.stats);
  chrome.runtime.sendMessage({ type: "PURETUBE_SYNC_RULES" });
}

document.addEventListener("DOMContentLoaded", async () => {
  const data = await chrome.storage.local.get(["prefs", "stats"]);
  renderState(data.prefs, data.stats);

  document.getElementById("opt-adblock").addEventListener("change", (e) => savePref("adblock", e.target.checked));
  document.getElementById("opt-sponsorblock").addEventListener("change", (e) => savePref("sponsorBlock", e.target.checked));
  document.getElementById("opt-background").addEventListener("change", (e) => savePref("backgroundPlay", e.target.checked));
  document.getElementById("opt-anti-idle").addEventListener("change", (e) => savePref("antiIdle", e.target.checked));

  document.getElementById("btn-open-youtube").addEventListener("click", () => {
    chrome.tabs.create({ url: "https://www.youtube.com" });
  });

  document.getElementById("btn-reset-stats").addEventListener("click", async () => {
    const res = await chrome.runtime.sendMessage({ type: "PURETUBE_RESET_STATS" });
    const latest = await chrome.storage.local.get(["prefs", "stats"]);
    renderState(latest.prefs, res?.stats || latest.stats);
  });
});

chrome.storage.onChanged.addListener((changes, areaName) => {
  if (areaName !== "local") return;
  chrome.storage.local.get(["prefs", "stats"]).then((data) => renderState(data.prefs, data.stats));
});
