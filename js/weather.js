/**
 * Real weather for the scene: finds where you are, fetches current
 * conditions from Open-Meteo (free, no key), and turns them into the few
 * numbers the shaders need. Nothing here touches the DOM.
 *
 * Location comes from location.js (IP lookup, or your typed city on a VPN).
 * It is resolved even with weather switched off, because the sun needs it.
 * With no usable location the sky simply stays clear.
 */
import { fetchJson, resolveLocation } from './location.js';

const WEATHER_MS = 15 * 60 * 1000;   // conditions refresh
const LOCATION_MS = 60 * 60 * 1000;  // re-check location (VPNs come and go)
const STALE_MS = 3 * 60 * 60 * 1000; // after this without data, fade to clear
const CACHE_KEY = 'star-trails-weather-v1';
const MIN_PRECIP_MM = 0.2;           // less than this is a trace: no streaks

/** The scene's weather parameters. All 0..1 unless noted. */
export const CLEAR = Object.freeze({
  cloudLow: 0, cloudMid: 0, cloudHigh: 0,
  haze: 0,          // humidity-driven thickening of the low sky
  fog: 0,           // from visibility / fog codes
  rain: 0, snow: 0, // precipitation intensity
  storm: 0,         // thunderstorm: lightning
  windSpeed: 0,     // km/h at 10 m
  windDir: 0,       // degrees the wind comes FROM (meteorological)
});

/** WMO weather code + Open-Meteo fields → scene parameters. */
export function toScene(c) {
  const code = c.weather_code ?? 0;
  const pct = (v) => Math.min(Math.max((v ?? 0) / 100, 0), 1);
  let low = pct(c.cloud_cover_low), mid = pct(c.cloud_cover_mid), high = pct(c.cloud_cover_high);
  // Some models only report the total: put it in the middle layer.
  if (!low && !mid && !high && c.cloud_cover) mid = pct(c.cloud_cover);

  // Rain or snow is only drawn when it's measurably falling: forecast models
  // often report a drizzle code with a trace (0.1 mm), and drawing that as
  // streaks made the sky look like it rained all the time.
  const mm = c.precipitation ?? 0;
  const wetCode = (code >= 51 && code <= 67) || (code >= 80 && code <= 82) || code >= 95;
  const isSnow = (code >= 71 && code <= 77) || code === 85 || code === 86;
  const measurable = mm >= MIN_PRECIP_MM;
  // 0.2 mm faint, ~1 mm moderate, 5 mm and up heavy.
  const precip = measurable && (wetCode || isSnow)
    ? Math.min(1, 0.2 + 0.25 * Math.log2(mm / MIN_PRECIP_MM))
    : 0;
  const isRain = wetCode && !isSnow;
  // It doesn't rain from a clear sky: make sure the low deck is there. A
  // trace of drizzle still lowers and thickens it a little.
  if (precip) low = Math.max(low, 0.55 + 0.4 * precip);
  else if (wetCode || isSnow) low = Math.max(low, 0.45);

  const vis = c.visibility ?? 20000;
  let fog = Math.pow(Math.min(Math.max(1 - (vis - 800) / 9200, 0), 1), 1.5);
  if (code === 45 || code === 48) fog = Math.max(fog, 0.8);

  return {
    cloudLow: low, cloudMid: mid, cloudHigh: high,
    haze: Math.min(1, Math.max(((c.relative_humidity_2m ?? 50) - 55) / 45, 0) + (wetCode && !precip ? 0.15 : 0)),
    fog,
    rain: isRain ? precip : 0,
    snow: isSnow ? precip : 0,
    storm: code >= 95 ? (code >= 96 ? 1 : 0.7) : 0,
    windSpeed: c.wind_speed_10m ?? 0,
    windDir: c.wind_direction_10m ?? 0,
  };
}

