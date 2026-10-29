/*
 * The LG side of the home screen: the TV's apps, opening one (or a Netflix title), its settings, the Back key, and
 * the small JS service that runs on the TV (webos/service).
 * The Luna and remote control API calls are adapted from Free My TV (github.com/simbasjungles/free-my-tv, MIT).
 * In a desktop browser it stands in with the Mi Box's logos, so the screen can be previewed on a computer.
 * Plain ES5: older webOS runs an old Chromium.
 */
var TV = (function () {
  'use strict';

  var webos = typeof window.PalmServiceBridge !== 'undefined';
  var calls = [];   // a bridge is collected if nothing holds it before its reply arrives
  var self = 'fr.sacha.tvhome';
  if (webos && window.PalmSystem && window.PalmSystem.identifier) self = window.PalmSystem.identifier.split(' ')[0];

  /** One Luna call; done(result), null on failure. */
  function luna(uri, params, done) {
    if (!webos) {
      if (done) setTimeout(function () { done(null); }, 0);
      return;
    }
    var bridge = new window.PalmServiceBridge();
    calls.push(bridge);
    var finished = false;
    bridge.onservicecallback = function (message) {
      if (finished) return;
      finished = true;
      var i = calls.indexOf(bridge);
      if (i >= 0) calls.splice(i, 1);
      var result = null;
      try { result = JSON.parse(message); } catch (e) {}
      if (done) done(result && result.returnValue !== false ? result : null);
    };
    bridge.call(uri, JSON.stringify(params || {}));
  }

  /** A call to our service on the TV (jw, quote, ram, ssap, log). */
  function service(method, params, done) {
    luna('luna://' + self + '.service/' + method, params, done);
  }

  /** A Luna subscription: onMessage(result) for every reply. Held here for good, so it's never collected. */
  function subscribe(uri, params, onMessage) {
    if (!webos) return;
    var bridge = new window.PalmServiceBridge();
    calls.push(bridge);
    bridge.onservicecallback = function (message) {
      var result = null;
      try { result = JSON.parse(message); } catch (e) {}
      if (result) onMessage(result);
    };
    params.subscribe = true;
    bridge.call(uri, JSON.stringify(params));
  }

  // webOS 6 hides listLaunchPoints from Developer Mode apps. The list then comes from the TV's remote control API
  // (the one LG's phone app uses): the TV asks once to allow it, and the key it gives back is kept. Newer firmware
  // refuses the page's own origin ("invalid origin"), so the service makes that call.
  // The same list as webos/service: the app list, and for the watcher, the app on screen, the power state and
  // opening apps. Changing it makes the TV ask again.
  var SSAP_KEY = 'tvhome.ssapKey2', SSAP_REFUSED = 'tvhome.ssapRefused2';
  var PERMISSIONS = ['READ_INSTALLED_APPS', 'READ_RUNNING_APPS', 'READ_POWER_STATE', 'LAUNCH'];

  function store(k, v) { try { localStorage.setItem(k, v); } catch (e) {} }
  function read(k) { try { return localStorage.getItem(k); } catch (e) { return null; } }

  function ssap(uri, done) {
    var ws = null, finished = false, key = read(SSAP_KEY);
    var timer = setTimeout(function () { finish(null); }, 90000);   // time to answer the TV's prompt
    function finish(result) {
      if (finished) return;
      finished = true;
      clearTimeout(timer);
      try { ws.close(); } catch (e) {}
      done(result);
    }
    function viaService() {
      clearTimeout(timer);
      timer = setTimeout(function () { finish(null); }, 100000);   // the service waits 90 s for the prompt
      service('ssap', {uri: uri, clientKey: key}, function (res) {
        if (res && res.clientKey) store(SSAP_KEY, res.clientKey);
        if (res && res.refused) store(SSAP_REFUSED, '1');   // "no" on the TV: not asked again
        finish(res && res.payload && res.payload.returnValue !== false ? res.payload : null);
      });
    }
    try { ws = new WebSocket('ws://127.0.0.1:3000'); } catch (e) { viaService(); return; }
    ws.onopen = function () {
      var payload = {forcePairing: false, pairingType: 'PROMPT',
        manifest: {manifestVersion: 1, appVersion: '1.0', permissions: PERMISSIONS}};
      if (key) payload['client-key'] = key;
      ws.send(JSON.stringify({type: 'register', id: 'register', payload: payload}));
    };
    ws.onmessage = function (event) {
      var m = null;
      try { m = JSON.parse(event.data); } catch (e) {}
      if (!m) return;
      if (m.type === 'registered') {
        store(SSAP_KEY, m.payload['client-key']);
        ws.send(JSON.stringify({type: 'request', id: 'call', uri: 'ssap://' + uri}));
      } else if (m.id === 'call' || m.type === 'error') {
        if (m.id === 'register' && m.type === 'error') store(SSAP_REFUSED, '1');
        finish(m.type !== 'error' && m.payload && m.payload.returnValue !== false ? m.payload : null);
      }
    };
    ws.onerror = function () {};
    ws.onclose = function (event) {
      if (event.code === 1008 && !finished) viaService(); else finish(null);
    };
  }

  // Not in the dock: the inputs, LG's own home and launchers, and Settings (it has its own button).
  var HIDDEN = /^(com\.webos\.app\.(livetv|hdmi\d|home|homeconnect|discovery|launcher|inputpicker)|com\.palm\.app\.settings)$/;

  // Until the TV allows the remote control API: the well-known apps it says it has, one id at a time.
  var KNOWN = [
    ['netflix', 'Netflix', '#000000'], ['youtube.leanback.v4', 'YouTube', '#FFFFFF'], ['amazon', 'Prime Video', '#1A98FF'],
    ['com.disney.disneyplus-prod', 'Disney+', '#1838C8'], ['com.apple.appletv', 'Apple TV', '#111114'],
    ['cdp-30', 'Plex', '#1F1F1F'], ['spotify-beehive', 'Spotify', '#1DB954'], ['io.freemytv', 'Free My TV', '#FF7A9E'],
    ['com.webos.app.browser', 'Web Browser', '#3A7BD5']
  ];

  function knownApps(done) {
    var found = [], left = KNOWN.length, sent = false;
    function finish() {
      if (sent) return;
      sent = true;
      done(found.filter(function (x) { return x; }));
    }
    setTimeout(finish, 5000);   // an id that never answers doesn't hold the rest
    KNOWN.forEach(function (k, i) {
      luna('luna://com.webos.applicationManager/getAppLoadStatus', {appId: k[0]}, function (res) {
        if (res && res.exist) found[i] = {id: k[0], title: k[1], icon: '', color: k[2]};
        if (--left === 0) finish();
      });
    });
  }

  function list(res) {
    var out = [], points = res && res.launchPoints ? res.launchPoints : [];
    for (var i = 0; i < points.length; i++) {
      var p = points[i];
      if (!p.id || p.id === self || HIDDEN.test(p.id)) continue;
      out.push({id: p.id, title: p.title || p.id, icon: p.largeIcon || p.icon || '', color: p.bgColor || p.iconColor || ''});
    }
    return out;
  }

  return {
    webos: webos,

    /** Installed apps: [{id, title, icon, color}]. */
    apps: function (done) {
      if (!webos) {
        var logos = (window.CONFIG && CONFIG.logos) || {};
        done(Object.keys(logos).map(function (k) { return {id: k, title: k, icon: '', color: ''}; }));
        return;
      }
      luna('luna://com.webos.applicationManager/listLaunchPoints', {}, function (res) {
        if (res) { done(list(res)); return; }
        if (read(SSAP_KEY)) {
          ssap('com.webos.applicationManager/listLaunchPoints', function (res2) {
            if (res2) done(list(res2)); else knownApps(done);
          });
          return;
        }
        // Until the TV is allowed (the watcher asks, once): the well-known apps.
        knownApps(done);
      });
    },

    /** Opens an app; done(ok). */
    launch: function (id, params, done) {
      if (!webos) { if (done) done(true); return; }
      luna('luna://com.webos.applicationManager/launch', params ? {id: id, params: params} : {id: id}, function (res) {
        if (done) done(!!res);
      });
    },

    /** Opens a title's page in Netflix, from its id (netflix.com/title/<id>). */
    netflix: function (titleId, done) {
      this.launch('netflix', {contentTarget: 'm=https://api-global.netflix.com/catalog/titles/movie/' + titleId +
          '&source_type=4'}, done);
    },

    /** The TV's settings, on a page when the TV knows it ("network"). */
    settings: function (target) {
      var self_ = this;
      this.launch('com.palm.app.settings', target ? {target: target} : null, function (ok) {
        if (!ok && target) self_.launch('com.palm.app.settings', null);
      });
    },

    service: function (method, params, done) {
      if (!webos) { if (done) done(null); return; }
      service(method, params, done);
    },

    /**
     * Starts the service's watcher: it brings this screen back when the TV turns on and when LG's home screen opens
     * (Home pressed twice in a row lets LG's stay). Our subscription is what keeps the service running.
     */
    watch: function () {
      if (read(SSAP_REFUSED)) return;
      subscribe('luna://' + self + '.service/watch', {clientKey: read(SSAP_KEY)}, function (res) {
        if (res.refused) store(SSAP_REFUSED, '1');   // "no" on the TV: not asked again
        if (!res.clientKey || res.clientKey === read(SSAP_KEY)) return;
        // Just allowed: the dock gets every app, with its icon.
        store(SSAP_KEY, res.clientKey);
        ssap('com.webos.applicationManager/listLaunchPoints', function (res2) {
          if (res2 && TV.onApps) TV.onApps(list(res2));
        });
      });
    },

    /** What the app was opened with ({perf: true} runs the speed test). */
    launchParams: function () {
      try { return JSON.parse(window.PalmSystem.launchParams || '{}') || {}; } catch (e) { return {}; }
    },

    keys: {left: 37, up: 38, right: 39, down: 40, ok: 13, back: 461}
  };
})();
