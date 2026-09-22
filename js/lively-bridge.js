/**
 * Lively calls livelyPropertyListener(name, value) once per property on load
 * and again on every change in the Customize panel. Sliders arrive as
 * integers; they're scaled to engine units here. explore.html drives the same
 * listener from its own panel.
 */
const bool = (v) => v === true || v === 'true';

export function connectLively(engine) {
  window.livelyPropertyListener = (name, val) => {
    const n = Number(val);
    switch (name) {
      // 1..100 → x20..x4000, exponential so the slider feels even.
      case 'speed': engine.setSpeed(20 * Math.pow(200, (n - 1) / 99)); break;
      case 'showTrails': engine.setTrails(bool(val)); break;
      case 'trailLength': engine.setTrailLength(n); break;
      case 'trailStyle': engine.setTrailStyle(n); break;
      case 'trailBuildup': engine.setBuildup(bool(val)); break;
      case 'showConstellations': engine.setConstellations(bool(val)); break;
      case 'constellationNames': engine.setConstellationNames(bool(val)); break;
      case 'constellationOpacity': engine.setConstellationOpacity(n / 100); break;
      case 'starDensity': engine.setMagLimit(n / 10); break;
      case 'exposure': engine.setExposure(3 * n / 100); break;
      case 'latitude': engine.setLatitude(n); break;
      case 'longitude': engine.setLongitude(n); break;
      case 'showMilkyWay': engine.setMilkyWay(bool(val)); break;
      case 'showForeground': engine.setForeground(bool(val)); break;
      case 'grain': engine.setGrain(n / 100); break;
      case 'mirror': engine.setMirror(bool(val)); break;
      case 'fov': engine.setFov(n); break;
      case 'fpsCap': engine.setFps(n === 1 ? 60 : 30); break;
      case 'renderScale': engine.setRenderScale(n / 100); break;
      case 'restart': engine.restart(); break;
    }
  };
}
