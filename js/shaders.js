/**
 * GLSL sources. World frame for every shader: camera at the origin,
 * +x = east, +y = up (zenith), +z = south, so the camera faces north down -z.
 */

// The real sun (sun.js): direction in this frame, how much daylight (0..1),
// how much dusk/dawn colour (0..1), and how dark the night is (1 = full night).
const SUN_UNIFORMS = /* glsl */ `
uniform vec3 uSunDir;
uniform float uDay, uTwi, uNight;
// 1 looking toward the sun's compass bearing, 0 looking away.
float towardSun(vec3 d) {
  vec2 s = uSunDir.xz, v = d.xz;
  float ls = length(s), lv = length(v);
  if (ls < 1e-4 || lv < 1e-4) return 0.5;
  // Clamped: looking straight away from the sun, rounding can make the dot
  // product -1.0000001, and pow() of a value below zero is NaN, which the
  // bloom pass then smears into flickering black blocks.
  return pow(clamp(0.5 + 0.5 * dot(s / ls, v / lv), 0.0, 1.0), 1.6);
}
`;

// Equatorial (hour angle, declination) → horizontal unit vector, plus the
// atmosphere. Shared by every layer that draws something on the sky.
export const SKY_COMMON = /* glsl */ `
uniform float uLST;  // local sidereal time, radians
uniform float uLat;  // observer latitude, radians

vec3 horizDir(float H, float dec) {
  float cd = cos(dec), sd = sin(dec), ch = cos(H), sh = sin(H);
  float cl = cos(uLat), sl = sin(uLat);
  return vec3(-cd * sh, cd * ch * cl + sd * sl, cd * ch * sl - sd * cl);
}

// Per-channel atmospheric transmission for a direction whose sin(altitude)
// is sinAlt: Kasten-Young airmass, with more extinction in blue than red so
// stars low in the sky dim and redden. Fades to zero just below the horizon.
vec3 transmission(float sinAlt) {
  float altDeg = degrees(asin(clamp(sinAlt, -1.0, 1.0)));
  float a = max(altDeg, 0.0);
  float X = 1.0 / (sin(radians(a)) + 0.50572 * pow(a + 6.07995, -1.6364));
  vec3 k = vec3(0.13, 0.21, 0.36);
  return pow(vec3(10.0), -0.4 * k * (X - 1.0)) * smoothstep(-0.6, 0.4, altDeg);
}
`;

// ---------------------------------------------------------------- trails --

// One instance per star; the base strip runs t = 0 (star now) → 1 (where it
// was uTrail radians of rotation ago), side = ±1 across the ribbon. The
// ribbon is widened in screen space so it's always a crisp few pixels wide.
export const TRAIL_VERT = /* glsl */ `
${SKY_COMMON}
attribute vec4 aStar;   // ra, dec (rad), energy, psf sigma (px @1440p)
attribute vec3 aColor;
uniform float uTrail;
uniform vec2 uRes;
uniform float uPxScale;
uniform float uGain;
uniform float uStyle;   // 0 comet, 1 exposure
uniform float uSkyMag;  // faintest magnitude the sky still shows
varying vec3 vColor;
varying float vAcross;

void main() {
  float t = position.x;
  float side = position.y;
  float H = uLST - aStar.x - t * uTrail;
  vec3 p = horizDir(H, aStar.y);
  vec3 q = horizDir(H + 0.003, aStar.y);

  mat4 vp = projectionMatrix * viewMatrix;
  vec4 c = vp * vec4(p, 1.0);
  vec4 c2 = vp * vec4(q, 1.0);
  vec2 s = c.xy / max(c.w, 1e-4);
  vec2 s2 = c2.xy / max(c2.w, 1e-4);
  vec2 dir = (s2 - s) * uRes;
  float len = length(dir);
  dir = len > 1e-6 ? dir / len : vec2(1.0, 0.0);
  vec2 n = vec2(-dir.y, dir.x);

  float sigma = aStar.w * uPxScale;
  float halfW = sigma * 3.0 + 0.75;
  c.xy += n * side * halfW * 2.0 / uRes * c.w;
  gl_Position = c;

  // Exposure per pixel of a trail goes as flux / angular speed, and angular
  // speed goes as cos(dec): slow stars near the pole burn brighter arcs.
  float slow = inversesqrt(max(cos(aStar.y), 0.08));
  float fade = uStyle < 0.5
    ? pow(1.0 - t, 1.35)
    : smoothstep(1.0, 0.9, t) * mix(0.8, 1.0, smoothstep(0.0, 0.05, t));
  // Arcs that swing behind the camera would otherwise collapse into a
  // straight chord across the frame; fade them out well outside the view.
  float facing = smoothstep(0.08, 0.3, -(viewMatrix * vec4(p, 0.0)).z);
  // The brighter the sky (twilight, day), the fewer stars: faint ones go first.
  float magnitude = -log(max(aStar.z, 1e-9)) / (0.4 * 0.62 * 2.302585);
  float skyVis = smoothstep(uSkyMag + 1.5, uSkyMag, magnitude);
  vColor = aColor * aStar.z * uGain * slow * fade * facing * skyVis * transmission(p.y) / (sigma * 2.5066);
  vAcross = side * halfW / sigma;
}
`;

