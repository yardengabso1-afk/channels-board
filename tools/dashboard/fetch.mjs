// Reads every connected channel through YouTube's official APIs, read-only, and writes out/dashboard/data.json.
//   node tools/dashboard/fetch.mjs              then publish what out/dashboard/publish.json lists
// One channel failing keeps that channel's last numbers and marks it on the page.
//
// Sources, checked against the docs on 4.11.2026:
//   channels.list, playlistItems.list, videos.list    https://developers.google.com/youtube/v3/docs
//   reports.query, dimensions video,creatorContentType https://developers.google.com/youtube/analytics/channel_reports
//   channel_reach_basic_a1                             https://developers.google.com/youtube/reporting/v1/reports/channel_reports
import {existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync} from 'node:fs';
import {join} from 'node:path';
import {pathToFileURL} from 'node:url';
import {ApiError, ReconnectError, apiGet, listTokens, loadClient, pathsFor, readJSONFile, refreshAccessToken, writeJSONFile} from './lib.mjs';

const DATA_API = 'https://www.googleapis.com/youtube/v3';
const ANALYTICS_API = 'https://youtubeanalytics.googleapis.com/v2/reports';
const REPORTING_API = 'https://youtubereporting.googleapis.com/v1';
export const REACH_REPORT = 'channel_reach_basic_a1';
const SHORT_MAX_SECONDS = 180; // YouTube allows Shorts up to 3 minutes. Used only when Analytics has no row for the video yet.
const PURGE_AFTER_DAYS = 30; // Terms III.E.4: data that can no longer be refreshed goes after 30 days.

const url = (base, params) => `${base}?${new URLSearchParams(params)}`;
const num = (v) => (v === undefined || v === null || v === '' ? null : Number(v));

// ISO 8601 duration from videos.list, e.g. PT9M23S.
export function durationSeconds(iso) {
  const m = /^P(?:(\d+)D)?T?(?:(\d+)H)?(?:(\d+)M)?(?:(\d+)S)?$/.exec(iso ?? '');
  if (!m) return null;
  return (+(m[1] ?? 0)) * 86400 + (+(m[2] ?? 0)) * 3600 + (+(m[3] ?? 0)) * 60 + (+(m[4] ?? 0));
}

// Quote-aware CSV, keyed by the header row: the docs say new columns may appear.
export function parseCsv(text) {
  const rows = [];
  let row = [], cell = '', quoted = false;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (quoted) {
      if (ch === '"' && text[i + 1] === '"') { cell += '"'; i++; }
      else if (ch === '"') quoted = false;
      else cell += ch;
    } else if (ch === '"') quoted = true;
    else if (ch === ',') { row.push(cell); cell = ''; }
    else if (ch === '\n') { row.push(cell.replace(/\r$/, '')); rows.push(row); row = []; cell = ''; }
    else cell += ch;
  }
  if (cell !== '' || row.length) { row.push(cell.replace(/\r$/, '')); rows.push(row); }
  const [header, ...body] = rows;
  return (body ?? []).filter((r) => r.length > 1).map((r) => Object.fromEntries(header.map((h, i) => [h, r[i]])));
}

const tableRows = (table) => {
  const names = (table.columnHeaders ?? []).map((c) => c.name);
  return (table.rows ?? []).map((r) => Object.fromEntries(names.map((n, i) => [n, r[i]])));
};

// ---- Data API ----

async function readChannel(http, token) {
  const res = await apiGet(http, url(`${DATA_API}/channels`, {part: 'snippet,statistics,contentDetails', mine: 'true'}), token);
  const item = (await res.json()).items?.[0];
  if (!item) throw new ApiError('channels.list returned no channel');
  return item;
}

async function readUploadIds(http, token, playlistId) {
  const ids = [];
  let pageToken;
  do {
    const params = {part: 'contentDetails', playlistId, maxResults: '50'};
    if (pageToken) params.pageToken = pageToken;
    const res = await apiGet(http, url(`${DATA_API}/playlistItems`, params), token);
    const json = await res.json();
    ids.push(...(json.items ?? []).map((i) => i.contentDetails.videoId));
    pageToken = json.nextPageToken;
  } while (pageToken);
  return ids;
}

