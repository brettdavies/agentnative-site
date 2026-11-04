// Playwright global setup for runs that target a deployed Worker: authenticate
// to Cloudflare Access once, and start every context from the cookie Access
// answers with instead of the service token.
//
// Access headers follow a run wherever it goes. Set on a browser context they
// reach every third-party script a page loads and every host a navigation
// redirects to; set on a request they cross a followed redirect. A cookie is
// scoped to the host that set it, so it stays behind in all of those cases.
//
// Access issues the cookie only while strict service token authentication is
// off, and a missing cookie reads as a redirect to a login page that answers
// 200, which every test then reports as a missing feature. So setup proves the
// cookie admits a request, or stops the run and names the reason.

import { rm, writeFile } from 'node:fs/promises';

export const ACCESS_COOKIE_NAME = 'CF_Authorization';
const LOGIN_PATH = '/cdn-cgi/access/login';
const STRICT_AUTH_DOCS =
  'https://developers.cloudflare.com/cloudflare-one/access-controls/service-credentials/service-tokens/#strict-service-token-authentication';
const REQUEST_TIMEOUT_MS = 30_000;

export type AccessSessionReason =
  | 'access-credentials-missing'
  | 'access-token-rejected'
  | 'access-cookie-not-issued'
  | 'access-cookie-refused';

export class AccessSessionError extends Error {
  constructor(
    readonly reason: AccessSessionReason,
    message: string,
  ) {
    super(`${reason}: ${message}`);
    this.name = 'AccessSessionError';
  }
}

export type AccessCookie = {
  name: string;
  value: string;
  domain: string;
  path: string;
  expires: number;
  httpOnly: boolean;
  secure: boolean;
  sameSite: 'Strict' | 'Lax' | 'None';
};

export type AccessStorageState = { cookies: AccessCookie[]; origins: [] };

export type MintInput = {
  base: string;
  clientId?: string;
  clientSecret?: string;
};

/** A credential on a followed request goes wherever the redirect points, so nothing here follows one. */
function getWithoutFollowing(url: URL, headers: Record<string, string> = {}): Promise<Response> {
  return fetch(url, { redirect: 'manual', headers, signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS) });
}

/** Access answers an unauthenticated request with its login redirect, or 401 where an application opts into that. */
function isAccessWall(res: Response): boolean {
  if (res.status === 401) return true;
  if (res.status < 300 || res.status >= 400) return false;
  const location = res.headers.get('location');
  return location !== null && new URL(location, res.url).pathname.startsWith(LOGIN_PATH);
}

/**
 * The domain is pinned to the target rather than read from the header, so a
 * broader Domain attribute cannot widen where the run sends the cookie.
 */
function parseAccessCookie(setCookie: string[], hostname: string): AccessCookie | null {
  for (const line of setCookie) {
    const [pair = '', ...attributes] = line.split(';').map((part) => part.trim());
    const separator = pair.indexOf('=');
    if (pair.slice(0, separator) !== ACCESS_COOKIE_NAME) continue;
    const value = pair.slice(separator + 1);
    if (value.length === 0) continue;
    const attribute = (name: string): string | undefined =>
      attributes.find((a) => a.toLowerCase().startsWith(`${name}=`))?.slice(name.length + 1);
    const flag = (name: string): boolean => attributes.some((a) => a.toLowerCase() === name);
    const expires = attribute('expires');
    const sameSite = attribute('samesite')?.toLowerCase();
    return {
      name: ACCESS_COOKIE_NAME,
      value,
      domain: hostname,
      path: attribute('path') ?? '/',
      expires: expires ? Math.floor(Date.parse(expires) / 1000) : -1,
      httpOnly: flag('httponly'),
      secure: flag('secure'),
      sameSite: sameSite === 'strict' ? 'Strict' : sameSite === 'lax' ? 'Lax' : 'None',
    };
  }
  return null;
}

/**
 * The storage state a run's contexts start from: empty for a target with no
 * Access wall, which never sees the service token, otherwise the one cookie
 * Access issued.
 */
export async function mintAccessState(input: MintInput): Promise<AccessStorageState> {
  const root = new URL('/', input.base);
  if (!isAccessWall(await getWithoutFollowing(root))) return { cookies: [], origins: [] };

  if (!input.clientId || !input.clientSecret) {
    throw new AccessSessionError(
      'access-credentials-missing',
      `${root.origin} sits behind Cloudflare Access. Export ANC_STAGING_ACCESS_CLIENT_ID and ANC_STAGING_ACCESS_CLIENT_SECRET.`,
    );
  }

  const minted = await getWithoutFollowing(root, {
    'CF-Access-Client-Id': input.clientId,
    'CF-Access-Client-Secret': input.clientSecret,
  });
  if (minted.status < 200 || minted.status >= 300) {
    throw new AccessSessionError(
      'access-token-rejected',
      `Access answered ${minted.status} to the service token: rotate it or re-admit it on the Access application.`,
    );
  }

  const cookie = parseAccessCookie(minted.headers.getSetCookie(), root.hostname);
  if (!cookie) {
    throw new AccessSessionError(
      'access-cookie-not-issued',
      `Access admitted the service token but set no ${ACCESS_COOKIE_NAME} cookie. Strict service token authentication withholds it: ${STRICT_AUTH_DOCS}`,
    );
  }

  const check = await getWithoutFollowing(root, { cookie: `${ACCESS_COOKIE_NAME}=${cookie.value}` });
  if (check.status === 403 || isAccessWall(check)) {
    throw new AccessSessionError(
      'access-cookie-refused',
      `Access answered ${check.status} to the ${ACCESS_COOKIE_NAME} cookie it just issued: ${STRICT_AUTH_DOCS}`,
    );
  }
  return { cookies: [cookie], origins: [] };
}

/**
 * Playwright prints a failed request's headers, cookie included, and GitHub
 * masks registered secrets only, not a value minted during the step.
 * https://docs.github.com/en/actions/reference/workflows-and-actions/workflow-commands#masking-a-value-in-a-log
 */
function maskInCi(state: AccessStorageState): void {
  if (process.env.GITHUB_ACTIONS !== 'true') return;
  for (const cookie of state.cookies) console.log(`::add-mask::${cookie.value}`);
}

export default async function globalSetup(): Promise<() => Promise<void>> {
  const base = process.env.ANC_STAGING_BASE_URL;
  const statePath = process.env.ANC_E2E_ACCESS_STATE;
  if (!base || !statePath) throw new Error('access-session needs ANC_STAGING_BASE_URL and ANC_E2E_ACCESS_STATE');

  const state = await mintAccessState({
    base,
    clientId: process.env.ANC_STAGING_ACCESS_CLIENT_ID,
    clientSecret: process.env.ANC_STAGING_ACCESS_CLIENT_SECRET,
  });
  maskInCi(state);
  await writeFile(statePath, JSON.stringify(state), { mode: 0o600 });
  return () => rm(statePath, { force: true });
}
