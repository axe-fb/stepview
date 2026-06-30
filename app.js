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

  // ==================== STATE ====================
  var state = {
    running: false,
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
        settings: state.settings, lastReset: state.lastReset
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
    $('goal-line').innerHTML = 'Goal ' + fmtInt(goal) + ' · ' + Math.round(pct) + '%';
    $('ring-prog').style.strokeDashoffset = (RING_CIRC * (1 - pct / 100)).toFixed(1);
    $('distance').textContent = distKm().toFixed(2);
    $('calories').textContent = fmtInt(calories());

    var st = $('status');
    st.textContent = state.running ? 'Active' : 'Paused';
    st.classList.toggle('active', state.running);
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
    // Non-fatal: app falls back to step-estimated distance.
    if (err && err.code === 1) toast('Location denied — using steps');
  }

  // ==================== SENSOR LIFECYCLE ====================
  function attachSensors() {
    if (motionAttached) return;
    if (typeof DeviceMotionEvent !== 'undefined' &&
        typeof DeviceMotionEvent.requestPermission === 'function') {
      DeviceMotionEvent.requestPermission().then(function (r) {
        if (r === 'granted') { window.addEventListener('devicemotion', onMotion); motionAttached = true; }
        else toast('Motion permission denied');
      }).catch(function () { window.addEventListener('devicemotion', onMotion); motionAttached = true; });
    } else {
      window.addEventListener('devicemotion', onMotion);
      motionAttached = true;
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
      case 'start': start(); break;
      case 'stop': stop(); break;
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
    focusFirst();
  }
  function focusables() {
    return Array.prototype.slice.call(
      screens[currentScreen].querySelectorAll('.focusable:not([disabled])'));
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
    // Pause sensors when the app is hidden (battery); resume if still running.
    document.addEventListener('visibilitychange', function () {
      if (document.hidden) { if (state.running) detachSensors(); }
      else { if (state.running) attachSensors(); }
    });
    window.addEventListener('pagehide', save);
  }

  // ==================== DEBUG HOOK (browser preview only) ====================
  window.__sv = {
    simSteps: function (n) { for (var i = 0; i < (n || 1); i++) addStep(); },
    setSteps: function (n) { state.steps = n; render(); },
    addGps: function (km) { state.gpsDistM += km * 1000; state.gpsSegments++; render(); },
    state: state
  };

  // ==================== INIT ====================
  function init() {
    document.querySelectorAll('.screen').forEach(function (s) { if (s.id) screens[s.id] = s; });
    load();
    setupEvents();
    render();
    navigate('home');
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init);
  else init();
})();