async function readVideos(http, token, ids) {
  const out = [];
  for (let i = 0; i < ids.length; i += 50) {
    const res = await apiGet(http, url(`${DATA_API}/videos`, {part: 'snippet,contentDetails,status,statistics', id: ids.slice(i, i + 50).join(','), maxResults: '50'}), token);
    out.push(...((await res.json()).items ?? []));
  }
  return out;
}

// ---- Analytics API ----

const analyticsGet = async (http, token, params) => {
  const res = await apiGet(http, url(ANALYTICS_API, {ids: 'channel==MINE', ...params}), token);
  return tableRows(await res.json());
};

async function readChannelTotals(http, token, startDate, endDate) {
  const [totals] = await analyticsGet(http, token, {startDate, endDate, metrics: 'engagedViews,views,estimatedMinutesWatched'});
  // Analytics runs a few days behind. The last day with any row tells how fresh the totals are.
  const days = await analyticsGet(http, token, {startDate, endDate, metrics: 'views', dimensions: 'day', sort: 'day'});
  return {
    engagedViews: num(totals?.engagedViews),
    views: num(totals?.views),
    hours: totals?.estimatedMinutesWatched === undefined ? null : totals.estimatedMinutesWatched / 60,
    statsThrough: days.at(-1)?.day ?? null,
  };
}

const VIDEO_METRICS = 'engagedViews,views,estimatedMinutesWatched,averageViewDuration,averageViewPercentage';

async function readVideoStats(http, token, startDate, endDate) {
  const stats = new Map();
  const warnings = [];
  const pull = async (dimensions) => {
    // The top videos report requires sort and maxResults of at most 200.
    for (let startIndex = 1; ; startIndex += 200) {
      const rows = await analyticsGet(http, token, {startDate, endDate, metrics: VIDEO_METRICS, dimensions, sort: '-views', maxResults: '200', startIndex: String(startIndex)});
      for (const r of rows) {
        const seen = stats.get(r.video);
        // A video normally has one content type. If it ever has two rows, keep the bigger one rather than invent a sum.
        if (!seen || r.views > seen.views) stats.set(r.video, r);
      }
      if (rows.length < 200) return;
    }
  };
  try {
    await pull('video,creatorContentType');
  } catch (err) {
    if (!(err instanceof ApiError) || err.status !== 400) throw err;
    // Seen on the first real run: YouTube refuses this dimension pair. classifyKind then goes by length,
    // which is safe here (Shorts run under a minute, episodes over 8), so the page doesn't need to mention it.
    stats.clear();
    await pull('video');
  }
  return {stats, warnings};
}

// ---- Reporting API: impressions and click-through ----

async function ensureReachJob(http, token, state) {
  if (state.jobId) return state.jobId;
  const res = await apiGet(http, `${REPORTING_API}/jobs`, token);
  const existing = ((await res.json()).jobs ?? []).find((j) => j.reportTypeId === REACH_REPORT);
  if (existing) {
    state.jobId = existing.id;
    state.jobCreatedAt = existing.createTime ?? null;
    return state.jobId;
  }
  const created = await http(`${REPORTING_API}/jobs`, {
    method: 'POST',
    headers: {Authorization: `Bearer ${token}`, 'Content-Type': 'application/json'},
    body: JSON.stringify({reportTypeId: REACH_REPORT, name: 'dashboard reach'}),
  });
  if (!created.ok) throw new ApiError(`could not create reporting job: HTTP ${created.status}`, {status: created.status});
  const job = await created.json();
  state.jobId = job.id;
  state.jobCreatedAt = job.createTime ?? new Date().toISOString();
  return state.jobId;
}

async function syncReachReports(http, token, state) {
  const jobId = await ensureReachJob(http, token, state);
  state.days ??= {};
  let pageToken;
  const reports = [];
  do {
    const res = await apiGet(http, url(`${REPORTING_API}/jobs/${jobId}/reports`, pageToken ? {pageToken} : {}), token);
    const json = await res.json();
    reports.push(...(json.reports ?? []));
    pageToken = json.nextPageToken;
  } while (pageToken);

  // Each report is one day. A newer report for the same day is YouTube's correction and replaces the older one.
  reports.sort((a, b) => String(a.createTime).localeCompare(String(b.createTime)));
  for (const report of reports) {
    const day = report.startTime;
    const held = state.days[day];
    if (held && held.createTime >= report.createTime) continue;
    const res = await apiGet(http, report.downloadUrl, token);
    const rows = {};
    for (const r of parseCsv(await res.text())) {
      rows[r.video_id] = {impressions: Number(r.video_thumbnail_impressions), ctr: Number(r.video_thumbnail_impressions_ctr)};
    }
    state.days[day] = {id: report.id, createTime: report.createTime, rows};
  }
  return state;
}

