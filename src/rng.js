/* Seeded randomness: deterministic PRNG, tileable gradient noise, name coining. */
(function (FE) {
  'use strict';

  function hashString(str) {
    var h = 2166136261 >>> 0;
    for (var i = 0; i < str.length; i++) {
      h ^= str.charCodeAt(i);
      h = Math.imul(h, 16777619) >>> 0;
    }
    return h >>> 0;
  }

  function seedToInt(seed) {
    return typeof seed === 'number' ? seed >>> 0 : hashString(String(seed));
  }

  /* mulberry32 — small, fast, good enough for terrain. */
  function makeRng(seed) {
    var a = seedToInt(seed);
    var next = function () {
      a = (a + 0x6d2b79f5) >>> 0;
      var t = a;
      t = Math.imul(t ^ (t >>> 15), t | 1);
      t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
    next.range = function (lo, hi) { return lo + (hi - lo) * next(); };
    next.int = function (lo, hi) {
      var v = lo + Math.floor(next() * (hi - lo + 1));
      return v > hi ? hi : v;
    };
    next.pick = function (list) { return list[next.int(0, list.length - 1)]; };
    return next;
  }

  /* Gradient noise on an integer lattice. The x axis wraps at `period`
     so every map joins up with itself east to west, like a globe. */
  function makeNoise(seed) {
    var s = seedToInt(seed) | 0;

    function grad(ix, iy, out) {
      var h = (Math.imul(ix, 374761393) + Math.imul(iy, 668265263) + s) | 0;
      h = (h ^ (h >>> 13)) | 0;
      h = Math.imul(h, 1274126177) | 0;
      h = (h ^ (h >>> 16)) >>> 0;
      var a = (h / 4294967296) * 6.283185307179586;
      out[0] = Math.cos(a);
      out[1] = Math.sin(a);
    }

    function fade(t) { return t * t * t * (t * (t * 6 - 15) + 10); }

    var g = [0, 0];

    function noise2(x, y, period) {
      var x0 = Math.floor(x), y0 = Math.floor(y);
      var fx = x - x0, fy = y - y0;
      var u = fade(fx), v = fade(fy);
      var sum = 0;
      for (var dy = 0; dy <= 1; dy++) {
        for (var dx = 0; dx <= 1; dx++) {
          var lx = x0 + dx, ly = y0 + dy;
          var wx = lx % period; if (wx < 0) wx += period;
          grad(wx, ly, g);
          var rx = fx - dx, ry = fy - dy;
          var dot = g[0] * rx + g[1] * ry;
          var w = (dx ? u : 1 - u) * (dy ? v : 1 - v);
          sum += w * dot;
        }
      }
      return sum * 1.4;
    }

    /* x, y in [0,1]. baseFreq must be an integer for the wrap to hold. */
    function fbm(x, y, octaves, baseFreq, gain) {
      gain = gain === undefined ? 0.5 : gain;
      var amp = 1, sum = 0, norm = 0, f = baseFreq;
      for (var o = 0; o < octaves; o++) {
        sum += amp * noise2(x * f, y * f, f);
        norm += amp;
        amp *= gain;
        f *= 2;
      }
      return sum / norm;
    }

    return { noise2: noise2, fbm: fbm };
  }

  /* Plates, ranges and continents want names that sound like they came off
     a geological map rather than out of a number generator. */
  var ONSET = ['b', 'br', 'd', 'g', 'gl', 'k', 'kr', 'l', 'm', 'n', 'p', 'r', 's', 'sk', 't', 'tr', 'v', 'z', 'th', 'kh'];
  var VOWEL = ['a', 'e', 'i', 'o', 'u', 'au', 'ia', 'ae', 'ou', 'y'];
  var SOFT_CODA = ['n', 'r', 'l', 'm'];
  var CODA = ['n', 'r', 's', 'l', 'th', 'ng', 'rd', 'st', 'm', ''];

  function makeNamer(rng) {
    var used = Object.create(null);
    return function name() {
      for (var attempt = 0; attempt < 40; attempt++) {
        var syllables = rng.int(2, 3);
        var out = '';
        for (var i = 0; i < syllables; i++) {
          out += rng.pick(ONSET) + rng.pick(VOWEL);
          var last = i === syllables - 1;
          if (last) out += rng.pick(CODA);
          else if (rng() < 0.35) out += rng.pick(SOFT_CODA);
        }
        out = out.charAt(0).toUpperCase() + out.slice(1);
        if (!used[out] && out.length > 3) { used[out] = true; return out; }
      }
      return 'Terra';
    };
  }

  FE.hashString = hashString;
  FE.makeRng = makeRng;
  FE.makeNoise = makeNoise;
  FE.makeNamer = makeNamer;
})(typeof window !== 'undefined'
  ? (window.FE = window.FE || {})
  : (globalThis.FE = globalThis.FE || {}));
