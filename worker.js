/* SENTRASPERE live-air relay  --------------------------------------------
   The public ADS-B aggregators do not send an Access-Control-Allow-Origin
   header, so a page on github.io cannot call them directly. This sits in
   between: it fetches, caches, normalises the two different envelopes into
   one shape, and adds the header the browser needs.

   Deploy free on Cloudflare Workers:
     1. dash.cloudflare.com -> Workers & Pages -> Create -> Start with Hello
        World -> Deploy, then Edit Code
     2. paste this file over what is there, Deploy
     3. the game takes the worker URL as  ?feed=https://<name>.<you>.workers.dev

   Usage:  /?lat=47.6025&lon=-122.42&dist=60
   ------------------------------------------------------------------------ */

const SOURCES = [
  { name: 'adsb.lol',
    url: (la, lo, d) => `https://api.adsb.lol/v2/point/${la}/${lo}/${d}`,
    list: j => j.ac || [] },
  { name: 'adsb.fi',
    url: (la, lo, d) => `https://opendata.adsb.fi/api/v3/lat/${la}/lon/${lo}/dist/${d}`,
    list: j => j.aircraft || j.ac || [] }
];

const CACHE_SECONDS = 8;        // their published limit is 1 request/second
const HEADERS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, OPTIONS',
  'Content-Type': 'application/json; charset=utf-8'
};

/* Great-circle range and bearing, so a tiled answer still reports the
   distance and direction from where the player actually stands. */
function geo(lat1, lon1, lat2, lon2) {
  if (!Number.isFinite(lat2) || !Number.isFinite(lon2)) { return null; }
  const R = 3440.065;                              // nautical miles
  const r = Math.PI / 180;
  const p1 = lat1 * r, p2 = lat2 * r, dp = (lat2 - lat1) * r, dl = (lon2 - lon1) * r;
  const a = Math.sin(dp / 2) ** 2 + Math.cos(p1) * Math.cos(p2) * Math.sin(dl / 2) ** 2;
  const nm = 2 * R * Math.asin(Math.min(1, Math.sqrt(a)));
  const y = Math.sin(dl) * Math.cos(p2);
  const x = Math.cos(p1) * Math.sin(p2) - Math.sin(p1) * Math.cos(p2) * Math.cos(dl);
  return { nm, deg: (Math.atan2(y, x) / r + 360) % 360 };
}

function num(v, lo, hi, dflt) {
  const n = parseFloat(v);
  return Number.isFinite(n) ? Math.min(hi, Math.max(lo, n)) : dflt;
}

/* One shape, whichever source answered. Only the fields the game reads. */
function tidy(a) {
  const alt = a.alt_baro === 'ground' ? 0 : Number(a.alt_baro ?? a.alt_geom ?? 0);
  return {
    hex:   a.hex,
    call:  (a.flight || '').trim() || null,
    reg:   a.r || null,
    type:  a.t || null,
    desc:  a.desc || null,
    cat:   a.category || null,
    squawk: a.squawk || null,
    altFt: alt,
    gs:    Number(a.gs ?? 0),
    track: Number(a.track ?? a.true_heading ?? 0),
    dst:   Number(a.dst ?? 0),          // nm from the query point
    dir:   Number(a.dir ?? 0),          // bearing from the query point
    mil:   !!((a.dbFlags || 0) & 1),
    src:   a.type || null,
    seen:  Number(a.seen_pos ?? a.seen ?? 0)
  };
}

export default {
  async fetch(request) {
    if (request.method === 'OPTIONS') {
      return new Response(null, { status: 204, headers: HEADERS });
    }
    const u = new URL(request.url);
    const lat  = num(u.searchParams.get('lat'),  -90,  90,  47.6025);
    const lon  = num(u.searchParams.get('lon'), -180, 180, -122.4200);
    const dist = Math.round(num(u.searchParams.get('dist'), 1, 500, 250));

    const key = new Request(`https://relay/${lat},${lon},${dist}`, request);
    const cache = caches.default;
    const hit = await cache.match(key);
    if (hit) { return hit; }

    /* The upstreams cap a single query at 250 nm. Past that we tile: the
       centre plus a ring of six, which reaches about 500 nm (925 km). Worth
       knowing before you ask for more — an airliner at 11 km is below your
       horizon beyond roughly 400 km, so the extra range is a scope picture,
       not something you could ever look up and see. */
    const tiles = [[lat, lon, Math.min(250, dist)]];
    if (dist > 250) {
      const ringNm = Math.min(250, dist - 250);
      for (let i = 0; i < 6; i++) {
        const br = (i * 60) * Math.PI / 180;
        const dLat = (ringNm / 60) * Math.cos(br);
        const dLon = (ringNm / 60) * Math.sin(br) / Math.cos(lat * Math.PI / 180);
        tiles.push([lat + dLat, lon + dLon, 250]);
      }
    }

    let out = null, used = null, why = [];
    for (const s of SOURCES) {
      try {
        if (tiles.length > 1) {
          const parts = await Promise.all(tiles.map(([la, lo, d]) =>
            fetch(s.url(la.toFixed(4), lo.toFixed(4), d), {
              headers: { 'Accept': 'application/json', 'User-Agent': 'sentraspere-relay' },
              cf: { cacheTtl: 60, cacheEverything: true }
            }).then(r => r.ok ? r.json() : null)['catch'](() => null)));
          const seen = new Map();
          for (const j of parts) {
            if (!j) { continue; }
            for (const a of (s.list(j) || [])) {
              if (!a.hex || seen.has(a.hex)) { continue; }
              const t = tidy(a);
              // distance and bearing must be from where the PLAYER is,
              // not from whichever tile happened to catch the aircraft
              const d = geo(lat, lon, a.lat, a.lon);
              if (!d || d.nm > dist) { continue; }
              t.dst = d.nm; t.dir = d.deg;
              seen.set(a.hex, t);
            }
          }
          if (seen.size) { out = [...seen.values()]; used = s.name + ' x' + tiles.length; break; }
          why.push(`${s.name}:empty-tiles`); continue;
        }
        const r = await fetch(s.url(lat, lon, dist), {
          headers: { 'Accept': 'application/json', 'User-Agent': 'sentraspere-relay' },
          cf: { cacheTtl: CACHE_SECONDS, cacheEverything: true }
        });
        if (!r.ok) { why.push(`${s.name}:${r.status}`); continue; }
        const j = await r.json();
        const list = s.list(j);
        if (!Array.isArray(list)) { why.push(`${s.name}:shape`); continue; }
        out = list.map(tidy).filter(a => a.hex && a.dst >= 0);
        used = s.name;
        break;
      } catch (e) {
        why.push(`${s.name}:${(e && e.message || 'error').slice(0, 40)}`);
      }
    }

    const body = out
      ? { ok: true,  source: used, at: [lat, lon], dist, now: Date.now(), aircraft: out }
      : { ok: false, error: 'no upstream answered', tried: why, now: Date.now(), aircraft: [] };

    const res = new Response(JSON.stringify(body), {
      status: out ? 200 : 502,
      headers: { ...HEADERS, 'Cache-Control': `public, max-age=${CACHE_SECONDS}` }
    });
    if (out) { await cache.put(key, res.clone()); }
    return res;
  }
};