// The docs call the CTR a percentage worked out as clicks / impressions, without saying if 5% arrives as 5 or 0.05.
// The first real report (5.11.2026) settled it: 0.00954 for 4 clicks out of 419 impressions, so a fraction.
// A value above 1 can only be on the 0-100 scale, so that case stays handled if YouTube ever changes it.
export function ctrScale(days) {
  for (const day of Object.values(days)) {
    for (const r of Object.values(day.rows)) if (r.ctr > 1) return 1;
  }
  return 100;
}

// YouTube's report is per day. Lifetime figures are our own sum over the days we hold, so the page marks them as ours.
export function summarizeReach(state) {
  const days = state.days ?? {};
  const scale = ctrScale(days);
  const perVideo = new Map();
  for (const day of Object.values(days)) {
    for (const [id, r] of Object.entries(day.rows)) {
      const t = perVideo.get(id) ?? {impressions: 0, weighted: 0};
      t.impressions += r.impressions;
      t.weighted += r.impressions * r.ctr;
      perVideo.set(id, t);
    }
  }
  const result = new Map();
  for (const [id, t] of perVideo) {
    result.set(id, {impressions: t.impressions, ctr: t.impressions > 0 ? (t.weighted / t.impressions) * scale : null});
  }
  // YouTube also sends empty reports for the weeks before a channel had videos. Those aren't days with data.
  const names = Object.keys(days).filter((name) => Object.keys(days[name].rows).length > 0).sort();
  return {perVideo: result, firstDay: names[0]?.slice(0, 10) ?? null, lastDay: names.at(-1)?.slice(0, 10) ?? null, dayCount: names.length};
}

// ---- Turning API answers into what the page shows ----

export function classifyKind(contentType, seconds) {
  if (contentType === 'SHORTS') return 'short';
  if (contentType === 'VIDEO_ON_DEMAND' || contentType === 'LIVE_STREAM') return 'long';
  return seconds !== null && seconds <= SHORT_MAX_SECONDS ? 'short' : 'long';
}

export function buildChannel({channel, videos, stats, reach, totals, now, warnings}) {
  const long = [], shorts = [], scheduled = [];
  for (const v of videos) {
    const seconds = durationSeconds(v.contentDetails?.duration);
    const s = stats.get(v.id);
    const kind = classifyKind(s?.creatorContentType, seconds);
    const base = {
      id: v.id,
      title: v.snippet?.title ?? '',
      kind,
      duration: seconds,
      thumbUrl: v.snippet?.thumbnails?.medium?.url ?? v.snippet?.thumbnails?.default?.url ?? null,
    };
    const publishAt = v.status?.publishAt;
    if (v.status?.privacyStatus === 'private' && publishAt && Date.parse(publishAt) > now) {
      scheduled.push({...base, at: publishAt, source: 'api'});
      continue;
    }
    if (v.status?.privacyStatus !== 'public') continue;
    const r = reach.perVideo.get(v.id);
    const item = {
      ...base,
      publishedAt: v.snippet?.publishedAt ?? null,
      engagedViews: num(s?.engagedViews),
      // The public count is live. Analytics runs a few days behind, so it is only the fallback.
      views: num(v.statistics?.viewCount) ?? num(s?.views),
      hours: s?.estimatedMinutesWatched === undefined ? null : s.estimatedMinutesWatched / 60,
      avgViewPct: num(s?.averageViewPercentage),
      avgViewSeconds: num(s?.averageViewDuration),
      impressions: r?.impressions ?? null,
      ctr: r?.ctr ?? null,
    };
    (kind === 'short' ? shorts : long).push(item);
  }
  const byNewest = (a, b) => String(b.publishedAt).localeCompare(String(a.publishedAt));
  long.sort(byNewest);
  shorts.sort(byNewest);
  scheduled.sort((a, b) => a.at.localeCompare(b.at));

  const out = [...warnings];
  // The docs do not promise that the uploads playlist lists private videos, so an empty list gets a visible note.
  if (scheduled.length === 0) out.push('יוטיוב לא החזירה סרטונים מתוזמנים לערוץ הזה. אם יש כאלה ב־Studio, הרשימה כאן חסרה.');
  return {
    id: channel.id,
    name: channel.snippet?.title ?? channel.id,
    handle: channel.snippet?.customUrl ?? null,
    status: 'ok',
    error: null,
    lastOk: new Date(now).toISOString(),
    subscribers: channel.statistics?.hiddenSubscriberCount ? null : num(channel.statistics?.subscriberCount),
    // Our own sum, labelled as one on the page. YouTube's channel counter lags: on 5.11.2026 it read 458
    // while the live counts of the channel's videos added up to 637, and the page lists those videos right below.
    viewsNow: [...long, ...shorts].reduce((sum, v) => sum + (v.views ?? 0), 0),
    ...totals,
    reach: {firstDay: reach.firstDay, lastDay: reach.lastDay, dayCount: reach.dayCount},
    warnings: out,
    long,
    shorts,
    scheduled,
  };
}

