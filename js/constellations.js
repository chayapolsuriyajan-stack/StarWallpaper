import * as THREE from 'three';
import { SEGMENTS, LABELS } from '../data/constellations.js';
import { LINE_VERT, LINE_FRAG } from './shaders.js';
import { deg, horizDir } from './sky.js';

/**
 * Constellation figures drawn at the stars' current positions (no trails),
 * plus optional names on a 2D overlay. Toggling fades rather than pops.
 */
export class Constellations {
  constructor(skyUniforms) {
    const raDec = new Float32Array(SEGMENTS.length);
    for (let i = 0; i < SEGMENTS.length; i++) raDec[i] = SEGMENTS[i] * deg;
    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.BufferAttribute(new Float32Array(raDec.length / 2 * 3), 3));
    geo.setAttribute('aRaDec', new THREE.BufferAttribute(raDec, 2));

    this.uniforms = {
      uLST: skyUniforms.uLST,
      uLat: skyUniforms.uLat,
      uOpacity: { value: 0 },
      uColor: { value: new THREE.Color(0.55, 0.68, 1.0) },
    };
    this.lines = new THREE.LineSegments(geo, new THREE.ShaderMaterial({
      uniforms: this.uniforms,
      vertexShader: LINE_VERT,
      fragmentShader: LINE_FRAG,
      blending: THREE.AdditiveBlending,
      depthTest: false,
      depthWrite: false,
      transparent: true,
    }));
    this.lines.frustumCulled = false;
    this.lines.renderOrder = 3;

    this.visible = false;
    this.showNames = false;
    this.opacity = 0.25;
    this.fade = 0;

    this.canvas = document.createElement('canvas');
    this.canvas.className = 'labels';
    document.body.appendChild(this.canvas);
    this.ctx = this.canvas.getContext('2d');
    this.v = new THREE.Vector3();
  }

  addTo(scene) {
    scene.add(this.lines);
  }

  resize(w, h, dpr) {
    this.canvas.width = Math.round(w * dpr);
    this.canvas.height = Math.round(h * dpr);
    this.dpr = dpr;
  }

  update(dt, camera, lstRad, latRad) {
    const target = this.visible ? 1 : 0;
    this.fade += Math.sign(target - this.fade) * Math.min(Math.abs(target - this.fade), dt / 1.5);
    this.uniforms.uOpacity.value = this.opacity * this.fade * this.fade * (3 - 2 * this.fade);
    this.lines.visible = this.fade > 0;
    this.drawLabels(camera, lstRad, latRad);
  }

  drawLabels(camera, lstRad, latRad) {
    const { ctx, canvas } = this;
    ctx.clearRect(0, 0, canvas.width, canvas.height);
    const a = this.showNames ? this.uniforms.uOpacity.value * 2.2 : 0;
    if (a <= 0.003) return;

    ctx.font = `${Math.round(10.5 * this.dpr)}px "Segoe UI", system-ui, sans-serif`;
    ctx.letterSpacing = `${(2.2 * this.dpr).toFixed(1)}px`;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    for (const l of LABELS) {
      horizDir(lstRad - l.ra * deg, l.dec * deg, latRad, this.v);
      const alt = this.v.y;
      if (alt < 0.03) continue;
      this.v.project(camera);
      if (this.v.z > 1 || Math.abs(this.v.x) > 1.1 || Math.abs(this.v.y) > 1.1) continue;
      const x = (this.v.x * 0.5 + 0.5) * canvas.width;
      const y = (-this.v.y * 0.5 + 0.5) * canvas.height;
      const fade = Math.min(1, (alt - 0.03) / 0.08);
      ctx.fillStyle = `rgba(160, 182, 235, ${Math.min(a * fade, 0.8).toFixed(3)})`;
      ctx.fillText(l.name.toUpperCase(), x, y);
    }
  }
}