/** Named conditions for previews (explore.html?wx=rain). */
export const PRESETS = {
  clear: { ...CLEAR },
  cirrus: { ...CLEAR, cloudHigh: 0.7, haze: 0.2, windSpeed: 12, windDir: 250 },
  partly: { ...CLEAR, cloudLow: 0.35, cloudMid: 0.25, haze: 0.3, windSpeed: 15, windDir: 200 },
  overcast: { ...CLEAR, cloudLow: 0.95, cloudMid: 0.6, haze: 0.6, windSpeed: 18, windDir: 220 },
  fog: { ...CLEAR, cloudLow: 0.2, fog: 0.85, haze: 1, windSpeed: 3, windDir: 90 },
  rain: { ...CLEAR, cloudLow: 0.9, cloudMid: 0.7, haze: 0.8, fog: 0.15, rain: 0.6, windSpeed: 20, windDir: 240 },
  storm: { ...CLEAR, cloudLow: 1, cloudMid: 0.8, cloudHigh: 0.5, haze: 0.9, fog: 0.1, rain: 0.9, storm: 1, windSpeed: 30, windDir: 230 },
  snow: { ...CLEAR, cloudLow: 0.85, cloudMid: 0.5, haze: 0.5, fog: 0.2, snow: 0.7, windSpeed: 8, windDir: 300 },
};

export class Weather {
  /**
   * onChange(params): fresh scene parameters. onLocation(loc): the resolved
   * location (or null), which the sun uses too.
   */
  constructor(onChange, onLocation = () => {}) {
    this.onChange = onChange;
    this.onLocation = onLocation;
    this.enabled = true;
    this.mode = 'auto';   // 'auto' | 'city'
    this.city = '';
    this.location = null;
    this.locatedAt = 0;
    this.updatedAt = 0;
    this.timer = null;
    this.status = 'idle';
    // A remembered reading avoids a clear-sky flash on startup.
    try {
      const c = JSON.parse(localStorage.getItem(CACHE_KEY) ?? 'null');
      if (c && Date.now() - c.at < STALE_MS) { this.updatedAt = c.at; this.onChange(c.params); }
    } catch { /* storage unavailable: start clear */ }
  }

  configure({ enabled = this.enabled, mode = this.mode, city = this.city }) {
    const relocate = mode !== this.mode || city !== this.city;
    this.enabled = enabled; this.mode = mode; this.city = city.trim();
    if (relocate) this.locatedAt = 0;
    clearTimeout(this.debounce);
    // The city box fires on every keystroke; wait for typing to stop.
    this.debounce = setTimeout(() => this.refresh(), relocate ? 1500 : 0);
  }

  async refresh() {
    clearTimeout(this.timer);
    this.timer = setTimeout(() => this.refresh(), WEATHER_MS);
    try {
      if (!this.locatedAt || Date.now() - this.locatedAt > LOCATION_MS) {
        this.location = await resolveLocation({ mode: this.mode, city: this.city });
        this.locatedAt = Date.now();
        this.onLocation(this.location);
      }
      if (!this.enabled) { this.status = 'off'; this.onChange({ ...CLEAR }); return; }
      if (!this.location) {
        this.status = this.mode === 'city' ? 'no city set' : 'VPN or no IP location, and no city set';
        this.onChange({ ...CLEAR });
        return;
      }
      const { lat, lon } = this.location;
      const j = await fetchJson('https://api.open-meteo.com/v1/forecast?' + new URLSearchParams({
        latitude: lat.toFixed(3), longitude: lon.toFixed(3),
        current: 'cloud_cover,cloud_cover_low,cloud_cover_mid,cloud_cover_high,relative_humidity_2m,precipitation,weather_code,wind_speed_10m,wind_direction_10m,visibility',
      }));
      const params = toScene(j.current);
      this.updatedAt = Date.now();
      this.status = `ok: ${this.location.name} via ${this.location.provider}, code ${j.current.weather_code}`;
      this.raw = j.current;
      this.onChange(params);
      try { localStorage.setItem(CACHE_KEY, JSON.stringify({ at: this.updatedAt, params, from: { name: this.location.name, provider: this.location.provider, vpn: this.location.vpn, code: j.current.weather_code, mm: j.current.precipitation } })); } catch { /* ignore */ }
    } catch (e) {
      // Offline or a service hiccup: keep the last sky, fade to clear once it's old.
      this.status = `error: ${e.message}`;
      if (Date.now() - this.updatedAt > STALE_MS) this.onChange({ ...CLEAR });
    }
  }
}
