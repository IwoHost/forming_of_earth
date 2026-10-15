/* Climate laid over the finished terrain: sunlight by latitude, lapse rate by
   altitude, and moisture carried inland by the prevailing winds until the
   mountains wring it out. */
(function (FE) {
  'use strict';

  /* Tunable constants for the water cycle, gathered so they can be swept
     against real-world figures rather than guessed at one at a time. */
  var C = {
    rainScale: 72000,   // moisture units to millimetres a year over land
    oceanRain: 2600,    // the same over open water
    baseShare: 0.045,   // of the air's moisture that falls per cell crossed
    orographic: 0.55,   // extra share per 900 m the ground climbs
    evaporation: 0.30,  // recharge per cell of open water
    recycle: 0.55,      // rain handed back to the air by wet, warm ground
    recycleAt: 0.45,    // moisture the air needs before the ground gives back
    runoff: 0.997,      // what the rest of the water loses to the sea
    beltSharp: 2.0      // how much harder the dry belts bite over land
  };

  var B = {
    ICE: 0, TUNDRA: 1, TAIGA: 2, TEMPERATE: 3, GRASSLAND: 4, SHRUB: 5,
    DESERT: 6, SAVANNA: 7, SEASONAL: 8, RAINFOREST: 9, ALPINE: 10, BARE: 11,
    SHELF: 12, OCEAN: 13, ABYSS: 14, SEA_ICE: 15
  };

  var BIOME_NAMES = [
    'Ice sheet', 'Tundra', 'Taiga', 'Temperate forest', 'Grassland', 'Shrubland',
    'Desert', 'Savanna', 'Seasonal forest', 'Rainforest', 'Alpine', 'Bare rock',
    'Continental shelf', 'Ocean', 'Abyssal plain', 'Sea ice'
  ];

  /* Rain belts: easterlies at the tropics and the poles, westerlies between.
     Returns the direction the wind blows, in grid columns. */
  function windDir(latAbs) {
    if (latAbs < 30) return -1;
    if (latAbs < 60) return 1;
    return -1;
  }

  /* Earth's mean rainfall by latitude, sampled every ten degrees and scaled
     to a multiplier: wet where air rises at the equator and again along the
     polar front, dry where it sinks over the horse latitudes. */
  var RAIN_BELT = [1.00, 0.94, 0.58, 0.42, 0.62, 0.78, 0.66, 0.46, 0.31, 0.26];

  function beltAt(latAbs) {
    var t = Math.min(8.999, latAbs / 10);
    var i = Math.floor(t);
    return RAIN_BELT[i] + (RAIN_BELT[i + 1] - RAIN_BELT[i]) * (t - i);
  }

  function Climate(world) {
    var n = world.width * world.height;
    this.world = world;
    this.temp = new Float32Array(n);      // degrees C
    this.rain = new Float32Array(n);      // millimetres a year
    this.biome = new Uint8Array(n);
    this.warmth = 0;                      // greenhouse offset in degrees
    this.moisture = new Float32Array(n);
  }

  Climate.prototype.update = function () {
    var w = this.world, W = w.width, H = w.height;
    var h = w.height_, sea = w.seaLevel, temp = this.temp;
    var scale = FE.World.ELEV_SCALE;

    for (var y = 0; y < H; y++) {
      var lat = ((y + 0.5) / H) * 180 - 90;
      var latAbs = Math.abs(lat);
      /* Fitted to Earth's mean annual temperature by latitude: about 27 C at
         the equator, 13 C at 45 degrees, -26 C at the poles. */
      var base = 27 - 53 * Math.pow(latAbs / 90, 1.9) + this.warmth;
      for (var x = 0; x < W; x++) {
        var i = y * W + x;
        var metres = (h[i] - sea) * scale;
        var t = base;
        if (metres > 0) t -= (metres / 1000) * 6.5;   // environmental lapse rate
        else t = t * 0.92 + 1.5;                       // water evens out extremes
        temp[i] = t;
      }
    }

    this.flow();
    /* One zonal pass gives hard stripes. Real weather wanders: a light blur
       stands in for storm tracks and monsoons crossing the prevailing wind. */
    this.smoothRain();
    this.classify();
    return this;
  };

  /* March moisture downwind, evaporating over water and raining it out over
     land — hardest where the ground climbs into the wind. */
  Climate.prototype.flow = function () {
    var w = this.world, W = w.width, H = w.height;
    var h = w.height_, sea = w.seaLevel, temp = this.temp;
    var rain = this.rain, carry = this.moisture;
    var scale = FE.World.ELEV_SCALE;

    for (var y = 0; y < H; y++) {
      var lat = ((y + 0.5) / H) * 180 - 90;
      var latAbs = Math.abs(lat);
      var dir = windDir(latAbs);
      var belt = beltAt(latAbs);
      /* Sinking air shuts off rain over land far more completely than over
         the sea, where evaporation keeps feeding it. The subtropical deserts
         sit in the same latitudes as some of the wetter stretches of ocean. */
      var landBelt = Math.pow(belt, C.beltSharp);

      var m = 0.5;
      var start = dir > 0 ? 0 : W - 1;
      /* Two laps: the first primes the air, the second is recorded. */
      for (var pass = 0; pass < 2; pass++) {
        for (var k = 0; k < W; k++) {
          var x = (start + dir * k % W + W * 2) % W;
          var i = y * W + x;
          var prevX = (x - dir + W) % W;
          var elev = Math.max(0, (h[i] - sea) * scale);
          var prevElev = Math.max(0, (h[y * W + prevX] - sea) * scale);

          if (h[i] <= sea) {
            /* Warm seas feed the air; cold ones barely do. */
            var evap = Math.max(0.05, Math.min(1, (temp[i] + 5) / 32));
            m += (1 - m) * C.evaporation * evap;
            if (pass === 1) rain[i] = (0.25 + 0.75 * m) * belt * C.oceanRain;
          } else {
            var climb = Math.max(0, elev - prevElev) / 900;   // orographic lift
            var share = Math.min(0.85, C.baseShare + climb * C.orographic);
            var fall = m * share;
            m -= fall;
            /* Forests and wet ground hand water straight back to the air.
               Roughly half the rain over a warm, well-watered interior fell
               before, which is what keeps a continent's heart from drying out
               the moment the coast is behind it — and why, once an interior
               does dry, it stays dry. */
            var warm = Math.max(0, Math.min(1, (temp[i] + 4) / 28));
            var green = Math.min(1, m / C.recycleAt);
            m += fall * C.recycle * warm * green;
            m *= C.runoff;                                     // runoff to the sea
            if (pass === 1) rain[i] = fall * landBelt * C.rainScale;
          }
        }
      }
      carry[y] = m;
    }
  };

  Climate.prototype.smoothRain = function () {
    var W = this.world.width, H = this.world.height;
    var rain = this.rain, out = this.smoothBuf || (this.smoothBuf = new Float32Array(W * H));
    for (var y = 0; y < H; y++) {
      var up = y > 0 ? y - 1 : 0, dn = y < H - 1 ? y + 1 : H - 1;
      for (var x = 0; x < W; x++) {
        var xl = x > 0 ? x - 1 : W - 1, xr = x < W - 1 ? x + 1 : 0;
        out[y * W + x] = (
          rain[up * W + xl] + rain[up * W + x] + rain[up * W + xr] +
          rain[y * W + xl] + rain[y * W + x] * 4 + rain[y * W + xr] +
          rain[dn * W + xl] + rain[dn * W + x] + rain[dn * W + xr]) / 12;
      }
    }
    this.rain = out;
    this.smoothBuf = rain;
  };

  Climate.prototype.classify = function () {
    var w = this.world, n = w.width * w.height;
    var h = w.height_, sea = w.seaLevel;
    var temp = this.temp, rain = this.rain, biome = this.biome;
    var scale = FE.World.ELEV_SCALE;

    for (var i = 0; i < n; i++) {
      var metres = (h[i] - sea) * scale;
      var t = temp[i], r = rain[i];
      var b;
      if (metres <= 0) {
        if (t < -2) b = B.SEA_ICE;
        else if (metres > -350) b = B.SHELF;
        else if (metres > -3800) b = B.OCEAN;
        else b = B.ABYSS;
      } else if (t < -9) {
        b = B.ICE;
      } else if (metres > 3200 && t < 3) {
        b = t < -4 ? B.ICE : B.ALPINE;
      } else if (t < 0) {
        b = B.TUNDRA;
      } else if (t < 6) {
        b = r < 240 ? B.SHRUB : B.TAIGA;
      } else if (t < 19) {
        if (r < 230) b = B.DESERT;
        else if (r < 520) b = B.GRASSLAND;
        else if (r < 850) b = B.SHRUB;
        else b = B.TEMPERATE;
      } else {
        if (r < 190) b = B.DESERT;
        else if (r < 620) b = B.SAVANNA;
        else if (r < 1400) b = B.SEASONAL;
        else b = B.RAINFOREST;
      }
      /* Steep, high ground keeps its rock bare whatever the climate. */
      if (b !== B.ICE && b !== B.ALPINE && metres > 4200) b = B.BARE;
      biome[i] = b;
    }
  };

  Climate.prototype.summary = function () {
    var w = this.world, W = w.width, H = w.height, h = w.height_, sea = w.seaLevel;
    var sum = 0, land = 0, ice = 0, dry = 0, wet = 0;
    for (var y = 0, i = 0; y < H; y++) {
      var a = w.rowArea[y];
      for (var x = 0; x < W; x++, i++) {
        sum += this.temp[i] * a;
        var b = this.biome[i];
        if (b === FE.Biome.ICE || b === FE.Biome.SEA_ICE) ice += a;
        if (h[i] > sea) {
          land += a;
          if (b === FE.Biome.DESERT) dry += a;
          if (b === FE.Biome.RAINFOREST || b === FE.Biome.SEASONAL) wet += a;
        }
      }
    }
    return {
      meanTemp: sum / w.areaTotal,
      iceFraction: ice / w.areaTotal,
      desertShare: land ? dry / land : 0,
      forestShare: land ? wet / land : 0
    };
  };

  FE.ClimateConstants = C;
  FE.Biome = B;
  FE.BIOME_NAMES = BIOME_NAMES;
  FE.Climate = Climate;
})(typeof window !== 'undefined'
  ? (window.FE = window.FE || {})
  : (globalThis.FE = globalThis.FE || {}));