export const TRAIL_FRAG = /* glsl */ `
varying vec3 vColor;
varying float vAcross;
void main() {
  gl_FragColor = vec4(vColor * exp(-0.5 * vAcross * vAcross), 1.0);
}
`;

// ----------------------------------------------------------------- heads --

export const HEAD_VERT = /* glsl */ `
${SKY_COMMON}
attribute vec4 aStar;
attribute vec3 aColor;
uniform float uPxScale;
uniform float uGain;
uniform float uTime;
uniform float uSkyMag;
varying vec3 vColor;
varying float vSize;
varying float vSigma;

void main() {
  vec3 p = horizDir(uLST - aStar.x, aStar.y);
  gl_Position = projectionMatrix * viewMatrix * vec4(p, 1.0);

  float sigma = aStar.w * uPxScale * 1.05;
  vSize = ceil(sigma * 7.0) + 2.0;
  vSigma = sigma;
  gl_PointSize = p.y < -0.02 ? 0.0 : vSize;

  // Scintillation: stronger through the thick air near the horizon.
  float seed = aStar.x * 913.7 + aStar.y * 457.3;
  float depth = mix(0.35, 0.05, clamp(p.y * 2.5, 0.0, 1.0));
  float tw = 1.0 + depth * (0.6 * sin(uTime * 9.1 + seed) + 0.4 * sin(uTime * 14.3 + seed * 1.7));

  // The brighter the sky (twilight, day), the fewer stars: faint ones go first.
  float magnitude = -log(max(aStar.z, 1e-9)) / (0.4 * 0.62 * 2.302585);
  float skyVis = smoothstep(uSkyMag + 1.5, uSkyMag, magnitude);
  vColor = aColor * aStar.z * uGain * tw * skyVis * transmission(p.y) / (6.2832 * sigma * sigma);
}
`;

export const HEAD_FRAG = /* glsl */ `
varying vec3 vColor;
varying float vSize;
varying float vSigma;
void main() {
  vec2 d = (gl_PointCoord - 0.5) * vSize / vSigma;
  gl_FragColor = vec4(vColor * exp(-0.5 * dot(d, d)), 1.0);
}
`;

// -------------------------------------------------------- constellations --

export const LINE_VERT = /* glsl */ `
${SKY_COMMON}
attribute vec2 aRaDec;
uniform float uOpacity;
varying float vA;
void main() {
  vec3 p = horizDir(uLST - aRaDec.x, aRaDec.y);
  gl_Position = projectionMatrix * viewMatrix * vec4(p, 1.0);
  vA = uOpacity * smoothstep(-0.005, 0.05, p.y);
}
`;

export const LINE_FRAG = /* glsl */ `
uniform vec3 uColor;
varying float vA;
void main() { gl_FragColor = vec4(uColor * vA, 1.0); }
`;

// ------------------------------------------------------ fullscreen passes --

export const QUAD_VERT = /* glsl */ `
varying vec2 vUv;
void main() {
  vUv = position.xy * 0.5 + 0.5;
  gl_Position = vec4(position.xy, 0.0, 1.0);
}
`;

