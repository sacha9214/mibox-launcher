/*
 * A small QR code maker for one short URL: byte mode, error correction M, versions 1 to 6 (up to 106 bytes), the
 * mask with the lowest penalty. Follows the steps of Project Nayuki's QR Code generator (MIT), cut down to that.
 * QR.svg(text) → an SVG string, dark modules on white with the 4-module quiet zone.
 * Plain ES5.
 */
var QR = (function () {
  'use strict';

  // Version 1 to 6, error correction level M.
  var ECC_PER_BLOCK = [0, 10, 16, 26, 18, 24, 16];
  var BLOCKS = [0, 1, 1, 1, 2, 2, 4];
  var FORMAT_M = 0;   // the two bits for level M

  function rawModules(ver) {
    var n = (16 * ver + 128) * ver + 64;
    if (ver >= 2) {
      var align = Math.floor(ver / 7) + 2;
      n -= (25 * align - 10) * align - 55;
    }
    return n;
  }

  function dataCodewords(ver) { return Math.floor(rawModules(ver) / 8) - ECC_PER_BLOCK[ver] * BLOCKS[ver]; }

  // ---- Reed-Solomon over GF(2^8), modulus 0x11D.
  function mul(x, y) {
    var z = 0;
    for (var i = 7; i >= 0; i--) {
      z = (z << 1) ^ ((z >>> 7) * 0x11D);
      z ^= ((y >>> i) & 1) * x;
    }
    return z;
  }

  function divisor(degree) {
    var r = [];
    for (var i = 0; i < degree - 1; i++) r.push(0);
    r.push(1);
    var root = 1;
    for (i = 0; i < degree; i++) {
      for (var j = 0; j < r.length; j++) {
        r[j] = mul(r[j], root);
        if (j + 1 < r.length) r[j] ^= r[j + 1];
      }
      root = mul(root, 0x02);
    }
    return r;
  }

  function remainder(data, div) {
    var r = div.map(function () { return 0; });
    data.forEach(function (b) {
      var factor = b ^ r.shift();
      r.push(0);
      div.forEach(function (c, i) { r[i] ^= mul(c, factor); });
    });
    return r;
  }

  /** The URL's bytes (UTF-8). */
  function utf8(text) {
    var s = unescape(encodeURIComponent(text)), out = [];
    for (var i = 0; i < s.length; i++) out.push(s.charCodeAt(i));
    return out;
  }

  function encode(text) {
    var bytes = utf8(text), ver = 1;
    while (ver <= 6 && 4 + 8 + bytes.length * 8 > dataCodewords(ver) * 8) ver++;
    if (ver > 6) throw new Error('Too long for this QR maker');
    var cap = dataCodewords(ver) * 8, bits = [];
    function put(val, len) { for (var i = len - 1; i >= 0; i--) bits.push((val >>> i) & 1); }
    put(4, 4);               // byte mode
    put(bytes.length, 8);    // count (8 bits up to version 9)
    bytes.forEach(function (b) { put(b, 8); });
    put(0, Math.min(4, cap - bits.length));
    put(0, (8 - bits.length % 8) % 8);
    for (var pad = 0xEC; bits.length < cap; pad ^= 0xEC ^ 0x11) put(pad, 8);
    var data = [];
    for (var i = 0; i < bits.length; i += 8) {
      var v = 0;
      for (var j = 0; j < 8; j++) v = (v << 1) | bits[i + j];
      data.push(v);
    }
    return {ver: ver, codewords: interleave(ver, data)};
  }

  function interleave(ver, data) {
    var blocks = BLOCKS[ver], eccLen = ECC_PER_BLOCK[ver], raw = Math.floor(rawModules(ver) / 8);
    var shortBlocks = blocks - raw % blocks, shortLen = Math.floor(raw / blocks), div = divisor(eccLen), all = [];
    for (var i = 0, k = 0; i < blocks; i++) {
      var dat = data.slice(k, k + shortLen - eccLen + (i < shortBlocks ? 0 : 1));
      k += dat.length;
      var ecc = remainder(dat, div);
      if (i < shortBlocks) dat.push(0);
      all.push(dat.concat(ecc));
    }
    var out = [];
    for (i = 0; i < all[0].length; i++) {
      for (var j = 0; j < all.length; j++) {
        if (i !== shortLen - eccLen || j >= shortBlocks) out.push(all[j][i]);
      }
    }
    return out;
  }

  function build(ver, codewords, mask) {
    var size = ver * 4 + 17, m = [], fn = [];
    for (var y = 0; y < size; y++) { m.push([]); fn.push([]); for (var x = 0; x < size; x++) { m[y].push(false); fn[y].push(false); } }
    function set(x, y, dark) { m[y][x] = dark; fn[y][x] = true; }

    for (var i = 0; i < size; i++) { set(6, i, i % 2 === 0); set(i, 6, i % 2 === 0); }   // timing
    [[3, 3], [size - 4, 3], [3, size - 4]].forEach(function (c) {                          // finders
      for (var dy = -4; dy <= 4; dy++) {
        for (var dx = -4; dx <= 4; dx++) {
          var d = Math.max(Math.abs(dx), Math.abs(dy)), xx = c[0] + dx, yy = c[1] + dy;
          if (xx >= 0 && xx < size && yy >= 0 && yy < size) set(xx, yy, d !== 2 && d !== 4);
        }
      }
    });
    if (ver >= 2) {                                                                          // alignment
      var count = Math.floor(ver / 7) + 2, step = Math.ceil((ver * 4 + 4) / (count * 2 - 2)) * 2, pos = [6];
      for (var p = size - 7; pos.length < count; p -= step) pos.splice(1, 0, p);
      for (i = 0; i < pos.length; i++) {
        for (var j = 0; j < pos.length; j++) {
          if ((i === 0 && j === 0) || (i === 0 && j === pos.length - 1) || (i === pos.length - 1 && j === 0)) continue;
          for (var ay = -2; ay <= 2; ay++) {
            for (var ax = -2; ax <= 2; ax++) set(pos[i] + ax, pos[j] + ay, Math.max(Math.abs(ax), Math.abs(ay)) !== 1);
          }
        }
      }
    }
    format(0);   // reserves the format areas; drawn for real once the mask is known

    function format(maskNo) {
      var d = FORMAT_M << 3 | maskNo, rem = d;
      for (var n = 0; n < 10; n++) rem = (rem << 1) ^ ((rem >>> 9) * 0x537);
      var b = (d << 10 | rem) ^ 0x5412;
      function bit(k) { return ((b >>> k) & 1) !== 0; }
      for (var q = 0; q <= 5; q++) set(8, q, bit(q));
      set(8, 7, bit(6)); set(8, 8, bit(7)); set(7, 8, bit(8));
      for (q = 9; q < 15; q++) set(14 - q, 8, bit(q));
      for (q = 0; q < 8; q++) set(size - 1 - q, 8, bit(q));
      for (q = 8; q < 15; q++) set(8, size - 15 + q, bit(q));
      set(8, size - 8, true);
    }

    var bitIndex = 0;                                                                        // data, zigzag
    for (var right = size - 1; right >= 1; right -= 2) {
      if (right === 6) right = 5;
      for (var vert = 0; vert < size; vert++) {
        for (var k = 0; k < 2; k++) {
          var cx = right - k, upward = ((right + 1) & 2) === 0, cy = upward ? size - 1 - vert : vert;
          if (!fn[cy][cx] && bitIndex < codewords.length * 8) {
            m[cy][cx] = ((codewords[bitIndex >>> 3] >>> (7 - (bitIndex & 7))) & 1) !== 0;
            bitIndex++;
          }
        }
      }
    }

    for (y = 0; y < size; y++) {                                                             // mask
      for (x = 0; x < size; x++) {
        if (fn[y][x]) continue;
        var flip;
        switch (mask) {
          case 0: flip = (x + y) % 2 === 0; break;
          case 1: flip = y % 2 === 0; break;
          case 2: flip = x % 3 === 0; break;
          case 3: flip = (x + y) % 3 === 0; break;
          case 4: flip = (Math.floor(x / 3) + Math.floor(y / 2)) % 2 === 0; break;
          case 5: flip = x * y % 2 + x * y % 3 === 0; break;
          case 6: flip = (x * y % 2 + x * y % 3) % 2 === 0; break;
          default: flip = ((x + y) % 2 + x * y % 3) % 2 === 0;
        }
        if (flip) m[y][x] = !m[y][x];
      }
    }
    format(mask);
    return m;
  }

  /** The standard's penalty, without the finder-like pattern rule: runs of 5+, 2×2 blocks, dark/light balance. */
  function penalty(m) {
    var size = m.length, score = 0, dark = 0;
    for (var a = 0; a < 2; a++) {
      for (var i = 0; i < size; i++) {
        var run = 1;
        for (var j = 1; j < size; j++) {
          var cur = a ? m[j][i] : m[i][j], prev = a ? m[j - 1][i] : m[i][j - 1];
          if (cur === prev) { run++; if (run === 5) score += 3; else if (run > 5) score++; } else run = 1;
        }
      }
    }
    for (var y = 0; y < size - 1; y++) {
      for (var x = 0; x < size - 1; x++) {
        var c = m[y][x];
        if (c === m[y][x + 1] && c === m[y + 1][x] && c === m[y + 1][x + 1]) score += 3;
      }
    }
    for (y = 0; y < size; y++) for (x = 0; x < size; x++) if (m[y][x]) dark++;
    var total = size * size;
    return score + (Math.ceil(Math.abs(dark * 20 - total * 10) / total) - 1) * 10;
  }

  function matrix(text) {
    var e = encode(text), best = null, bestScore = Infinity;
    for (var mask = 0; mask < 8; mask++) {
      var m = build(e.ver, e.codewords, mask), s = penalty(m);
      if (s < bestScore) { best = m; bestScore = s; }
    }
    return best;
  }

  return {
    matrix: matrix,
    svg: function (text) {
      var m = matrix(text), size = m.length, quiet = 4, full = size + quiet * 2, d = '';
      for (var y = 0; y < size; y++) {
        for (var x = 0; x < size; x++) if (m[y][x]) d += 'M' + (x + quiet) + ' ' + (y + quiet) + 'h1v1h-1z';
      }
      return '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ' + full + ' ' + full + '" shape-rendering="crispEdges">' +
          '<rect width="' + full + '" height="' + full + '" fill="#fff"/><path fill="#000" d="' + d + '"/></svg>';
    }
  };
})();
