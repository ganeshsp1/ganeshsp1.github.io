// Publishes the day's reel to Instagram and the Facebook Page via the Graph API.
//
//   META_TOKEN=<page token> IG_USER_ID=<id> PAGE_ID=<id> \
//     node publish.mjs [--manifest reels.json] [--date 2026-11-22] [--check]
//
// Runs daily from GitHub Actions (see lanternbay-reels.yml). Videos and
// covers are fetched by Meta from their public URLs in the manifest, so
// nothing is uploaded from here. --check validates the token and IDs and
// creates (but never publishes) an Instagram container for the given day.
// Results are appended to published.json next to the manifest; a day that
// is already there is skipped, so reruns are safe.

import fs from 'fs';
import path from 'path';

const arg = (flag, fallback) => {
  const i = process.argv.indexOf(flag);
  return i > 0 ? process.argv[i + 1] : fallback;
};
const VERSION = process.env.GRAPH_VERSION || 'v24.0';
const GRAPH = `https://graph.facebook.com/${VERSION}`;
const TOKEN = process.env.META_TOKEN;
const IG = process.env.IG_USER_ID;
const PAGE = process.env.PAGE_ID;
const MANIFEST = arg('--manifest', 'reels.json');
const CHECK = process.argv.includes('--check');
const LOG = path.join(path.dirname(MANIFEST), 'published.json');

// The calendar runs on India time.
const today = new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Kolkata' }).format(new Date());
const DATE = arg('--date', today);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function graph(method, url, params = {}, headers = {}) {
  const body = new URLSearchParams({ ...params, access_token: TOKEN });
  const full = method === 'GET' ? `${url}?${body}` : url;
  const res = await fetch(full, { method, headers, body: method === 'GET' ? undefined : body });
  const json = await res.json().catch(() => ({}));
  if (!res.ok || json.error) {
    const e = json.error || {};
    throw new Error(`${method} ${url.replace(GRAPH, '')}: ${e.message || res.status} (code ${e.code ?? '-'})`);
  }
  return json;
}

async function instagram(entry) {
  const container = await graph('POST', `${GRAPH}/${IG}/media`, {
    media_type: 'REELS',
    video_url: entry.video_url,
    cover_url: entry.cover_url,
    caption: entry.caption,
    share_to_feed: 'true',
  });
  // Meta fetches and transcodes the video; wait until the container is ready.
  for (let i = 0; i < 60; i++) {
    const { status_code: status } = await graph('GET', `${GRAPH}/${container.id}`, { fields: 'status_code' });
    if (status === 'FINISHED') break;
    if (status === 'ERROR' || status === 'EXPIRED') throw new Error(`instagram container ${status}`);
    await sleep(10000);
    if (i === 59) throw new Error('instagram container never finished');
  }
  if (CHECK) return { container: container.id, published: false };
  const media = await graph('POST', `${GRAPH}/${IG}/media_publish`, { creation_id: container.id });
  const { permalink } = await graph('GET', `${GRAPH}/${media.id}`, { fields: 'permalink' });
  return { id: media.id, permalink };
}

async function facebook(entry) {
  const start = await graph('POST', `${GRAPH}/${PAGE}/video_reels`, { upload_phase: 'start' });
  // Hosted upload: Meta pulls the file from file_url.
  const up = await fetch(start.upload_url, {
    method: 'POST',
    headers: { Authorization: `OAuth ${TOKEN}`, file_url: entry.video_url },
  });
  const upJson = await up.json().catch(() => ({}));
  if (!up.ok || upJson.success === false) throw new Error(`facebook upload: ${JSON.stringify(upJson).slice(0, 200)}`);
  await graph('POST', `${GRAPH}/${PAGE}/video_reels`, {
    upload_phase: 'finish',
    video_id: start.video_id,
    video_state: 'PUBLISHED',
    description: entry.caption,
  });
  return { id: start.video_id };
}

async function main() {
  if (!TOKEN || !IG || !PAGE) throw new Error('META_TOKEN, IG_USER_ID and PAGE_ID are required');
  const entries = JSON.parse(fs.readFileSync(MANIFEST, 'utf8'));
  const log = fs.existsSync(LOG) ? JSON.parse(fs.readFileSync(LOG, 'utf8')) : {};
  if (CHECK) {
    const page = await graph('GET', `${GRAPH}/${PAGE}`, { fields: 'name,instagram_business_account' });
    const ig = await graph('GET', `${GRAPH}/${IG}`, { fields: 'username' });
    console.log(`token ok: page "${page.name}", instagram @${ig.username}`);
  }
  const entry = entries.find((e) => e.date === DATE);
  if (!entry) {
    console.log(`${DATE}: nothing in the manifest for today`);
    return;
  }
  const done = log[entry.name] || {};
  const result = { ...done, day: entry.day, date: entry.date };
  let failed = false;
  for (const [key, fn] of [['instagram', instagram], ['facebook', facebook]]) {
    if (CHECK && key === 'facebook') continue;
    if (done[key]?.id) {
      console.log(`${entry.name}: ${key} already published`);
      continue;
    }
    try {
      result[key] = await fn(entry);
      console.log(`${entry.name}: ${key} ${CHECK ? 'checked' : 'published'} ${JSON.stringify(result[key])}`);
    } catch (error) {
      failed = true;
      result[key] = { error: error.message, at: new Date().toISOString() };
      console.log(`${entry.name}: ${key} FAILED ${error.message}`);
    }
  }
  if (!CHECK) {
    log[entry.name] = result;
    fs.writeFileSync(LOG, JSON.stringify(log, null, 1) + '\n');
  }
  if (failed) process.exit(1);
}

main().catch((error) => {
  console.error(error.message);
  process.exit(1);
});
