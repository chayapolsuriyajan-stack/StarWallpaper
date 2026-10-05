import * as THREE from 'three';
import { QUAD_VERT, SKY_FRAG, WEATHER_FRAG, COPY_FRAG, DOWN_FRAG, UP_FRAG, COMPOSITE_FRAG } from './shaders.js';

const BLOOM_LEVELS = 5;

function target(w, h) {
  return new THREE.WebGLRenderTarget(Math.max(1, w), Math.max(1, h), {
    type: THREE.HalfFloatType,
    depthBuffer: false,
    minFilter: THREE.LinearFilter,
    magFilter: THREE.LinearFilter,
  });
}

function pass(fragmentShader, uniforms) {
  const mesh = new THREE.Mesh(
    new THREE.PlaneGeometry(2, 2),
    new THREE.ShaderMaterial({ vertexShader: QUAD_VERT, fragmentShader, uniforms, depthTest: false, depthWrite: false }),
  );
  mesh.frustumCulled = false;
  return mesh;
}

/**
 * The image pipeline: quarter-res sky background → full-res HDR scene
 * (background + trails + heads + lines) → dual-Kawase bloom → composite
 * (silhouette, tone curve, vignette, grain) to the screen.
 */
export class Post {
  constructor(renderer, skyUniforms) {
    this.renderer = renderer;
    this.quadCam = new THREE.OrthographicCamera(-1, 1, 1, -1, 0, 1);
    this.quadScene = new THREE.Scene();

    this.skyUniforms = {
      uLST: skyUniforms.uLST,
      uLat: skyUniforms.uLat,
      uTrail: skyUniforms.uTrail,
      uStyle: skyUniforms.uStyle,
      uInvVP: { value: new THREE.Matrix4() },
      uMilkyWay: { value: 1 },
    };
    this.skyPass = pass(SKY_FRAG, this.skyUniforms);

    // Weather: clouds, haze and fog as a premultiplied layer, blended over the
    // scene before bloom (so a star hidden by cloud leaves no glow).
    this.weatherUniforms = {
      uInvVP: this.skyUniforms.uInvVP,
      uCloud: { value: new THREE.Vector3() },
      uWind: { value: new THREE.Vector4() },
      uWindDir: { value: new THREE.Vector2(1, 0) },
      uHaze: { value: 0 },
      uFog: { value: 0 },
      uFlash: { value: 0 },
      uTime: { value: 0 },
    };
    this.weatherPass = pass(WEATHER_FRAG, this.weatherUniforms);
    this.applyPass = pass(COPY_FRAG, { tSrc: { value: null } });
    Object.assign(this.applyPass.material, {
      transparent: true,
      blending: THREE.CustomBlending,
      blendSrc: THREE.OneFactor,
      blendDst: THREE.OneMinusSrcAlphaFactor,
    });
    this.weatherOn = false;

    // Background quad that lives inside the star scene, drawn first.
    this.bgQuad = pass(COPY_FRAG, { tSrc: { value: null } });
    this.bgQuad.renderOrder = 0;

    this.downPass = pass(DOWN_FRAG, { tSrc: { value: null }, uTexel: { value: new THREE.Vector2() } });
    this.upPass = pass(UP_FRAG, { tSrc: { value: null }, uTexel: { value: new THREE.Vector2() } });
    this.upPass.material.blending = THREE.AdditiveBlending;
    this.upPass.material.transparent = true;

    this.compositeUniforms = {
      tScene: { value: null },
      tBloom: { value: null },
      uBloom: { value: 0.2 },
      uExposure: { value: 3.0 },
      uGrain: { value: 0.5 },
      uForeground: { value: 1 },
      uFlip: { value: 1 },
      uPxAng: { value: 0.001 },
      uFrame: { value: 0 },
      uRes: { value: new THREE.Vector2() },
      uInvVP: this.skyUniforms.uInvVP,
      uFog: this.weatherUniforms.uFog,
      uFlash: this.weatherUniforms.uFlash,
      uRain: { value: 0 },
      uSnow: { value: 0 },
      uTime: { value: 0 },
      uWindX: { value: 0 },
    };
    this.compositePass = pass(COMPOSITE_FRAG, this.compositeUniforms);
    this.foregroundTarget = 1;
    this.milkyWayTarget = 1;
  }

  resize(w, h) {
    this.dispose();
    this.sky = target(Math.ceil(w / 4), Math.ceil(h / 4));
    this.weather = target(Math.ceil(w / 4), Math.ceil(h / 4));
    this.applyPass.material.uniforms.tSrc.value = this.weather.texture;
    this.scene = target(w, h);
    this.bloom = [];
    let bw = w, bh = h;
    for (let i = 0; i < BLOOM_LEVELS; i++) {
      bw = Math.ceil(bw / 2); bh = Math.ceil(bh / 2);
      this.bloom.push(target(bw, bh));
    }
    this.bgQuad.material.uniforms.tSrc.value = this.sky.texture;
    this.compositeUniforms.uRes.value.set(w, h);
  }

  dispose() {
    for (const t of [this.sky, this.weather, this.scene, ...(this.bloom ?? [])]) t?.dispose();
  }

  runPass(mesh, rt) {
    this.quadScene.children.length = 0;
    this.quadScene.add(mesh);
    this.renderer.setRenderTarget(rt);
    this.renderer.render(this.quadScene, this.quadCam);
  }

  render(scene, camera, dt, time) {
    const r = this.renderer;
    const ease = (u, target) => {
      u.value += Math.sign(target - u.value) * Math.min(Math.abs(target - u.value), dt / 1.2);
    };
    ease(this.compositeUniforms.uForeground, this.foregroundTarget);
    ease(this.skyUniforms.uMilkyWay, this.milkyWayTarget);

    this.skyUniforms.uInvVP.value
      .multiplyMatrices(camera.projectionMatrix, camera.matrixWorldInverse)
      .invert();
    this.compositeUniforms.uPxAng.value =
      2 * Math.tan(THREE.MathUtils.degToRad(camera.fov) / 2) / this.scene.height;
    this.compositeUniforms.uFrame.value = Math.floor(time * 24) % 997;

    this.runPass(this.skyPass, this.sky);

    r.setRenderTarget(this.scene);
    r.render(scene, camera);

    if (this.weatherOn) {
      this.weatherUniforms.uTime.value = time;
      this.compositeUniforms.uTime.value = time;
      this.runPass(this.weatherPass, this.weather);
      r.autoClear = false;
      this.runPass(this.applyPass, this.scene);
      r.autoClear = true;
    }

    // Bloom: downsample chain, then additive upsample back to level 1 (level 0
    // is still nearly sharp and would ghost fine lines through the mountains).
    const down = this.downPass.material.uniforms;
    let src = this.scene;
    for (const rt of this.bloom) {
      down.tSrc.value = src.texture;
      down.uTexel.value.set(1 / src.width, 1 / src.height);
      this.runPass(this.downPass, rt);
      src = rt;
    }
    const up = this.upPass.material.uniforms;
    r.autoClear = false;
    for (let i = this.bloom.length - 1; i > 1; i--) {
      up.tSrc.value = this.bloom[i].texture;
      up.uTexel.value.set(1 / this.bloom[i].width, 1 / this.bloom[i].height);
      this.runPass(this.upPass, this.bloom[i - 1]);
    }
    r.autoClear = true;

    this.compositeUniforms.tScene.value = this.scene.texture;
    this.compositeUniforms.tBloom.value = this.bloom[1].texture;
    this.runPass(this.compositePass, null);
  }
}