const NOISE = /* glsl */ `
float hash13(vec3 p) {
  p = fract(p * 0.1031);
  p += dot(p, p.zyx + 31.32);
  return fract((p.x + p.y) * p.z);
}
float vnoise(vec3 p) {
  vec3 i = floor(p), f = fract(p);
  f = f * f * (3.0 - 2.0 * f);
  return mix(mix(mix(hash13(i), hash13(i + vec3(1,0,0)), f.x),
                 mix(hash13(i + vec3(0,1,0)), hash13(i + vec3(1,1,0)), f.x), f.y),
             mix(mix(hash13(i + vec3(0,0,1)), hash13(i + vec3(1,0,1)), f.x),
                 mix(hash13(i + vec3(0,1,1)), hash13(i + vec3(1,1,1)), f.x), f.y), f.z);
}
float fbm(vec3 p) {
  float s = 0.0, a = 0.5;
  for (int i = 0; i < 5; i++) { s += a * vnoise(p); p = p * 2.03 + 17.1; a *= 0.5; }
  return s;
}
float hash11(float x) { return fract(sin(x * 127.1) * 43758.5453); }
float vnoise1(float x) {
  float i = floor(x), f = fract(x);
  return mix(hash11(i), hash11(i + 1.0), f * f * (3.0 - 2.0 * f));
}
float fbm1(float x) {
  float s = 0.0, a = 0.5;
  for (int i = 0; i < 6; i++) { s += a * vnoise1(x); x = x * 2.1 + 3.7; a *= 0.5; }
  return s;
}
`;

const RAY = /* glsl */ `
uniform mat4 uInvVP;
vec3 rayDir(vec2 uv) {
  vec4 w = uInvVP * vec4(uv * 2.0 - 1.0, 1.0, 1.0);
  return normalize(w.xyz / w.w);
}
`;

// Night sky background: airglow gradient, a little light pollution, and the
// Milky Way built in galactic coordinates so it turns with the real sky. The
// Milky Way is smeared along the same arc as the trails, like the exposure
// would smear it. Rendered at quarter resolution — it's all low frequency.
export const SKY_FRAG = /* glsl */ `
${SKY_COMMON}
${NOISE}
${RAY}
${SUN_UNIFORMS}
uniform float uMilkyWay;
uniform float uTrail;
uniform float uStyle;
varying vec2 vUv;

float milkyWay(float ra, float dec, out float core) {
  vec3 e = vec3(cos(dec) * cos(ra), cos(dec) * sin(ra), sin(dec));
  // J2000 equatorial → galactic.
  vec3 g = vec3(
    dot(vec3(-0.0548755604, -0.8734370902, -0.4838350155), e),
    dot(vec3( 0.4941094279, -0.4448296300,  0.7469822445), e),
    dot(vec3(-0.8676661490, -0.1980763734,  0.4559837762), e));
  float b = asin(clamp(g.z, -1.0, 1.0));
  float cl = g.x / max(length(g.xy), 1e-4);          // cos(galactic longitude)
  core = exp((cl - 1.0) * 3.5);
  float width = mix(0.16, 0.26, core);
  float band = exp(-b * b / (width * width));
  float clumps = fbm(g * 7.0);
  float dust = smoothstep(0.42, 0.72, fbm(g * 5.0 + 3.1)) * exp(-b * b / 0.004);
  return band * (0.35 + 1.1 * clumps * clumps) * (0.55 + 1.2 * core) * (1.0 - 0.75 * dust);
}

void main() {
  vec3 d = rayDir(vUv);
  float alt = asin(clamp(d.y, -1.0, 1.0));
  float az = atan(d.x, -d.z);
  float up = max(alt, 0.0);

  // Airglow and scattered light: a blue-grey sky brightening to the horizon.
  vec3 col = vec3(0.0035, 0.0048, 0.0085);
  col += vec3(0.010, 0.013, 0.019) * exp(-up / 0.35);
  col += vec3(0.012, 0.014, 0.017) * exp(-up / 0.07);
  // Faint sodium glow from a distant town, off to the north-east.
  col += vec3(0.010, 0.007, 0.004) * exp(-up / 0.06) * exp(-((az - 0.7) / 0.5) * ((az - 0.7) / 0.5)); // squared directly: pow() is undefined below zero

  if (uMilkyWay > 0.001) {
    // Back to equatorial: horizontal (S, W, Up) → hour-angle frame.
    float sl = sin(uLat), cl = cos(uLat);
    float S = d.z, U = d.y, W = -d.x;
    vec3 h = vec3(S * sl + U * cl, W, -S * cl + U * sl);
    float H = atan(h.y, h.x);
    float dec = asin(clamp(h.z, -1.0, 1.0));
    float ra = uLST - H;

    float mw = 0.0, wsum = 0.0, core = 0.0, c;
    for (int k = 0; k < 6; k++) {
      float t = float(k) / 5.0;
      float w = uStyle < 0.5 ? pow(1.0 - t * 0.999, 1.35) : 1.0;
      mw += w * milkyWay(ra - t * uTrail, dec, c);
      core += w * c;
      wsum += w;
    }
    mw /= wsum; core /= wsum;
    vec3 tint = mix(vec3(0.78, 0.84, 1.0), vec3(1.0, 0.9, 0.78), core);
    col += tint * mw * 0.018 * uMilkyWay * uNight * transmission(d.y);
  }

  // Twilight and day, from the real sun. Colours are chosen so that, after
  // the camera's exposure and tone curve, day reads as a clear blue and dusk
  // as a deep blue sky with a warm band where the sun went down.
  if (uTwi + uDay > 0.001) {
    float toward = towardSun(d);
    float hor = exp(-up / 0.10);
    vec3 twi = mix(vec3(0.010, 0.017, 0.045), vec3(0.030, 0.040, 0.075), exp(-up / 0.35));
    // The afterglow: a warm band along the whole horizon, strongest on the
    // sun's side even when that side is out of frame.
    twi += vec3(0.17, 0.075, 0.024) * hor * (0.3 + 0.7 * toward);
    twi += vec3(0.05, 0.03, 0.022) * exp(-up / 0.3) * (0.4 + 0.6 * toward);
    twi += vec3(0.04, 0.024, 0.034) * exp(-up / 0.22) * (1.0 - toward) * 0.5; // Belt of Venus
    vec3 daySky = mix(vec3(0.090, 0.122, 0.170), vec3(0.015, 0.040, 0.130), pow(up, 0.45));
    daySky += vec3(0.10, 0.085, 0.06) * pow(max(dot(d, uSunDir), 0.0), 12.0)
            + vec3(0.03, 0.028, 0.022) * hor * toward;
    col = mix(col, twi, uTwi);
    col = mix(col, daySky, uDay);
  }
  gl_FragColor = vec4(col, 1.0);
}
`;

