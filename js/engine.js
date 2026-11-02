import * as THREE from 'three';
import { SkyClock, deg } from './sky.js';
import { StarTrails } from './star-trails.js';
import { Constellations } from './constellations.js';
import { Post } from './post.js';
import { Weather, CLEAR, PRESETS } from './weather.js';
import { sunPosition, sunDirection, skyState } from './sun.js';

// Trail and head brightness, tuned against the reference photo.
const TRAIL_GAIN = 0.12;
const HEAD_GAIN_WITH_TRAILS = 0.9;
const HEAD_GAIN_ALONE = 1.8;

// Clouds drift at this many times real speed: a gentle time-lapse, in the
// spirit of the sped-up sky, without turning into a blur.
const CLOUD_TIMELAPSE = 25;
const WEATHER_EASE_S = 25; // a new reading rolls in over this long

/**
 * Shared core for wallpaper.html and explore.html. A fixed camera faces due
 * north; the real sky turns around the celestial pole, which sits at an
 * altitude equal to the observer's latitude.
 */
export class Engine {
  constructor({
    latitude = 15,
    longitude = 100.5,
    speed = 300,
    fov = 55,
    date,
  } = {}) {
    this.renderer = new THREE.WebGLRenderer({ antialias: false, powerPreference: 'high-performance' });
    this.renderer.outputColorSpace = THREE.LinearSRGBColorSpace;
    this.renderer.setClearColor(0x000000, 1);
    document.body.appendChild(this.renderer.domElement);

    this.clock = new SkyClock({ longitude, speed, date });
    this.scene = new THREE.Scene();
    this.camera = new THREE.PerspectiveCamera(fov, 1, 0.01, 10);
    this.camera.rotation.order = 'YXZ';

    this.stars = new StarTrails();
    this.stars.addTo(this.scene);
    const u = this.stars.uniforms;
    u.uLat.value = latitude * deg;

    this.constellations = new Constellations(u);
    this.constellations.addTo(this.scene);

    this.post = new Post(this.renderer, u);
    this.scene.add(this.post.bgQuad);

    this.trailsOn = true;
    this.trailMix = 1;
    this.trailDeg = 60;
    this.buildup = true;
    this.fps = 30;
    this.renderScale = 1;
    this.time = 0;
    this.flip = 1;

    // Real weather from your location (see weather.js).
    this.wx = { ...CLEAR };
    this.wxTarget = { ...CLEAR };
    this.wxSnap = true;          // the first reading appears at once
    this.wxIntensity = 1;
    this.wxPreview = null;       // a named preset overrides live data (explore.html?wx=)
    this.wind = { lx: 0, lz: 0, hx: 0, hz: 0 };
    this.flash = { next: 6, t: -1 };
    // Location (shared with the sun) arrives with the first weather refresh.
    this.location = null;
    this.weather = new Weather((p) => { this.wxTarget = { ...p }; }, (loc) => { this.location = loc; });

    // Real sunset and sunrise (see sun.js).
    this.dayMode = 'real';       // 'real' | 'dark' (holds at the blue hour) | 'night'
    this.sunPreview = null;      // { alt, az } overrides the real sun (explore.html?tod=)
    this.prevSunAlt = null;
    // Lively configures it on load; start anyway if no settings ever arrive.
    setTimeout(() => { if (!this.weather.updatedAt && this.weather.status === 'idle') this.weather.refresh(); }, 2500);

    window.addEventListener('resize', () => this.resize());
    this.resize();
  }

  resize() {
    const w = window.innerWidth;
    const h = window.innerHeight;
    const dpr = window.devicePixelRatio * this.renderScale;
    this.renderer.setPixelRatio(dpr);
    this.renderer.setSize(w, h);
    const size = this.renderer.getDrawingBufferSize(new THREE.Vector2());
    this.post.resize(size.x, size.y);
    this.stars.uniforms.uRes.value.copy(size);
    // Star widths are tuned at 1440 px tall; keep them the same on screen.
    this.stars.uniforms.uPxScale.value = Math.max(size.y / 1440, 0.6);
    this.constellations.resize(w, h, window.devicePixelRatio);
    this.camera.aspect = w / h;
    this.aimCamera();
  }

