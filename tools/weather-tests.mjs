// Location and weather-mapping checks for js/weather.js, with the network
// simulated, so they run offline and test the VPN fallback deterministically.
import { Weather, toScene, CLEAR } from '../js/weather.js';

globalThis.localStorage = { getItem: () => null, setItem: () => {} };
const sysOffset = -new Date().getTimezoneOffset();
const zoneFor = (off) => ({ 420: 'Asia/Bangkok', 0: 'UTC', 60: 'Europe/Paris', [-300]: 'America/New_York' }[off] ?? 'UTC');
const OTHER_TZ = sysOffset === -300 ? 'Europe/Paris' : 'America/New_York';

let calls = [];
function mockNet({ ipApi, ipWho, geo = { results: [{ latitude: 18.79, longitude: 98.98, name: 'Chiang Mai', country: 'Thailand' }] } }) {
  calls = [];
  globalThis.fetch = async (url) => {
    calls.push(String(url).split('?')[0]);
    const body = url.includes('ip-api.com') ? ipApi : url.includes('ipwho.is') ? ipWho
      : url.includes('geocoding') ? geo
      : url.includes('api.open-meteo.com') ? { current: { weather_code: 3, cloud_cover: 90, cloud_cover_low: 80 } } : null;
    if (body === 'down') throw new Error('network down');
    return { ok: true, json: async () => body };
  };
}

async function locateWith(net, cfg) {
  mockNet(net);
  const w = new Weather(() => {});
  Object.assign(w, cfg);
  return w.locate();
}

const home = { status: 'success', city: 'Bangkok', country: 'Thailand', lat: 13.75, lon: 100.5, timezone: zoneFor(sysOffset), proxy: false, hosting: false };
const cases = [
  ['plain connection uses the IP location', { ipApi: home }, { mode: 'auto', city: '' }, (l) => l?.name === 'Bangkok, Thailand'],
  ['VPN flagged by provider -> typed city', { ipApi: { ...home, proxy: true, city: 'Frankfurt' } }, { mode: 'auto', city: 'Chiang Mai' }, (l) => l?.name === 'Chiang Mai, Thailand'],
  ['datacenter (hosting) IP -> typed city', { ipApi: { ...home, hosting: true } }, { mode: 'auto', city: 'Chiang Mai' }, (l) => l?.name === 'Chiang Mai, Thailand'],
  ['VPN caught by timezone mismatch -> typed city', { ipApi: { ...home, timezone: OTHER_TZ, city: 'Elsewhere' } }, { mode: 'auto', city: 'Chiang Mai' }, (l) => l?.name === 'Chiang Mai, Thailand'],
  ['VPN with no city typed -> no location (clear sky)', { ipApi: { ...home, proxy: true } }, { mode: 'auto', city: '' }, (l) => l === null],
  ['ip-api blocked -> ipwho.is fallback', { ipApi: 'down', ipWho: { success: true, city: 'Bangkok', country: 'Thailand', latitude: 13.75, longitude: 100.5, timezone: { offset: sysOffset * 60 } } }, { mode: 'auto', city: '' }, (l) => l?.name === 'Bangkok, Thailand' && calls.some((c) => c.includes('ipwho'))],
  ['every IP service down -> typed city', { ipApi: 'down', ipWho: 'down' }, { mode: 'auto', city: 'Chiang Mai' }, (l) => l?.name === 'Chiang Mai, Thailand'],
  ['"always the city" never asks for the IP', { ipApi: home }, { mode: 'city', city: 'Chiang Mai' }, (l) => l?.name === 'Chiang Mai, Thailand' && !calls.some((c) => c.includes('ip'))],
];

let fail = 0;
for (const [label, net, cfg, ok] of cases) {
  const l = await locateWith(net, cfg);
  const pass = ok(l);
  if (!pass) fail++;
  console.log(`${pass ? 'ok  ' : 'FAIL'} ${label}${pass ? '' : ` (got ${JSON.stringify(l)})`}`);
}

// refresh(): with no location the scene is told to show a clear sky.
mockNet({ ipApi: { ...home, proxy: true } });
let got = null;
const w = new Weather((p) => { got = p; });
w.configure({ city: '' });
await w.refresh();
const clearOk = JSON.stringify(got) === JSON.stringify(CLEAR);
if (!clearOk) fail++;
console.log(`${clearOk ? 'ok  ' : 'FAIL'} VPN + no city: scene shows a clear sky (status: ${w.status})`);
clearTimeout(w.timer); clearTimeout(w.debounce);

// WMO code mapping.
const m = [
  ['thunderstorm', { weather_code: 95, precipitation: 0.5 }, (s) => s.storm > 0 && s.rain > 0 && s.cloudLow >= 0.55],
  ['snow', { weather_code: 73, precipitation: 1 }, (s) => s.snow > 0 && s.rain === 0],
  ['fog code', { weather_code: 45, visibility: 15000 }, (s) => s.fog >= 0.8],
  ['low visibility', { weather_code: 3, visibility: 900 }, (s) => s.fog > 0.9],
  ['clear night', { weather_code: 0, visibility: 30000, relative_humidity_2m: 40 }, (s) => s.fog === 0 && s.haze === 0 && s.rain === 0],
  ['total-only cloud', { weather_code: 3, cloud_cover: 70 }, (s) => s.cloudMid === 0.7],
];
for (const [label, cur, ok] of m) {
  const pass = ok(toScene(cur));
  if (!pass) fail++;
  console.log(`${pass ? 'ok  ' : 'FAIL'} maps ${label}${pass ? '' : ` -> ${JSON.stringify(toScene(cur))}`}`);
}
console.log(fail ? `\n${fail} failure(s)` : '\nall weather tests passed');
process.exit(fail ? 1 : 0);