// Real weather, as a premultiplied layer (rgb = light, a = opacity) blended
// over the scene before bloom, so stars behind a cloud leave no glow. Three
// cloud decks sit on flat ceilings (1.5, 4 and 9 km): a view ray meets each
// at d.xz * height / d.y, which gives true perspective, clouds bunching up
// toward the horizon. Night clouds are dark against the stars and lit warm
// from below on the side of the town glow; haze and fog sit in front.
export const WEATHER_FRAG = /* glsl */ `
${NOISE}
${RAY}
uniform vec3 uCloud;    // low, mid, high deck coverage, 0..1
uniform vec4 uWind;     // xy: low/mid drift (km), zw: high drift (km)
uniform vec2 uWindDir;  // unit vector the wind blows toward (x east, y south)
uniform float uHaze, uFog, uFlash, uTime;
${SUN_UNIFORMS}
varying vec2 vUv;

// Night colour → dusk (pink-orange undersides toward the sun) → day (white
// tops, grey where thick).
vec3 lightCloud(vec3 night, float n, float thick, float toward) {
  vec3 twi = vec3(0.020, 0.020, 0.030) * (0.5 + 0.7 * n)
           + vec3(0.13, 0.055, 0.03) * toward * (0.6 + 0.6 * n) * (1.0 - 0.5 * thick);
  vec3 day = mix(vec3(0.16, 0.165, 0.175), vec3(0.075, 0.08, 0.088), thick) * (0.6 + 0.7 * n);
  return mix(mix(night, twi, uTwi), day, uDay);
}

// Coverage c turns noise into cloud: more cover, lower threshold.
float cover(float n, float c) {
  float t = mix(0.80, 0.24, c);
  return smoothstep(t, t + 0.17, n) * step(0.002, c);
}

void main() {
  vec3 d = rayDir(vUv);
  float up = max(d.y, 0.0);
  float az = atan(d.x, -d.z); // real-world bearing, like the sky's town glow
  // The town glow lights cloud bases from below, strongest low in the NE.
  float town = exp(-((az - 0.7) / 0.6) * ((az - 0.7) / 0.6));
  vec3 under = vec3(0.0075, 0.0052, 0.0034) * town;
  vec3 flash = uFlash * vec3(0.026, 0.029, 0.037); // a glow inside the cloud, not a camera flash

  vec3 acc = vec3(0.0);   // light so far (front to back)
  float T = 1.0;          // transmittance so far

  // Haze and fog are nearest: a veil thickening toward the horizon.
  float hazeA = uHaze * 0.32 * exp(-up / 0.08);
  float fogA = uFog * (0.78 + 0.22 * exp(-up / 0.14)); // ~1 km visibility hides nearly every star
  float veil = 1.0 - (1.0 - hazeA) * (1.0 - fogA);
  float toward = towardSun(d);
  vec3 veilCol = vec3(0.010, 0.0115, 0.0140) + under * 0.8 + flash * 0.25;
  veilCol = mix(mix(veilCol, vec3(0.035, 0.032, 0.042) + vec3(0.06, 0.03, 0.015) * toward, uTwi), vec3(0.11, 0.12, 0.13), uDay);
  acc += T * veil * veilCol; T *= 1.0 - veil;

  if (d.y > 0.0 && (uCloud.x + uCloud.y + uCloud.z) > 0.0) {
    float y = max(d.y, 0.012);
    float lowSky = exp(-up / 0.2);

    // Low deck: stratocumulus, chunky, the one that hides stars.
    float distL = 1.5 / y;
    vec2 pL = d.xz * distL + uWind.xy;
    float nL = fbm(vec3(pL * 0.55, uTime * 0.004));
    float aL = mix(cover(nL, uCloud.x), uCloud.x, smoothstep(10.0, 50.0, distL)) * 0.97;
    vec3 cL = vec3(0.0052, 0.0057, 0.0068) * (0.55 + 0.7 * nL) + under * (0.3 + 2.4 * lowSky) * (0.6 + nL)
            + flash * (0.4 + nL);
    cL = lightCloud(cL, nL, 1.0, toward);
    acc += T * aL * cL; T *= 1.0 - aL;

    // Middle deck: altocumulus, smaller puffs, a little thinner.
    float distM = 4.0 / y;
    vec2 pM = d.xz * distM + uWind.xy * 1.4 + 31.7;
    float nM = fbm(vec3(pM * 0.42, uTime * 0.003 + 5.0));
    float aM = mix(cover(nM, uCloud.y), uCloud.y, smoothstep(25.0, 130.0, distM)) * 0.85;
    vec3 cM = vec3(0.0050, 0.0055, 0.0068) * (0.6 + 0.6 * nM) + under * (0.3 + 1.2 * lowSky) + flash * 0.6 * nM;
    cM = lightCloud(cM, nM, 0.6, toward);
    acc += T * aM * cM; T *= 1.0 - aM;

    // High deck: cirrus, combed out along the wind and thin enough that
    // the brighter stars still show through.
    float distH = 9.0 / y;
    vec2 pH = d.xz * distH + uWind.zw;
    vec2 along = vec2(dot(pH, uWindDir), dot(pH, vec2(-uWindDir.y, uWindDir.x)));
    float nH = fbm(vec3(along.x * 0.03, along.y * 0.16, 2.0));
    float aH = mix(cover(nH, uCloud.z), uCloud.z * 0.6, smoothstep(40.0, 220.0, distH)) * 0.5;
    vec3 cH = vec3(0.0062, 0.0072, 0.0098) * (0.7 + 0.5 * nH) + under * 0.25 + flash * 0.3;
    cH = lightCloud(cH, nH, 0.1, toward);
    acc += T * aH * cH; T *= 1.0 - aH;
  }
  gl_FragColor = vec4(acc, 1.0 - T);
}
`;