export async function fetchOne({http, client, tokenRecord, paths, now}) {
  const token = await refreshAccessToken({http, client, refreshToken: tokenRecord.refreshToken});
  const channel = await readChannel(http, token);
  if (channel.id !== tokenRecord.channelId) {
    throw new ApiError(`token belongs to a different channel (${channel.id})`);
  }
  const uploads = channel.contentDetails?.relatedPlaylists?.uploads;
  const ids = uploads ? await readUploadIds(http, token, uploads) : [];
  const videos = await readVideos(http, token, ids);

  const startDate = (channel.snippet?.publishedAt ?? '2005-02-14').slice(0, 10);
  const endDate = new Date(now).toISOString().slice(0, 10);
  const totals = await readChannelTotals(http, token, startDate, endDate);
  const {stats, warnings} = await readVideoStats(http, token, startDate, endDate);

  // Impressions are extra: if this part fails, the channel's other numbers still update.
  const reachPath = join(paths.reach, `${channel.id}.json`);
  const reachState = readJSONFile(reachPath, {channelId: channel.id});
  const reachWarnings = [];
  try {
    await syncReachReports(http, token, reachState);
    writeJSONFile(reachPath, reachState);
  } catch (err) {
    if (err instanceof ReconnectError) throw err;
    reachWarnings.push(`דוחות החשיפות לא נקראו הפעם (${err.message}).`);
  }
  return buildChannel({channel, videos, stats, reach: summarizeReach(reachState), totals, now, warnings: [...warnings, ...reachWarnings]});
}

// ---- Thumbnails ----

// The hosted page loads each picture from the address the API gave, so nothing is copied.
function useRemoteThumbs(channels) {
  for (const channel of channels) {
    for (const video of [...(channel.long ?? []), ...(channel.shorts ?? []), ...(channel.scheduled ?? [])]) {
      video.thumb = video.thumbUrl ?? video.thumb ?? null;
      delete video.thumbUrl;
    }
  }
  return {changed: [], removed: []};
}

// A run on this computer keeps its own copies, for pages that can't load images from other hosts.
async function syncThumbs({http, channels, paths}) {
  mkdirSync(paths.thumbs, {recursive: true});
  const changed = [];
  const wanted = new Set();
  for (const channel of channels) {
    for (const video of [...(channel.long ?? []), ...(channel.shorts ?? []), ...(channel.scheduled ?? [])]) {
      const name = `${video.id}.jpg`;
      const file = join(paths.thumbs, name);
      if (video.thumbUrl) {
        try {
          const res = await http(video.thumbUrl);
          if (res.ok) {
            const bytes = Buffer.from(await res.arrayBuffer());
            if (!existsSync(file) || !readFileSync(file).equals(bytes)) {
              writeFileSync(file, bytes);
              changed.push(name);
            }
          }
        } catch {
          // A missing picture is not worth failing a channel for: the last copy stays, or the page shows a blank.
        }
      }
      video.thumb = existsSync(file) ? `thumbs/${name}` : null;
      if (video.thumb) wanted.add(name);
      delete video.thumbUrl;
    }
  }
  // A video that left the channel loses its picture too, here and on the page (terms III.E.4).
  const removed = readdirSync(paths.thumbs).filter((n) => !wanted.has(n));
  for (const n of removed) rmSync(join(paths.thumbs, n));
  return {changed, removed};
}

