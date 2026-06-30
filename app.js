(function () {
  'use strict';

  // ==================== CONFIG ====================
  var STORAGE_KEY = 'stepview_v1';
  var RING_CIRC = 603;                 // 2*pi*r, r=96
  var KCAL_PER_KG_PER_KM = 0.9;        // gross walking estimate
  var STEP_THRESHOLD = 1.4;            // m/s^2 dynamic accel for a step peak
  var STEP_RESET = 0.4;                // must fall below this to re-arm
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
  var motionAttached = false, watchId = null;
  var motionStatus = 'unknown', locationStatus = 'unknown';   // unknown|granted|denied|unavailable
  var accelBase = 9.81, peaked = false, lastStepTs = 0;
  var lastFix = null;
  var saveTick = 0;

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
        // Note: minimized is intentionally NOT restored — always launch maximized.
      }
    } catch (e) { /* ignore */ }
    // Daily auto-reset
    if (state.lastReset !== today()) {
      state.steps = 0; state.gpsDistM = 0; state.gpsSegments = 0;
      state.lastReset = today();
      save();
    }
  }
  function save() {
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify({
        steps: state.steps, gpsDistM: state.gpsDistM, gpsSegments: state.gpsSegments,
        minimized: state.minimized, settings: state.settings, lastReset: state.lastReset
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
  function onMotion(e) {
    if (!state.running) return;
    var a = e.accelerationIncludingGravity || e.acceleration;
    if (!a || a.x == null) return;
    var m = Math.sqrt(a.x * a.x + a.y * a.y + a.z * a.z);
    accelBase = accelBase * 0.9 + m * 0.1;      // slow baseline ~ gravity
    var dyn = m - accelBase;                      // high-pass component
    var now = (typeof performance !== 'undefined' ? performance.now() : new Date().getTime());
    if (dyn > STEP_THRESHOLD && !peaked && (now - lastStepTs) > STEP_MIN_INTERVAL) {
      addStep();
      lastStepTs = now;
      peaked = true;
    }
    if (dyn < STEP_RESET) peaked = false;
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
          function () { locationStatus = 'granted'; updatePermUI(); if (state.running) attachSensors(); },
          function (err) { if (err && err.code === 1) { locationStatus = 'denied'; updatePermUI(); } },
          { enableHighAccuracy: true, timeout: 15000, maximumAge: 60000 });
      } catch (e) { /* ignore */ }
    } else {
      locationStatus = 'unavailable';
    }
    requestMotionPermission().then(function (s) {
      motionStatus = s; updatePermUI();
      if (s === 'granted' && state.running) attachSensors();
    });
  }

  function updatePermUI() {
    var banner = $('perm-banner');
    if (!banner) return;
    var missing = [];
    if (motionStatus === 'denied' || motionStatus === 'unavailable') missing.push('Motion');
    if (locationStatus === 'denied') missing.push('Location');
    var txt = $('perm-text');
    if (missing.length) {
      if (txt) txt.textContent = missing.join(' & ') + ' access needed — tap Grant';
      banner.classList.remove('hidden');
    } else {
      banner.classList.add('hidden');
    }
  }

  // ==================== SENSOR LIFECYCLE ====================
  function attachSensors() {
    if (!motionAttached) {
      if (motionStatus === 'granted') {
        window.addEventListener('devicemotion', onMotion);
        motionAttached = true;
      } else if (motionStatus !== 'unavailable') {
        // Obtain it now — works when called from a user gesture (Start / Grant)
        requestMotionPermission().then(function (s) {
          motionStatus = s; updatePermUI();
          if (s === 'granted' && !motionAttached) {
            window.addEventListener('devicemotion', onMotion); motionAttached = true;
          }
        });
      }
    }
    if ('geolocation' in navigator && watchId === null) {
      lastFix = null;
      watchId = navigator.geolocation.watchPosition(onPos, onGeoErr,
        { enableHighAccuracy: true, maximumAge: 1000, timeout: 20000 });
    }
  }
  function detachSensors() {
    if (motionAttached) { window.removeEventListener('devicemotion', onMotion); motionAttached = false; }
    if (watchId !== null) { navigator.geolocation.clearWatch(watchId); watchId = null; }
  }

  // ==================== ACTIONS ====================
  function start() {
    if (state.running) return;
    state.running = true;
    attachSensors();
    render();
    toast('Tracking started');
  }
  function stop() {
    if (!state.running) return;
    state.running = false;
    detachSensors();
    save();
    render();
    toast('Paused');
  }
  function resetCounters() {
    state.steps = 0; state.gpsDistM = 0; state.gpsSegments = 0;
    lastFix = null; accelBase = 9.81; peaked = false;
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
    // Re-arm the watch if the OS dropped it while backgrounded, without ever
    // detaching motion — keeps counting continuously while running.
    document.addEventListener('visibilitychange', function () {
      if (!document.hidden && state.running) attachSensors();
    });
  }

  // ==================== DEBUG HOOK (only when URL has ?debug — never ships in normal use) ====================
  if (location.search.indexOf('debug') !== -1) {
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
    render();
    navigate('home');
    primePermissions();   // ask for motion + location as soon as the app loads
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init);
  else init();
})();