export const COPY_FRAG = /* glsl */ `
uniform sampler2D tSrc;
varying vec2 vUv;
void main() { gl_FragColor = texture2D(tSrc, vUv); }
`;

// Dual-Kawase bloom.
export const DOWN_FRAG = /* glsl */ `
uniform sampler2D tSrc;
uniform vec2 uTexel;
varying vec2 vUv;
void main() {
  vec2 o = uTexel * 0.5;
  vec3 s = texture2D(tSrc, vUv).rgb * 4.0;
  s += texture2D(tSrc, vUv - o).rgb;
  s += texture2D(tSrc, vUv + o).rgb;
  s += texture2D(tSrc, vUv + vec2(o.x, -o.y)).rgb;
  s += texture2D(tSrc, vUv - vec2(o.x, -o.y)).rgb;
  gl_FragColor = vec4(s / 8.0, 1.0);
}
`;

export const UP_FRAG = /* glsl */ `
uniform sampler2D tSrc;
uniform vec2 uTexel;
varying vec2 vUv;
void main() {
  vec2 o = uTexel * 0.5;
  vec3 s = texture2D(tSrc, vUv + vec2(-o.x * 2.0, 0.0)).rgb;
  s += texture2D(tSrc, vUv + vec2(-o.x, o.y)).rgb * 2.0;
  s += texture2D(tSrc, vUv + vec2(0.0, o.y * 2.0)).rgb;
  s += texture2D(tSrc, vUv + vec2(o.x, o.y)).rgb * 2.0;
  s += texture2D(tSrc, vUv + vec2(o.x * 2.0, 0.0)).rgb;
  s += texture2D(tSrc, vUv + vec2(o.x, -o.y)).rgb * 2.0;
  s += texture2D(tSrc, vUv + vec2(0.0, -o.y * 2.0)).rgb;
  s += texture2D(tSrc, vUv + vec2(-o.x, -o.y)).rgb * 2.0;
  gl_FragColor = vec4(s / 12.0, 1.0);
}
`;

