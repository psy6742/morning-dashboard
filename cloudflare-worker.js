/**
 * 네이버 날씨 중계 (Cloudflare Worker)
 * ─────────────────────────────────────────────────────────────
 * weather.naver.com/today/09230105 (서울 동대문구 답십리1동) HTML 안의
 *   var blockApiResult = { ... };
 * JSON을 그대로 읽어 필요한 값만 골라 JSON으로 돌려줍니다.
 * 브라우저에서 weather.naver.com을 직접 부를 수 없어( CORS ) 생긴 중계용입니다.
 *
 * 배포
 *   1) npm i -g wrangler  (또는 npx wrangler)
 *   2) wrangler deploy cloudflare-worker.js --name naver-weather --compatibility-date 2024-11-01
 *   3) 나온 주소(https://naver-weather.<계정>.workers.dev)를
 *      대시보드 ⚙️ 설정 → "네이버 날씨 중계 주소"에 넣고 [저장 및 새로고침]
 *
 * 응답 (GET)
 *   { ok, source:"naver", region:{...}, todayDate:"20261117",
 *     observedAt:"2026-11-17T14:39:26+09:00",
 *     current:{temp, txt, cd, wmo, feels?}, 
 *     today:{min, max, amTxt, pmTxt, amProb, pmProb},
 *     hours:[{h, t, p, txt, cd, wmo}],           // 오늘 날짜(aplYmd)만, 이른 시각부터
 *     dust:{pm10, pm10Grade, pm25, pm25Grade, station},
 *     fetchedAt }
 *   실패하면 ok:false + error, HTTP 502/500. 모든 응답에 CORS 헤더가 붙습니다.
 *
 * 옵션: ?region=09230105 (다른 동네를 중계할 때만)
 */

const DEFAULT_REGION = '09230105';
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36';

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type',
  'Access-Control-Max-Age': '86400',
};

function jsonResponse(obj, status = 200, extra = {}) {
  return new Response(JSON.stringify(obj), {
    status,
    headers: {
      ...CORS,
      'Content-Type': 'application/json; charset=utf-8',
      'Cache-Control': 'public, max-age=300',
      ...extra,
    },
  });
}

/* HTML 안의 `var blockApiResult = { ... };` 부분만 떼어내 JSON으로 파싱.
   문자열 안의 중괄호를 세지 않도록 따옴표·이스케이프를 따라가며 균형을 맞춥니다. */
function parseBlockApiResult(html) {
  const at = html.indexOf('blockApiResult');
  if (at < 0) return null;
  const start = html.indexOf('{', at);
  if (start < 0) return null;
  let depth = 0, inStr = false, esc = false;
  for (let i = start; i < html.length; i++) {
    const ch = html[i];
    if (inStr) {
      if (esc) { esc = false; continue; }
      if (ch === '\\') { esc = true; continue; }
      if (ch === '"') inStr = false;
      continue;
    }
    if (ch === '"') { inStr = true; continue; }
    if (ch === '{') depth++;
    else if (ch === '}') {
      depth--;
      if (depth === 0) {
        try { return JSON.parse(html.slice(start, i + 1)); }
        catch (e) { return null; }
      }
    }
  }
  return null;
}

/* 네이버 날씨 코드/문구 → 대시보드가 쓰는 WMO 코드 (아이콘·옷차림 팁 공용) */
function wmoOf(cd, txt) {
  const t = String(txt || '');
  if (/눈/.test(t)) return /소낙/.test(t) ? 86 : 73;
  if (/소나기/.test(t)) return /강/.test(t) ? 82 : 80;
  if (/천둥|번개/.test(t)) return 95;
  if (/비|이슬비/.test(t)) return /강/.test(t) ? 65 : 61;
  if (/안개/.test(t)) return 45;
  if (/황사|먼지/.test(t)) return 3;
  if (/흐리|구름많/.test(t)) return 3;
  if (/구름\s*조금/.test(t)) return 2;
  if (/맑음/.test(t)) return 0;
  const n = Number(cd);
  if (n === 2 || n === 1) return 0;
  if (n === 3 || n === 4) return 2;
  if (n === 15 || n === 42) return 80;
  if (n === 17) return 45;
  if (n === 20) return 3;
  return 3;
}

function kstToday() {
  const d = new Date(Date.now() + 9 * 3600 * 1000);
  return d.toISOString().slice(0, 10).replace(/-/g, '');      // YYYYMMDD
}

function isoKst(ymdt) {                                       // "20261117143926" → ISO(+09:00)
  const s = String(ymdt || '');
  if (s.length < 12) return null;
  const y = s.slice(0, 4), mo = s.slice(4, 6), d = s.slice(6, 8);
  const h = s.slice(8, 10), mi = s.slice(10, 12), se = s.slice(12, 14) || '00';
  return `${y}-${mo}-${d}T${h}:${mi}:${se}+09:00`;
}

const num = (v) => (typeof v === 'number' && isFinite(v)) ? v : (v === '' || v == null ? null : (isFinite(Number(v)) ? Number(v) : null));
const prob = (v) => (v === '-' || v == null || v === '') ? null : num(v);

