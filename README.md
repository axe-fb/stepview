# StepView

A browser-based **step / distance / calorie counter** for the **Meta Ray-Ban Display** glasses.
Pure static web app (HTML/CSS/JS) — no backend, no build step.

## How it works

- **Steps** — peak detection on the accelerometer (`DeviceMotionEvent.accelerationIncludingGravity`)
  with a low-pass baseline, dynamic threshold, and a 250 ms refractory window (caps cadence ~4 steps/s).
- **Distance** — hybrid: cumulative haversine over `navigator.geolocation` fixes (accuracy ≤ 30 m,
  jitter/jump gated) when GPS is available, falling back to `steps × stride` indoors
  (stride ≈ height × 0.415).
- **Calories** — `distance_km × weight_kg × 0.9` (gross walking estimate).
- **Persistence** — `localStorage`, with automatic daily reset.

## Screens

1. **Steps** — glanceable ring (progress to goal), distance, calories, Start/Stop.
2. **Settings** — step goal, body weight, height (stride), and Reset.

## Display notes (Meta Display Glasses)

- 600 × 600 dp viewport; additive waveguide display (`#000` = transparent — real world shows through).
- UI surfaces use the bright end of the dark-gray range with visible borders so they read on a
  see-through canvas; text is bright white. D-pad focus + EMG pinch input.

## Run on glasses

Served over HTTPS via GitHub Pages, then opened in the glasses browser
(directly or via an `fb-viewapp://web_app_deep_link` deep link / QR).
