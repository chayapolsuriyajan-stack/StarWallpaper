// Location and weather-mapping checks for js/location.js and js/weather.js.
// The network is simulated (except the optional replay of real data at the
// end), so the provider order and VPN fallbacks are tested deterministically,
// including the https:// page Lively actually serves the wallpaper from.
import { resolveLocation } from '../js/location.js';
import { Weather, toScene, CLEAR } from '../js/weather.js';

globalThis.localStorage = { getItem: () => null, setItem: () => {} };
const sysOffset = -new Date().getTimezoneOffset();
const ZONES = { 420: 'Asia/Bangkok', 0: 'UTC', 60: 'Europe/Paris', [-300]: 'America/New_York' };
const homeZone = ZONES[sysOffset] ?? 'UTC';
const OTHER_TZ = sysOffset === -300 ? 'Europe/Paris' : 'America/New_York';
const setPage = (protocol) => { globalThis.location = { protocol }; };

let calls = [];
const realFetch = globalThis.fetch;
function mockNet({ geojs = 'down', ipWho = 'down', ipApi = 'down', geo = { results: [{ latitude: 18.79, longitude: 98.98, name: 'Chiang Mai', country: 'Thailand' }] } }) {
  calls = [];
  globalThis.fetch = async (url) => {
    const u = String(url);
    calls.push(u.split('?')[0]);
    const body = u.includes('geojs') ? geojs : u.includes('ipwho.is') ? ipWho : u.includes('ip-api.com') ? ipApi
      : u.includes('geocoding') ? geo
      : u.includes('api.open-meteo.com') ? { current: { weather_code: 3, cloud_cover: 90, cloud_cover_low: 80, precipitation: 0 } } : null;
    if (body === 'down') throw new Error('network down');
    return { ok: true, json: async () => body };
  };
}

const geojsCM = { city: 'Chiang Mai', country: 'Thailand', latitude: '18.7857', longitude: '98.9736', timezone: homeZone };
const ipWhoBKK = { success: true, city: 'Bangkok', country: 'Thailand', latitude: 13.75, longitude: 100.5, timezone: { offset: sysOffset * 60 } };
const ipApiCM = { status: 'success', city: 'Chiang Mai', country: 'Thailand', lat: 18.79, lon: 98.97, timezone: homeZone, proxy: false, hosting: false };

const cases = [
  // [label, page protocol, network, config, check(location)]
  ['Lively (https): geojs is used first', 'https:', { geojs: geojsCM, ipWho: ipWhoBKK, ipApi: ipApiCM }, {},
    (l) => l?.name === 'Chiang Mai, Thailand' && l.provider === 'geojs'],
  ['Lively (https): http-only ip-api is never called', 'https:', { geojs: 'down', ipWho: ipWhoBKK, ipApi: ipApiCM }, {},
    (l) => l?.provider === 'ipwho.is' && !calls.some((c) => c.includes('ip-api'))],
  ['geojs down -> ipwho.is fallback', 'https:', { ipWho: ipWhoBKK }, {},
    (l) => l?.provider === 'ipwho.is'],
  ['http page (browser test) still reaches ip-api last', 'http:', { ipApi: ipApiCM }, {},
    (l) => l?.provider === 'ip-api'],
  ['VPN flagged by provider -> typed city', 'http:', { ipApi: { ...ipApiCM, proxy: true } }, { city: 'Chiang Mai' },
    (l) => l?.provider === 'city' && l.vpn === true],
  ['VPN caught by timezone mismatch -> typed city', 'https:', { geojs: { ...geojsCM, timezone: OTHER_TZ, city: 'Frankfurt' } }, { city: 'Chiang Mai' },
    (l) => l?.name === 'Chiang Mai, Thailand' && l.provider === 'city'],
  ['VPN with no city typed -> unknown (clear sky)', 'https:', { geojs: { ...geojsCM, timezone: OTHER_TZ } }, {},
    (l) => l === null],
  ['every IP service down -> typed city', 'https:', {}, { city: 'Chiang Mai' },
    (l) => l?.provider === 'city'],
  ['"always the city" never asks for the IP', 'https:', { geojs: geojsCM }, { mode: 'city', city: 'Chiang Mai' },
    (l) => l?.provider === 'city' && !calls.some((c) => /geojs|ipwho|ip-api/.test(c))],
  ['"always the city" with an unknown city -> null', 'https:', { geo: { results: [] } }, { mode: 'city', city: 'Nowhereville' },
    (l) => l === null],
];

