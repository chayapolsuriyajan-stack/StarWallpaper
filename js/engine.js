import * as THREE from 'three';
import { SkyClock, deg } from './sky.js';
import { StarTrails } from './star-trails.js';
import { Constellations } from './constellations.js';
import { Post } from './post.js';

// Trail and head brightness, tuned against the reference photo.
const TRAIL_GAIN = 0.12;
const HEAD_GAIN_WITH_TRAILS = 0.9;
const HEAD_GAIN_ALONE = 1.8;

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

    this.constellations.update(dt, this.camera, lst, u.uLat.value);
    this.post.render(this.scene, this.camera, dt, this.time);
  }

  // ------------------------------------------------------------- settings --

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
