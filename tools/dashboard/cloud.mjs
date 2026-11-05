// The hourly run on GitHub Actions: reads the channels, seals the result, and leaves a folder ready to deploy.
//   BOARD_KEY      32 random bytes in base64url. The page gets the same key from its link, after the #.
//   BOARD_SECRETS  base64 of {client, tokens, pipeline}, written by push-cloud.mjs.
//   PAGES_URL      where the last run's sealed files are served, so this run can carry them forward.
//
// THIS REPOSITORY IS PUBLIC AND SO ARE ITS RUN LOGS. Nothing about a channel may reach stdout or stderr:
// no name, no number, no message from an API. Counts, HTTP codes and code locations only.
import {createCipheriv, createDecipheriv, randomBytes} from 'node:crypto';
import {appendFileSync, cpSync, existsSync, mkdtempSync, readdirSync, rmSync, writeFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {pathToFileURL} from 'node:url';
import {runFetch} from './fetch.mjs';
import {ROOT, pathsFor, readJSONFile, saveToken, writeJSONFile} from './lib.mjs';

export const DATA_FILE = 'data.enc.json';
export const STATE_FILE = 'state.enc.json';
const KEY_BYTES = 32;
const IV_BYTES = 12;
const TAG_BYTES = 16;

// Only messages built by this file: they are known to hold no channel data.
class LogSafeError extends Error {}

export function readKey(text) {
  const key = Buffer.from(String(text ?? '').trim(), 'base64url');
  if (key.length !== KEY_BYTES) throw new LogSafeError('BOARD_KEY is not 32 bytes of base64url');
  return key;
}

// AES-256-GCM, with the tag after the ciphertext: the layout the browser's crypto.subtle expects.
export function seal(value, key) {
  const iv = randomBytes(IV_BYTES);
  const cipher = createCipheriv('aes-256-gcm', key, iv);
  const ct = Buffer.concat([cipher.update(JSON.stringify(value), 'utf8'), cipher.final(), cipher.getAuthTag()]);
  return {v: 1, iv: iv.toString('base64'), ct: ct.toString('base64')};
}

export function unseal(box, key) {
  const raw = Buffer.from(box.ct, 'base64');
  const decipher = createDecipheriv('aes-256-gcm', key, Buffer.from(box.iv, 'base64'));
  decipher.setAuthTag(raw.subarray(raw.length - TAG_BYTES));
  const plain = Buffer.concat([decipher.update(raw.subarray(0, raw.length - TAG_BYTES)), decipher.final()]);
  return JSON.parse(plain.toString('utf8'));
}

// A failed download stops the run, so a passing hiccup can't overwrite the page with less.
// A 404 is the very first run. A file that won't open means a new key or damage: everything in it can be
// read again from YouTube, reports up to 60 days back, so the board carries on rather than stay stuck.
export async function readPrevious({http, base, key}) {
  const get = async (name) => {
    const res = await http(`${base}/${name}?t=${Date.now()}`, {cache: 'no-store'});
    if (res.status === 404) return null;
    if (!res.ok) throw new LogSafeError(`could not read the last run's ${name}: HTTP ${res.status}`);
    return res.json();
  };
  const dataBox = await get(DATA_FILE);
  const stateBox = await get(STATE_FILE);
  try {
    return {data: dataBox && unseal(dataBox, key), state: stateBox && unseal(stateBox, key), unreadable: false};
  } catch {
    return {data: null, state: null, unreadable: true};
  }
}

function placeBundle(paths, bundle) {
  writeJSONFile(join(paths.secrets, 'client_secret_cloud.json'), {
    installed: {client_id: bundle.client.clientId, client_secret: bundle.client.clientSecret},
  }, {mode: 0o600});
  for (const token of bundle.tokens) saveToken(token, paths);
  writeJSONFile(paths.pipeline, {items: bundle.pipeline ?? []});
}

export async function runCloud({key, bundle, base, root, http = fetch, now = Date.now()}) {
  const paths = pathsFor(root);
  placeBundle(paths, bundle);
  const previous = await readPrevious({http, base, key});
  if (previous.data) writeJSONFile(paths.data, previous.data);
  for (const [channelId, reach] of Object.entries(previous.state?.reach ?? {})) {
    writeJSONFile(join(paths.reach, `${channelId}.json`), reach);
  }

  const {data, failed} = await runFetch({http, paths, now, log: () => {}, remoteThumbs: true});

  const reach = {};
  if (existsSync(paths.reach)) {
    for (const name of readdirSync(paths.reach)) reach[name.replace(/\.json$/, '')] = readJSONFile(join(paths.reach, name));
  }
  return {
    dataBox: seal(data, key),
    stateBox: seal({reach}, key),
    failed,
    total: data.channels.length,
    unreadable: previous.unreadable,
  };
}

async function main() {
  const key = readKey(process.env.BOARD_KEY);
  const bundle = JSON.parse(Buffer.from(process.env.BOARD_SECRETS ?? '', 'base64').toString('utf8'));
  const root = mkdtempSync(join(process.env.RUNNER_TEMP ?? tmpdir(), 'board-'));
  try {
    const {dataBox, stateBox, failed, total, unreadable} = await runCloud({key, bundle, base: process.env.PAGES_URL, root});
    const site = join(ROOT, '_site');
    cpSync(join(ROOT, 'site'), site, {recursive: true});
    writeFileSync(join(site, 'board', DATA_FILE), JSON.stringify(dataBox));
    writeFileSync(join(site, 'board', STATE_FILE), JSON.stringify(stateBox));
    if (unreadable) console.log('the last run\'s files could not be opened, so this run started fresh');
    console.log(`read ${total - failed} of ${total} channels`);
    if (process.env.GITHUB_OUTPUT) appendFileSync(process.env.GITHUB_OUTPUT, `failed=${failed}\n`);
  } finally {
    rmSync(root, {recursive: true, force: true});
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((err) => {
    const where = String(err?.stack ?? '').split('\n').find((line) => line.trim().startsWith('at ')) ?? '';
    console.error(`stopped: ${err instanceof LogSafeError ? err.message : err?.name} ${where.trim()}`);
    process.exit(1);
  });
}
