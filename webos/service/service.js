/*
 * The home screen's service on LG webOS, for what the page can't do itself:
 *  - jw: one JustWatch query (what's popular on Netflix France), whose API refuses an app page's origin (CORS).
 *  - quote: EssilorLuxottica's price from Yahoo Finance, which a web page can't read (no CORS).
 *  - ram: the TV's memory in use, in %, from /proc/meminfo.
 *  - ssap: the TV's app list from its remote control API (127.0.0.1:3000), which refuses the page's own origin.
 *    Adapted from Free My TV's service (github.com/simbasjungles/free-my-tv, MIT).
 *  - watch: through that same API, brings the home screen back when the TV turns on and when LG's home opens.
 *    LG denies these events to Developer Mode apps on its own bus (Luna), but its remote control API, once
 *    allowed on the TV, gives them. The page's subscription to it is what keeps this service running.
 *  - phone: a page for phones on the home Wi-Fi (http://<TV>:8090): describe a film or a show, Claude names it (on
 *    the server in server/tvhome_ai.py, with a Claude subscription), JustWatch says where it streams in France, and
 *    the TV opens it there (the title itself in Netflix; other apps open on their home).
 *  - log / dump: the speed test's numbers and the watcher's events, kept in memory (the service can't write
 *    where SSH reads), read with luna-send-pub luna://fr.sacha.tvhome.service/dump '{}'.
 * Plain ES5 with Node's built-ins only: webOS 6 ships Node 8.
 */
var fs = require('fs');
var http = require('http');
var https = require('https');
var net = require('net');
var os = require('os');
var Service = require('webos-service');

var service = new Service(require('./package.json').name);

// ---- jw ------------------------------------------------------------------

/** POSTs JSON over HTTPS; done(error, answer). `opts` are https.request's (hostname, path, port, headers, ca). */
function postJSON(opts, obj, timeout, done) {
  var body = Buffer.from(JSON.stringify(obj)), finished = false;
  function end(err, json) { if (!finished) { finished = true; done(err, json); } }
  opts.method = 'POST';
  opts.headers = opts.headers || {};
  opts.headers['Content-Type'] = 'application/json';
  opts.headers['Content-Length'] = body.length;
  var req = https.request(opts, function (res) {
    var text = '';
    res.setEncoding('utf8');
    res.on('data', function (c) { text += c; });
    res.on('end', function () {
      var json = null;
      try { json = JSON.parse(text); } catch (e) {}
      end(res.statusCode === 200 && json ? null : 'HTTP ' + res.statusCode, json);
    });
  });
  // A hard deadline: a server behind a firewall that drops the connection never times the socket out (Node 8).
  var deadline = setTimeout(function () { end('timeout'); req.abort(); }, timeout);
  req.on('error', function (e) { end(String(e.code || e.message)); });
  req.on('close', function () { clearTimeout(deadline); });
  req.end(body);
}

function justWatch(query, done) {
  postJSON({hostname: 'apis.justwatch.com', path: '/graphql'}, query, 10000, done);
}

service.register('jw', function (message) {
  justWatch((message.payload || {}).query || {}, function (err, json) {
    try {
      // Only the Netflix link of each title goes back: the answer stays small on the TV's message bus.
      json.data.popularTitles.edges.forEach(function (e) {
        e.node.offers = (e.node.offers || []).filter(function (o) {
          return /netflix\.com\/title\//.test(o.standardWebURL || '');
        }).slice(0, 1);
      });
      message.respond({returnValue: true, json: json});
    } catch (e) {
      message.respond({returnValue: false, errorText: err || 'Bad answer'});
    }
  });
});

// ---- quote ---------------------------------------------------------------

// One options object: Node 8 has no https.get(url, options, callback).
var STOCK = {hostname: 'query1.finance.yahoo.com', path: '/v8/finance/chart/EL.PA?range=1d&interval=1d',
  headers: {'User-Agent': 'Mozilla/5.0'}};   // Yahoo rejects requests without one