let fail = 0;
const report = (pass, label, extra = '') => { if (!pass) fail++; console.log(`${pass ? 'ok  ' : 'FAIL'} ${label}${pass ? '' : extra}`); };

for (const [label, protocol, net, cfg, ok] of cases) {
  setPage(protocol);
  mockNet(net);
  const l = await resolveLocation(cfg);
  report(ok(l), label, ` (got ${JSON.stringify(l)})`);
}

// refresh(): no location -> clear sky; location is reported even with weather off.
setPage('https:');
mockNet({ geojs: { ...geojsCM, timezone: OTHER_TZ } });
let got = null;
const w = new Weather((p) => { got = p; });
w.configure({ city: '' });
await w.refresh();
report(JSON.stringify(got) === JSON.stringify(CLEAR), `VPN + no city: scene shows a clear sky (${w.status})`);
clearTimeout(w.timer); clearTimeout(w.debounce);

mockNet({ geojs: geojsCM });
let loc = null;
const w2 = new Weather(() => {}, (l) => { loc = l; });
w2.configure({ enabled: false });
await w2.refresh();
report(loc?.name === 'Chiang Mai, Thailand' && w2.status === 'off', 'weather off: location still resolved for the sun');
clearTimeout(w2.timer); clearTimeout(w2.debounce);

// WMO code mapping.
const m = [
  ['drizzle trace (code 51, 0.1 mm) draws no rain', { weather_code: 51, precipitation: 0.1 }, (s) => s.rain === 0 && s.cloudLow >= 0.45],
  ['measurable drizzle (0.2 mm) is faint', { weather_code: 53, precipitation: 0.2 }, (s) => s.rain > 0 && s.rain <= 0.25],
  ['1 mm of rain is moderate', { weather_code: 61, precipitation: 1 }, (s) => s.rain > 0.6 && s.rain < 0.9],
  ['5 mm and up is heavy', { weather_code: 65, precipitation: 6 }, (s) => s.rain === 1],
  ['thunder with no rain: glow only', { weather_code: 95, precipitation: 0 }, (s) => s.storm > 0 && s.rain === 0],
  ['thunderstorm with rain', { weather_code: 95, precipitation: 0.5 }, (s) => s.storm > 0 && s.rain > 0 && s.cloudLow >= 0.55],
  ['snow', { weather_code: 73, precipitation: 1 }, (s) => s.snow > 0 && s.rain === 0],
  ['fog code', { weather_code: 45, visibility: 15000 }, (s) => s.fog >= 0.8],
  ['clear night', { weather_code: 0, visibility: 30000, relative_humidity_2m: 40 }, (s) => s.fog === 0 && s.haze === 0 && s.rain === 0],
  ['total-only cloud', { weather_code: 3, cloud_cover: 70 }, (s) => s.cloudMid === 0.7],
];
for (const [label, cur, ok] of m) {
  const s = toScene(cur);
  report(ok(s), `maps ${label}`, ` -> ${JSON.stringify(s)}`);
}

// Replay the last 8 days of real Chiang Mai weather (skipped when offline):
// rain may only be drawn in hours with measurable precipitation.
globalThis.fetch = realFetch;
try {
  const r = await fetch('https://api.open-meteo.com/v1/forecast?latitude=18.786&longitude=98.974&past_days=7&forecast_days=1&hourly=weather_code,precipitation,relative_humidity_2m,visibility,cloud_cover', { signal: AbortSignal.timeout(10000) });
  const h = (await r.json()).hourly;
  let shown = 0, wrong = 0, missed = 0;
  h.time.forEach((_, i) => {
    const s = toScene({ weather_code: h.weather_code[i], precipitation: h.precipitation[i], relative_humidity_2m: h.relative_humidity_2m[i], visibility: h.visibility[i], cloud_cover: h.cloud_cover[i] });
    const wet = h.precipitation[i] >= 0.2;
    if (s.rain + s.snow > 0) shown++;
    if (s.rain + s.snow > 0 && !wet) wrong++;
    if (wet && s.rain + s.snow === 0 && ((h.weather_code[i] >= 51) )) missed++;
  });
  report(wrong === 0 && missed === 0, `real Chiang Mai week: rain drawn in ${shown}/${h.time.length} hours, all of them measurably wet`, ` (wrong ${wrong}, missed ${missed})`);
} catch (e) {
  console.log(`skip real-data replay (${e.message})`);
}

console.log(fail ? `\n${fail} failure(s)` : '\nall weather tests passed');
process.exit(fail ? 1 : 0);