  /**
   * Frame the pole off-centre, rule-of-thirds style: ~35% in from the left
   * (right when mirrored) and a little above the middle, which leaves the
   * horizon low in the frame. Solved numerically for yaw/pitch, then pitch is
   * clamped so the horizon always stays between ~8% and ~40% up the frame.
   */
  aimCamera() {
    const cam = this.camera;
    cam.updateProjectionMatrix();
    const lat = this.stars.uniforms.uLat.value;
    const pole = new THREE.Vector3(0, Math.sin(lat), -Math.cos(lat));
    const target = new THREE.Vector2(-0.3 * this.flip, 0.1);
    const tanHalf = Math.tan((cam.fov * deg) / 2);
    const minPitch = Math.atan(0.2 * tanHalf);
    const maxPitch = Math.atan(0.84 * tanHalf);

    const at = (yaw, pitch) => {
      cam.rotation.set(pitch, yaw, 0);
      cam.updateMatrixWorld();
      return pole.clone().project(cam);
    };
    let yaw = 0, pitch = lat;
    for (let i = 0; i < 8; i++) {
      const p = at(yaw, pitch);
      const e = 1e-4;
      const py = at(yaw + e, pitch), pp = at(yaw, pitch + e);
      // 2x2 Newton step on (yaw, pitch) → pole's screen position.
      const a = (py.x - p.x) / e, b = (pp.x - p.x) / e;
      const c = (py.y - p.y) / e, d = (pp.y - p.y) / e;
      const det = a * d - b * c;
      if (Math.abs(det) < 1e-9) break;
      const rx = target.x - p.x, ry = target.y - p.y;
      yaw += (d * rx - b * ry) / det;
      pitch += (a * ry - c * rx) / det;
    }
    pitch = Math.min(Math.max(pitch, minPitch), maxPitch);
    cam.rotation.set(pitch, yaw, 0);
    cam.updateMatrixWorld();
  }

  start() {
    // Frame limiter on an accumulating deadline, so the average rate is exact
    // even when the cap isn't a factor of the monitor's refresh (60 fps on a
    // 144 Hz screen, say). Uncapped (Infinity) renders every vsync.
    let last = performance.now();
    let next = last;
    const tick = (now) => {
      requestAnimationFrame(tick);
      if (now < next - 0.5) return;
      next = Math.max(now, next + 1000 / this.fps);
      const dt = (now - last) / 1000;
      last = now;
      this.frame(Math.min(dt, 0.25));
    };
    requestAnimationFrame(tick);
  }

  frame(dt) {
    this.time += dt;
    this.clock.advance(dt);
    const u = this.stars.uniforms;

    const target = this.trailsOn ? 1 : 0;
    this.trailMix += Math.sign(target - this.trailMix) * Math.min(Math.abs(target - this.trailMix), dt / 1.2);
    const mix = this.trailMix * this.trailMix * (3 - 2 * this.trailMix);

    const trailDeg = this.buildup ? Math.min(this.trailDeg, this.clock.exposureDeg) : this.trailDeg;
    const lst = this.clock.lstDeg * deg;
    u.uLST.value = lst;
    u.uTime.value = this.time;
    u.uTrail.value = trailDeg * deg * mix;
    u.uGain.value = TRAIL_GAIN * mix;
    this.stars.headUniforms.uGain.value = HEAD_GAIN_ALONE + (HEAD_GAIN_WITH_TRAILS - HEAD_GAIN_ALONE) * mix;
    this.stars.trailMesh.visible = mix > 0.001;

    this.updateSun();
    this.updateWeather(dt);
    this.constellations.update(dt, this.camera, lst, u.uLat.value);
    this.post.render(this.scene, this.camera, dt, this.time);
  }

  /** The real sun, from the real clock at your location, drives day and night. */
  updateSun() {
    const u = this.stars.uniforms;
    let alt, az;
    if (this.sunPreview) ({ alt, az } = this.sunPreview);
    else {
      // Unknown location (on a VPN with no city): use the sky's own settings.
      const lat = this.location?.lat ?? u.uLat.value / deg;
      const lon = this.location?.lon ?? this.clock.longitude;
      ({ alt, az } = sunPosition(new Date(), lat, lon));
    }
    if (this.dayMode === 'dark') alt = Math.min(alt, -7);   // never brighter than the blue hour
    if (this.dayMode === 'night') alt = -30;
    this.sunAlt = alt;

    const st = skyState(alt);
    u.uDay.value = st.day;
    u.uTwi.value = st.twilight;
    u.uNight.value = Math.min(1, Math.max(0, (-12 - alt) / 6));
    u.uSkyMag.value = st.magLimit;
    u.uSunDir.value.set(...sunDirection(alt, az));
    // Constellation lines would look odd painted on a daylight sky.
    this.constellations.dayFade = 1 - Math.max(st.day, st.twilight * 0.6);

    // Nightfall opens the shutter: the trails build up through each night,
    // like a real all-night exposure.
    if (this.prevSunAlt != null && this.prevSunAlt >= -12 && alt < -12 && this.buildup) this.clock.openShutter();
    this.prevSunAlt = alt;
  }

