// Applies the saved light/dark choice before the page draws, so it never flashes the wrong theme.
'use strict';
(function () {
  let theme = 'dark';
  try { theme = localStorage.getItem('netmon-theme') || 'dark'; } catch { /* storage blocked: use dark */ }
  document.documentElement.setAttribute('data-theme', theme === 'light' ? 'light' : 'dark');
})();
