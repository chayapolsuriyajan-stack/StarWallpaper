// js/sun.js against reality: the computed sunrise and sunset (the sun's
// centre at -0.833 degrees, the standard refraction-corrected definition)
// must match Open-Meteo's published times within 2 minutes, for several
// cities and seasons. Dates are kept inside Open-Meteo's forecast window
// (about 3 months back to 2 weeks ahead) relative to today.
import { sunPosition, skyState } from '../js/sun.js';

const CITIES = [
  ['Chiang Mai', 18.7857, 98.9736],
  ['Reykjavik', 64.1466, -21.9426],
  ['Sydney', -33.8688, 151.2093],
  ['New York', 40.7128, -74.006],
];
const day = (offset) => new Date(Date.now() + offset * 86400000).toISOString().slice(0, 10);
const DATES = [day(-85), day(-45), day(-10), day(0), day(12)];
const RISE_ALT = -0.833;

/** The minute in [from, to) where the sun crosses RISE_ALT going `up` (or down), by bisection. */
function crossing(lat, lon, from, to, up) {
  const f = (t) => sunPosition(new Date(t), lat, lon).alt - RISE_ALT;
  for (let t = from; t < to; t += 5 * 60000) {
    const a = f(t), b = f(t + 5 * 60000);
    if ((up && a < 0 && b >= 0) || (!up && a > 0 && b <= 0)) {
      let lo = t, hi = t + 5 * 60000;
      for (let i = 0; i < 30; i++) { const mid = (lo + hi) / 2; if ((f(mid) < 0) === up) lo = mid; else hi = mid; }
      return (lo + hi) / 2;
    }
  }
  return null;
}

let fail = 0, checked = 0, worst = 0;
for (const [name, lat, lon] of CITIES) {
  const url = `https://api.open-meteo.com/v1/forecast?latitude=${lat}&longitude=${lon}&daily=sunrise,sunset&timezone=GMT&start_date=${DATES[0]}&end_date=${DATES.at(-1)}`;
  const j = await (await fetch(url, { signal: AbortSignal.timeout(15000) })).json();
  const daily = j.daily;
  if (!daily?.time) throw new Error(`no reference data for ${name}: ${JSON.stringify(j).slice(0, 200)}`);
  for (const d of DATES) {
    const i = daily.time.indexOf(d);
    if (i < 0) { console.log(`skip ${name} ${d} (no reference)`); continue; }
    for (const [kind, ref] of [['sunrise', daily.sunrise[i]], ['sunset', daily.sunset[i]]]) {
      const refMs = Date.parse(ref + 'Z');
      const got = crossing(lat, lon, refMs - 3 * 3600000, refMs + 3 * 3600000, kind === 'sunrise');
      const diff = got == null ? Infinity : Math.abs(got - refMs) / 60000;
      checked++;
      worst = Math.max(worst, diff);
      if (diff > 2) { fail++; console.log(`FAIL ${name} ${d} ${kind}: ours ${got && new Date(got).toISOString().slice(11, 16)} vs ${ref.slice(11)} UTC (${diff.toFixed(1)} min)`); }
    }
  }
  console.log(`ok   ${name}: sunrise/sunset on ${DATES.length} dates`);
}

// Sky phases move the right way.
const s = (a) => skyState(a);
const phases = [
  ['night is dark with all stars', s(-25).day === 0 && s(-25).magLimit === 7],
  ['astronomical twilight hides the faintest', s(-15).magLimit < 7 && s(-15).magLimit > 4],
  ['blue hour keeps only bright stars', s(-9).magLimit < 3.5],
  ['civil dusk is mostly colour', s(-3).twilight > 0.6 && s(-3).day < 0.5],
  ['daylight has no stars', s(10).day === 1 && s(10).magLimit < -1],
];
for (const [label, ok] of phases) { if (!ok) fail++; console.log(`${ok ? 'ok  ' : 'FAIL'} ${label}`); }

console.log(fail ? `\n${fail} failure(s)` : `\nall sun tests passed (${checked} sunrises/sunsets, worst ${worst.toFixed(1)} min off)`);
process.exit(fail ? 1 : 0);
