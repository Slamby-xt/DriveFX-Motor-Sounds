/* DriveFX Stats tracker: no cookies, no storage, sends only the page path, the referrer and the window width.
   Add to the tracked site:  <script defer src="https://YOUR-STATS-SITE/t.js"></script>
   Custom events (optional):  window.dfxTrack('paywall_open')   (names: a-z, 0-9, _ ; max 30 characters) */
(function () {
  try {
    var dnt = navigator.doNotTrack === '1' || window.doNotTrack === '1' || navigator.msDoNotTrack === '1';
    if (dnt || /^(localhost|127\.|\[::1\])/.test(location.hostname)) { window.dfxTrack = function () {}; return; }
    var s = document.currentScript, base = s && s.src ? s.src.replace(/t\.js(\?.*)?$/, '') : '';
    if (!base) return;
    var url = base + 'api/collect';
    function send(o) {
      var d = JSON.stringify(o);
      try { if (navigator.sendBeacon && navigator.sendBeacon(url, new Blob([d], { type: 'text/plain' }))) return; } catch (e) {}
      try { fetch(url, { method: 'POST', body: d, keepalive: true, headers: { 'Content-Type': 'text/plain' } }); } catch (e) {}
    }
    window.dfxTrack = function (name) { if (/^[a-z0-9_]{1,30}$/.test(name)) send({ p: location.pathname, n: name }); };
    send({ p: location.pathname, r: document.referrer, w: window.innerWidth });
  } catch (e) {}
})();
