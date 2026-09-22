import * as THREE from 'three';
import { STARS_B64, STAR_COUNT } from '../data/stars.js';
import { TRAIL_VERT, TRAIL_FRAG, HEAD_VERT, HEAD_FRAG } from './shaders.js';
import { deg } from './sky.js';

function decodeStars() {
  const bin = atob(STARS_B64);
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  return new Float32Array(bytes.buffer);
}

/** B−V colour index → linear RGB with unit luminance, gently desaturated. */
function bvToRgb(bv) {
  bv = Math.min(Math.max(bv, -0.4), 2.0);
  // Ballesteros (2012): colour index → effective temperature.
  const T = 4600 * (1 / (0.92 * bv + 1.7) + 1 / (0.92 * bv + 0.62));
  // Planckian locus → sRGB (Tanner Helland fit), then to linear.
  const t = T / 100;
  let r, g, b;
  if (t <= 66) {
    r = 255;
    g = 99.4708025861 * Math.log(t) - 161.1195681661;
    b = t <= 19 ? 0 : 138.5177312231 * Math.log(t - 10) - 305.0447927307;
  } else {
    r = 329.698727446 * Math.pow(t - 60, -0.1332047592);
    g = 288.1221695283 * Math.pow(t - 60, -0.0755148492);
    b = 255;
  }
  const lin = (v) => Math.pow(Math.min(Math.max(v, 0), 255) / 255, 2.2);
  let c = [lin(r), lin(g), lin(b)];
  const y = 0.2126 * c[0] + 0.7152 * c[1] + 0.0722 * c[2];
  // A camera sensor + white balance renders most stars nearly white.
  return c.map((v) => (y + (v / y - 1) * 0.55 * y) / y);
}

/**
 * Every catalogue star as an analytic arc: one instance per star, a ribbon
 * strip along its diurnal circle computed in the vertex shader, plus a
 * point-sprite "head" at its current position.
 */
export class StarTrails {
  constructor() {
    const raw = decodeStars();
    this.mags = new Float32Array(STAR_COUNT);
    const star = new Float32Array(STAR_COUNT * 4);
    const color = new Float32Array(STAR_COUNT * 3);
    for (let i = 0; i < STAR_COUNT; i++) {
      const [ra, dec, mag, bv] = raw.subarray(i * 4, i * 4 + 4);
      this.mags[i] = mag;
      star[i * 4] = ra * deg;
      star[i * 4 + 1] = dec * deg;
      // Photographic stretch: a long exposure lifts faint stars far more than
      // bright ones, so energy follows flux^0.62 rather than flux.
      star[i * 4 + 2] = Math.pow(10, -0.4 * mag * 0.62);
      // PSF width grows with brightness (seeing + sensor bloom).
      star[i * 4 + 3] = 0.55 + 1.1 * Math.min(Math.max((6.5 - mag) / 8, 0), 1);
      color.set(bvToRgb(bv), i * 3);
    }
    this.starAttr = new THREE.InstancedBufferAttribute(star, 4);
    this.colorAttr = new THREE.InstancedBufferAttribute(color, 3);

    this.uniforms = {
      uLST: { value: 0 },
      uLat: { value: 15 * deg },
      uTrail: { value: 0 },
      uRes: { value: new THREE.Vector2(1, 1) },
      uPxScale: { value: 1 },
      uGain: { value: 1 },
      uStyle: { value: 0 },
      uTime: { value: 0 },
    };

    this.trailMaterial = new THREE.ShaderMaterial({
      uniforms: this.uniforms,
      vertexShader: TRAIL_VERT,
      fragmentShader: TRAIL_FRAG,
      blending: THREE.AdditiveBlending,
      depthTest: false,
      depthWrite: false,
      transparent: true,
    });
    this.trailMesh = new THREE.Mesh(new THREE.InstancedBufferGeometry(), this.trailMaterial);
    this.trailMesh.frustumCulled = false;
    this.trailMesh.renderOrder = 1;
    this.segments = 0;
    this.setSegmentsFor(60);

    this.headUniforms = { ...this.uniforms, uGain: { value: 1 } };
    const headGeo = new THREE.BufferGeometry();
    // Plain (non-instanced) attributes over the same arrays.
    headGeo.setAttribute('position', new THREE.BufferAttribute(new Float32Array(STAR_COUNT * 3), 3));
    headGeo.setAttribute('aStar', new THREE.BufferAttribute(star, 4));
    headGeo.setAttribute('aColor', new THREE.BufferAttribute(color, 3));
    this.heads = new THREE.Points(headGeo, new THREE.ShaderMaterial({
      uniforms: this.headUniforms,
      vertexShader: HEAD_VERT,
      fragmentShader: HEAD_FRAG,
      blending: THREE.AdditiveBlending,
      depthTest: false,
      depthWrite: false,
      transparent: true,
    }));
    this.heads.frustumCulled = false;
    this.heads.renderOrder = 2;

    this.setMagLimit(7);
  }

  addTo(scene) {
    scene.add(this.trailMesh, this.heads);
  }

  /** Rebuild the shared ribbon strip so arcs stay smooth at any length. */
  setSegmentsFor(trailDeg) {
    const n = Math.min(Math.max(Math.ceil(trailDeg / 2.5), 6), 72);
    if (n === this.segments) return;
    this.segments = n;
    const pos = new Float32Array((n + 1) * 2 * 3);
    const idx = [];
    for (let i = 0; i <= n; i++) {
      pos.set([i / n, -1, 0, i / n, 1, 0], i * 6);
      if (i < n) {
        const a = i * 2;
        idx.push(a, a + 1, a + 2, a + 1, a + 3, a + 2);
      }
    }
    const geo = new THREE.InstancedBufferGeometry();
    geo.setAttribute('position', new THREE.BufferAttribute(pos, 3));
    geo.setIndex(idx);
    geo.setAttribute('aStar', this.starAttr);
    geo.setAttribute('aColor', this.colorAttr);
    geo.instanceCount = this.count ?? STAR_COUNT;
    this.trailMesh.geometry.dispose();
    this.trailMesh.geometry = geo;
  }

  /** Stars are sorted by magnitude, so the limit is just a draw count. */
  setMagLimit(mag) {
    let lo = 0, hi = STAR_COUNT;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      if (this.mags[mid] <= mag) lo = mid + 1; else hi = mid;
    }
    this.count = lo;
    this.trailMesh.geometry.instanceCount = lo;
    this.heads.geometry.setDrawRange(0, lo);
  }
}
