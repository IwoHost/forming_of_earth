/* The planet itself: a cylindrical grid of crust pushed around by drifting
   plates, raised at collisions, torn open at rifts, worn down by weather.

   Heights are unitless. 0 is roughly the top of fresh continental crust;
   ELEV_SCALE converts the distance from sea level into metres. */
(function (FE) {
  'use strict';

  var ELEV_SCALE = 8000;   // metres per unit of height
  var MA_PER_STEP = 2;     // millions of years in one simulation step
  var EARTH_CIRCUM_KM = 40075;

  /* Tuned so a collision belt takes tens of steps to build a cordillera
     and erosion can still flatten one given long enough. */
  var K = {
    oceanBase: -0.65,     // fresh ocean floor before it has cooled
    ridgeHeight: -0.31,   // a spreading ridge crest, ~2.5 km down
    subsidence: 0.33,     // how much further old sea floor sinks
    subAge: 80,           // Ma for that subsidence to run its course
    coolRate: 0.040,
    healRate: 0.012,      // trenches and rifts fill back in slowly
    crustLine: -0.22,     // above this the crust counts as continental
    contRise: 0.75,       // how far continental crust floats above the abyss
    cratonShare: 0.40,    // fraction of the surface that starts as continent
    collide: 0.030,       // continent against continent: fold mountains
    arc: 0.019,           // ocean under continent: volcanic arc
    trench: 0.016,        // the down-going slab pulls a trench open
    rift: 0.011,          // continental crust pulled apart thins and drops
    spread: 0.09,         // new sea floor relaxes toward ridge height
    hotspot: 0.030,
    isoCeiling: 0.80,     // uplift fades as crust approaches this
    talus: 0.30,          // slope a hillside holds before it slumps
    thermal: 0.30,
    hydro: 0.10,
    warp: 26,             // how far plate outlines wander off a circle
    edgeDrift: 0.55       // boundaries migrate slower than the crust they carry
  };

  var DEFAULTS = {
    width: 256,
    height: 144,
    plateCount: 11,
    drift: 1,
    erosion: 1,
    volcanism: 1,
    seaFraction: 0.68,
    spinUp: 32
  };

  function World(opts) {
    opts = opts || {};
    this.width = opts.width || DEFAULTS.width;
    this.height = opts.height || DEFAULTS.height;
    this.params = {
      plateCount: opts.plateCount || DEFAULTS.plateCount,
      drift: opts.drift === undefined ? DEFAULTS.drift : opts.drift,
      erosion: opts.erosion === undefined ? DEFAULTS.erosion : opts.erosion,
      volcanism: opts.volcanism === undefined ? DEFAULTS.volcanism : opts.volcanism,
      seaFraction: opts.seaFraction === undefined ? DEFAULTS.seaFraction : opts.seaFraction
    };
    var n = this.width * this.height;
    this.height_ = new Float32Array(n);   // elevation field
    this.scratch = new Float32Array(n);
    this.delta = new Float32Array(n);
    this.uplift = new Float32Array(n);
    this.upliftB = new Float32Array(n);
    this.plate = new Int16Array(n);
    this.vx = new Float32Array(n);
    this.vy = new Float32Array(n);
    this.stress = new Float32Array(n);    // + convergent, - divergent
    this.crustAge = new Float32Array(n);
    this.warpX = new Float32Array(n);
    this.warpY = new Float32Array(n);
    this.landId = new Int32Array(n);
    this.stack = new Int32Array(n);
    /* The grid is equirectangular, so a polar row covers far less ground than
       an equatorial one. Every area, mean and volume is weighted by cos(lat)
       to keep the numbers honest. */
    this.rowArea = new Float32Array(this.height);
    this.areaTotal = 0;
    for (var ry = 0; ry < this.height; ry++) {
      var latR = (((ry + 0.5) / this.height) * 180 - 90) * Math.PI / 180;
      this.rowArea[ry] = Math.max(0.02, Math.cos(latR));
      this.areaTotal += this.rowArea[ry] * this.width;
    }
    this.reset(opts.seed === undefined ? 'earth' : opts.seed, opts.spinUp);
  }

  World.prototype.reset = function (seed, spinUp) {
    var W = this.width, H = this.height, n = W * H;
    this.seed = String(seed);
    this.rng = FE.makeRng(this.seed);
    this.noise = FE.makeNoise(this.seed);
    this.name = FE.makeNamer(this.rng);
    this.age = 0;
    this.seaHistory = null;
    this.events = [];
    this.stats = null;
    this.prevStats = null;
    this.milestones = {};
    this.stepCount = 0;

    /* Early crust separates into two kinds, and the gap between them is what
       gives a planet a shoreline: light continental rafts floating high, dense
       ocean floor lying low, joined by a steep continental slope. The cut is
       taken at a quantile so the continental share comes out as intended
       whatever shape the noise happens to have. */
    var h = this.height_, noise = this.noise;
    var craton = this.scratch;
    for (var y = 0; y < H; y++) {
      for (var x = 0; x < W; x++) craton[y * W + x] = noise.fbm(x / W, y / H, 4, 2);
    }
    var cut = quantile(craton, this.rowArea, W, H, this.areaTotal, 1 - K.cratonShare);
    for (var y2 = 0; y2 < H; y2++) {
      for (var x2 = 0; x2 < W; x2++) {
        var i2 = y2 * W + x2;
        var grain = noise.fbm(x2 / W + 3.1, y2 / H + 1.7, 6, 5);
        var raft = smoothstep(cut - 0.045, cut + 0.045, craton[i2]);
        h[i2] = K.oceanBase + raft * K.contRise + grain * 0.045;
      }
    }
    craton.fill(0);

    /* Plate outlines follow a warped Voronoi diagram: the warp is fixed for
       the life of the world, so boundaries stay ragged as the plates drift. */
    var wnoise = FE.makeNoise(this.seed + ':warp');
    for (var i = 0, yy = 0; yy < H; yy++) {
      for (var xx = 0; xx < W; xx++, i++) {
        this.warpX[i] = wnoise.fbm(xx / W, yy / H, 4, 3);
        this.warpY[i] = wnoise.fbm(xx / W + 5.3, yy / H + 2.9, 4, 3);
      }
    }

    this.plates = [];
    for (var p = 0; p < this.params.plateCount; p++) this.plates.push(this.makePlate());

    this.hotspotList = [];
    var spots = this.rng.int(3, 5);
    for (var s = 0; s < spots; s++) {
      this.hotspotList.push({
        x: this.rng.range(0, W),
        y: this.rng.range(H * 0.15, H * 0.85),
        strength: this.rng.range(0.6, 1.3),
        radius: this.rng.range(2.5, 5)
      });
    }

    this.crustAge.fill(0);
    this.assignPlates();
    this.seaLevel = this.levelForFraction(this.params.seaFraction);
    this.waterVolume = this.waterOf(this.seaLevel);
    this.log('Crust congeals over the magma ocean. ' +
             this.plates.length + ' plates take shape.');

    var warm = spinUp === undefined ? DEFAULTS.spinUp : spinUp;
    for (var k = 0; k < warm; k++) this.step(true);
    /* Settling the oceans after the spin-up moves sea level in one jump.
       Forget that jump so the trend readout starts from a calm planet. */
    this.setSeaFraction(this.params.seaFraction);
    this.seaHistory = null;
    this.measure();
    this.prevStats = this.stats;
  };

  World.prototype.makePlate = function (index) {
    var rng = this.rng;
    var angle = rng.range(0, Math.PI * 2);
    var speed = rng.range(0.22, 0.70);
    return {
      cx: rng.range(0, this.width),
      cy: rng.range(-this.height * 0.1, this.height * 1.1),
      vx: Math.cos(angle) * speed,
      vy: Math.sin(angle) * speed * 0.6,
      weight: rng.range(0, 9),
      spin: rng.range(-0.02, 0.02),
      name: this.name(),
      cells: 0
    };
  };

  /* --- one step of geological time ------------------------------------- */

  World.prototype.step = function (quiet) {
    this.movePlates();
    this.assignPlates();
    this.tectonics();
    this.advect();
    this.applyUplift();
    this.coolCrust();
    this.balanceCrust();
    this.erode();
    this.settleSea();
    this.stepCount++;
    this.age += MA_PER_STEP;
    this.measure();
    if (!quiet) this.chronicle();
    return this;
  };

  World.prototype.movePlates = function () {
    var W = this.width, H = this.height, d = this.params.drift, rng = this.rng;
    for (var i = 0; i < this.plates.length; i++) {
      var p = this.plates[i];
      /* Ridges and trenches migrate at their own pace, so crust streams
         across them: made at one edge of a plate, consumed at the other.
         Were the outlines locked to the crust, a basin would never recycle
         and the sea floor would be as old as the planet. */
      p.cx += p.vx * d * K.edgeDrift;
      p.cy += p.vy * d * K.edgeDrift;
      p.cx = ((p.cx % W) + W) % W;
      if (p.cy < -H * 0.15 || p.cy > H * 1.15) p.vy = -p.vy;
      /* Slab pull and ridge push never hold a steady course for long. */
      var a = Math.atan2(p.vy, p.vx) + rng.range(-0.05, 0.05) + p.spin * 0.1;
      var s = Math.hypot(p.vx, p.vy) * rng.range(0.98, 1.02);
      s = Math.min(0.95, Math.max(0.12, s));
      p.vx = Math.cos(a) * s;
      p.vy = Math.sin(a) * s * 0.75;
    }
    /* A plate consumed at the trenches is replaced by one born at a rift. */
    if (this.stepCount % 12 === 0) {
      for (var j = 0; j < this.plates.length; j++) {
        if (this.plates[j].cells < this.width * this.height * 0.012) {
          var fresh = this.makePlate();
          fresh.name = this.plates[j].name;
          this.plates[j] = fresh;
        }
      }
    }
  };

  World.prototype.assignPlates = function () {
    var W = this.width, H = this.height, plates = this.plates;
    var plate = this.plate, vx = this.vx, vy = this.vy;
    var wX = this.warpX, wY = this.warpY, warp = K.warp;
    var half = W / 2;
    for (var p = 0; p < plates.length; p++) plates[p].cells = 0;
    for (var i = 0, y = 0; y < H; y++) {
      for (var x = 0; x < W; x++, i++) {
        var px = x + wX[i] * warp, py = y + wY[i] * warp;
        var best = -1, bestD = Infinity;
        for (var k = 0; k < plates.length; k++) {
          var pl = plates[k];
          var dx = px - pl.cx;
          if (dx > half) dx -= W; else if (dx < -half) dx += W;
          var dy = py - pl.cy;
          var d = Math.sqrt(dx * dx + dy * dy) - pl.weight;
          if (d < bestD) { bestD = d; best = k; }
        }
        plate[i] = best;
        vx[i] = plates[best].vx;
        vy[i] = plates[best].vy;
        plates[best].cells++;
      }
    }
  };

  /* Where plates meet, their relative motion decides what the crust does. */
  World.prototype.tectonics = function () {
    var W = this.width, H = this.height, n = W * H;
    var plate = this.plate, vx = this.vx, vy = this.vy;
    var h = this.height_, up = this.uplift, stress = this.stress;
    var drift = this.params.drift, volc = this.params.volcanism;
    up.fill(0);
    stress.fill(0);

    for (var y = 0; y < H; y++) {
      for (var x = 0; x < W; x++) {
        var i = y * W + x;
        for (var axis = 0; axis < 2; axis++) {
          var j, rel;
          if (axis === 0) {
            j = y * W + (x + 1 === W ? 0 : x + 1);
            rel = (vx[j] - vx[i]) * drift;
          } else {
            if (y + 1 === H) continue;
            j = i + W;
            rel = (vy[j] - vy[i]) * drift;
          }
          if (plate[j] === plate[i]) continue;
          var conv = -rel;                 // positive when they close on each other
          stress[i] += conv; stress[j] += conv;
          var hi = h[i], hj = h[j];
          if (conv > 0) {
            var contI = hi > K.crustLine, contJ = hj > K.crustLine;
            if (contI && contJ) {
              /* Neither side will sink: the crust crumples upward. */
              up[i] += conv * K.collide;
              up[j] += conv * K.collide;
            } else if (contI || contJ) {
              /* Ocean floor dives; an arc of volcanoes rises inland of a trench. */
              var oc = contI ? j : i, co = contI ? i : j;
              up[co] += conv * K.arc * (0.6 + 0.4 * volc);
              up[oc] -= conv * K.trench;
            } else {
              var hiCell = hi >= hj ? i : j, loCell = hi >= hj ? j : i;
              up[hiCell] += conv * K.arc * 0.7 * volc;
              up[loCell] -= conv * K.trench * 0.6;
            }
          } else {
            var div = -conv;
            if (hi > K.crustLine || hj > K.crustLine) {
              /* A continent pulled apart thins, drops, and floods. */
              up[i] -= div * K.rift;
              up[j] -= div * K.rift;
            } else {
              /* Fresh basalt wells up and sets at ridge height. The crust
                 here is newly made, so its age goes back to nothing — far
                 faster than the height relaxes. */
              var f = Math.min(0.5, div * K.spread * (0.7 + 0.3 * volc));
              up[i] += (K.ridgeHeight - hi) * f;
              up[j] += (K.ridgeHeight - hj) * f;
              var fresh = Math.min(0.9, div * 1.4);
              this.crustAge[i] *= 1 - fresh;
              this.crustAge[j] *= 1 - fresh;
            }
          }
        }
      }
    }

    /* Mountain belts are broad; smear the boundary forces into ranges. */
    blur(up, this.upliftB, W, H);
    blur(this.upliftB, up, W, H);

    /* Mantle plumes sit still while the plates slide over them, so each
       leaves a trail of islands behind. */
    var spots = this.hotspotList;
    for (var s = 0; s < spots.length; s++) {
      var sp = spots[s];
      var r = sp.radius, r2 = r * r;
      var cx = Math.round(sp.x), cy = Math.round(sp.y);
      for (var dy = -Math.ceil(r); dy <= Math.ceil(r); dy++) {
        var yy = cy + dy;
        if (yy < 0 || yy >= H) continue;
        for (var dx = -Math.ceil(r); dx <= Math.ceil(r); dx++) {
          var d2 = dx * dx + dy * dy;
          if (d2 > r2) continue;
          var xx = (cx + dx) % W; if (xx < 0) xx += W;
          var idx = yy * W + xx;
          up[idx] += K.hotspot * volc * sp.strength * Math.exp(-d2 / (r2 * 0.4));
        }
      }
    }
  };

  /* Carry the crust along with the plate that owns it. */
  World.prototype.advect = function () {
    var W = this.width, H = this.height;
    var h = this.height_, out = this.scratch;
    var vx = this.vx, vy = this.vy, d = this.params.drift;
    var age = this.crustAge, ageOut = this.delta;
    for (var i = 0, y = 0; y < H; y++) {
      for (var x = 0; x < W; x++, i++) {
        var sx = x - vx[i] * d, sy = y - vy[i] * d;
        out[i] = sampleCubic(h, W, H, sx, sy);
        ageOut[i] = sampleLinear(age, W, H, sx, sy);
      }
    }
    this.height_ = out;
    this.scratch = h;
    for (var k = 0; k < W * H; k++) age[k] = ageOut[k] + MA_PER_STEP;
  };

  World.prototype.applyUplift = function () {
    var h = this.height_, up = this.uplift, n = h.length;
    for (var i = 0; i < n; i++) {
      var u = up[i];
      /* Thick crust floats higher but resists being pushed higher still. */
      if (u > 0) u *= Math.max(0.05, 1 - Math.max(0, h[i]) / K.isoCeiling);
      h[i] += u;
      if (h[i] > 0.90) h[i] = 0.90;      // ~7.5 km, about as high as crust stands
      if (h[i] < -1.35) h[i] = -1.35;    // ~11 km, the deepest trenches
    }
  };

  /* Volcanic arcs and hotspots keep turning ocean floor into continent, and
     nothing in the model turns it back, so given long enough the whole planet
     would go continental. Subduction erosion and delamination are what answer
     that on Earth: crust is scraped off at the margins at roughly the rate it
     is added. Here the weakest crust at the shoreline edge of the margin gives
     way whenever the continental share runs above where it started, and thin
     ocean floor at the margin is accreted when it runs below. */
  World.prototype.balanceCrust = function () {
    var W = this.width, H = this.height, h = this.height_;
    var line = K.crustLine, band = 0.26, cont = 0;
    for (var y = 0, i = 0; y < H; y++) {
      var a = this.rowArea[y];
      for (var x = 0; x < W; x++, i++) if (h[i] >= line) cont += a;
    }
    this.continentalShare = cont / this.areaTotal;
    var excess = this.continentalShare - K.cratonShare;
    if (Math.abs(excess) < 0.002) return;
    var push = excess * 0.30;
    for (var j = 0; j < h.length; j++) {
      /* Only the margin moves: crust well above the line is already thick
         enough to stay, and deep ocean floor is already gone. */
      var d = Math.abs(h[j] - line);
      if (d > band) continue;
      h[j] -= push * (1 - d / band);
    }
  };

  /* Slumping plus rivers: material leaves steep ground and settles downhill. */
  World.prototype.erode = function () {
    var W = this.width, H = this.height, h = this.height_, dz = this.delta;
    var e = this.params.erosion, sea = this.seaLevel;
    dz.fill(0);
    var talus = K.talus, thermal = K.thermal * e, hydro = K.hydro * e;
    for (var y = 0; y < H; y++) {
      for (var x = 0; x < W; x++) {
        var i = y * W + x;
        var hi = h[i];
        var lowIdx = -1, lowH = hi;
        for (var k = 0; k < 4; k++) {
          var nx = x + (k === 0 ? 1 : k === 1 ? -1 : 0);
          var ny = y + (k === 2 ? 1 : k === 3 ? -1 : 0);
          if (ny < 0 || ny >= H) continue;
          nx = nx === W ? 0 : (nx === -1 ? W - 1 : nx);
          var j = ny * W + nx;
          if (h[j] < lowH) { lowH = h[j]; lowIdx = j; }
        }
        if (lowIdx < 0) continue;
        var drop = hi - lowH;
        var move = 0;
        if (drop > talus) move += (drop - talus) * thermal;
        if (hi > sea) {
          /* Rainfall does the heavy lifting; the higher the ground, the more
             of it falls as runoff. */
          var relief = Math.min(1, (hi - sea) / 0.5);
          move += drop * hydro * (0.25 + 0.75 * relief);
        } else {
          move += drop * hydro * 0.08;   // slow creep on the sea floor
        }
        if (move > drop * 0.45) move = drop * 0.45;
        dz[i] -= move;
        dz[lowIdx] += move;
      }
    }
    for (var m = 0; m < h.length; m++) h[m] += dz[m];
  };

  /* Ocean floor is born hot at a ridge and sinks as it cools, roughly with
     the square root of its age. This is what carves the deep basins, and it
     is why the oldest sea floor lies deepest. */
  World.prototype.coolCrust = function () {
    var h = this.height_, age = this.crustAge, n = h.length;
    for (var i = 0; i < n; i++) {
      if (h[i] >= K.crustLine) continue;
      var t = Math.min(1, Math.sqrt(age[i] / K.subAge));
      var target = K.ridgeHeight - K.subsidence * t;
      var gap = target - h[i];
      h[i] += gap * (gap < 0 ? K.coolRate : K.healRate);
    }
  };

  /* --- reading the planet ---------------------------------------------- */

  World.prototype.levelForFraction = function (frac) {
    var W = this.width, H = this.height, h = this.height_;
    var bins = 1024, lo = -1.45, hi = 1.05, span = hi - lo;
    var hist = new Float64Array(bins);
    for (var y = 0, i = 0; y < H; y++) {
      var a = this.rowArea[y];
      for (var x = 0; x < W; x++, i++) {
        var b = Math.floor(((h[i] - lo) / span) * bins);
        hist[b < 0 ? 0 : b >= bins ? bins - 1 : b] += a;
      }
    }
    var want = frac * this.areaTotal, acc = 0;
    for (var b2 = 0; b2 < bins; b2++) {
      acc += hist[b2];
      if (acc >= want) return lo + ((b2 + 0.5) / bins) * span;
    }
    return hi;
  };

  /* Sea level is not a fixed height: the water volume is what is fixed, so
     deepening basins drain the shelves and thickening crust floods them. */
  World.prototype.waterOf = function (level) {
    var W = this.width, H = this.height, h = this.height_, v = 0;
    for (var y = 0, i = 0; y < H; y++) {
      var a = this.rowArea[y];
      for (var x = 0; x < W; x++, i++) if (h[i] < level) v += (level - h[i]) * a;
    }
    return v;
  };

  World.prototype.levelForVolume = function (vol) {
    var W = this.width, H = this.height, h = this.height_;
    var bins = 1024, lo = -1.45, hi = 1.05, span = hi - lo;
    var count = new Float64Array(bins), sum = new Float64Array(bins);
    for (var y = 0, i = 0; y < H; y++) {
      var a = this.rowArea[y];
      for (var x = 0; x < W; x++, i++) {
        var b = Math.floor(((h[i] - lo) / span) * bins);
        if (b < 0) b = 0; else if (b >= bins) b = bins - 1;
        count[b] += a; sum[b] += h[i] * a;
      }
    }
    var c = 0, below = 0;
    for (var b2 = 0; b2 < bins; b2++) {
      var edge = lo + ((b2 + 1) / bins) * span;
      var cNext = c + count[b2], belowNext = below + sum[b2];
      var vol2 = cNext * edge - belowNext;
      if (vol2 >= vol && cNext > 0) {
        var level = (vol + belowNext) / cNext;
        var floorEdge = lo + (b2 / bins) * span;
        if (level < floorEdge) level = floorEdge;
        return level > edge ? edge : level;
      }
      c = cNext; below = belowNext;
    }
    return hi;
  };

  /* Water volume carries sea level from step to step, which is what makes
     shelves flood and drain. Left alone it drifts: basins deepen for hundreds
     of millions of years and the oceans slowly retreat into them. A weak pull
     toward the chosen coverage stands in for the rest of the water cycle and
     holds the planet near the ocean fraction the user asked for. */
  World.prototype.settleSea = function () {
    var byVolume = this.levelForVolume(this.waterVolume);
    var byCoverage = this.levelForFraction(this.params.seaFraction);
    this.seaLevel = byVolume + (byCoverage - byVolume) * 0.025;
    this.waterVolume = this.waterOf(this.seaLevel);
  };

  World.prototype.setSeaFraction = function (frac) {
    this.params.seaFraction = frac;
    this.seaLevel = this.levelForFraction(frac);
    this.waterVolume = this.waterOf(this.seaLevel);
    this.measure();
  };

  World.prototype.toMetres = function (h) { return (h - this.seaLevel) * ELEV_SCALE; };

  /* Average plate speed in centimetres a year, the unit plate motion is
     actually quoted in. */
  World.prototype.driftCmPerYear = function () {
    var kmPerCell = EARTH_CIRCUM_KM / this.width;
    var sum = 0;
    for (var i = 0; i < this.plates.length; i++) {
      sum += Math.hypot(this.plates[i].vx, this.plates[i].vy) * this.params.drift;
    }
    var cellsPerStep = sum / this.plates.length;
    var kmPerMa = (cellsPerStep * kmPerCell) / MA_PER_STEP;
    return kmPerMa * 0.1;   // km per Ma -> cm per year
  };

  World.prototype.measure = function () {
    if (!this.seaHistory) this.seaHistory = [];
    this.seaHistory.push(this.seaLevel);
    if (this.seaHistory.length > 21) this.seaHistory.shift();
    var W = this.width, H = this.height, h = this.height_, sea = this.seaLevel;
    var n = W * H, land = 0, maxH = -Infinity, maxIdx = 0, sumLand = 0, landCells = 0;
    for (var y = 0, i = 0; y < H; y++) {
      var a = this.rowArea[y];
      for (var x = 0; x < W; x++, i++) {
        if (h[i] > sea) { land += a; sumLand += (h[i] - sea) * a; landCells++; }
        if (h[i] > maxH) { maxH = h[i]; maxIdx = i; }
      }
    }
    var masses = this.landmasses();
    this.prevStats = this.stats;
    this.stats = {
      age: this.age,
      landFraction: land / this.areaTotal,
      landCells: landCells,
      peak: (maxH - sea) * ELEV_SCALE,
      peakIdx: maxIdx,
      meanLand: land ? (sumLand / land) * ELEV_SCALE : 0,
      landArea: land,
      continents: masses.count,
      largestShare: land ? masses.largest / land : 0,
      continentalShare: this.continentalShare || 0,
      seaTrend: (this.seaLevel - this.seaHistory[0]) * ELEV_SCALE,
      drift: this.driftCmPerYear()
    };
    return this.stats;
  };

  /* Flood fill the land to count separate landmasses. */
  World.prototype.landmasses = function () {
    var W = this.width, H = this.height, h = this.height_, sea = this.seaLevel;
    var id = this.landId, stack = this.stack;
    id.fill(0);
    var next = 0, largest = 0, count = 0;
    var minArea = this.areaTotal * 0.004;
    for (var start = 0; start < id.length; start++) {
      if (id[start] !== 0 || h[start] <= sea) continue;
      next++;
      var sp = 0, size = 0;
      stack[sp++] = start;
      id[start] = next;
      while (sp > 0) {
        var cur = stack[--sp];
        size += this.rowArea[(cur / W) | 0];
        var cx = cur % W, cy = (cur / W) | 0;
        for (var k = 0; k < 4; k++) {
          var nx = cx + (k === 0 ? 1 : k === 1 ? -1 : 0);
          var ny = cy + (k === 2 ? 1 : k === 3 ? -1 : 0);
          if (ny < 0 || ny >= H) continue;
          nx = nx === W ? 0 : (nx === -1 ? W - 1 : nx);
          var j = ny * W + nx;
          if (id[j] === 0 && h[j] > sea) { id[j] = next; stack[sp++] = j; }
        }
      }
      if (size > largest) largest = size;
      if (size >= minArea) count++;
    }
    return { count: count, largest: largest };
  };

  /* --- the chronicle ---------------------------------------------------- */

  World.prototype.log = function (text) {
    this.events.push({ age: this.age, text: text });
    if (this.events.length > 60) this.events.shift();
  };

  World.prototype.chronicle = function () {
    var s = this.stats, p = this.prevStats;
    if (!s || !p) return;
    var m = this.milestones;

    var peakSteps = [3000, 5000, 7000, 8500];
    for (var i = 0; i < peakSteps.length; i++) {
      var t = peakSteps[i];
      if (s.peak >= t && !m['peak' + t]) {
        m['peak' + t] = true;
        this.log('The ' + this.name() + ' Range passes ' +
                 t.toLocaleString('en-US') + ' m.');
      }
    }

    if (s.largestShare > 0.62 && !m.superContinent) {
      m.superContinent = true;
      m.superName = this.name();
      this.log('One landmass now holds most of the dry land: ' + m.superName + '.');
    } else if (m.superContinent && s.largestShare < 0.42) {
      m.superContinent = false;
      this.log(m.superName + ' rifts apart. The pieces drift for open water.');
    }

    /* Only report a count that has actually settled somewhere new. */
    if (m.lastCount === undefined) m.lastCount = s.continents;
    if (s.continents !== m.lastCount && this.stepCount - (m.countStep || 0) > 8) {
      var verb = s.continents > m.lastCount ? 'A continent splits.' : 'Landmasses collide.';
      m.lastCount = s.continents;
      m.countStep = this.stepCount;
      if (s.continents > 0) {
        this.log(verb + ' ' + s.continents + ' major landmass' +
                 (s.continents === 1 ? '' : 'es') + (s.continents === 1 ? ' stands.' : ' stand.'));
      }
    }

    if (this.stepCount % 10 === 0 && this.seaHistory.length > 20) {
      if (s.seaTrend > 90 && !m.flooding) {
        m.flooding = true; m.draining = false;
        this.log('Seas rise ' + Math.round(s.seaTrend) + ' m in 40 Ma; shelves drown.');
      } else if (s.seaTrend < -90 && !m.draining) {
        m.draining = true; m.flooding = false;
        this.log('Seas fall ' + Math.round(-s.seaTrend) + ' m in 40 Ma; shelves emerge.');
      } else if (Math.abs(s.seaTrend) < 40) {
        m.flooding = false; m.draining = false;
      }
    }

    var bands = [0.12, 0.22, 0.32, 0.45];
    for (var b = 0; b < bands.length; b++) {
      var lv = bands[b];
      if (p.landFraction < lv && s.landFraction >= lv) {
        this.log('Dry land reaches ' + Math.round(lv * 100) + '% of the surface.');
      } else if (p.landFraction > lv && s.landFraction <= lv) {
        this.log('The sea takes back ground: land falls to ' +
                 Math.round(lv * 100) + '%.');
      }
    }
  };

  /* --- helpers ---------------------------------------------------------- */

  function smoothstep(a, b, x) {
    var t = (x - a) / (b - a);
    if (t < 0) t = 0; else if (t > 1) t = 1;
    return t * t * (3 - 2 * t);
  }

  /* The value below which `frac` of the planet's surface lies. */
  function quantile(arr, rowArea, W, H, areaTotal, frac) {
    var bins = 1024, lo = -1.5, hi = 1.5, span = hi - lo;
    var hist = new Float64Array(bins);
    for (var y = 0, i = 0; y < H; y++) {
      var a = rowArea[y];
      for (var x = 0; x < W; x++, i++) {
        var b = Math.floor(((arr[i] - lo) / span) * bins);
        hist[b < 0 ? 0 : b >= bins ? bins - 1 : b] += a;
      }
    }
    var want = frac * areaTotal, acc = 0;
    for (var k = 0; k < bins; k++) {
      acc += hist[k];
      if (acc >= want) return lo + ((k + 0.5) / bins) * span;
    }
    return hi;
  }

  function blur(src, dst, W, H) {
    for (var y = 0; y < H; y++) {
      var yUp = y > 0 ? y - 1 : 0, yDn = y < H - 1 ? y + 1 : H - 1;
      for (var x = 0; x < W; x++) {
        var xL = x > 0 ? x - 1 : W - 1, xR = x < W - 1 ? x + 1 : 0;
        dst[y * W + x] = (
          src[yUp * W + xL] + src[yUp * W + x] + src[yUp * W + xR] +
          src[y * W + xL] + src[y * W + x] * 2 + src[y * W + xR] +
          src[yDn * W + xL] + src[yDn * W + x] + src[yDn * W + xR]
        ) / 10;
      }
    }
  }

  function wrapX(x, W) { x %= W; return x < 0 ? x + W : x; }
  function clampY(y, H) { return y < 0 ? 0 : (y > H - 1 ? H - 1 : y); }

  function sampleLinear(a, W, H, x, y) {
    var x0 = Math.floor(x), y0 = Math.floor(y);
    var fx = x - x0, fy = y - y0;
    var x1 = wrapX(x0 + 1, W), y1 = clampY(y0 + 1, H);
    x0 = wrapX(x0, W); y0 = clampY(y0, H);
    var a00 = a[y0 * W + x0], a10 = a[y0 * W + x1];
    var a01 = a[y1 * W + x0], a11 = a[y1 * W + x1];
    return (a00 * (1 - fx) + a10 * fx) * (1 - fy) + (a01 * (1 - fx) + a11 * fx) * fy;
  }

  function cubic(p0, p1, p2, p3, t) {
    var b = 0.5 * (p2 - p0);
    var c = p0 - 2.5 * p1 + 2 * p2 - 0.5 * p3;
    var d = -0.5 * p0 + 1.5 * p1 - 1.5 * p2 + 0.5 * p3;
    var v = ((d * t + c) * t + b) * t + p1;
    /* Clamp to the span so the interpolation never invents a peak. */
    var lo = p1 < p2 ? p1 : p2, hi = p1 < p2 ? p2 : p1;
    return v < lo ? lo : (v > hi ? hi : v);
  }

  var row = [0, 0, 0, 0];

  function sampleCubic(a, W, H, x, y) {
    var x0 = Math.floor(x), y0 = Math.floor(y);
    var fx = x - x0, fy = y - y0;
    for (var m = 0; m < 4; m++) {
      var yy = clampY(y0 - 1 + m, H) * W;
      row[m] = cubic(
        a[yy + wrapX(x0 - 1, W)], a[yy + wrapX(x0, W)],
        a[yy + wrapX(x0 + 1, W)], a[yy + wrapX(x0 + 2, W)], fx);
    }
    return cubic(row[0], row[1], row[2], row[3], fy);
  }

  World.ELEV_SCALE = ELEV_SCALE;
  World.MA_PER_STEP = MA_PER_STEP;
  World.K = K;
  FE.World = World;
})(typeof window !== 'undefined'
  ? (window.FE = window.FE || {})
  : (globalThis.FE = globalThis.FE || {}));