function buildPayload(block) {
  const cr = block && block.results && block.results.choiceResult;
  if (!cr) throw new Error('choiceResult 없음');

  const syn = cr['nowSynthesisFcast~~1'];
  if (!syn || !syn.nowFcast) throw new Error('nowSynthesisFcast 없음');
  const now = syn.nowFcast;
  const air = syn.airFcast || {};
  const weekly = (syn.weeklyFcastList || [])[0] || {};
  const todayK = kstToday();

  /* 오늘 날짜(aplYmd) 시간대별 예보만, 이른 시각부터. 오늘 칸이 없으면 가장 이른 날짜로 대체 */
  const raw = (cr['hourlyFcast~~1'] && cr['hourlyFcast~~1'].domesticHourlyFcastList) || [];
  const todayList = raw.filter((o) => String(o.aplYmd) === todayK);
  const pickDate = todayList.length ? todayK
    : raw.length ? String(raw.map((o) => String(o.aplYmd)).sort()[0]) : todayK;
  const seen = new Set();
  const hours = raw
    .filter((o) => String(o.aplYmd) === pickDate)
    .map((o) => ({
      h: Number(o.aplTm),
      t: num(o.tmpr),
      p: prob(o.rainProb),
      txt: o.wetrTxt || '',
      cd: o.wetrCd != null ? String(o.wetrCd) : '',
      wmo: wmoOf(o.wetrCd, o.wetrTxt),
    }))
    .filter((o) => isFinite(o.h) && typeof o.t === 'number')
    .sort((a, b) => a.h - b.h)
    .filter((o) => (seen.has(o.h) ? false : (seen.add(o.h), true)));

  return {
    ok: true,
    source: 'naver',
    region: {
      code: now.naverRgnCd || air.stationNaverRgnCd || '',
      lareaNm: now.lareaNm || '',
      mareaNm: now.mareaNm || '',
      sareaNm: now.sareaNm || '',
    },
    todayDate: pickDate,
    observedAt: isoKst(now.lastUdtYmdt || now.fcastYmdt),
    current: {
      temp: num(now.tmpr),
      txt: now.wetrTxt || '',
      cd: now.wetrCd != null ? String(now.wetrCd) : '',
      wmo: wmoOf(now.wetrCd, now.wetrTxt),
      humidity: num(now.humd),
      windDir: now.windDrctn || '',
      windSpeed: num(now.windSpd),
    },
    today: {
      min: num(weekly.minTmpr),
      max: num(weekly.maxTmpr),
      amTxt: weekly.amWetrTxt || '',
      pmTxt: weekly.pmWetrTxt || '',
      amProb: prob(weekly.amRainProb),
      pmProb: prob(weekly.pmRainProb),
    },
    hours,
    dust: {
      pm10: num(air.stationPM10),
      pm10Grade: air.stationPM10Legend1 || '',
      pm25: num(air.stationPM25),
      pm25Grade: air.stationPM25Legend1 || '',
      station: air.stationName || '',
    },
    fetchedAt: new Date().toISOString(),
  };
}

async function handler(request) {
  if (request.method === 'OPTIONS') {
    return new Response(null, { status: 204, headers: CORS });
  }
  if (request.method !== 'GET' && request.method !== 'HEAD') {
    return jsonResponse({ ok: false, error: 'GET만 지원해요' }, 405);
  }

  const url = new URL(request.url);
  const regionParam = url.searchParams.get('region') || DEFAULT_REGION;
  const region = /^\d{6,10}$/.test(regionParam) ? regionParam : DEFAULT_REGION;
  const target = `https://weather.naver.com/today/${region}`;

  let html;
  try {
    const res = await fetch(target, {
      headers: {
        'User-Agent': UA,
        'Accept': 'text/html,application/xhtml+xml',
        'Accept-Language': 'ko-KR,ko;q=0.9',
        'Referer': 'https://weather.naver.com/',
      },
      cf: { cacheTtl: 240, cacheEverything: true },
    });
    if (!res.ok) return jsonResponse({ ok: false, error: 'naver http ' + res.status }, 502);
    html = await res.text();
  } catch (e) {
    return jsonResponse({ ok: false, error: 'naver fetch 실패: ' + (e && e.message ? e.message : e) }, 502);
  }

  const block = parseBlockApiResult(html);
  if (!block) return jsonResponse({ ok: false, error: 'blockApiResult를 찾지 못했어요 (페이지 구조 변경?)' }, 502);

  let payload;
  try {
    payload = buildPayload(block);
  } catch (e) {
    return jsonResponse({ ok: false, error: '파싱 실패: ' + (e && e.message ? e.message : e) }, 502);
  }

  if (typeof payload.current.temp !== 'number') {
    return jsonResponse({ ok: false, error: '현재 기온이 비어 있어요' }, 502);
  }

  /* Cloudflare 캐시에 5분 저장 (같은 태블릿이 여러 번 새로고침해도 네이버는 5분에 한 번만) */
  const cacheable = new Response(JSON.stringify(payload), {
    headers: {
      ...CORS,
      'Content-Type': 'application/json; charset=utf-8',
      'Cache-Control': 'public, max-age=300',
    },
  });
  try {
    const cache = typeof caches !== 'undefined' ? caches.default : null;
    if (cache && typeof cache.put === 'function') {
      const key = new Request(url.origin + url.pathname + '?region=' + region, { method: 'GET' });
      await cache.put(key, cacheable.clone());
    }
  } catch (e) { /* 캐시는 실패해도 응답에는 영향 없음 */ }

  return cacheable;
}

export default {
  async fetch(request, env, ctx) {
    return handler(request);
  },
};