// Final "camera": lens glow, the mountain silhouette, filmic tone curve,
// vignette, and grain.
export const COMPOSITE_FRAG = /* glsl */ `
${NOISE}
${RAY}
uniform sampler2D tScene;
uniform sampler2D tBloom;
uniform float uBloom;
uniform float uExposure;
uniform float uGrain;
uniform float uForeground;
uniform float uFlip;     // -1 mirrors the landscape along with the camera
uniform float uPxAng;
uniform float uFrame;
uniform vec2 uRes;
// Weather in front of the landscape.
uniform float uFog;      // 0..1, swallows the far ridges first
uniform float uRain;     // 0..1
uniform float uSnow;     // 0..1
uniform float uFlash;    // lightning, 0..1
uniform float uTime;     // real seconds
uniform float uWindX;    // across-screen wind, -1..1 (slants rain, drifts snow)
uniform float uDay, uTwi;
varying vec2 vUv;

// Rain: streaks in a scrolling grid of cells, one possible drop per cell.
// At night they only catch ambient light, so they're faint and grey.
float rainLayer(vec2 uv, float scale, float speed, float seed, float density) {
  vec2 p = uv * vec2(uRes.x / uRes.y, 1.0) * scale;
  p.x += p.y * uWindX * 0.45;
  p.y += uTime * speed;
  vec2 cell = floor(p), f = fract(p);
  if (hash13(vec3(cell, seed)) > density) return 0.0;
  float x = 0.15 + 0.7 * hash13(vec3(cell, seed + 1.0));
  float len = 0.45 + 0.4 * hash13(vec3(cell, seed + 2.0));
  float y = fract(f.y - hash13(vec3(cell, seed + 3.0)));
  float w = 1.3 * scale / uRes.y; // ~1.3 px wide whatever the resolution
  return smoothstep(w, 0.0, abs(f.x - x)) * smoothstep(len, len * 0.5, y) * smoothstep(0.0, 0.08, y);
}

// Snow: soft flakes that drift and sway on the wind.
float snowLayer(vec2 uv, float scale, float speed, float seed, float density) {
  vec2 p = uv * vec2(uRes.x / uRes.y, 1.0) * scale;
  p.y += uTime * speed;
  p.x += uTime * speed * uWindX * 0.8;
  vec2 cell = floor(p), f = fract(p);
  if (hash13(vec3(cell, seed)) > density) return 0.0;
  vec2 c = vec2(0.2, 0.2) + 0.6 * vec2(hash13(vec3(cell, seed + 1.0)), hash13(vec3(cell, seed + 2.0)));
  c.x += 0.12 * sin(uTime * (0.7 + hash13(vec3(cell, seed + 4.0))) + seed);
  float r = 0.06 + 0.05 * hash13(vec3(cell, seed + 3.0));
  return smoothstep(r, r * 0.2, length(f - c));
}

// Distant range: rolling granite ridges with one Half-Dome-like monolith
// (rounded back, sheer face) west of north, clear of the pole.
float ridgeFar(float az) {
  float h = 0.05 + 0.11 * (fbm1(az * 2.0 + 4.0) - 0.45) + 0.022 * (fbm1(az * 7.0) - 0.5)
          + 0.01 * (fbm1(az * 18.0) - 0.5) + 0.004 * fbm1(az * 40.0);
  // Broad massif rising to the dome: long rounded back, steep ragged face.
  float x = (az + 0.13) / 0.08;
  float massif = 0.045 * smoothstep(-5.0, -0.5, x) * smoothstep(4.0, 0.4, x);
  float dome = x < 0.0
    ? pow(max(0.0, 1.0 - x * x / 2.2), 0.8)
    : (1.0 - 0.5 * x * x) * (1.0 - smoothstep(0.1, 0.42, x + 0.12 * (fbm1(az * 90.0) - 0.5)));
  dome *= 1.0 + 0.06 * (fbm1(az * 30.0) - 0.5);
  float top = 0.035 + massif + 0.05 * dome;
  return max(h, top + 0.003 * fbm1(az * 70.0) + 0.0015 * fbm1(az * 300.0));
}
// Middle range between the two, half lost in haze.
float ridgeMid(float az) {
  return 0.028 + 0.11 * (fbm1(az * 3.3 + 21.0) - 0.45) + 0.012 * (fbm1(az * 11.0) - 0.5)
       + 0.004 * fbm1(az * 60.0) + 0.002 * fbm1(az * 260.0);
}
// Nearer, darker foothills with a tree-ragged edge, rising at the frame
// edges so the sky is framed like a shot through a valley.
float ridgeNear(float az) {
  return 0.0 + 0.08 * (fbm1(az * 2.4 + 11.0) - 0.45) + 0.1 * smoothstep(0.35, 1.3, abs(az))
       + 0.012 * (fbm1(az * 16.0) - 0.5) + 0.005 * fbm1(az * 120.0) + 0.003 * fbm1(az * 420.0)
       + 0.0015 * fbm1(az * 1400.0);
}

vec3 aces(vec3 x) {
  return clamp((x * (2.51 * x + 0.03)) / (x * (2.43 * x + 0.59) + 0.14), 0.0, 1.0);
}

void main() {
  vec2 uv = vUv;
  vec2 fromC = uv - 0.5;
  // A touch of lateral chromatic softness toward the frame edges.
  vec2 ca = fromC * dot(fromC, fromC) * 0.004;
  vec3 col = vec3(texture2D(tScene, uv - ca).r, texture2D(tScene, uv).g, texture2D(tScene, uv + ca).b);
  vec3 bloom = texture2D(tBloom, uv).rgb;

  if (uForeground > 0.001) {
    vec3 d = rayDir(uv);
    float alt = asin(clamp(d.y, -1.0, 1.0));
    float az = atan(d.x, -d.z) * uFlip;
    float hf = ridgeFar(az), hm = ridgeMid(az), hn = ridgeNear(az);
    float mf = 1.0 - smoothstep(hf - uPxAng, hf + uPxAng, alt);
    float mm = 1.0 - smoothstep(hm - uPxAng, hm + uPxAng, alt);
    float mn = 1.0 - smoothstep(hn - uPxAng, hn + uPxAng, alt);
    // Each layer catches a little skyglow; haze thickens toward its crest
    // and the nearer the layer, the darker it is. Faint mottling reads as
    // forest and rock under starlight.
    float tex = 0.7 + 0.6 * fbm(vec3(az * 30.0, alt * 30.0, 0.0));
    vec3 base = vec3(0.0013, 0.0017, 0.0026);
    vec3 far = base * (1.0 + 1.3 * exp(-(hf - alt) / 0.02)) * tex;
    vec3 mid = base * 0.4 * (1.0 + 1.1 * exp(-(hm - alt) / 0.015)) * tex;
    vec3 near = base * 0.12 * (1.0 + 0.9 * exp(-(hn - alt) / 0.012))
              * (0.6 + 0.8 * fbm(vec3(az * 12.0, alt * 12.0, 5.0)));
    // Fog swallows the far ridges first; lightning lights the land for an instant.
    vec3 fogCol = mix(vec3(0.010, 0.011, 0.013), vec3(0.11, 0.12, 0.13), uDay);
    // By day the ridges show their depth: pale blue-grey far away, darker in
    // front. At dusk they stay silhouettes against the glow.
    // Daylight shows the texture, so it runs in gentle horizontal strata;
    // round blobs in a thin band of ridge read as vertical wisps (like rain).
    float strata = 0.93 + 0.14 * fbm(vec3(az * 6.0, alt * 70.0, 9.0));
    far = mix(far, vec3(0.040, 0.052, 0.068) * strata, uDay);
    mid = mix(mid, vec3(0.012, 0.017, 0.016) * strata, uDay);
    near = mix(near, vec3(0.0045, 0.0062, 0.0040) * (0.6 + 0.8 * fbm(vec3(az * 12.0, alt * 12.0, 5.0))), uDay);
    far = mix(far, fogCol, uFog * 0.92) + uFlash * vec3(0.0030, 0.0033, 0.0042);
    mid = mix(mid, fogCol * 0.85, uFog * 0.75) + uFlash * vec3(0.0018, 0.002, 0.0025);
    near = mix(near, fogCol * 0.6, uFog * 0.45) + uFlash * vec3(0.0009);
    col = mix(col, far, mf * uForeground);
    col = mix(col, mid, mm * uForeground);
    col = mix(col, near, mn * uForeground);
    bloom *= 1.0 - 0.97 * mf * uForeground;
  }

  // Bloom is the stars' lens glow; a bright twilight or day sky would wash
  // it across everything, so it fades as the sky brightens.
  col += bloom * uBloom * (1.0 - 0.85 * max(uDay, uTwi * 0.8));

  // Precipitation is nearest of all, in front of the hills.
  if (uRain > 0.001) {
    float r = rainLayer(uv, 26.0, 9.0, 1.0, uRain * 0.5) * 1.0
            + rainLayer(uv, 44.0, 7.0, 7.0, uRain * 0.6) * 0.6
            + rainLayer(uv, 70.0, 5.5, 13.0, uRain * 0.7) * 0.35;
    col += r * (mix(vec3(0.010, 0.011, 0.013), vec3(0.05, 0.052, 0.056), uDay) + uFlash * vec3(0.012, 0.013, 0.016));
  }
  if (uSnow > 0.001) {
    float s = snowLayer(uv, 14.0, 0.35, 3.0, uSnow * 0.45) * 1.0
            + snowLayer(uv, 26.0, 0.25, 9.0, uSnow * 0.55) * 0.6
            + snowLayer(uv, 44.0, 0.18, 17.0, uSnow * 0.6) * 0.35;
    col += s * mix(vec3(0.016, 0.017, 0.019), vec3(0.14, 0.145, 0.15), uDay);
  }
  col += uFlash * vec3(0.0012, 0.0013, 0.0017);
  col *= uExposure;
  col = aces(col);

  float vig = smoothstep(1.05, 0.25, length(fromC * vec2(uRes.x / uRes.y, 1.0) * 0.9));
  col *= mix(0.55, 1.0, vig);

  col = pow(col, vec3(1.0 / 2.2));

  // Film grain: strongest in the mid-tones, refreshed at 24 fps.
  float luma = dot(col, vec3(0.299, 0.587, 0.114));
  float g = hash13(vec3(gl_FragCoord.xy, uFrame)) + hash13(vec3(gl_FragCoord.yx * 1.37, uFrame + 7.0)) - 1.0;
  col += g * uGrain * (0.015 + 0.09 * luma * (1.0 - luma));
  // Dither to kill banding in the sky gradient.
  col += (hash13(vec3(gl_FragCoord.xy, uFrame * 1.7 + 3.0)) - 0.5) / 255.0;

  gl_FragColor = vec4(col, 1.0);
}
`;
