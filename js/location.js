/**
 * Where you are, for the weather and the sun. Shared by both.
 *
 * Automatic mode looks your IP address up. Lively serves wallpapers from an
 * https:// origin, so only HTTPS services are reachable there:
 *   1. geojs.io   - HTTPS, open to any page. Places Thai mobile/fibre IPs in
 *                   the right city where most services report the ISP's
 *                   Bangkok hub.
 *   2. ipwho.is   - HTTPS fallback.
 *   3. ip-api.com - has VPN/proxy flags, but its free tier is plain HTTP, so
 *                   it's only tried when the page itself is http:// (browser
 *                   testing); on https it would be blocked as mixed content.
 * A VPN or proxy (a provider's flag, or an IP timezone that disagrees with
 * this PC's clock) means the IP says nothing true about where you are; the
 * city typed in settings is used instead, and with none the location is
 * unknown (null).
 */

export const fetchJson = async (url, ms = 8000) => {
  const ctl = new AbortController();
  const t = setTimeout(() => ctl.abort(), ms);
  try {
    const r = await fetch(url, { signal: ctl.signal, cache: 'no-store' });
    if (!r.ok) throw new Error(`${r.status} ${url}`);
    return await r.json();
  } finally {
    clearTimeout(t);
  }
};

/** Current UTC offset of an IANA timezone, in minutes. */
export function tzOffset(tz, at = new Date()) {
  const asUtc = (zone) => Date.parse(at.toLocaleString('en-US', { timeZone: zone, hour12: false }));
  return Math.round((asUtc(tz) - asUtc('UTC')) / 60000);
}

const pageIsHttp = () => globalThis.location?.protocol === 'http:';

/** Each provider: [name, url, parse(json) -> location or null, onlyOnHttpPages]. */
const PROVIDERS = [
  ['geojs', 'https://get.geojs.io/v1/ip/geo.json', (j) => j.latitude && {
    lat: +j.latitude, lon: +j.longitude, city: j.city, country: j.country,
    tzOffset: j.timezone ? tzOffset(j.timezone) : null, flagged: false,
  }],
  ['ipwho.is', 'https://ipwho.is/?fields=success,city,country,latitude,longitude,timezone', (j) => j.success && {
    lat: j.latitude, lon: j.longitude, city: j.city, country: j.country,
    tzOffset: j.timezone ? Math.round(j.timezone.offset / 60) : null, flagged: false,
  }],
  ['ip-api', 'http://ip-api.com/json/?fields=status,city,country,lat,lon,timezone,proxy,hosting', (j) => j.status === 'success' && {
    lat: j.lat, lon: j.lon, city: j.city, country: j.country,
    tzOffset: tzOffset(j.timezone), flagged: j.proxy || j.hosting,
  }, true],
];

/** The first IP provider that answers, tagged with its name. */
export async function ipLocation() {
  for (const [provider, url, parse, httpOnly] of PROVIDERS) {
    if (httpOnly && !pageIsHttp()) continue;
    try {
      const l = parse(await fetchJson(url));
      if (l) return { ...l, name: [l.city, l.country].filter(Boolean).join(', '), provider };
    } catch { /* blocked or down: try the next one */ }
  }
  return null;
}

export async function geocode(city) {
  const j = await fetchJson(`https://geocoding-api.open-meteo.com/v1/search?count=1&name=${encodeURIComponent(city)}`);
  const r = j.results?.[0];
  return r ? { lat: r.latitude, lon: r.longitude, name: `${r.name}, ${r.country}`, provider: 'city' } : null;
}

/** True when an IP location can't be where this PC actually is. */
export function looksLikeVpn(ip, sysOffset = -new Date().getTimezoneOffset()) {
  return !!ip && (ip.flagged || (ip.tzOffset != null && Math.abs(ip.tzOffset - sysOffset) >= 60));
}

/**
 * Resolve a location. mode 'auto': IP, or the city on a VPN; mode 'city':
 * the city only. Returns null when unknown. `vpn` reports what was seen.
 */
export async function resolveLocation({ mode = 'auto', city = '' } = {}) {
  const typed = city.trim();
  if (mode === 'city') {
    const c = typed ? await geocode(typed) : null;
    return c && { ...c, vpn: false };
  }
  const ip = await ipLocation();
  const vpn = looksLikeVpn(ip);
  if (ip && !vpn) return { ...ip, vpn: false };
  if (!typed) return null;
  const c = await geocode(typed);
  return c && { ...c, vpn };
}
