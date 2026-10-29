/*
 * The home screen's service on LG webOS, for what the page can't do itself:
 *  - jw: one JustWatch query (what's popular on Netflix France), whose API refuses an app page's origin (CORS).
 *  - quote: EssilorLuxottica's price from Yahoo Finance, which a web page can't read (no CORS).
 *  - ram: the TV's memory in use, in %, from /proc/meminfo.
 *  - ssap: the TV's app list from its remote control API (127.0.0.1:3000), which refuses the page's own origin.
 *    Adapted from Free My TV's service (github.com/simbasjungles/free-my-tv, MIT).
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

// ---- ssap ----------------------------------------------------------------

/** A client's text frame: masked, as the protocol asks. */
function frame(text) {
  var data = Buffer.from(text), n = data.length;
  var mask = Buffer.from([Math.random() * 256 | 0, Math.random() * 256 | 0, Math.random() * 256 | 0, Math.random() * 256 | 0]);
  for (var i = 0; i < n; i++) data[i] ^= mask[i % 4];
  return Buffer.concat([Buffer.from(n < 126 ? [0x81, 0x80 | n] : [0x81, 0xfe, n >> 8, n & 0xff]), mask, data]);
}

/** done({clientKey, payload}), {refused: true} when the person said no on the TV, or null. */
function call(uri, clientKey, done) {
  var socket = net.connect(3000, '127.0.0.1'), buf = Buffer.alloc(0), open = false, text = '', finished = false;
  var timer = setTimeout(function () { finish(null); }, 90000);   // time to answer the TV's prompt
  function finish(result) {
    if (finished) return;
    finished = true;
    clearTimeout(timer);
    socket.destroy();
    done(result);
  }
  function send(obj) {
    socket.write(frame(JSON.stringify(obj)));
  }
  function onMessage(m) {
    if (m.type === 'registered') {
      clientKey = m.payload['client-key'];
      send({type: 'request', id: 'call', uri: 'ssap://' + uri});
    } else if (m.id === 'call') {
      finish(m.type === 'error' ? null : {clientKey: clientKey, payload: m.payload});
    } else if (m.type === 'error') {
      finish(m.id === 'register' ? {refused: true} : null);
    }
  }
  socket.on('connect', function () {
    socket.write('GET / HTTP/1.1\r\nHost: 127.0.0.1:3000\r\nOrigin: file://\r\nUpgrade: websocket\r\n' +
        'Connection: Upgrade\r\nSec-WebSocket-Version: 13\r\nSec-WebSocket-Key: dHZob21lLXdlYm9zLWFwaQ==\r\n\r\n');
  });
  socket.on('data', function (chunk) {
    buf = Buffer.concat([buf, chunk]);
    if (!open) {
      var end = buf.toString('binary').indexOf('\r\n\r\n');
      if (end < 0) return;
      if (!/^HTTP\/1\.1 101/.test(buf.toString('utf8', 0, 12))) { finish(null); return; }
      open = true;
      buf = buf.slice(end + 4);
      var payload = {forcePairing: false, pairingType: 'PROMPT',
        manifest: {manifestVersion: 1, appVersion: '1.0', permissions: ['READ_INSTALLED_APPS']}};
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
      if (op === 8) { finish(null); return; }
      if (op !== 1 && op !== 0) continue;
      text += data.toString('utf8');
      if (!fin) continue;
      var m = null;
      try { m = JSON.parse(text); } catch (e) {}
      text = '';
      if (m) onMessage(m);
    }
  });
  socket.on('error', function () { finish(null); });
  socket.on('close', function () { finish(null); });
}

service.register('ssap', function (message) {
  var p = message.payload || {};
  // Only the app list: nothing else goes to the TV's API, nor gets its client key.
  if (p.uri !== 'com.webos.applicationManager/listLaunchPoints') {
    message.respond({returnValue: false, errorText: 'Only listLaunchPoints'});
    return;
  }
  call(p.uri, p.clientKey, function (result) {
    if (!result) message.respond({returnValue: false, errorText: 'No answer from the remote control API'});
    else {
      result.returnValue = true;
      message.respond(result);
    }
  });
});