service.register('quote', function (message) {
  var req = https.get(STOCK, function (res) {
    var body = '';
    res.setEncoding('utf8');
    res.on('data', function (c) { body += c; });
    res.on('end', function () {
      try {
        var price = JSON.parse(body).chart.result[0].meta.regularMarketPrice;
        message.respond({returnValue: true, price: price});
      } catch (e) {
        message.respond({returnValue: false, errorText: 'No price'});
      }
    });
  });
  req.setTimeout(8000, function () { req.abort(); });
  req.on('error', function () { message.respond({returnValue: false, errorText: 'Offline'}); });
});

// ---- ram -----------------------------------------------------------------

service.register('ram', function (message) {
  fs.readFile('/proc/meminfo', 'utf8', function (err, text) {
    var total = /MemTotal:\s+(\d+)/.exec(text || ''), avail = /MemAvailable:\s+(\d+)/.exec(text || '');
    if (err || !total || !avail) {
      message.respond({returnValue: false, errorText: 'No meminfo'});
      return;
    }
    message.respond({returnValue: true, used: Math.round(100 * (total[1] - avail[1]) / total[1])});
  });
});

// ---- log -----------------------------------------------------------------

var journal = [];

function log(entry) {
  entry.t = new Date().toISOString();
  journal.push(entry);
  if (journal.length > 200) journal.shift();
}

service.register('log', function (message) {
  log(message.payload || {});
  message.respond({returnValue: true});
});

service.register('dump', function (message) {
  message.respond({returnValue: true, journal: journal});
});

// ---- the TV's remote control API (SSAP) ---------------------------------

var APP_ID = require('./package.json').name.replace(/\.service$/, '');
// The same list as the page (webos/app/tv.js). Changing it makes the TV ask again.
var PERMISSIONS = ['READ_INSTALLED_APPS', 'READ_RUNNING_APPS', 'READ_POWER_STATE', 'LAUNCH'];

/** A client's text frame: masked, as the protocol asks. */
function frame(text) {
  var data = Buffer.from(text), n = data.length;
  var mask = Buffer.from([Math.random() * 256 | 0, Math.random() * 256 | 0, Math.random() * 256 | 0, Math.random() * 256 | 0]);
  for (var i = 0; i < n; i++) data[i] ^= mask[i % 4];
  var head = n < 126 ? [0x81, 0x80 | n] : [0x81, 0xfe, n >> 8, n & 0xff];
  return Buffer.concat([Buffer.from(head), mask, data]);
}

/**
 * A connection to the API, registered with the client key (the TV asks the first time). on.registered(key, send),
 * on.message(m) for everything after, on.refused() when the person says no on the TV, on.end() when it closes.
 */
function connect(clientKey, on) {
  var socket = net.connect(3000, '127.0.0.1'), buf = Buffer.alloc(0), open = false, text = '', closed = false;
  function send(obj) {
    if (!closed) socket.write(frame(JSON.stringify(obj)));
  }
  function end() {
    if (closed) return;
    closed = true;
    socket.destroy();
    if (on.end) on.end();
  }
  function onMessage(m) {
    if (m.id === 'register' && m.type === 'registered') on.registered(m.payload['client-key'], send);
    else if (m.id === 'register' && m.type === 'error') {
      if (on.refused) on.refused();
      end();
    } else if (on.message) on.message(m);
  }
  socket.on('connect', function () {
    socket.write('GET / HTTP/1.1\r\nHost: 127.0.0.1:3000\r\nOrigin: file://\r\nUpgrade: websocket\r\n' +
        'Connection: Upgrade\r\nSec-WebSocket-Version: 13\r\nSec-WebSocket-Key: dHZob21lLXdlYm9zLWFwaQ==\r\n\r\n');
  });
  socket.on('data', function (chunk) {
    buf = Buffer.concat([buf, chunk]);
    if (!open) {
      var head = buf.toString('binary').indexOf('\r\n\r\n');
      if (head < 0) return;
      if (!/^HTTP\/1\.1 101/.test(buf.toString('utf8', 0, 12))) { end(); return; }
      open = true;
      buf = buf.slice(head + 4);
      var payload = {forcePairing: false, pairingType: 'PROMPT',
        manifest: {manifestVersion: 1, appVersion: '1.0', permissions: PERMISSIONS}};
      if (clientKey) payload['client-key'] = clientKey;
      send({type: 'register', id: 'register', payload: payload});
    }
    // The server's frames: unmasked, a message possibly split in several (continuation frames until FIN).
    while (buf.length >= 2) {
      var fin = buf[0] & 0x80, op = buf[0] & 0x0f, n = buf[1] & 0x7f, off = 2;
      if (n === 126) {
        if (buf.length < 4) return;
        n = buf.readUInt16BE(2);
        off = 4;
      } else if (n === 127) {
        if (buf.length < 10) return;
        n = buf.readUInt32BE(6);
        off = 10;
      }
      if (buf.length < off + n) return;
      var data = buf.slice(off, off + n);
      buf = buf.slice(off + n);
      if (op === 8) { end(); return; }
      if (op === 9) {   // ping: pong with the same data, or the TV drops a long-lived connection
        socket.write(Buffer.concat([Buffer.from([0x8a, 0x80 | data.length]), Buffer.from([0, 0, 0, 0]), data]));
        continue;
      }
      if (op !== 1 && op !== 0) continue;
      text += data.toString('utf8');
      if (!fin) continue;
      var m = null;
      try { m = JSON.parse(text); } catch (e) {}
      text = '';
      if (m) onMessage(m);
    }
  });
  socket.on('error', end);
  socket.on('close', end);
  return {close: end};
}

