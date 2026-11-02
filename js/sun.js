/**
 * Where the sun really is, from the NOAA solar position algorithm
 * (declination, equation of time, hour angle): accurate to about half a
 * degree, plenty for twilight. Real time and your real location decide day
 * and night; the stars keep their artistic time-lapse.
 */
const RAD = Math.PI / 180;

/** Sun altitude and azimuth (degrees; azimuth from north, clockwise). */
export function sunPosition(date, lat, lon) {
  const ms = date.getTime();
  const jd = ms / 86400000 + 2440587.5;
  const T = (jd - 2451545) / 36525;
  const L0 = (((280.46646 + T * (36000.76983 + T * 0.0003032)) % 360) + 360) % 360;
  const M = 357.52911 + T * (35999.05029 - 0.0001537 * T);
  const e = 0.016708634 - T * (0.000042037 + 0.0000001267 * T);
  const C = Math.sin(M * RAD) * (1.914602 - T * (0.004817 + 0.000014 * T))
    + Math.sin(2 * M * RAD) * (0.019993 - 0.000101 * T) + Math.sin(3 * M * RAD) * 0.000289;
  const omega = 125.04 - 1934.136 * T;
  const lambda = L0 + C - 0.00569 - 0.00478 * Math.sin(omega * RAD);
  const eps0 = 23 + (26 + (21.448 - T * (46.815 + T * (0.00059 - T * 0.001813))) / 60) / 60;
  const eps = eps0 + 0.00256 * Math.cos(omega * RAD);
  const decl = Math.asin(Math.sin(eps * RAD) * Math.sin(lambda * RAD));

  // Equation of time, in minutes.
  const y = Math.tan((eps * RAD) / 2) ** 2;
  const eot = (4 / RAD) * (y * Math.sin(2 * L0 * RAD) - 2 * e * Math.sin(M * RAD)
    + 4 * e * y * Math.sin(M * RAD) * Math.cos(2 * L0 * RAD)
    - 0.5 * y * y * Math.sin(4 * L0 * RAD) - 1.25 * e * e * Math.sin(2 * M * RAD));

  const utcMin = (((ms / 60000) % 1440) + 1440) % 1440;
  const solarMin = (((utcMin + eot + 4 * lon) % 1440) + 1440) % 1440;
  const H = (solarMin / 4 - 180) * RAD;
  const phi = lat * RAD;
  const cosZ = Math.sin(phi) * Math.sin(decl) + Math.cos(phi) * Math.cos(decl) * Math.cos(H);
  const alt = 90 - Math.acos(Math.min(1, Math.max(-1, cosZ))) / RAD;
  const az = (Math.atan2(Math.sin(H), Math.cos(H) * Math.sin(phi) - Math.tan(decl) * Math.cos(phi)) / RAD + 180 + 360) % 360;
  return { alt, az };
}

/** Unit vector toward the sun in the scene's frame (x east, y up, z south). */
export function sunDirection(alt, az) {
  const a = alt * RAD, z = az * RAD;
  return [Math.sin(z) * Math.cos(a), Math.sin(a), -Math.cos(z) * Math.cos(a)];
}

const smooth = (a, b, x) => { const t = Math.min(1, Math.max(0, (x - a) / (b - a))); return t * t * (3 - 2 * t); };

/**
 * Everything the scene needs from a sun altitude (degrees), all smooth:
 *  day      0 at night .. 1 in full daylight (sun ~8 degrees up)
 *  twilight how much dusk/dawn colour there is (peaks around -3 degrees)
 *  magLimit faintest star still visible (7 at night .. -2 in daylight)
 */
export function skyState(alt) {
  return {
    day: smooth(-6, 8, alt),
    twilight: smooth(-18, -4, alt) * (1 - smooth(-1, 9, alt)),
    // -18: 7, -12: 4, -6: 1.5, 0 and up: no stars.
    magLimit: alt < -18 ? 7 : alt < -12 ? 7 - (alt + 18) * 0.5 : alt < -6 ? 4 - (alt + 12) * (2.5 / 6) : alt < 0 ? 1.5 - (alt + 6) * (3.5 / 6) : -2,
  };
}
