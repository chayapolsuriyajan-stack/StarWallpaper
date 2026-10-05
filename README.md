# Star Trails

![preview](preview.jpg)

A live wallpaper for Windows that looks like a long-exposure star-trail
photograph. The real night sky turns slowly around the north celestial pole,
which sits low over a mountain horizon. Every star leaves an arc. The frame
has film grain, lens glow, atmospheric extinction and a faint Milky Way.

Nothing here is a canned animation. Each star is a real catalogue star at its
true position, and the sky starts as it actually is right now from the chosen
latitude and longitude. After that, time runs faster than real time.

## Installing as a wallpaper

1. Install [Lively Wallpaper](https://github.com/rocksdanister/lively) (free).
2. In Lively, choose **Add Wallpaper → Browse** and pick this folder, or drag
   the folder onto the Lively window. Lively finds it through `LivelyInfo.json`.
3. Right-click the wallpaper → **Customize**. Every setting applies live:

| Setting | What it does |
| --- | --- |
| Rotation speed | ×20 to ×4000 real time. The default turns the sky once every ~5 minutes. |
| Star trails | On/off. Trails fade in and out smoothly. With trails off, stars are twinkling points that still rotate. |
| Trail length | 5° to 180° of sky rotation. |
| Trail style | **Comet** fades toward the tail. **Exposure** is an even arc, like a stacked long exposure. |
| Build trails up from start | Trails grow from nothing, as if the shutter just opened. |
| Constellation lines / names / opacity | Constellation figures that turn with the sky. |
| Faintest star | Limiting magnitude, from 4.0 (city sky) to 8.0 (remote dark site). |
| Exposure, Film grain | The camera look. |
| Latitude | Height of the pole above the horizon. Lower puts it nearer the horizon line. |
| Longitude | Only decides which stars are up at the start. |
| Milky Way glow, Mountain silhouette | Scene layers. |
| Mirror composition | Moves the pole from the left third of the frame to the right third. The landscape mirrors with it; the sky stays astronomically correct. |
| Field of view, Frame rate, Render scale | Framing and performance. Frame rate caps at 30, 60, 120 or 144 fps, or runs uncapped at the monitor's refresh rate; rates above 60 only help on a high-refresh monitor. Lower the render scale on integrated graphics. |
| Real weather | Shows the actual weather where you are (see below). On by default. |
| Weather location | **Automatic** finds you from your IP address, and uses the city below when you're on a VPN. **Always the city below** never looks at your IP. |
| City for weather | Used on a VPN, or always if you choose that. |
| Weather intensity | Turn it down to keep more stars visible on cloudy nights. |
| Open the shutter again | Restarts the trail build-up. |

## Real weather

The sky shows the weather actually happening where you are, refreshed every
15 minutes from [Open-Meteo](https://open-meteo.com/), which is free and needs
no account or key. There is no text on screen: the weather simply changes the
picture.

| Weather | What you see |
| --- | --- |
| Cloud | Three real cloud decks: low, middle and high cirrus. They drift with the real wind direction and speed, at 25× real speed for a gentle time-lapse. They hide the trails behind them, and on the town-glow side they're lit warm from below, as night clouds look in a long exposure. |
| Humidity, fog | Haze thickens near the horizon. Low visibility turns into fog that swallows the far ridges first, then the stars. |
| Rain, snow | Rain streaks slanted by the wind, or flakes drifting across, in front of everything. |
| Thunderstorm | Now and then the clouds glow from inside: one soft pulse, deliberately never a strobe, since this runs on your desktop all day. |

New readings blend in over about 25 seconds instead of switching abruptly.

**How your location is found.** In automatic mode the wallpaper looks up your
IP address with [ip-api.com](https://ip-api.com/), falling back to
[ipwho.is](https://ipwho.is/). It treats the connection as a VPN or proxy,
and ignores the IP's location, if either of these is true:

- the service flags the address as a proxy, VPN or datacentre;
- the IP's timezone doesn't match your PC's clock.

On a VPN it uses the city you typed instead. With no city set, the sky stays
clear. Only your IP address (to the IP service) and approximate coordinates
(to Open-Meteo) leave your machine. Choose **Always the city below** to
skip the IP lookup entirely.

To preview a condition in a browser, use `explore.html?wx=clear`, `cirrus`,
`partly`, `overcast`, `fog`, `rain`, `storm` or `snow`.

## Running explore.html

ES module imports are blocked over `file://`, so serve the folder over HTTP:

```bash
npx serve -l 8000 .
```

Then open <http://localhost:8000/explore.html>. A panel generated from
`LivelyProperties.json` drives the same settings; press <kbd>H</kbd> to hide
it. `?t=2026-09-22T15:00:00Z` pins the start time, and `?still` hides the
panel and shows full-length trails immediately (useful for screenshots).
`serve.json` turns off clean-URL redirects, which would otherwise drop these
query strings.

## How it works

- **Real data.** `data/stars.js` holds 41,487 stars down to magnitude 8 from
  the HYG Database v4.1 (Hipparcos + Yale Bright Star + Gliese): RA, Dec,
  magnitude and B−V colour, sorted by brightness. The star-density setting
  therefore only changes a draw count. `data/constellations.js` holds the
  constellation figures from d3-celestial. Both files are generated by
  `node tools/build-catalog.mjs`, and the output is committed.
- **Real sky motion.** Local sidereal time is computed from the clock and
  longitude. Each star's hour angle, declination and your latitude become an
  altitude/azimuth direction in the vertex shader. The camera faces due north.
  It is solved numerically so that the pole lands about a third of the way in
  from one side and a little above the middle.
- **Trails are drawn exactly, not built up by stacking frames.** Each star is
  one instance of a ribbon strip. The vertex shader places each strip vertex
  along the star's diurnal circle, from where the star is now back to where it
  was `trailLength` degrees ago, and widens the ribbon in screen space. The
  result is independent of framerate, and changing speed, length or style
  applies instantly.
- **Photographic brightness.** Energy follows a stretched flux curve
  (flux^0.62), much as a processed long exposure lifts faint stars. A trail's
  exposure per pixel goes as 1/cos(dec), so slow circumpolar stars burn
  brighter arcs. Each ribbon has a Gaussian profile, with a minimum width so
  faint stars stay fine hairlines. B−V is converted to colour temperature and
  then to RGB, and desaturated like a camera's white balance. Kasten-Young
  airmass dims stars near the horizon and shifts them red.
- **Camera pipeline** (`js/post.js`): a quarter-resolution sky (airglow
  gradient, a faint town glow, and a Milky Way computed in galactic
  coordinates and smeared along the same arc as the trails) → HDR half-float
  scene → dual-Kawase bloom → composite. The composite draws three layered
  procedural ridgelines, including a Half Dome-like monolith, then applies an
  ACES tone curve, vignette, lateral chromatic softness, 24 fps film grain and
  dithering.

## Data and licences

- Code: MIT. See [LICENSE](LICENSE).
- Star catalogue: [HYG Database](https://github.com/astronexus/HYG-Database),
  CC BY-SA 4.0.
- Constellation figures: [d3-celestial](https://github.com/ofrohn/d3-celestial),
  BSD-3-Clause.
- `vendor/three/`: Three.js r0.185.1, MIT. See `vendor/three/LICENSE`.
- Weather data: [Open-Meteo](https://open-meteo.com/), CC BY 4.0.
- IP location: [ip-api.com](https://ip-api.com/) (free tier, non-commercial
  use only) and [ipwho.is](https://ipwho.is/).
