// Shared by connect.mjs and fetch.mjs: where things live, OAuth calls, token files.
// Secrets rule: nothing in this folder may print or log a token or the client secret.
import {existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync} from 'node:fs';
import {dirname, join, resolve} from 'node:path';
import {fileURLToPath} from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
export const ROOT = resolve(here, '..', '..');

// Read-only scopes. The dashboard never writes to YouTube.
export const SCOPES = [
  'https://www.googleapis.com/auth/youtube.readonly',
  'https://www.googleapis.com/auth/yt-analytics.readonly',
];
export const AUTH_URL = 'https://accounts.google.com/o/oauth2/v2/auth';
export const TOKEN_URL = 'https://oauth2.googleapis.com/token';
export const REVOKE_URL = 'https://oauth2.googleapis.com/revoke';

export const pathsFor = (root = ROOT) => ({
  secrets: join(root, '.secrets'),
  tokens: join(root, '.secrets', 'tokens'),
  out: join(root, 'out', 'dashboard'),
  data: join(root, 'out', 'dashboard', 'data.json'),
  dataJs: join(root, 'out', 'dashboard', 'data.js'),
  thumbs: join(root, 'out', 'dashboard', 'thumbs'),
  reach: join(root, 'out', 'dashboard', 'reach'),
  manifest: join(root, 'out', 'dashboard', 'publish.json'),
  pipeline: join(root, 'dashboard', 'pipeline.json'),
  page: join(root, 'dashboard', 'index.html'),
});

// An error that is safe to show on the page: it holds no response bodies with secrets.
export class ApiError extends Error {
  constructor(message, {status, reason} = {}) {
    super(message);
    this.status = status;
    this.reason = reason;
  }
}
// The token no longer works: Yarden has to approve the channel again.
export class ReconnectError extends Error {}

export function readJSONFile(path, fallback = null) {
  if (!existsSync(path)) return fallback;
  return JSON.parse(readFileSync(path, 'utf8').replace(/^﻿/, ''));
}

export function writeJSONFile(path, value, options = {}) {
  mkdirSync(dirname(path), {recursive: true});
  writeFileSync(path, JSON.stringify(value, null, 2) + '\n', options);
}

// Google names the downloaded file client_secret_<id>.apps.googleusercontent.com.json.
export function loadClient(paths = pathsFor()) {
  const found = existsSync(paths.secrets)
    ? readdirSync(paths.secrets).filter((n) => /^client_secret.*\.json$/i.test(n))
    : [];
  if (found.length === 0) {
    throw new Error(`No client_secret*.json in ${paths.secrets}. See dashboard/CONNECT.md.`);
  }
  if (found.length > 1) {
    throw new Error(`Found ${found.length} client_secret files in ${paths.secrets}. Keep only the current one.`);
  }
  const raw = readJSONFile(join(paths.secrets, found[0]));
  const client = raw.installed;
  if (!client) {
    throw new Error(`${found[0]} is not a Desktop app client. Create a client of type "Desktop app" (dashboard/CONNECT.md).`);
  }
  return {clientId: client.client_id, clientSecret: client.client_secret};
}

export function listTokens(paths = pathsFor()) {
  if (!existsSync(paths.tokens)) return [];
  return readdirSync(paths.tokens)
    .filter((n) => n.endsWith('.json'))
    .map((n) => readJSONFile(join(paths.tokens, n)))
    .sort((a, b) => String(a.connectedAt).localeCompare(String(b.connectedAt)));
}

export const tokenPath = (channelId, paths = pathsFor()) => join(paths.tokens, `${channelId}.json`);

export function saveToken(token, paths = pathsFor()) {
  writeJSONFile(tokenPath(token.channelId, paths), token, {mode: 0o600});
}

async function postForm(http, url, body) {
  return http(url, {
    method: 'POST',
    headers: {'Content-Type': 'application/x-www-form-urlencoded'},
    body: new URLSearchParams(body).toString(),
  });
}

// Google's error field is a fixed code such as invalid_grant, so it is safe to repeat. The rest of the body is not read.
async function tokenRequest(http, body) {
  const res = await postForm(http, TOKEN_URL, body);
  const json = await res.json().catch(() => ({}));
  if (!res.ok) {
    if (json.error === 'invalid_grant') throw new ReconnectError('invalid_grant');
    throw new ApiError(`token request failed: HTTP ${res.status} ${json.error ?? ''}`.trim(), {status: res.status, reason: json.error});
  }
  return json;
}

export function exchangeCode({http = fetch, client, code, codeVerifier, redirectUri}) {
  return tokenRequest(http, {
    client_id: client.clientId,
    client_secret: client.clientSecret,
    code,
    code_verifier: codeVerifier,
    redirect_uri: redirectUri,
    grant_type: 'authorization_code',
  });
}

export async function refreshAccessToken({http = fetch, client, refreshToken}) {
  const json = await tokenRequest(http, {
    client_id: client.clientId,
    client_secret: client.clientSecret,
    refresh_token: refreshToken,
    grant_type: 'refresh_token',
  });
  return json.access_token;
}

export async function revokeToken({http = fetch, token}) {
  const res = await postForm(http, REVOKE_URL, {token});
  // 400 means the token is already invalid, which is the state we want.
  if (!res.ok && res.status !== 400) throw new ApiError(`revoke failed: HTTP ${res.status}`, {status: res.status});
}

// GET with a bearer token. Errors carry the status and YouTube's reason code, never the request headers.
export async function apiGet(http, url, accessToken) {
  const res = await http(url, {headers: {Authorization: `Bearer ${accessToken}`}});
  if (res.ok) return res;
  const json = await res.json().catch(() => ({}));
  const reason = json?.error?.errors?.[0]?.reason ?? json?.error?.status ?? '';
  if (res.status === 401) throw new ReconnectError(`HTTP 401 ${reason}`.trim());
  throw new ApiError(`HTTP ${res.status} ${reason} at ${new URL(url).pathname}`.trim(), {status: res.status, reason});
}

// Removes the local data of one channel. Used on revoke (terms III.A: delete within 7 days).
export function dropChannelFromData(channelId, paths = pathsFor()) {
  const data = readJSONFile(paths.data);
  if (!data) return;
  const gone = (data.channels ?? []).find((c) => c.id === channelId);
  data.channels = (data.channels ?? []).filter((c) => c.id !== channelId);
  writeJSONFile(paths.data, data);
  writeFileSync(paths.dataJs, `window.DASHBOARD_DATA = ${JSON.stringify(data)};\n`);
  const pictures = [...(gone?.long ?? []), ...(gone?.shorts ?? []), ...(gone?.scheduled ?? [])].map((v) => v.thumb).filter(Boolean);
  for (const picture of pictures) rmSync(join(paths.out, picture), {force: true});
  writeJSONFile(paths.manifest, {files: [{as: 'data.json', path: paths.data}, {as: 'data.js', path: paths.dataJs}], remove: pictures});
}
