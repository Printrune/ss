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
    const dist = Math.round(num(u.searchParams.get('dist'), 1, 250, 60));

    const key = new Request(`https://relay/${lat},${lon},${dist}`, request);
    const cache = caches.default;
    const hit = await cache.match(key);
    if (hit) { return hit; }

    let out = null, used = null, why = [];
    for (const s of SOURCES) {
      try {
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
