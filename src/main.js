/* Wiring: the clock that advances the world, the controls that steer it,
   and the readouts that report on it. */
(function (FE) {
  'use strict';

  var MA_RATES = [2, 4, 8, 16, 32, 64];   // millions of years per second
  var $ = function (id) { return document.getElementById(id); };

  var state = {
    world: null,
    climate: null,
    renderer: null,
    mode: 'terrain',
    running: true,
    dirty: true,
    rateIndex: 2,
    boundaries: true,
    probeCell: -1,
    loggedEvents: 0
  };

  var canvas = $('map');
  var ctx = canvas.getContext('2d');

  /* --- building a world -------------------------------------------------- */

  function seedFromHash() {
    var h = (location.hash || '').replace(/^#/, '');
    return /^[A-Za-z0-9_-]{1,32}$/.test(h) ? h : null;
  }

  function newWorld(seed) {
    var plates = +$('plates').value;
    var coverage = +$('coverage').value / 100;
    $('seed').value = seed;
    state.world = new FE.World({
      seed: seed,
      plateCount: plates,
      seaFraction: coverage,
      drift: +$('drift').value / 10,
      erosion: +$('erosion').value / 10,
      volcanism: +$('volcanism').value / 10
    });
    state.climate = new FE.Climate(state.world);
    state.climate.warmth = +$('warmth').value;
    if (!state.renderer) state.renderer = new FE.Renderer(state.world);
    state.loggedEvents = 0;
    state.dirty = true;
    try {
      history.replaceState(null, '', '#' + seed);
    } catch (e) { /* a sandboxed frame may refuse; the seed box still shows it */ }
    refresh();
  }

  function randomSeed() {
    var words = 'ash basalt cinder delta ember fold gneiss horizon ice joint karst lava magma nappe ocean pangea quartz rift shale trench uplift vent wash xeno yield zone'.split(' ');
    var w = words[Math.floor(Math.random() * words.length)];
    return w + '-' + Math.floor(Math.random() * 900 + 100);
  }

  /* --- drawing ----------------------------------------------------------- */

  function sizeCanvas() {
    var rect = canvas.getBoundingClientRect();
    if (!rect.width) return;
    var dpr = Math.min(2, window.devicePixelRatio || 1);
    var w = Math.round(rect.width * dpr), h = Math.round(rect.width * 9 / 16 * dpr);
    if (canvas.width !== w || canvas.height !== h) {
      canvas.width = w;
      canvas.height = h;
      state.dirty = true;
    }
  }

  function refresh() {
    state.climate.update();
    state.dirty = true;
  }

  function paint() {
    state.renderer.draw(state.world, state.climate, {
      mode: state.mode,
      boundaries: state.boundaries
    });
    state.renderer.blit(ctx, canvas.width, canvas.height);
    state.dirty = false;
  }

  /* --- readouts ---------------------------------------------------------- */

  function fmt(n, digits) {
    return n.toLocaleString('en-US', {
      minimumFractionDigits: digits || 0,
      maximumFractionDigits: digits || 0
    });
  }

  function unit(value, suffix) {
    return value + ' <small>' + suffix + '</small>';
  }

  function updateStats() {
    var w = state.world, s = w.stats, c = state.climate.summary();
    $('age').textContent = fmt(w.age);
    $('s-land').innerHTML = unit(fmt(s.landFraction * 100, 1), '%');
    $('s-peak').innerHTML = unit(fmt(Math.max(0, s.peak)), 'm');
    $('s-cont').textContent = s.continents;
    var trend = s.seaTrend;
    $('s-sea').innerHTML = (trend >= 0 ? '+' : '−') + fmt(Math.abs(trend)) +
      ' <small>m / 40 Ma</small>';
    $('s-drift').innerHTML = unit(fmt(s.drift, 1), 'cm/yr');
    $('s-temp').innerHTML = unit(fmt(c.meanTemp, 1), '°C');

    if (w.events.length !== state.loggedEvents) {
      state.loggedEvents = w.events.length;
      var html = '';
      for (var i = w.events.length - 1; i >= 0; i--) {
        var e = w.events[i];
        html += '<li><time>' + fmt(e.age) + ' Ma</time><span>' + e.text + '</span></li>';
      }
      $('log').innerHTML = html;
    }
  }

  /* --- the probe under the pointer ---------------------------------------- */

  function cellAt(event) {
    var rect = canvas.getBoundingClientRect();
    if (!rect.width || !rect.height) return -1;
    var w = state.world;
    var x = Math.floor(((event.clientX - rect.left) / rect.width) * w.width);
    var y = Math.floor(((event.clientY - rect.top) / rect.height) * w.height);
    if (x < 0 || y < 0 || x >= w.width || y >= w.height) return -1;
    return y * w.width + x;
  }

  function coords(i) {
    var w = state.world;
    var x = i % w.width, y = (i / w.width) | 0;
    var lat = 90 - ((y + 0.5) / w.height) * 180;
    var lon = ((x + 0.5) / w.width) * 360 - 180;
    return Math.abs(lat).toFixed(1) + '°' + (lat >= 0 ? 'N' : 'S') + ' ' +
           Math.abs(lon).toFixed(1) + '°' + (lon >= 0 ? 'E' : 'W');
  }

  function drawProbe() {
    var i = state.probeCell;
    var el = $('probe');
    if (i < 0) {
      el.innerHTML = '<p class="hint">Point at the map to sound a location.</p>';
      return;
    }
    var w = state.world, c = state.climate;
    var metres = w.toMetres(w.height_[i]);
    var plate = w.plates[w.plate[i]];
    var depth = metres < 0;
    el.innerHTML =
      '<div>' + coords(i) + '</div>' +
      '<div>' + (depth ? 'Depth' : 'Elev') + ' <span>' +
        fmt(Math.abs(metres)) + ' m</span></div>' +
      '<div>' + fmt(c.temp[i], 1) + ' <span>°C</span></div>' +
      '<div>' + fmt(c.rain[i]) + ' <span>mm/yr</span></div>' +
      '<div><span>' + FE.BIOME_NAMES[c.biome[i]] + '</span></div>' +
      '<div><span>' + plate.name + '</span> plate</div>';
  }

  /* --- legend ------------------------------------------------------------- */

  var TERRAIN_KEY = [9, 8, 3, 2, 4, 7, 6, 5, 1, 0, 12, 13, 14, 15];

  function scaleBar(stops) {
    var bar = '<div class="scale">';
    for (var i = 0; i < stops.length - 1; i++) {
      bar += '<i style="background:linear-gradient(to right,' +
             stops[i].color + ',' + stops[i + 1].color + ')"></i>';
    }
    bar += '</div><div class="ticks">';
    for (var k = 0; k < stops.length; k++) bar += '<span>' + stops[k].label + '</span>';
    return bar + '</div>';
  }

  function drawLegend() {
    var el = $('legend'), html = '';
    if (state.mode === 'terrain') {
      for (var k = 0; k < TERRAIN_KEY.length; k++) {
        var b = TERRAIN_KEY[k];
        html += '<div class="row"><i class="sw" style="background:rgb(' +
          FE.BIOME_COLOR[b].join(',') + ')"></i>' + FE.BIOME_NAMES[b] + '</div>';
      }
    } else if (state.mode === 'plates') {
      html += '<div class="row"><i class="sw" style="background:rgb(236,94,52)"></i>' +
              'Convergent &mdash; crust collides, mountains and arcs rise</div>' +
              '<div class="row"><i class="sw" style="background:rgb(92,188,230)"></i>' +
              'Divergent &mdash; crust pulls apart, new sea floor forms</div>' +
              '<p class="note">Each tint is one plate. Flooded crust is shaded darker.</p>';
    } else if (state.mode === 'relief') {
      html = scaleBar(FE.LEGENDS.relief()) +
        '<p class="note">Height above sea level. Ocean depth is shaded separately.</p>';
    } else if (state.mode === 'temperature') {
      html = scaleBar(FE.LEGENDS.temperature()) +
        '<p class="note">Mean surface temperature in degrees Celsius.</p>';
    } else if (state.mode === 'rainfall') {
      html = scaleBar(FE.LEGENDS.rainfall()) +
        '<p class="note">Millimetres of rain a year on land.</p>';
    } else {
      html = scaleBar(FE.LEGENDS.age()) +
        '<p class="note">Age of the sea floor in millions of years. New crust forms at the ridges and is destroyed at the trenches, so the ocean floor is always younger than the continents.</p>';
    }
    el.innerHTML = html;
  }

  /* --- the clock ---------------------------------------------------------- */

  var last = 0, carry = 0;

  function frame(now) {
    requestAnimationFrame(frame);
    if (!last) last = now;
    var dt = Math.min(0.25, (now - last) / 1000);
    last = now;
    sizeCanvas();

    if (state.running) {
      var perSecond = MA_RATES[state.rateIndex] / FE.World.MA_PER_STEP;
      carry += dt * perSecond;
      var steps = Math.min(8, Math.floor(carry));
      carry -= steps;
      if (steps > 0) {
        for (var i = 0; i < steps; i++) state.world.step();
        refresh();
      }
    }

    if (state.dirty) {
      paint();
      updateStats();
      drawProbe();
    }
  }

  /* --- controls ----------------------------------------------------------- */

  function setMode(mode) {
    state.mode = mode;
    var chips = document.querySelectorAll('.chip[data-mode]');
    for (var i = 0; i < chips.length; i++) {
      chips[i].setAttribute('aria-pressed', String(chips[i].dataset.mode === mode));
    }
    drawLegend();
    state.dirty = true;
  }

  function setRunning(run) {
    state.running = run;
    $('play').textContent = run ? 'Pause' : 'Run';
    carry = 0;
  }

  function bindSlider(id, format, apply) {
    var input = $(id), out = $(id + '-v');
    function sync() {
      out.innerHTML = format(+input.value);
      if (apply) apply(+input.value);
      state.dirty = true;
    }
    input.addEventListener('input', sync);
    sync();
  }

  function init() {
    var chips = document.querySelectorAll('.chip[data-mode]');
    for (var i = 0; i < chips.length; i++) {
      chips[i].addEventListener('click', function () { setMode(this.dataset.mode); });
    }
    $('bounds').addEventListener('click', function () {
      state.boundaries = !state.boundaries;
      this.setAttribute('aria-pressed', String(state.boundaries));
      state.dirty = true;
    });

    $('play').addEventListener('click', function () { setRunning(!state.running); });
    $('stepBtn').addEventListener('click', function () {
      setRunning(false);
      state.world.step();
      refresh();
    });
    $('newWorld').addEventListener('click', function () {
      newWorld($('seed').value.trim() || randomSeed());
    });
    $('roll').addEventListener('click', function () { newWorld(randomSeed()); });
    $('seed').addEventListener('keydown', function (e) {
      if (e.key === 'Enter') newWorld(this.value.trim() || randomSeed());
    });

    $('speed').addEventListener('input', function () {
      state.rateIndex = +this.value;
      $('speedLabel').textContent = MA_RATES[state.rateIndex] + ' Ma/s';
    });

    bindSlider('plates', function (v) { return v; });
    bindSlider('coverage', function (v) { return v + '%'; }, function (v) {
      if (state.world) { state.world.setSeaFraction(v / 100); refresh(); }
    });
    bindSlider('drift', function (v) { return (v / 10).toFixed(1) + '×'; }, function (v) {
      if (state.world) state.world.params.drift = v / 10;
    });
    bindSlider('erosion', function (v) { return (v / 10).toFixed(1) + '×'; }, function (v) {
      if (state.world) state.world.params.erosion = v / 10;
    });
    bindSlider('volcanism', function (v) { return (v / 10).toFixed(1) + '×'; }, function (v) {
      if (state.world) state.world.params.volcanism = v / 10;
    });
    bindSlider('warmth', function (v) {
      return (v > 0 ? '+' : '') + v + ' °C';
    }, function (v) {
      if (state.climate) { state.climate.warmth = v; refresh(); }
    });

    canvas.addEventListener('pointermove', function (e) {
      var cell = cellAt(e);
      if (cell !== state.probeCell) { state.probeCell = cell; drawProbe(); }
    });
    canvas.addEventListener('pointerleave', function () {
      state.probeCell = -1;
      drawProbe();
    });

    document.addEventListener('keydown', function (e) {
      var tag = (e.target.tagName || '').toLowerCase();
      if (tag === 'input' || tag === 'textarea') return;
      var modes = ['terrain', 'relief', 'plates', 'temperature', 'rainfall', 'age'];
      if (e.key === ' ') { e.preventDefault(); setRunning(!state.running); }
      else if (e.key === 'b' || e.key === 'B') { $('bounds').click(); }
      else if (e.key === 's' || e.key === 'S') { $('stepBtn').click(); }
      else if (e.key === 'n' || e.key === 'N') { $('roll').click(); }
      else if (e.key >= '1' && e.key <= '6') setMode(modes[+e.key - 1]);
    });

    $('speedLabel').textContent = MA_RATES[state.rateIndex] + ' Ma/s';
    newWorld(seedFromHash() || 'earth');
    setMode('terrain');

    if (window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches) {
      setRunning(false);
    } else {
      setRunning(true);
    }
    requestAnimationFrame(frame);
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }
})(window.FE = window.FE || {});
