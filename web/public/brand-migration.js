/* One-release migration from legacy DeepTutor browser storage to Cognivoy. */
(function () {
  "use strict";

  var legacyPrefix = "deeptutor";
  var currentPrefix = "cognivoy";

  try {
    var keys = [];
    for (var index = 0; index < localStorage.length; index += 1) {
      var key = localStorage.key(index);
      if (key && key.indexOf(legacyPrefix) === 0) keys.push(key);
    }
    keys.forEach(function (legacyKey) {
      var currentKey = currentPrefix + legacyKey.slice(legacyPrefix.length);
      if (localStorage.getItem(currentKey) === null) {
        var value = localStorage.getItem(legacyKey);
        if (value !== null) localStorage.setItem(currentKey, value);
      }
    });
  } catch {
    // Storage may be disabled; the application defaults remain usable.
  }

  try {
    var legacyLanguage = document.cookie.match(/(?:^|;\s*)deeptutor-lang=([^;]*)/);
    var hasCurrentLanguage = /(?:^|;\s*)cognivoy-lang=/.test(document.cookie);
    if (legacyLanguage && !hasCurrentLanguage) {
      document.cookie =
        "cognivoy-lang=" + legacyLanguage[1] + ";path=/;max-age=31536000;samesite=lax";
    }
  } catch {
    // Cookie access can be denied without preventing application startup.
  }
})();