service.register('ssap', function (message) {
  var p = message.payload || {}, done = false;
  // Only the app list: nothing else goes to the TV's API, nor gets its client key.
  if (p.uri !== 'com.webos.applicationManager/listLaunchPoints') {
    message.respond({returnValue: false, errorText: 'Only listLaunchPoints'});
    return;
  }
  function reply(r) {
    if (done) return;
    done = true;
    clearTimeout(timer);
    message.respond(r);
    c.close();
  }
  var timer = setTimeout(function () { reply({returnValue: false, errorText: 'No answer'}); }, 90000);
  var key = null;
  var c = connect(p.clientKey, {
    registered: function (k, send) {
      key = k;
      send({type: 'request', id: 'call', uri: 'ssap://' + p.uri});
    },
    message: function (m) {
      if (m.id === 'call') reply(m.type === 'error' ? {returnValue: false, errorText: 'Denied'}
          : {returnValue: true, clientKey: key, payload: m.payload});
    },
    refused: function () { reply({returnValue: true, refused: true}); },
    end: function () { reply({returnValue: false, errorText: 'No answer from the remote control API'}); }
  });
});

// ---- watch ---------------------------------------------------------------

// LG's home screen: shown by the Home button, and at power-on when "Home Auto Launch" is on.
var HOME = /^com\.webos\.app\.(home|launcher)$/;
var watchers = [], conn = null, key = null, retry = null;
var foreground = '', power = '', redirectedAt = 0, waking = null, sendNow = null, frontAt = 0, regrabs = 0, pending = null;

// Waking up. LG gives no power state to an unsigned client ("401 insufficient permissions"), but with Quick Start+
// the TV freezes everything when it's turned off: this clock then jumps ahead by the time it was off.
var lastTick = Date.now();
setInterval(function () {
  var now = Date.now(), gap = now - lastTick;
  lastTick = now;
  if (gap < 30000 || !watchers.length) return;
  log({watch: 'woke', off: Math.round(gap / 1000)});
  // The app on screen before standby means nothing now: wait for the TV's fresh answer (or 8 s at most).
  clearTimeout(waking);
  waking = setTimeout(function () { wake(); }, 8000);
}, 5000);

function wake() {
  clearTimeout(waking);
  waking = null;
  if (foreground !== APP_ID) bringBack('power on');
}

function tell(r) {
  r.returnValue = true;
  watchers.forEach(function (w) { w.respond(r); });
}

