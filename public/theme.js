// Light (cream) or festive red theme. Runs before the page paints, so there's no flash.
(function () {
  var KEY = "rv-theme";
  var ICONS = {
    // shown on the button: the theme you'd switch TO
    festive: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"><path d="M20 14.5A8 8 0 0 1 9.5 4a8 8 0 1 0 10.5 10.5Z"/></svg>',
    light: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round"><circle cx="12" cy="12" r="4"/><path d="M12 2.5v2M12 19.5v2M4.6 4.6l1.4 1.4M18 18l1.4 1.4M2.5 12h2M19.5 12h2M4.6 19.4 6 18M18 6l1.4-1.4"/></svg>',
  };
  var COLORS = { light: "#faf7f0", festive: "#630e16" };

  function saved() { try { return localStorage.getItem(KEY); } catch (e) { return null; } }
  function apply(t) {
    document.documentElement.dataset.theme = t;
    var meta = document.querySelector('meta[name="theme-color"]');
    if (meta && !document.body.classList.contains("studio")) meta.content = COLORS[t];
    var btn = document.getElementById("themeBtn");
    if (btn) {
      var next = t === "festive" ? "light" : "festive";
      btn.innerHTML = ICONS[next];
      btn.setAttribute("aria-label", next === "festive" ? "Switch to festive red theme" : "Switch to light theme");
    }
  }
  var theme = saved() || (window.matchMedia && matchMedia("(prefers-color-scheme: dark)").matches ? "festive" : "light");
  document.documentElement.dataset.theme = theme;

  document.addEventListener("DOMContentLoaded", function () {
    apply(theme);
    var btn = document.getElementById("themeBtn");
    if (btn) btn.addEventListener("click", function () {
      theme = theme === "festive" ? "light" : "festive";
      try { localStorage.setItem(KEY, theme); } catch (e) {}
      apply(theme);
    });
  });
})();
