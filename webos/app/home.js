/*
 * The Mi Box home screen (launcher/src/fr/sacha/tvhome/HomeActivity.java) as an LG web app: tabs of what's popular
 * on Netflix France (via JustWatch), the info line (time, EssilorLuxottica, Bitcoin, Ethereum, Solana, RAM), light
 * and dark, and a dock of the TV's apps. The remote's arrows move between three rows: tabs and buttons, the
 * shelf, the dock. The Magic Remote's pointer works too.
 * Plain ES5: older webOS runs an old Chromium.
 */
(function () {
  'use strict';

  function $(id) { return document.getElementById(id); }
  function el(tag, cls, text) {
    var e = document.createElement(tag);
    if (cls) e.className = cls;
    if (text) e.textContent = text;
    return e;
  }
  function get(k) { try { return localStorage.getItem('tvhome.' + k); } catch (e) { return null; } }
  function put(k, v) { try { localStorage.setItem('tvhome.' + k, v); } catch (e) {} }

  // ---- Scale: laid out in the Mi Box's dp (960 × 540), drawn at the screen's size --------------------------

  function fit() {
    var s = Math.min(window.innerWidth / 960, window.innerHeight / 540);
    $('stage').style.webkitTransform = $('stage').style.transform = 'scale(' + s + ')';
  }

  // ---- Theme -----------------------------------------------------------------------------------------------

  function isDark() { return get('dark') === '1'; }
  function applyTheme() { document.documentElement.className = isDark() ? 'dark' : ''; }

  // ---- Network ---------------------------------------------------------------------------------------------

  function request(method, url, body, done) {
    var x = new XMLHttpRequest(), over = false;
    function end(err, json) { if (!over) { over = true; done(err, json); } }
    x.open(method, url, true);
    x.timeout = 8000;
    if (body) x.setRequestHeader('Content-Type', 'application/json');
    x.onload = function () {
      var j = null;
      try { j = JSON.parse(x.responseText); } catch (e) {}
      end(x.status === 200 && j ? null : 'HTTP ' + x.status, j);
    };
    x.onerror = x.ontimeout = function () { end('offline', null); };
    x.send(body || null);
  }

  // ---- What's popular on Netflix France, via JustWatch (no key needed) -------------------------------------

  var JW_API = 'https://apis.justwatch.com/graphql';
  var JW_IMG = 'https://images.justwatch.com';
  var JW_QUERY = 'query($f:TitleFilter){popularTitles(country:FR,first:15,filter:$f)' +
      '{edges{node{objectType content(country:FR,language:"fr"){title posterUrl' +
      ' backdrops{backdropUrl} genres{shortName} originalReleaseYear}' +
      ' offers(country:FR,platform:WEB){package{clearName} standardWebURL}}}}}';
  var GENRES = {act: 'Action', ani: 'Animation', cmy: 'Comédie', crm: 'Crime', doc: 'Documentaire', drm: 'Drame',
    fnt: 'Fantastique', hst: 'Histoire', hrr: 'Horreur', fml: 'Famille', msc: 'Musique', trl: 'Thriller',
    rma: 'Romance', scf: 'Science-fiction', spt: 'Sport', war: 'Guerre', wsn: 'Western', rly: 'Téléréalité',
    eur: 'Européen'};

  // Tabs, each a JustWatch filter on Netflix France (on top of packages=nfx).
  var TABS = [
    ['Explorer', {}],
    ['Films', {objectTypes: ['MOVIE']}],
    ['Séries', {objectTypes: ['SHOW']}],
    ['Comédie', {genres: ['cmy'], productionCountries: ['FR']}],   // French comedy
    ['Animé', {genres: ['ani'], productionCountries: ['JP']}]];    // Japanese animation
  var REFRESH_MS = 6 * 60 * 60 * 1000;

  var lists = {}, tab = 'Explorer', lastFetch = 0, shelfStale = false;

  function parseFeed(json) {
    var out = [];
    var edges = json && json.data && json.data.popularTitles ? json.data.popularTitles.edges : [];
    for (var i = 0; i < edges.length; i++) {
      var node = edges[i].node, c = node.content || {};
      if (!c.posterUrl) continue;
      var it = {title: c.title};
      it.poster = JW_IMG + c.posterUrl.replace('{profile}', 's332').replace('{format}', 'jpg');
      it.wide = c.backdrops && c.backdrops.length
          ? JW_IMG + c.backdrops[0].backdropUrl.replace('{profile}', 's1440').replace('{format}', 'jpg')
          : it.poster;
      var sub = [node.objectType === 'SHOW' ? 'Série' : 'Film'];
      for (var g = 0; c.genres && g < Math.min(2, c.genres.length); g++) {
        if (GENRES[c.genres[g].shortName]) sub.push(GENRES[c.genres[g].shortName]);
      }
      if (c.originalReleaseYear > 0) sub.push(c.originalReleaseYear);
      sub.push('Netflix');
      it.subtitle = sub.join(' · ');
      var offers = node.offers || [];
      for (var o = 0; o < offers.length; o++) {
        var m = /netflix\.com\/title\/(\d+)/.exec(offers[o].standardWebURL || '');
        if (m) { it.netflixId = m[1]; break; }
      }
      out.push(it);
    }
    return out;
  }

  /** On the TV through our service (JustWatch refuses an app page's origin); in a browser, directly. */
  function queryJW(query, done) {
    if (!TV.webos) {
      request('POST', JW_API, JSON.stringify(query), done);
      return;
    }
    TV.service('jw', {query: query}, function (res) {
      done(res && res.json ? null : 'no answer', res && res.json);
    });
  }

  function titles(items) { return (items || []).map(function (it) { return it.title; }).join('\n'); }

  function loadFeeds() {
    lastFetch = Date.now();
    if (!lists[TABS[0][0]]) {
      // The last saved lists right away; the network's answer replaces them below.
      try {
        var cached = JSON.parse(get('lists') || 'null');
        if (cached && cached[TABS[0][0]] && cached[TABS[0][0]].length) {
          lists = cached;
          resetShelves();
        }
      } catch (e) {}
    }
    var fresh = {}, left = TABS.length, any = false;
    TABS.forEach(function (t) {
      var filter = JSON.parse(JSON.stringify(t[1]));
      filter.packages = ['nfx'];
      queryJW({query: JW_QUERY, variables: {f: filter}}, function (err, json) {
        fresh[t[0]] = err ? (lists[t[0]] || []) : parseFeed(json);
        any = any || (!err && fresh[t[0]].length > 0);
        if (--left > 0) return;
        if (!any) { lastFetch = 0; return; }   // offline: try again next time the screen shows
        var changed = TABS.some(function (x) { return titles(fresh[x[0]]) !== titles(lists[x[0]]); });
        lists = fresh;
        put('lists', JSON.stringify(lists));
        if (!changed) return;
        // Don't pull the row out from under someone browsing it.
        if (at.row === 'shelf') shelfStale = true; else resetShelves();
      });
    });
  }

  // ---- Focus: three rows, moved through with the arrows --------------------------------------------------

  var rows = {header: [], shelf: [], dock: []};
  var at = {row: 'dock', header: 0, shelf: 0, dock: 0};

  function setFocus(row, i) {
    var items = rows[row];
    if (!items.length) return false;
    i = Math.max(0, Math.min(i, items.length - 1));
    var old = rows[at.row][at[at.row]];
    if (old) old.classList.remove('focused');
    at.row = row;
    at[row] = i;
    items[i].classList.add('focused');
    if (items[i].onfocusin_) items[i].onfocusin_();
    // The shelf keeps a focused (enlarged) card clear of the edge; the dock, clear of its fading edges.
    if (row === 'shelf') reveal(shelves[tab].row, $('shelfWrap'), items[i], i === 0, 4, 10, false);
    if (row === 'dock') reveal($('dock'), $('dockBox'), items[i], false, 0, 22, true);
    return true;
  }

  /** Scrolls a row the least needed to show `item` (`edge` px clear of the ends), as a HorizontalScrollView does. */
  function reveal(row, box, item, toStart, inset, edge, fade) {
    var width = box.clientWidth - 2 * inset;
    var x = row.x_ || 0, left = item.offsetLeft, right = left + item.offsetWidth;
    var max = Math.max(0, row.scrollWidth - width);
    if (toStart) x = 0;
    else if (left - edge < x) x = left - edge;
    else if (right + edge > x + width) x = right + edge - width;
    x = Math.max(0, Math.min(x, max));
    row.x_ = x;
    row.style.webkitTransform = row.style.transform = 'translateX(' + (-x) + 'px)';
    if (fade) fadeEdges(x > 0, x < max);
  }

  /** The dock's fading edges, on the side where tiles go on past the glass. */
  function fadeEdges(left, right) {
    $('fadeLeft').classList.toggle('on', left);
    $('fadeRight').classList.toggle('on', right);
  }

  function activeTabIndex() {
    for (var i = 0; i < TABS.length; i++) if (TABS[i][0] === tab) return i;
    return 0;
  }

  function move(key) {
    var K = TV.keys, row = at.row, i = at[row];
    if (phoneOpen) {   // the phone card: OK, Back or an arrow closes it
      if (key === K.ok || key === K.left || key === K.right || key === K.up || key === K.down) closePhone();
      return true;
    }
    if (key === K.left) setFocus(row, i - 1);
    else if (key === K.right) setFocus(row, i + 1);
    else if (key === K.up) {
      if (row === 'dock') setFocus('shelf', at.shelf) || setFocus('header', activeTabIndex());
      // Going up always lands on the active tab, not whichever is closest.
      else if (row === 'shelf') setFocus('header', activeTabIndex());
    } else if (key === K.down) {
      if (row === 'header') {
        if (i < TABS.length) selectTab(TABS[i][0]);   // a tab just reached: its row now, not after the pause
        setFocus('shelf', at.shelf) || setFocus('dock', at.dock);
      }
      else if (row === 'shelf') setFocus('dock', at.dock);
    } else if (key === K.ok) {
      var e = rows[row][i];
      if (e && e.activate_) e.activate_();
    } else return false;
    return true;
  }

  /** Pointer (Magic Remote): hovering focuses, clicking opens. */
  function pointable(e, row, index) {
    e.addEventListener('mouseover', function () { if (at.row !== row || at[row] !== index) setFocus(row, index); });
    e.addEventListener('click', function () { setFocus(row, index); if (e.activate_) e.activate_(); });
  }

  // ---- Header ----------------------------------------------------------------------------------------------

  var GLYPHS = {
    // A phone: the outline, and the button at the bottom.
    phone: '<svg viewBox="0 0 100 100"><rect x="27" y="6" width="46" height="88" rx="10" fill="none" ' +
        'stroke="currentColor" stroke-width="11"/><circle cx="50" cy="76" r="6" fill="currentColor"/></svg>',
    moon: '<svg viewBox="0 0 100 100"><defs><mask id="bite"><rect width="100" height="100" fill="#fff"/>' +
        '<circle cx="72" cy="32" r="34" fill="#000"/></mask></defs>' +
        '<circle cx="50" cy="50" r="42" fill="currentColor" mask="url(#bite)"/></svg>',
    sun: (function () {
      var s = '<svg viewBox="0 0 100 100"><circle cx="50" cy="50" r="20" fill="currentColor"/>';
      for (var i = 0; i < 8; i++) {
        var a = Math.PI / 4 * i, c = Math.cos(a), n = Math.sin(a);
        s += '<line x1="' + (50 + c * 32) + '" y1="' + (50 + n * 32) + '" x2="' + (50 + c * 46) + '" y2="' + (50 + n * 46) +
            '" stroke="currentColor" stroke-width="11" stroke-linecap="round"/>';
      }
      return s + '</svg>';
    })(),
    wifi: (function () {
      var s = '<svg viewBox="0 0 100 100" fill="none" stroke="currentColor" stroke-width="11" stroke-linecap="round">';
      for (var i = 1; i <= 3; i++) {
        var r = 17 * i + 2, d = r * Math.SQRT1_2;
        s += '<path d="M' + (50 - d) + ' ' + (85 - d) + ' A' + r + ' ' + r + ' 0 0 1 ' + (50 + d) + ' ' + (85 - d) + '"/>';
      }
      return s + '</svg>';
    })(),
    // Cog: 8 square teeth around a solid ring, with a hole in the middle.
    gear: (function () {
      var d = '', teeth = 8;
      for (var i = 0; i < teeth * 4; i++) {
        var a = Math.PI * 2 * (i - 0.5) / (teeth * 4), r = (i % 4 === 1 || i % 4 === 2) ? 48 : 36;
        d += (i ? 'L' : 'M') + (50 + Math.cos(a) * r).toFixed(2) + ' ' + (50 + Math.sin(a) * r).toFixed(2);
      }
      d += 'Z M65 50 A15 15 0 1 0 35 50 A15 15 0 1 0 65 50 Z';
      return '<svg viewBox="0 0 100 100"><path fill="currentColor" fill-rule="evenodd" d="' + d + '"/></svg>';
    })()
  };

  function buildHeader() {
    var tabs = $('tabs'), right = $('right');
    rows.header = [];
    TABS.forEach(function (t, i) {
      var e = el('div', 'tab', t[0]);
      e.onfocusin_ = function () {
        clearTimeout(tabTimer);
        tabTimer = setTimeout(function () { selectTab(t[0]); }, 120);
      };
      e.activate_ = function () { selectTab(t[0]); };
      tabs.appendChild(e);
      rows.header.push(e);
      pointable(e, 'header', i);
    });
    // Moon in light mode (switch to dark), sun in dark mode (switch to light).
    round('phone', openPhone);
    var theme = round(isDark() ? 'sun' : 'moon', function () {
      put('dark', isDark() ? '0' : '1');
      applyTheme();
      theme.innerHTML = GLYPHS[isDark() ? 'sun' : 'moon'];
    });
    round('wifi', function () { TV.settings('network'); });
    round('gear', function () { TV.settings(); });
    function round(glyph, onClick) {
      var b = el('div', 'round');
      b.innerHTML = GLYPHS[glyph];
      b.activate_ = onClick;
      right.appendChild(b);
      pointable(b, 'header', rows.header.length);
      rows.header.push(b);
      return b;
    }
    styleTabs();
  }

  function styleTabs() {
    rows.header.forEach(function (e, i) {
      if (i < TABS.length) e.classList.toggle('selected', TABS[i][0] === tab);
    });
  }

  var tabTimer = null;

  function selectTab(name) {
    clearTimeout(tabTimer);
    var changed = name !== tab || !rows.shelf.length;
    tab = name;
    styleTabs();
    if (changed) buildShelf();
  }

  function tick() {
    var d = new Date();
    $('clock').textContent = ('0' + d.getHours()).slice(-2) + ':' + ('0' + d.getMinutes()).slice(-2);
  }

  // ---- Info line: EssilorLuxottica, crypto, RAM ---------------------------------------------------------

  var PRICES_URL = 'https://api.coingecko.com/api/v3/simple/price?ids=bitcoin,ethereum,solana&vs_currencies=usd';
  var PRICES_MS = 5 * 60 * 1000;
  var stock = '', prices = '', ram = '', pricesTimer = null;

  /** 72585 → "72,6k", 2134.27 → "2 134", 92.88 → "92,88" (no currency symbol), as on the Mi Box. */
  function usd(v) {
    if (v >= 10000) return (v / 1000).toFixed(1).replace('.', ',') + 'k';
    if (v >= 1000) return String(Math.round(v)).replace(/\B(?=(\d{3})+(?!\d))/g, ' ');
    return v.toFixed(2).replace('.', ',');
  }

  function updateStatus() {
    var quotes = (stock ? stock + '   ' : '') + prices;
    $('status').textContent = quotes && ram ? quotes + '   ·   ' + ram : quotes || ram;
  }

  function pricesTick() {
    request('GET', PRICES_URL, null, function (err, j) {
      if (err || !j || !j.bitcoin) return;
      prices = 'BTC ' + usd(j.bitcoin.usd) + '   ETH ' + usd(j.ethereum.usd) + '   SOL ' + usd(j.solana.usd);
      updateStatus();
    });
    TV.service('quote', {}, function (res) {
      if (res && res.price) { stock = 'EL ' + usd(res.price); updateStatus(); }
    });
    updateRam();
    clearTimeout(pricesTimer);
    pricesTimer = setTimeout(pricesTick, PRICES_MS);
  }

  function updateRam() {
    TV.service('ram', {}, function (res) {
      if (res && typeof res.used === 'number') { ram = 'RAM ' + res.used + ' %'; updateStatus(); }
    });
  }

  // ---- Featured shelf ------------------------------------------------------------------------------------

  // Each tab's row is built once and kept (hidden when another tab shows): moving along the tabs only swaps
  // rows, instead of rebuilding 15 cards and decoding their pictures again.
  var shelves = {};

  /** Shows the active tab's row, back at its start, building it the first time. */
  function buildShelf() {
    shelfStale = false;
    var shelf = $('shelf');
    if (!shelves[tab]) shelves[tab] = makeRow(lists[tab] || []);
    for (var name in shelves) shelves[name].row.style.display = name === tab ? '' : 'none';
    var row = shelves[tab].row;
    row.x_ = 0;
    row.style.webkitTransform = row.style.transform = '';
    rows.shelf = shelves[tab].cards;
    at.shelf = 0;
    if (!rows.shelf.length) {
      delete shelves[tab];   // the loading message: built again once the lists are in
      if (at.row === 'shelf') setFocus('header', activeTabIndex());
      return;
    }
    if (at.row === 'shelf') setFocus('shelf', 0);
  }

  /** New lists: every row is built again (the active one now, the others when shown). */
  function resetShelves() {
    $('shelf').innerHTML = '';
    shelves = {};
    buildShelf();
  }

  function makeRow(items) {
    var row = el('div', 'row'), cards = [];
    $('shelf').appendChild(row);
    if (!items.length) {
      row.appendChild(el('div', 'empty', 'Chargement des films et séries…'));
      return {row: row, cards: cards};
    }
    var cardH = 250;
    items.forEach(function (it, i) {
      var hero = i === 0;
      var w = hero ? Math.floor(cardH * 16 / 7) + 24 : Math.floor(cardH * 2 / 3) + 8;
      var card = el('div', hero ? 'card hero' : 'card');
      card.style.width = w + 'px';
      var frame = el('div', 'frame');
      var img = new Image();
      img.decoding = 'async';   // decoded off the main thread: no hitch when a row first shows
      img.onload = function () { img.className = 'loaded'; };
      img.src = hero ? it.wide : it.poster;
      frame.appendChild(img);
      card.appendChild(frame);
      card.appendChild(el('div', 'title', it.title));
      if (hero && it.subtitle) card.appendChild(el('div', 'sub', it.subtitle));
      // Opens the title in Netflix (or Netflix itself when JustWatch gave no link).
      card.activate_ = function () {
        if (it.netflixId) TV.netflix(it.netflixId); else TV.launch('netflix');
      };
      row.appendChild(card);
      cards.push(card);
      pointable(card, 'shelf', i);
    });
    return {row: row, cards: cards};
  }

  // ---- App dock ----------------------------------------------------------------------------------------

  // Apps shown first, in this order (matched on their name or id); the rest follow alphabetically.
  var PREFERRED = ['freetv', 'oqee', 'netflix', 'youtube', 'prime', 'amazon', 'francetv', 'arte', 'plex', 'vlc'];

  function norm(s) { return String(s || '').toLowerCase().replace(/[^a-z0-9]/g, ''); }

  function rank(app) {
    var t = norm(app.title), id = norm(app.id);
    for (var i = 0; i < PREFERRED.length; i++) {
      if (t.indexOf(PREFERRED[i]) >= 0 || id.indexOf(PREFERRED[i]) >= 0) return i;
    }
    return PREFERRED.length;
  }

  /** The Mi Box's wide logo for this app, when the build has one (webos/build.py, from launcher/assets/demo). */
  function logo(app) {
    var logos = (window.CONFIG && CONFIG.logos) || {}, t = norm(app.title), id = norm(app.id);
    for (var k in logos) {
      if (t.indexOf(k) >= 0 || id.indexOf(k) >= 0 || (k === 'prime' && id === 'amazon')) return logos[k];
    }
    return '';
  }

  function buildDock(apps) {
    apps = apps.slice().sort(function (x, y) {
      var a = rank(x), b = rank(y);
      return a !== b ? a - b : x.title.toLowerCase() < y.title.toLowerCase() ? -1 : 1;
    });
    var dock = $('dock'), keep = at.dock;
    dock.innerHTML = '';
    rows.dock = [];
    apps.forEach(function (app, i) {
      var tile = el('div', 'tile'), banner = logo(app);
      if (banner) {
        var b = new Image();
        b.className = 'banner';
        b.src = banner;
        tile.appendChild(b);
      } else {
        tile.style.background = app.color || '#3A3A44';
        if (app.icon) {
          var ic = new Image();
          ic.className = 'icon';
          ic.onerror = function () { tile.removeChild(ic); tile.appendChild(el('div', 'name', app.title)); };
          ic.src = app.icon;
          tile.appendChild(ic);
        } else tile.appendChild(el('div', 'name', app.title));
      }
      tile.activate_ = function () { TV.launch(app.id); };
      dock.appendChild(tile);
      rows.dock.push(tile);
      pointable(tile, 'dock', i);
    });
    if (at.row === 'dock') setFocus('dock', keep);
    else reveal(dock, $('dockBox'), rows.dock[0] || dock, true, 0, 22, true);
  }

  // ---- Phone: a QR code to the page the TV serves (webos/service/phone.html) ---------------------------------

  var phoneOpen = false;

  function openPhone() {
    TV.service('phone', {}, function (res) {
      var url = res ? res.url : (TV.webos ? '' : 'http://192.168.1.120:8090');   // a browser shows an example
      var card = el('div', 'phone-card');
      card.appendChild(el('div', 'phone-title', 'Trouver un film depuis ton téléphone'));
      if (url) {
        var code = el('div', 'phone-qr');
        code.innerHTML = QR.svg(url);
        card.appendChild(code);
        card.appendChild(el('div', 'phone-text', "Scanne avec l'appareil photo, sur le Wi-Fi de la maison."));
        card.appendChild(el('div', 'phone-url', url.replace(/^http:\/\//, '')));
        if (res && !res.ai) card.appendChild(el('div', 'phone-text', "La recherche par l'IA n'est pas réglée sur cette télé."));
      } else card.appendChild(el('div', 'phone-text', "La télé n'a pas d'adresse sur le Wi-Fi."));
      card.appendChild(el('div', 'phone-hint', 'OK pour fermer'));
      var shade = el('div', 'phone-shade');
      shade.id = 'phone';
      shade.appendChild(card);
      shade.addEventListener('click', closePhone);
      $('stage').appendChild(shade);
      phoneOpen = true;
    });
  }

  function closePhone() {
    var shade = $('phone');
    if (shade) shade.parentNode.removeChild(shade);
    phoneOpen = false;
  }

  // ---- Speed test (opened with {"perf": "label"}): moves through every row, logs the frame times ----------

  function speedTest(label) {
    var K = TV.keys, script = [], frames = [], last = 0, section = '', done = false;
    function add(name, key, n) { for (var i = 0; i < n; i++) script.push([name, key]); }
    add('dock', K.right, 8); add('dock', K.left, 8);
    add('move', K.up, 1); add('shelf', K.right, 6); add('shelf', K.left, 6);
    add('move', K.up, 1); add('tabs', K.right, 4); add('tabs', K.left, 4);
    add('move', K.down, 2);
    function frame(t) {
      if (last && section) frames.push([section, t - last]);
      last = t;
      if (!done) requestAnimationFrame(frame);
    }
    requestAnimationFrame(frame);
    var i = 0;
    var step = setInterval(function () {
      if (i >= script.length) {
        clearInterval(step);
        done = true;
        var out = {perf: label, ua: navigator.userAgent, dpr: window.devicePixelRatio, w: window.innerWidth,
          h: window.innerHeight, memory: navigator.deviceMemory, cpus: navigator.hardwareConcurrency, sections: {}};
        ['dock', 'shelf', 'tabs', 'move'].forEach(function (s) {
          var ms = frames.filter(function (f) { return f[0] === s; }).map(function (f) { return f[1]; }).sort(function (a, b) { return a - b; });
          if (!ms.length) return;
          var sum = ms.reduce(function (a, b) { return a + b; }, 0);
          out.sections[s] = {frames: ms.length, fps: Math.round(1000 * ms.length / sum), p95: Math.round(ms[Math.floor(ms.length * 0.95)]),
            worst: Math.round(ms[ms.length - 1]), over33: ms.filter(function (m) { return m > 33.4; }).length};
        });
        TV.service('log', out);
        return;
      }
      section = script[i][0];
      move(script[i][1]);
      i++;
    }, 350);
  }

  // ---- Start ----------------------------------------------------------------------------------------------

  function shown() {
    tick();
    pricesTick();
    // The app stays alive for days in the background: refresh the lists when they get old.
    if (Date.now() - lastFetch > REFRESH_MS) loadFeeds();
    else if (shelfStale && at.row !== 'shelf') resetShelves();
  }

  window.addEventListener('resize', fit);
  document.addEventListener('keydown', function (e) {
    // Back does nothing, as on the Mi Box: this is the home screen (LG's home would only bring it back).
    if (e.keyCode === TV.keys.back) {
      e.preventDefault();
      if (phoneOpen) closePhone();
      return;
    }
    if (move(e.keyCode)) e.preventDefault();
  });
  document.addEventListener('visibilitychange', function () { if (!document.hidden) shown(); });
  document.addEventListener('webOSRelaunch', function () {
    // With handlesRelaunch, opening the app again (number key, the watcher) only sends this event: the app has
    // to come to the front itself.
    if (window.PalmSystem && window.PalmSystem.activate) window.PalmSystem.activate();
    shown();
    var perf = TV.launchParams().perf;
    if (perf) speedTest(perf);
  });

  applyTheme();
  fit();
  buildHeader();
  buildShelf();
  TV.onApps = buildDock;   // the full list, once the TV has allowed it
  TV.apps(function (apps) {
    buildDock(apps);
    if (at.row === 'dock' && rows.dock.length) setFocus('dock', 0);
    else if (!rows.dock.length) setFocus('header', 0);
  });
  setInterval(tick, 15000);
  shown();
  TV.watch();
  if (TV.launchParams().perf) setTimeout(function () { speedTest(TV.launchParams().perf); }, 5000);
})();