export function writeOutputs({data, paths, changed, removed}) {
  mkdirSync(paths.out, {recursive: true});
  writeJSONFile(paths.data, data);
  // data.js is the same content for viewers whose frame refuses fetch(): a script tag still loads it.
  writeFileSync(paths.dataJs, `window.DASHBOARD_DATA = ${JSON.stringify(data)};\n`);
  writeJSONFile(paths.manifest, {
    files: [
      {as: 'data.json', path: paths.data},
      {as: 'data.js', path: paths.dataJs},
      ...changed.map((n) => ({as: `thumbs/${n}`, path: join(paths.thumbs, n)})),
    ],
    remove: removed.map((n) => `thumbs/${n}`),
  });
}

// ---- One run ----

export async function runFetch({http = fetch, paths = pathsFor(), now = Date.now(), log = console.log, remoteThumbs = false} = {}) {
  const tokens = listTokens(paths);
  if (tokens.length === 0) throw new Error('No channels connected. Run tools/dashboard/connect.mjs first.');
  const client = loadClient(paths);
  const previous = readJSONFile(paths.data);
  // Anything from before the connection (the manual reading of 4.11) is dropped on the first real run.
  const prevById = new Map(previous?.mode === 'api' ? previous.channels.map((c) => [c.id, c]) : []);

  const channels = [];
  let failed = 0;
  for (const tokenRecord of tokens) {
    try {
      channels.push(await fetchOne({http, client, tokenRecord, paths, now}));
      log(`ok: ${tokenRecord.channelTitle}`);
    } catch (err) {
      failed++;
      const reconnect = err instanceof ReconnectError;
      log(`failed: ${tokenRecord.channelTitle}: ${reconnect ? 'needs reconnecting' : err.message}`);
      channels.push(keepLastGood({tokenRecord, prev: prevById.get(tokenRecord.channelId), reconnect, err, now}));
    }
  }

  const {changed, removed} = remoteThumbs ? useRemoteThumbs(channels) : await syncThumbs({http, channels, paths});
  const data = {
    schema: 1,
    mode: 'api',
    generatedAt: new Date(now).toISOString(),
    notice: null,
    channels,
    pipeline: readJSONFile(paths.pipeline, {items: []}).items,
  };
  writeOutputs({data, paths, changed, removed});
  log(`wrote ${paths.data}: ${channels.length - failed} ok, ${failed} failed, ${changed.length} pictures changed`);
  return {data, failed};
}

export function keepLastGood({tokenRecord, prev, reconnect, err, now}) {
  const message = reconnect
    ? 'החיבור לערוץ הזה פג. צריך לאשר אותו מחדש.'
    : `הקריאה מיוטיוב נכשלה: ${err.message}`;
  const status = reconnect ? 'reconnect' : 'stale';
  const tooOld = prev?.lastOk && now - Date.parse(prev.lastOk) > PURGE_AFTER_DAYS * 86400000;
  if (!prev || tooOld) {
    return {
      id: tokenRecord.channelId,
      name: prev?.name ?? tokenRecord.channelTitle,
      handle: prev?.handle ?? null,
      status,
      error: tooOld ? `${message} המספרים הישנים נמחקו אחרי ${PURGE_AFTER_DAYS} יום, לפי כללי יוטיוב.` : message,
      lastOk: null,
      subscribers: null, viewsNow: null, engagedViews: null, views: null, hours: null, statsThrough: null,
      reach: {firstDay: null, lastDay: null, dayCount: 0},
      warnings: [], long: [], shorts: [], scheduled: [],
    };
  }
  return {...prev, status, error: message};
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  runFetch()
    .then(({data, failed}) => {
      if (failed === data.channels.length) process.exit(1);
    })
    .catch((err) => {
      console.error(`Failed: ${err.message}`);
      process.exit(1);
    });
}
