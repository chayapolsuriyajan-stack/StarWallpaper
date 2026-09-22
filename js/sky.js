/**
 * Simulated clock. Starts at the real "now" (or a given date) so the sky on
 * screen is the sky actually overhead from the chosen longitude, then runs at
 * `speed` × real time. Also tracks how long the "shutter" has been open, so
 * trails can build up from nothing after a (re)start.
 */
const SIDEREAL_DEG_PER_SEC = 360.98564736629 / 86400;

export const deg = Math.PI / 180;

export class SkyClock {
  constructor({ longitude = 100.5, speed = 300, date } = {}) {
    this.longitude = longitude;
    this.speed = speed;
    this.simMs = (date ?? new Date()).getTime();
    this.exposureSec = 0;
  }

  advance(dtReal) {
    const dt = dtReal * this.speed;
    this.simMs += dt * 1000;
    this.exposureSec += dt;
  }

  /** Local sidereal time in degrees (IAU 1982 GMST, good to well under 1s). */
  get lstDeg() {
    const jd = this.simMs / 86400000 + 2440587.5;
    const gmst = 280.46061837 + 360.98564736629 * (jd - 2451545.0);
    return (((gmst + this.longitude) % 360) + 360) % 360;
  }

  /** Degrees the sky has turned since the shutter opened. */
  get exposureDeg() {
    return this.exposureSec * SIDEREAL_DEG_PER_SEC;
  }

  openShutter() {
    this.exposureSec = 0;
  }
}

/** Same maths as horizDir() in the shaders, for CPU-side label placement. */
export function horizDir(H, dec, lat, out) {
  const cd = Math.cos(dec), sd = Math.sin(dec), ch = Math.cos(H), sh = Math.sin(H);
  const cl = Math.cos(lat), sl = Math.sin(lat);
  return out.set(-cd * sh, cd * ch * cl + sd * sl, cd * ch * sl - sd * cl);
}
