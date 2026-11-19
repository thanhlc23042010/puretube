(function () {
  "use strict";

  var DEFAULT_PREFS = {
    adblock: true,
    sponsorBlock: true,
    backgroundPlay: true,
    antiIdle: true,
  };

  function applyPrefsToPage(prefs) {
    var merged = Object.assign({}, DEFAULT_PREFS, prefs || {});
    if (document.documentElement) {
      document.documentElement.classList.toggle("puretube-adblock-off", !merged.adblock);
    }
    try {
      window.postMessage(
        {
          type: "PURETUBE_EXT_PREFS",
          prefs: merged,
        },
        window.location.origin
      );
    } catch (_) {}
  }

  try {
    chrome.storage.local.get(["prefs"], function (res) {
      applyPrefsToPage(res && res.prefs ? res.prefs : DEFAULT_PREFS);
    });
  } catch (_) {}

  try {
    chrome.storage.onChanged.addListener(function (changes, areaName) {
      if (areaName !== "local" || !changes.prefs) return;
      applyPrefsToPage(changes.prefs.newValue || DEFAULT_PREFS);
    });
  } catch (_) {}

  window.addEventListener("message", function (event) {
    if (
      event.source !== window ||
      !event.data ||
      event.data.source !== "puretube-ext" ||
      event.data.type !== "PURETUBE_EXT_STATS"
    ) {
      return;
    }
    try {
      chrome.runtime.sendMessage({
        type: "PURETUBE_STAT_INC",
        adsDelta: Number(event.data.adsDelta || 0),
        sponsorsDelta: Number(event.data.sponsorsDelta || 0),
        secondsDelta: Number(event.data.secondsDelta || 0),
      });
    } catch (_) {}
  });
})();
