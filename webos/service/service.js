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
 *  - log / dump: the speed test's numbers and the watcher's events, kept in memory (the service can't write
 *    where SSH reads), read with luna-send-pub luna://fr.sacha.tvhome.service/dump '{}'.
 * Plain ES5 with Node's built-ins only: webOS 6 ships Node 8.
 */
var fs = require('fs');
var https = require('https');
var net = require('net');
var Service = require('webos-service');

var service = new Service(require('./package.json').name);

// ---- jw ------------------------------------------------------------------

service.register('jw', function (message) {
  var body = Buffer.from(JSON.stringify((message.payload || {}).query || {}));
  var req = https.request({hostname: 'apis.justwatch.com', path: '/graphql', method: 'POST',
    headers: {'Content-Type': 'application/json', 'Content-Length': body.length}}, function (res) {
    var text = '';
    res.setEncoding('utf8');
    res.on('data', function (c) { text += c; });
    res.on('end', function () {
      try {
        var json = JSON.parse(text);
        // Only the Netflix link of each title goes back: the answer stays small on the TV's message bus.
        json.data.popularTitles.edges.forEach(function (e) {
          e.node.offers = (e.node.offers || []).filter(function (o) {
            return /netflix\.com\/title\//.test(o.standardWebURL || '');
          }).slice(0, 1);
        });
        message.respond({returnValue: true, json: json});
      } catch (e) {
        message.respond({returnValue: false, errorText: 'Bad answer'});
      }
    });
  });
  req.setTimeout(10000, function () { req.abort(); });
  req.on('error', function () { message.respond({returnValue: false, errorText: 'Offline'}); });
  req.end(body);
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