function bringBack(why) {
  redirectedAt = Date.now();
  log({watch: 'open', why: why, from: foreground});
  // The remote control API first (LAUNCH, allowed with the rest); the TV's bus when that connection is down.
  if (sendNow) {
    sendNow({type: 'request', id: 'launch', uri: 'ssap://system.launcher/launch', payload: {id: APP_ID}});
    return;
  }
  service.call('luna://com.webos.applicationManager/launch', {id: APP_ID}, function (m) {
    log({watch: 'launched', via: 'luna', ok: !!(m.payload && m.payload.returnValue), error: m.payload && m.payload.errorText});
  });
}

// How long LG's home is left to finish opening before this screen comes back. Quicker, and it takes the front back
// as it settles, again and again. Measured on webOS 6.5 (LG's home opened 31 times): 0.7 s bounced; 0.8 s bounced
// 3 times in 7; 0.9 s (8/8) and 1 s (6/6) switched once, cleanly. 1 s leaves a margin over that 0.8 s edge.
var HOME_DELAY = 1000;

/**
 * LG's home just opened: once it has settled, this screen comes back, unless Home was pressed again within 4 s of
 * that: then the person wants LG's home, and it stays. LG's home taking the front back within 1.5 s of ours is
 * the TV, not a person (a slow moment): we come back again, waiting longer each time (three times at most).
 */
function onHome() {
  var now = Date.now();
  if (frontAt > redirectedAt && now - frontAt < 1500 && regrabs < 3) regrabs++;
  else if (now - redirectedAt < 4000) { log({watch: 'stay', why: 'home twice'}); return; }
  else regrabs = 0;
  clearTimeout(pending);
  pending = setTimeout(function () { if (HOME.test(foreground)) bringBack('home'); }, HOME_DELAY * (1 + regrabs / 2));
}

function startWatch() {
  startPhone();
  if (conn || !watchers.length) return;
  clearTimeout(retry);
  conn = connect(key, {
    registered: function (k, send) {
      if (k !== key) tell({clientKey: k});
      key = k;
      sendNow = send;
      log({watch: 'connected'});
      send({type: 'subscribe', id: 'fg', uri: 'ssap://com.webos.applicationManager/getForegroundAppInfo'});
      send({type: 'subscribe', id: 'power', uri: 'ssap://com.webos.service.tvpower/power/getPowerState'});
    },
    message: function (m) {
      var p = m.payload || {};
      if (m.type === 'error') {
        log({watch: 'denied', id: m.id, error: m.error});
        return;
      }
      if (m.id === 'launch') {
        log({watch: 'launched', via: 'ssap', ok: p.returnValue !== false});
        return;
      }
      if (m.id === 'fg' && p.appId !== undefined) {
        var was = foreground;
        foreground = p.appId;
        if (was !== foreground) log({watch: 'foreground', app: foreground});
        if (waking) { wake(); return; }
        if (foreground === APP_ID) frontAt = Date.now();
        if (HOME.test(foreground)) onHome();
      }
      if (m.id === 'power' && p.state) {
        var before = power;
        power = p.state;
        if (before !== power) log({watch: 'power', state: power});
        // Waking from standby, not the screen coming back on (Screen Off keeps the sound playing).
        if (/Standby|Suspend|Power/i.test(before) && power === 'Active' && foreground !== APP_ID) bringBack('power on');
      }
    },
    refused: function () {
      log({watch: 'refused'});
      tell({refused: true});
    },
    end: function () {
      conn = null;
      sendNow = null;
      // The TV restarts its API now and then (and when it wakes): connect again while someone is subscribed.
      if (watchers.length) retry = setTimeout(startWatch, 5000);
    }
  });
}

service.register('watch', function (message) {
  var p = message.payload || {};
  if (p.clientKey && !key) key = p.clientKey;
  if (message.isSubscription) watchers.push(message);
  message.respond({returnValue: true, subscribed: !!message.isSubscription, clientKey: key || undefined});
  startWatch();
}, function (message) {   // the page went away
  watchers = watchers.filter(function (w) { return w !== message; });
});

// ---- phone ---------------------------------------------------------------

var PHONE_PORT = 8090;
var AI = null;   // {url, token, cert} from webos/ai.local.json, put in the package by build.py
try { AI = JSON.parse(fs.readFileSync(__dirname + '/ai.json', 'utf8')); } catch (e) {}
var phoneServer = null;