  updateWeather(dt) {
    const target = this.wxPreview ?? this.wxTarget, wx = this.wx;
    const k = this.wxSnap ? 1 : Math.min(1, dt / WEATHER_EASE_S);
    if (this.weather.updatedAt || this.wxPreview) this.wxSnap = false;
    for (const key of Object.keys(CLEAR)) if (key !== 'windDir') wx[key] += (target[key] - wx[key]) * k;
    // Wind direction eases the short way round.
    const dd = ((target.windDir - wx.windDir + 540) % 360) - 180;
    wx.windDir = (wx.windDir + dd * k + 360) % 360;

    const I = this.wxIntensity;
    const w = this.post.weatherUniforms, c = this.post.compositeUniforms;
    w.uCloud.value.set(wx.cloudLow * I, wx.cloudMid * I, wx.cloudHigh * I);
    w.uHaze.value = wx.haze * I;
    w.uFog.value = wx.fog * I;
    c.uRain.value = wx.rain * I;
    c.uSnow.value = wx.snow * I;

    // Clouds move toward where the wind blows (it is reported as where it
    // comes FROM). World axes: x east, z south. Higher decks move faster.
    const toward = (wx.windDir + 180) * deg;
    const vx = Math.sin(toward), vz = -Math.cos(toward);
    w.uWindDir.value.set(vx, vz);
    const km = (Math.max(wx.windSpeed, 2) / 3600) * CLOUD_TIMELAPSE * dt;
    this.wind.lx -= vx * km * 1.6; this.wind.lz -= vz * km * 1.6;
    this.wind.hx -= vx * km * 3.0; this.wind.hz -= vz * km * 3.0;
    w.uWind.value.set(this.wind.lx, this.wind.lz, this.wind.hx, this.wind.hz);
    c.uWindX.value = Math.max(-1, Math.min(1, vx * wx.windSpeed / 30));

    // Lightning: one soft glow inside the clouds every 10-40 s in a storm.
    // Deliberately a single slow pulse, never a strobe: this runs on a
    // desktop all day, and rapid bright flashing can trigger photosensitive
    // reactions.
    const f = this.flash;
    if (wx.storm * I > 0.05 && this.time > f.next) {
      f.t = 0;
      f.next = this.time + 10 + Math.random() * 30 / wx.storm;
    }
    let flash = 0;
    if (f.t >= 0) {
      f.t += dt;
      // 0.15 s rise, then a ~1 s fade.
      flash = f.t < 0.15 ? f.t / 0.15 : Math.exp(-(f.t - 0.15) / 0.35);
      if (f.t > 1.6) f.t = -1;
    }
    w.uFlash.value = flash * Math.min(1, wx.storm * I);

    this.post.weatherOn = wx.cloudLow + wx.cloudMid + wx.cloudHigh + wx.haze + wx.fog + wx.rain + wx.snow > 0.002 && I > 0;
  }

  // ------------------------------------------------------------- settings --

  setWeather(on) { this.weather.configure({ enabled: on }); }
  setWeatherMode(i) { this.weather.configure({ mode: i === 1 ? 'city' : 'auto' }); }
  setWeatherCity(city) { this.weather.configure({ city: String(city ?? '') }); }
  setWeatherIntensity(v) { this.wxIntensity = v; }
  setDayMode(i) { this.dayMode = ['real', 'dark', 'night'][i] ?? 'real'; }
  /** Show the sun at a given altitude/azimuth instead of the real one (null returns to real). */
  previewSun(alt, az = 250) {
    this.sunPreview = alt == null ? null : { alt, az };
  }
  /** Show a named condition instead of live data (null returns to live). */
  previewWeather(name) {
    this.wxPreview = name ? { ...(PRESETS[name] ?? CLEAR) } : null;
  }

  setSpeed(multiplier) { this.clock.speed = multiplier; }
  setTrails(on) { this.trailsOn = on; }
  setTrailLength(d) { this.trailDeg = d; this.stars.setSegmentsFor(d); }
  setTrailStyle(i) { this.stars.uniforms.uStyle.value = i; }
  setBuildup(on) { this.buildup = on; }
  restart() { this.clock.openShutter(); }
  setConstellations(on) { this.constellations.visible = on; }
  setConstellationNames(on) { this.constellations.showNames = on; }
  setConstellationOpacity(v) { this.constellations.opacity = v; }
  setMagLimit(m) { this.stars.setMagLimit(m); }
  setLongitude(d) { this.clock.longitude = d; }
  setMilkyWay(on) { this.post.milkyWayTarget = on ? 1 : 0; }
  setForeground(on) { this.post.foregroundTarget = on ? 1 : 0; }
  setGrain(v) { this.post.compositeUniforms.uGrain.value = v; }
  setExposure(v) { this.post.compositeUniforms.uExposure.value = v; }
  setFps(v) { this.fps = v; }

  setLatitude(d) {
    this.stars.uniforms.uLat.value = d * deg;
    this.aimCamera();
  }

  setMirror(on) {
    this.flip = on ? -1 : 1;
    this.post.compositeUniforms.uFlip.value = this.flip;
    this.aimCamera();
  }

  setFov(v) {
    this.camera.fov = v;
    this.aimCamera();
  }

  setRenderScale(v) {
    this.renderScale = v;
    this.resize();
  }
}
