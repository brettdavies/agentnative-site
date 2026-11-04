// Playwright global setup for runs that target a deployed Worker: authenticate
// to Cloudflare Access once, and start every context from the cookie Access
// answers with.
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
import { type APIRequestContext, request } from '@playwright/test';

export const ACCESS_COOKIE_NAME = 'CF_Authorization';
const LOGIN_PATH = '/cdn-cgi/access/login';
const STRICT_AUTH_DOCS =
  'https://developers.cloudflare.com/cloudflare-one/access-controls/service-credentials/service-tokens/#strict-service-token-authentication';
const REQUEST_TIMEOUT_MS = 30_000;

export type AccessSessionReason =
  | 'access-target-unavailable'
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

export type AccessStorageState = Awaited<ReturnType<APIRequestContext['storageState']>>;

export type MintInput = {
  base: string;
  clientId?: string;
  clientSecret?: string;
};

type Answer = { status: number; location: string | undefined; state: AccessStorageState };

/**
 * One request in its own context, which never follows a redirect: a credential
 * on a followed request goes wherever the redirect points.
 */
async function visit(
  root: URL,
  options: { headers?: Record<string, string>; storageState?: AccessStorageState } = {},
): Promise<Answer> {
  const context = await request.newContext({ storageState: options.storageState });
  try {
    const res = await context.get(root.href, {
      headers: options.headers,
      maxRedirects: 0,
      timeout: REQUEST_TIMEOUT_MS,
    });
    return { status: res.status(), location: res.headers().location, state: await context.storageState() };
  } catch (err) {
    // First line only: the rest of Playwright's message is a call log that
    // prints the request's headers, the service token included.
    const reason = (err instanceof Error ? err.message : String(err)).split('\n')[0];
    throw new AccessSessionError('access-target-unavailable', `${root.origin} did not answer: ${reason}`);
  } finally {
    await context.dispose();
  }
}

function isLoginRedirect(answer: Answer): boolean {
  return answer.status >= 300 && answer.status < 400 && answer.location?.includes(LOGIN_PATH) === true;
}

function isRefused(answer: Answer): boolean {
  return isLoginRedirect(answer) || answer.status === 401 || answer.status === 403;
}

/**
 * The storage state a run's contexts start from: empty for a target with no
 * Access wall, which never sees the service token, otherwise the one cookie
 * Access issued. Only the login redirect counts as a wall, because a bare 401
 * or 403 can come from any host a mistyped target names.
 */
export async function mintAccessState(input: MintInput): Promise<AccessStorageState> {
  const root = new URL('/', input.base);
  const open = await visit(root);
  if (!isLoginRedirect(open)) {
    if (open.status >= 400) {
      throw new AccessSessionError(
        'access-target-unavailable',
        `${root.origin} answered ${open.status} with no credential, and that is not the Access login redirect.`,
      );
    }
    return { cookies: [], origins: [] };
  }

  if (!input.clientId || !input.clientSecret) {
    throw new AccessSessionError(
      'access-credentials-missing',
      `${root.origin} sits behind Cloudflare Access. Export ANC_STAGING_ACCESS_CLIENT_ID and ANC_STAGING_ACCESS_CLIENT_SECRET.`,
    );
  }

  const minted = await visit(root, {
    headers: { 'CF-Access-Client-Id': input.clientId, 'CF-Access-Client-Secret': input.clientSecret },
  });
  if (isRefused(minted)) {
    throw new AccessSessionError(
      'access-token-rejected',
      `Access answered ${minted.status} to the service token: rotate it or re-admit it on the Access application.`,
    );
  }

  const issued = minted.state.cookies.find((cookie) => cookie.name === ACCESS_COOKIE_NAME);
  if (!issued) {
    throw new AccessSessionError(
      'access-cookie-not-issued',
      `The service token got ${minted.status} and no ${ACCESS_COOKIE_NAME} cookie. Strict service token authentication withholds it: ${STRICT_AUTH_DOCS}`,
    );
  }

  // Pinned to the target, so a broader Domain attribute cannot widen where the
  // run sends the cookie.
  const state: AccessStorageState = { cookies: [{ ...issued, domain: root.hostname }], origins: [] };
  const check = await visit(root, { storageState: state });
  if (isRefused(check)) {
    throw new AccessSessionError(
      'access-cookie-refused',
      `Access answered ${check.status} to the ${ACCESS_COOKIE_NAME} cookie it just issued: ${STRICT_AUTH_DOCS}`,
    );
  }
  return state;
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