/** The TV's address on the home network. */
function lanAddress() {
  var nets = os.networkInterfaces();
  for (var name in nets) {
    for (var i = 0; i < nets[name].length; i++) {
      var a = nets[name][i];
      if (a.family === 'IPv4' && !a.internal && /^(10|172\.(1[6-9]|2\d|3[01])|192\.168)\./.test(a.address)) return a.address;
    }
  }
  return '';
}

service.register('phone', function (message) {
  startPhone();
  var ip = lanAddress();
  message.respond({returnValue: true, url: ip ? 'http://' + ip + ':' + PHONE_PORT : '', ai: !!AI});
});

/** Claude's guesses for a description, from the server: [{title, original_title, year, type}]. */
function askAI(q, done) {
  if (!AI) { done('not set up'); return; }
  var u = /^https:\/\/([^:/]+):(\d+)(\/.*)$/.exec(AI.url);
  postJSON({hostname: u[1], port: +u[2], path: u[3], ca: AI.cert, headers: {Authorization: 'Bearer ' + AI.token}},
      {q: q}, 45000, function (err, json) { done(err, json && json.results); });
}

var SEARCH = 'query($q:String!){popularTitles(country:FR,first:5,filter:{searchQuery:$q})' +
    '{edges{node{objectType content(country:FR,language:"fr"){title originalTitle originalReleaseYear posterUrl}' +
    ' offers(country:FR,platform:WEB){monetizationType package{clearName} standardWebURL}}}}}';

/** One guess on JustWatch: the closest title (same kind, year within one) and where it streams. */
function lookUp(guess, done) {
  function search(q, next) {
    justWatch({query: SEARCH, variables: {q: q}}, function (err, json) {
      var edges = [];
      try { edges = json.data.popularTitles.edges; } catch (e) {}
      var best = null;
      edges.forEach(function (e) {
        var c = e.node.content || {}, kind = e.node.objectType === 'SHOW' ? 'show' : 'movie';
        var near = !guess.year || !c.originalReleaseYear || Math.abs(c.originalReleaseYear - guess.year) <= 1;
        if (!best && kind === guess.type && near) best = e.node;
      });
      if (best || !next) done(best ? describe(best) : null); else next();
    });
  }
  search(guess.title, guess.original_title && guess.original_title !== guess.title
      ? function () { search(guess.original_title, null); } : null);
}

function describe(node) {
  var c = node.content || {}, seen = {}, offers = [];
  (node.offers || []).forEach(function (o) {
    // "Netflix Standard with Ads" is Netflix, "Amazon Prime Video with Ads" is Prime Video: one button each.
    var name = o.package && o.package.clearName.replace(/\s+(Standard\s+)?with Ads$/i, '').replace(/^Amazon\s+/, '');
    // Included in a subscription, or free: renting and buying aren't for a quick "play it".
    if (!name || seen[name] || !/^(FLATRATE|FREE|ADS)$/.test(o.monetizationType)) return;
    seen[name] = true;
    offers.push({service: name, url: o.standardWebURL || ''});
  });
  return {title: c.title, year: c.originalReleaseYear || null, type: node.objectType === 'SHOW' ? 'show' : 'movie',
    poster: c.posterUrl ? 'https://images.justwatch.com' + c.posterUrl.replace('{profile}', 's332').replace('{format}', 'jpg') : '',
    offers: offers};
}

/** "Amazon Prime Video" → "primevideo", "Disney Plus" → "disneyplus", "Canal+" → "canalplus". */
function norm(s) {
  return String(s || '').toLowerCase().replace(/\+/g, 'plus').replace(/amazon/g, '').replace(/[^a-z0-9]/g, '');
}

/** The TV's apps, through the remote control API (the key the watcher has): [{id, title}]. */
function tvApps(done) {
  if (!key) { done([]); return; }
  var finished = false;
  var c = connect(key, {
    registered: function (k, send) { send({type: 'request', id: 'apps', uri: 'ssap://com.webos.applicationManager/listLaunchPoints'}); },
    message: function (m) {
      if (m.id !== 'apps' || finished) return;
      finished = true;
      c.close();
      done(((m.payload || {}).launchPoints || []).map(function (p) { return {id: p.id, title: p.title || ''}; }));
    },
    end: function () { if (!finished) { finished = true; done([]); } }
  });
}

