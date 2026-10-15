/* Draws the planet into an offscreen buffer one cell per pixel, then scales
   that up to the display canvas. Every view shares the same relief shading so
   the terrain stays legible underneath the data. */
(function (FE) {
  'use strict';

  var BIOME_COLOR = [
    [238, 242, 246],  // ice sheet
    [154, 165, 143],  // tundra
    [ 60,  92,  69],  // taiga
    [ 74, 122,  68],  // temperate forest
    [154, 171,  92],  // grassland
    [168, 154,  98],  // shrubland
    [217, 189, 135],  // desert
    [194, 178,  96],  // savanna
    [ 95, 138,  67],  // seasonal forest
    [ 47, 107,  56],  // rainforest
    [185, 190, 196],  // alpine
    [141, 133, 120],  // bare rock
    [ 79, 147, 168],  // continental shelf
    [ 42,  95, 128],  // ocean
    [ 22,  58,  88],  // abyssal plain
    [218, 231, 238]   // sea ice
  ];

  /* Hypsometric tints, the convention printed on physical relief maps. */
  var LAND_RAMP = [
    [0, [66, 110, 70]], [300, [116, 148, 78]], [900, [186, 180, 108]],
    [2000, [160, 124, 84]], [3500, [138, 116, 104]], [5000, [196, 196, 198]],
    [7200, [255, 255, 255]]
  ];
  var SEA_RAMP = [
    [-11000, [12, 30, 52]], [-4500, [22, 60, 96]], [-2000, [34, 86, 124]],
    [-350, [66, 130, 158]], [0, [108, 170, 186]]
  ];
  var TEMP_RAMP = [
    [-45, [38, 46, 120]], [-20, [58, 108, 178]], [0, [116, 178, 205]],
    [12, [224, 214, 150]], [26, [222, 150, 74]], [42, [174, 52, 42]]
  ];
  var RAIN_RAMP = [
    [0, [206, 184, 142]], [250, [196, 190, 128]], [700, [128, 172, 128]],
    [1500, [56, 136, 124]], [2800, [34, 96, 122]], [5000, [26, 58, 104]]
  ];
  var AGE_RAMP = [
    [0, [214, 70, 52]], [40, [228, 136, 56]], [100, [226, 196, 86]],
    [200, [118, 178, 120]], [350, [62, 126, 176]], [600, [48, 62, 134]]
  ];

  function ramp(table, v, out) {
    if (v <= table[0][0]) { copy(table[0][1], out); return; }
    for (var i = 1; i < table.length; i++) {
      if (v <= table[i][0]) {
        var a = table[i - 1], b = table[i];
        var t = (v - a[0]) / (b[0] - a[0]);
        out[0] = a[1][0] + (b[1][0] - a[1][0]) * t;
        out[1] = a[1][1] + (b[1][1] - a[1][1]) * t;
        out[2] = a[1][2] + (b[1][2] - a[1][2]) * t;
        return;
      }
    }
    copy(table[table.length - 1][1], out);
  }

  function copy(src, out) { out[0] = src[0]; out[1] = src[1]; out[2] = src[2]; }

  /* Distinct plate hues spaced by the golden angle so neighbours never match. */
  function plateColor(index, out) {
    var hue = (index * 137.508) % 360;
    hsl(hue, 0.33, 0.50, out);
  }

  function hsl(h, s, l, out) {
    h /= 360;
    var q = l < 0.5 ? l * (1 + s) : l + s - l * s;
    var p = 2 * l - q;
    out[0] = hue2rgb(p, q, h + 1 / 3) * 255;
    out[1] = hue2rgb(p, q, h) * 255;
    out[2] = hue2rgb(p, q, h - 1 / 3) * 255;
  }

  function hue2rgb(p, q, t) {
    if (t < 0) t += 1;
    if (t > 1) t -= 1;
    if (t < 1 / 6) return p + (q - p) * 6 * t;
    if (t < 1 / 2) return q;
    if (t < 2 / 3) return p + (q - p) * (2 / 3 - t) * 6;
    return p;
  }

  function Renderer(world) {
    this.resize(world);
  }

  Renderer.prototype.resize = function (world) {
    var W = world.width, H = world.height;
    this.W = W; this.H = H;
    this.canvas = document.createElement('canvas');
    this.canvas.width = W;
    this.canvas.height = H;
    this.ctx = this.canvas.getContext('2d');
    this.image = this.ctx.createImageData(W, H);
  };

  var rgb = [0, 0, 0];

  Renderer.prototype.draw = function (world, climate, opts) {
    var W = this.W, H = this.H;
    if (world.width !== W || world.height !== H) this.resize(world);
    var mode = opts.mode || 'terrain';
    var data = this.image.data;
    var h = world.height_, sea = world.seaLevel, plate = world.plate;
    var stress = world.stress, crustAge = world.crustAge;
    var scale = FE.World.ELEV_SCALE;
    var biome = climate.biome, temp = climate.temp, rain = climate.rain;
    var showBounds = opts.boundaries && (mode === 'terrain' || mode === 'relief');

    for (var y = 0; y < H; y++) {
      var yUp = y > 0 ? y - 1 : 0, yDn = y < H - 1 ? y + 1 : H - 1;
      for (var x = 0; x < W; x++) {
        var i = y * W + x;
        var xl = x > 0 ? x - 1 : W - 1, xr = x < W - 1 ? x + 1 : 0;
        var metres = (h[i] - sea) * scale;
        var wet = metres <= 0;

        switch (mode) {
          case 'relief': ramp(wet ? SEA_RAMP : LAND_RAMP, metres, rgb); break;
          case 'temperature': ramp(TEMP_RAMP, temp[i], rgb); break;
          case 'rainfall':
            if (wet) { rgb[0] = 30; rgb[1] = 44; rgb[2] = 60; }
            else ramp(RAIN_RAMP, rain[i], rgb);
            break;
          case 'age':
            if (wet) ramp(AGE_RAMP, crustAge[i], rgb);
            else { rgb[0] = 74; rgb[1] = 70; rgb[2] = 66; }
            break;
          case 'plates':
            plateColor(plate[i], rgb);
            if (wet) { rgb[0] *= 0.62; rgb[1] *= 0.62; rgb[2] *= 0.68; }
            break;
          default: copy(BIOME_COLOR[biome[i]], rgb);
        }

        /* Relief shading: light from the north-west, as maps are drawn. */
        var dzdx = (h[y * W + xr] - h[y * W + xl]) * (wet ? 3.5 : 9);
        var dzdy = (h[yDn * W + x] - h[yUp * W + x]) * (wet ? 3.5 : 9);
        var lambert = (1 + dzdx * 0.6 + dzdy * 0.6) /
                      Math.sqrt(dzdx * dzdx + dzdy * dzdy + 1);
        var shade = 0.62 + 0.46 * lambert;
        if (shade < 0.35) shade = 0.35; else if (shade > 1.45) shade = 1.45;
        if (mode === 'temperature' || mode === 'rainfall') shade = 0.85 + (shade - 1) * 0.35;

        var r = rgb[0] * shade, g = rgb[1] * shade, b = rgb[2] * shade;

        /* A darker lip where the land meets the water reads as a coastline. */
        if (!wet && mode !== 'plates' && mode !== 'age') {
          if (h[y * W + xl] <= sea || h[y * W + xr] <= sea ||
              h[yUp * W + x] <= sea || h[yDn * W + x] <= sea) {
            r *= 0.72; g *= 0.74; b *= 0.78;
          }
        }

        if (showBounds || mode === 'plates') {
          var edge = plate[i] !== plate[y * W + xr] || plate[i] !== plate[yDn * W + x];
          if (edge) {
            var s = stress[i];
            /* Red where plates close, blue where they pull apart. */
            var target = s > 0 ? [236, 94, 52] : [92, 188, 230];
            var mix = mode === 'plates'
              ? Math.min(0.92, 0.45 + Math.abs(s) * 0.9)
              : Math.min(0.70, 0.26 + Math.abs(s) * 0.7);
            r += (target[0] - r) * mix;
            g += (target[1] - g) * mix;
            b += (target[2] - b) * mix;
          }
        }

        var o = i * 4;
        data[o] = r; data[o + 1] = g; data[o + 2] = b; data[o + 3] = 255;
      }
    }

    this.ctx.putImageData(this.image, 0, 0);
    return this.canvas;
  };

  Renderer.prototype.blit = function (ctx, width, height) {
    ctx.imageSmoothingEnabled = true;
    if ('imageSmoothingQuality' in ctx) ctx.imageSmoothingQuality = 'high';
    ctx.clearRect(0, 0, width, height);
    ctx.drawImage(this.canvas, 0, 0, width, height);
  };

  /* Legends are generated from the same ramps the map uses, so they can never
     drift out of step with it. */
  function rampStops(table, format) {
    return table.map(function (entry) {
      var c = entry[1];
      return { label: format(entry[0]), color: 'rgb(' + c.join(',') + ')' };
    });
  }

  FE.Renderer = Renderer;
  FE.BIOME_COLOR = BIOME_COLOR;
  FE.LEGENDS = {
    relief: function () {
      return rampStops(LAND_RAMP, function (v) {
        return v >= 1000 ? (v / 1000) + ' km' : v + ' m';
      });
    },
    temperature: function () {
      return rampStops(TEMP_RAMP, function (v) { return v + '°'; });
    },
    rainfall: function () {
      return rampStops(RAIN_RAMP, function (v) {
        return v >= 1000 ? (v / 1000) + 'k' : String(v);
      });
    },
    age: function () {
      return rampStops(AGE_RAMP, function (v) { return v + ''; });
    }
  };
})(typeof window !== 'undefined'
  ? (window.FE = window.FE || {})
  : (globalThis.FE = globalThis.FE || {}));
