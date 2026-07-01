(function () {
  'use strict';

  // ==================== CONFIG ====================
  var BUILD = '10';                    // bump every deploy — shown on Debug screen to confirm version
  var STORAGE_KEY = 'stepview_v1';
  var RING_CIRC = 603;                 // 2*pi*r, r=96
  var KCAL_PER_KG_PER_KM = 0.9;        // gross walking estimate
  var STEP_MIN_THR = 0.5;              // adaptive-threshold floor (m/s^2) — noise gate
  var STEP_ENV_FRAC = 0.4;             // step threshold = this * recent peak envelope
  var STEP_MIN_INTERVAL = 250;         // ms between steps (cap ~4/s)
  var GPS_MAX_ACCURACY = 30;           // m — ignore fixes worse than this
  var GPS_MIN_SEG = 1;                 // m — ignore jitter below this
  var GPS_MAX_SEG = 60;                // m — ignore impossible jumps

  // Inline SVG icons (no network — per display guidelines)
  var ICON = {
    play: '<svg class="icon" viewBox="0 0 24 24" aria-hidden="true"><polygon points="7,5 19,12 7,19" fill="currentColor"></polygon></svg>',
    stop: '<svg class="icon" viewBox="0 0 24 24" aria-hidden="true"><rect x="6" y="6" width="12" height="12" rx="2.5" fill="currentColor"></rect></svg>'
  };

  // ==================== STATE ====================
  var state = {
    running: false,
    minimized: false,
    steps: 0,
    gpsDistM: 0,        // distance from accepted GPS segments
    gpsSegments: 0,     // count of accepted GPS segments (>0 => trust GPS)
    settings: { goal: 8000, weightKg: 70, heightCm: 170 },
    lastReset: ''       // date string; daily auto-reset
  };

  var screens = {};
  var currentScreen = 'home';

  // sensor runtime
  var watchId = null, motionAttached = false, seedGravity = false;
  var motionStatus = 'unknown', locationStatus = 'unknown';   // unknown|granted|denied|unavailable
  var gravity = 9.8, env = 0, peaked = false, lastStepTs = 0;
  var lastFix = null;
  var saveTick = 0;
  // live diagnostics (Debug screen)
  var dbg = { evt: 0, hz: [], peak: 0, cross: 0, hidden: 0, lastM: 0, lastD: 0, thr: 0 };

  // ==================== HELPERS ====================
  function $(id) { return document.getElementById(id); }
  function fmtInt(n) { return Math.round(n).toLocaleString('en-US'); }
  function strideM() { return (state.settings.heightCm * 0.415) / 100; }
  function today() { return new Date().toISOString().slice(0, 10); }

  function stepDistM() { return state.steps * strideM(); }
  function effectiveDistM() {
    // Hybrid: trust GPS once we have accepted segments, else estimate from steps.
    return state.gpsSegments >= 1 ? state.gpsDistM : stepDistM();
  }
  function distKm() { return effectiveDistM() / 1000; }
  function calories() { return distKm() * state.settings.weightKg * KCAL_PER_KG_PER_KM; }

  function haversine(la1, lo1, la2, lo2) {
    var R = 6371000, rad = Math.PI / 180;
    var dLa = (la2 - la1) * rad, dLo = (lo2 - lo1) * rad;
    var s = Math.sin(dLa / 2) * Math.sin(dLa / 2) +
            Math.cos(la1 * rad) * Math.cos(la2 * rad) * Math.sin(dLo / 2) * Math.sin(dLo / 2);
    return 2 * R * Math.asin(Math.sqrt(s));
  }

  // ==================== PERSISTENCE ====================
  function load() {
    try {
      var raw = localStorage.getItem(STORAGE_KEY);
      if (raw) {
        var d = JSON.parse(raw);
        if (d.settings) state.settings = Object.assign(state.settings, d.settings);
        state.steps = d.steps || 0;
        state.gpsDistM = d.gpsDistM || 0;
        state.gpsSegments = d.gpsSegments || 0;
        state.lastReset = d.lastReset || '';
        state.running = !!d.running;   // resume tracking after an unexpected reload
        // Note: minimized is intentionally NOT restored — always launch maximized.
      }
    } catch (e) { /* ignore */ }
    // Daily auto-reset (also drops a stale cross-day running session)
    if (state.lastReset !== today()) {
      state.steps = 0; state.gpsDistM = 0; state.gpsSegments = 0;
      state.lastReset = today();
      state.running = false;   // don't silently resume a session from a previous day
      save();
    }
  }
  function save() {
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify({
        steps: state.steps, gpsDistM: state.gpsDistM, gpsSegments: state.gpsSegments,
        running: state.running, minimized: state.minimized, settings: state.settings, lastReset: state.lastReset
      }));
    } catch (e) { /* ignore */ }
  }

  // ==================== RENDER ====================
  function render() {
    var goal = state.settings.goal;
    var pct = goal > 0 ? Math.min(100, (state.steps / goal) * 100) : 0;

    var stepsEl = $('steps');
    var txt = fmtInt(state.steps);
    stepsEl.textContent = txt;
    // Auto-scale so large counts (e.g. 12,345) stay inside the ring
    stepsEl.style.fontSize = (txt.length <= 3 ? 72 : txt.length <= 5 ? 58 : txt.length <= 6 ? 48 : 40) + 'px';
    var gl = $('goal-line');
    if (gl) gl.innerHTML = 'Goal ' + fmtInt(goal) + ' · ' + Math.round(pct) + '%';
    $('ring-prog').style.strokeDashoffset = (RING_CIRC * (1 - pct / 100)).toFixed(1);
    $('distance').textContent = distKm().toFixed(2);
    $('calories').textContent = fmtInt(calories());

    var st = $('status');
    if (st) {
      st.textContent = state.running ? 'Active' : 'Paused';
      st.classList.toggle('active', state.running);
    }

    var tg = $('toggle');
    if (tg) {
      tg.innerHTML = state.running ? ICON.stop : ICON.play;
      tg.classList.toggle('danger', state.running);
      tg.classList.toggle('primary', !state.running);
      tg.setAttribute('aria-label', state.running ? 'Stop' : 'Start');
    }

    var smin = $('steps-min');
    if (smin) {
      smin.textContent = txt;
      smin.style.fontSize = (txt.length <= 3 ? 120 : txt.length <= 5 ? 96 : txt.length <= 6 ? 80 : 64) + 'px';
    }
  }

  function renderSettings() {
    $('set-goal').textContent = fmtInt(state.settings.goal);
    $('set-weight').textContent = state.settings.weightKg;
    $('set-height').textContent = state.settings.heightCm;
    $('set-note').innerHTML = 'Stride ~' + strideM().toFixed(2) + ' m · GPS outdoors, steps indoors';
  }

  // ==================== STEP DETECTION ====================
  // Always attached (see setupMotion) — the detector + gravity baseline run
  // continuously, independent of the UI. Steps are ADDED only while running.
  function onMotion(e) {
    var a = e.accelerationIncludingGravity || e.acceleration;
    if (!a || a.x == null) return;
    var m = Math.sqrt(a.x * a.x + a.y * a.y + a.z * a.z);
    var now = (typeof performance !== 'undefined') ? performance.now() : Date.now();

    // diagnostics: event delivery
    dbg.evt++; dbg.lastM = m;
    dbg.hz.push(now); while (dbg.hz.length && now - dbg.hz[0] > 1000) dbg.hz.shift();

    // seed baseline from the very first sample, then track slowly
    if (seedGravity) { gravity = m; seedGravity = false; }
    else gravity = gravity * 0.98 + m * 0.02;   // slow — does NOT chase the ~2 Hz walking wave
    var dyn = m - gravity;
    var adyn = dyn < 0 ? -dyn : dyn;
    // envelope of recent peak amplitude -> adaptive threshold (auto-scales to gait)
    env = adyn > env ? adyn : env * 0.95;
    var thr = env * STEP_ENV_FRAC; if (thr < STEP_MIN_THR) thr = STEP_MIN_THR;
    dbg.lastD = dyn; dbg.thr = thr; if (dyn > dbg.peak) dbg.peak = dyn;

    if (dyn > thr && !peaked && (now - lastStepTs) > STEP_MIN_INTERVAL) {
      peaked = true; lastStepTs = now;
      dbg.cross++;
      if (state.running) addStep();          // COUNT only while tracking
    }
    if (dyn < thr * 0.5) peaked = false;     // re-arm when signal drops
  }

  function addStep() {
    state.steps++;
    render();
    if (++saveTick % 10 === 0) save();
  }

  // ==================== GEOLOCATION ====================
  function onPos(p) {
    locationStatus = 'granted'; updatePermUI();
    if (!state.running) return;
    var c = p.coords;
    if (lastFix && c.accuracy <= GPS_MAX_ACCURACY) {
      var d = haversine(lastFix.lat, lastFix.lon, c.latitude, c.longitude);
      if (d >= GPS_MIN_SEG && d < GPS_MAX_SEG) {
        state.gpsDistM += d;
        state.gpsSegments++;
        render();
        save();
      }
    }
    lastFix = { lat: c.latitude, lon: c.longitude };
  }
  function onGeoErr(err) {
    // Permission denied -> show error; other errors fall back to step-estimated distance.
    if (err && err.code === 1) { locationStatus = 'denied'; updatePermUI(); }
  }

  // ==================== PERMISSIONS ====================
  function requestMotionPermission() {
    return new Promise(function (resolve) {
      if (typeof DeviceMotionEvent === 'undefined') { resolve('unavailable'); return; }
      if (typeof DeviceMotionEvent.requestPermission !== 'function') { resolve('granted'); return; }
      DeviceMotionEvent.requestPermission()
        .then(function (r) { resolve(r === 'granted' ? 'granted' : 'denied'); })
        .catch(function () { resolve('denied'); });   // e.g. requires a user gesture
    });
  }

  // Ask for motion + location as soon as the app loads (and again via the Grant button).
  function primePermissions() {
    if ('geolocation' in navigator) {
      try {
        navigator.geolocation.getCurrentPosition(
          function () { locationStatus = 'granted'; updatePermUI(); if (state.running) startGeo(); },
          function (err) { if (err && err.code === 1) { locationStatus = 'denied'; updatePermUI(); } },
          { enableHighAccuracy: true, timeout: 15000, maximumAge: 60000 });
      } catch (e) { /* ignore */ }
    } else {
      locationStatus = 'unavailable';
    }
    requestMotionPermission().then(function (s) { motionStatus = s; updatePermUI(); });
  }

  function updatePermUI() {
    var missing = [];
    if (motionStatus === 'denied' || motionStatus === 'unavailable') missing.push('Motion');
    if (locationStatus === 'denied') missing.push('Location');
    var show = missing.length > 0;
    var msg = show ? (missing.join(' & ') + ' access needed — tap Grant') : '';
    var banners = document.querySelectorAll('.perm-banner');   // home + settings
    for (var i = 0; i < banners.length; i++) {
      banners[i].classList.toggle('hidden', !show);
      var t = banners[i].querySelector('.perm-text');
      if (t) t.textContent = msg;
    }
  }

  // ==================== SENSOR LIFECYCLE ====================
  // The accelerometer is captured ALWAYS (attached once at init, never detached),
  // so the gravity baseline + step detector run continuously and step capture is
  // fully independent of the UI — screens, minimize, and Start/Stop never touch
  // it. Steps are only ADDED while state.running (see onMotion). GPS is the
  // battery-heavy part, so it alone is gated to running via start/stop.
  function setupMotion() {
    if (motionAttached) return;
    seedGravity = true;
    window.addEventListener('devicemotion', onMotion);
    motionAttached = true;
  }
  function ensureMotionPermission() {
    if (motionStatus === 'granted' || motionStatus === 'unavailable') return;
    requestMotionPermission().then(function (s) { motionStatus = s; updatePermUI(); });
  }
  function startGeo() {
    if ('geolocation' in navigator && watchId === null) {   // guard: never double-start
      lastFix = null;
      watchId = navigator.geolocation.watchPosition(onPos, onGeoErr,
        { enableHighAccuracy: true, maximumAge: 1000, timeout: 20000 });
    }
  }
  function stopGeo() {
    if (watchId !== null) { navigator.geolocation.clearWatch(watchId); watchId = null; }
  }

  // ==================== ACTIONS ====================
  function start() {
    if (state.running) return;      // guard: no double-start
    state.running = true;
    ensureMotionPermission();       // motion capture is already always-on
    startGeo();                     // GPS is the only thing we start here
    save();                         // persist running so an unexpected reload auto-resumes
    render();
    toast('Tracking started');
  }
  function stop() {
    if (!state.running) return;     // guard: no double-stop
    state.running = false;
    stopGeo();
    save();
    render();
    toast('Paused');
  }
  function resetCounters() {
    state.steps = 0; state.gpsDistM = 0; state.gpsSegments = 0;
    lastFix = null; peaked = false;
    save();
    render();
    toast('Reset');
  }

  function clampGoal(v) { return Math.max(1000, Math.min(50000, v)); }
  function clampWeight(v) { return Math.max(30, Math.min(200, v)); }
  function clampHeight(v) { return Math.max(120, Math.min(220, v)); }

  function handleAction(action) {
    switch (action) {
      case 'toggle': if (state.running) stop(); else start(); break;
      case 'minimize': setMinimized(true); break;
      case 'maximize': setMinimized(false); break;
      case 'request-perms': primePermissions(); break;
      case 'reset': resetCounters(); break;
      case 'settings': navigate('settings'); break;
      case 'debug': navigate('debug'); break;
      case 'debug-close': navigate('settings'); break;
      case 'dbg-reset': dbg.evt = 0; dbg.peak = 0; dbg.cross = 0; dbg.hidden = 0; dbg.hz = []; renderDebug(); break;
      case 'back': navigate('home'); save(); break;
      case 'goal-inc': state.settings.goal = clampGoal(state.settings.goal + 500); afterSetting(); break;
      case 'goal-dec': state.settings.goal = clampGoal(state.settings.goal - 500); afterSetting(); break;
      case 'weight-inc': state.settings.weightKg = clampWeight(state.settings.weightKg + 1); afterSetting(); break;
      case 'weight-dec': state.settings.weightKg = clampWeight(state.settings.weightKg - 1); afterSetting(); break;
      case 'height-inc': state.settings.heightCm = clampHeight(state.settings.heightCm + 1); afterSetting(); break;
      case 'height-dec': state.settings.heightCm = clampHeight(state.settings.heightCm - 1); afterSetting(); break;
    }
  }
  function afterSetting() { renderSettings(); render(); save(); }

  // ==================== NAVIGATION + FOCUS ====================
  function navigate(id) {
    Object.keys(screens).forEach(function (k) { screens[k].classList.add('hidden'); });
    screens[id].classList.remove('hidden');
    currentScreen = id;
    if (id === 'settings') renderSettings();
    if (id === 'debug') renderDebug();
    if (id === 'home') applyMinimized(); else focusFirst();
  }
  function applyMinimized() {
    var full = document.querySelector('#home .full-view');
    var min = document.querySelector('#home .min-view');
    if (!full || !min) return;
    full.classList.toggle('hidden', state.minimized);
    min.classList.toggle('hidden', !state.minimized);
    focusFirst();
  }
  function setMinimized(b) {
    state.minimized = b;
    applyMinimized();
    render();
    save();
  }
  function focusables() {
    return Array.prototype.slice.call(
      screens[currentScreen].querySelectorAll('.focusable:not([disabled])'))
      .filter(function (el) { return el.offsetParent !== null; });   // visible only
  }
  function focusFirst() { var f = focusables(); if (f.length) f[0].focus(); }
  function moveFocus(dir) {
    var f = focusables();
    if (!f.length) return;
    var i = f.indexOf(document.activeElement);
    if (i === -1) { f[0].focus(); return; }
    var n = dir > 0 ? (i + 1) % f.length : (i - 1 + f.length) % f.length;
    f[n].focus();
  }

  // ==================== TOAST ====================
  var toastEl = null, toastTimer = null;
  function toast(msg) {
    if (!toastEl) { toastEl = document.createElement('div'); toastEl.className = 'toast'; document.body.appendChild(toastEl); }
    toastEl.textContent = msg;
    void toastEl.offsetWidth;
    toastEl.classList.add('show');
    clearTimeout(toastTimer);
    toastTimer = setTimeout(function () { toastEl.classList.remove('show'); }, 2000);
  }

  // ==================== EVENTS ====================
  function setupEvents() {
    document.addEventListener('click', function (e) {
      var el = e.target.closest('[data-action]');
      if (el) handleAction(el.dataset.action);
    });
    document.addEventListener('keydown', function (e) {
      switch (e.key) {
        case 'ArrowRight': case 'ArrowDown': moveFocus(1); e.preventDefault(); break;
        case 'ArrowLeft': case 'ArrowUp': moveFocus(-1); e.preventDefault(); break;
        case 'Enter':
          if (document.activeElement && document.activeElement.dataset.action) {
            document.activeElement.click();
          }
          e.preventDefault();
          break;
        case 'Escape':
          if (currentScreen !== 'home') navigate('home');
          e.preventDefault();
          break;
      }
    });
    // Do NOT detach sensors on visibilitychange: the glasses display sleeps
    // while you walk (you're not looking at it), and detaching would drop
    // devicemotion events and badly under-count steps. Tracking pauses only on
    // an explicit Stop (toggle). Persist on pagehide.
    window.addEventListener('pagehide', save);
    // Count "hidden" events for diagnostics; re-arm the GPS watch on return
    // (motion is always attached, so it is never touched here).
    document.addEventListener('visibilitychange', function () {
      if (document.hidden) dbg.hidden++;
      else if (state.running) startGeo();
    });
  }

  // ==================== DEBUG SCREEN READOUT ====================
  function renderDebug() {
    var el = $('dbg-readout'); if (!el) return;
    var t = (typeof performance !== 'undefined') ? performance.now() : 0;
    while (dbg.hz.length && t - dbg.hz[0] > 1000) dbg.hz.shift();
    var hz = dbg.hz.length;
    function row(k, v, cls) {
      return '<div class="dbg-row"><span class="dbg-k">' + k + '</span>' +
             '<span class="dbg-v ' + (cls || '') + '">' + v + '</span></div>';
    }
    // green/red ONLY for status; key numbers are highlighted white (.big)
    function perm(s) { return s === 'granted' ? 'ok' : (s === 'denied' || s === 'unavailable') ? 'bad' : ''; }
    el.innerHTML =
      row('build', BUILD) +
      row('running', state.running ? 'YES' : 'no', state.running ? 'ok' : 'bad') +
      row('motion perm', motionStatus, perm(motionStatus)) +
      row('location perm', locationStatus, perm(locationStatus)) +
      row('rate', hz + ' Hz', (hz > 0 ? 'ok' : 'bad') + ' big') +
      row('steps', state.steps, 'big') +
      row('cross', dbg.cross, 'big') +
      row('peakDyn', dbg.peak.toFixed(2), 'big') +
      row('thr', dbg.thr.toFixed(2), 'big') +
      row('hidden', dbg.hidden, dbg.hidden > 0 ? 'bad' : '');
  }

  // Test-only hooks for desktop preview, enabled with ?debug
  function setupTestHooks() {
    window.__sv = {
      simSteps: function (n) { for (var i = 0; i < (n || 1); i++) addStep(); },
      setSteps: function (n) { state.steps = n; render(); },
      addGps: function (km) { state.gpsDistM += km * 1000; state.gpsSegments++; render(); },
      grantPerms: function () { motionStatus = 'granted'; locationStatus = 'granted'; updatePermUI(); },
      state: state
    };
  }

  // ==================== INIT ====================
  function init() {
    document.querySelectorAll('.screen').forEach(function (s) { if (s.id) screens[s.id] = s; });
    load();
    setupEvents();
    setupMotion();        // always-on accelerometer capture (independent of the UI)
    render();
    navigate('home');
    primePermissions();   // ask for motion + location as soon as the app loads
    if (state.running) { ensureMotionPermission(); startGeo(); }   // auto-resume after an unexpected reload
    setInterval(function () { if (currentScreen === 'debug') renderDebug(); }, 300);
    if (location.search.indexOf('debug') !== -1) setupTestHooks();
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init);
  else init();
})();