/** Opens a title on the TV: Netflix on the title itself, another service on its app. done(error, app title). */
function play(offer, done) {
  var nf = /netflix\.com\/title\/(\d+)/.exec(offer.url || '');
  if (nf) {
    launch('netflix', {contentTarget: 'm=https://api-global.netflix.com/catalog/titles/movie/' + nf[1] + '&source_type=4'},
        function (ok) { done(ok ? null : 'launch', 'Netflix'); });
    return;
  }
  tvApps(function (apps) {
    var want = norm(offer.service), app = null;
    apps.forEach(function (a) {
      var t = norm(a.title);
      if (!app && t && (t.indexOf(want) >= 0 || want.indexOf(t) >= 0)) app = a;
    });
    if (!app) { done('no app'); return; }
    launch(app.id, null, function (ok) { done(ok ? null : 'launch', app.title); });
  });
}

function launch(id, params, done) {
  service.call('luna://com.webos.applicationManager/launch', params ? {id: id, params: params} : {id: id}, function (m) {
    done(!!(m.payload && m.payload.returnValue));
  });
}

function startPhone() {
  if (phoneServer) return;
  phoneServer = http.createServer(function (req, res) {
    function reply(code, obj, type) {
      var body = Buffer.from(typeof obj === 'string' ? obj : JSON.stringify(obj));
      res.writeHead(code, {'Content-Type': type || 'application/json; charset=utf-8', 'Content-Length': body.length,
        'Cache-Control': 'no-store'});
      res.end(body);
    }
    // The home network only: the TV is behind the box's NAT, and this says so twice.
    var from = req.socket.remoteAddress || '';
    if (!/^(::ffff:)?(10\.|172\.(1[6-9]|2\d|3[01])\.|192\.168\.|127\.)/.test(from)) { reply(403, {error: 'home only'}); return; }
    if (req.method === 'GET' && (req.url === '/' || req.url.indexOf('/?') === 0)) {
      fs.readFile(__dirname + '/phone.html', function (err, html) {
        if (err) reply(500, {error: 'no page'}); else reply(200, html.toString('utf8'), 'text/html; charset=utf-8');
      });
      return;
    }
    if (req.method !== 'POST') { reply(404, {error: 'not found'}); return; }
    var body = '';
    req.setEncoding('utf8');
    req.on('data', function (c) { if (body.length < 4096) body += c; });
    req.on('end', function () {
      var p = {};
      try { p = JSON.parse(body || '{}'); } catch (e) {}
      if (req.url === '/api/ask') {
        var q = String(p.q || '').trim().slice(0, 500);
        if (!q) { reply(400, {error: 'empty'}); return; }
        log({phone: 'ask'});
        askAI(q, function (err, guesses) {
          if (err || !guesses) { log({phone: 'ai failed', error: err}); reply(502, {error: 'ai'}); return; }
          var out = [], left = guesses.length;
          if (!left) { reply(200, {results: []}); return; }
          guesses.forEach(function (g, i) {
            lookUp(g, function (found) {
              // Not on JustWatch: still shown, with no service, so the person sees what Claude understood.
              out[i] = found || {title: g.title, year: g.year, type: g.type, poster: '', offers: []};
              if (--left === 0) reply(200, {results: out});
            });
          });
        });
      } else if (req.url === '/api/play') {
        play({service: String(p.service || ''), url: String(p.url || '')}, function (err, app) {
          log({phone: 'play', app: app, error: err});
          reply(err ? 409 : 200, err ? {error: err} : {app: app});
        });
      } else if (req.url === '/api/home') {
        launch(APP_ID, null, function (ok) { reply(ok ? 200 : 409, {}); });
      } else reply(404, {error: 'not found'});
    });
  });
  phoneServer.on('error', function (e) { log({phone: 'server error', error: e.code}); phoneServer = null; });
  phoneServer.listen(PHONE_PORT, '0.0.0.0', function () { log({phone: 'listening', port: PHONE_PORT}); });
}
