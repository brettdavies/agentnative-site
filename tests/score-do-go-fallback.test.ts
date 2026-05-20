// Go discovery-fallback tests for resolveSpec() in resolve-spec.ts.
//
// `go install <module>@latest` would compile from source on the sandbox,
// violating the binary-only premise. resolveSpec redirects through the
// discovery chain: a module path of the form `github.com/<owner>/<repo>`
// runs through discoverBinary so a GitHub Releases asset substitutes
// for the compile. Non-github modules bounce as go_no_binary.
//
// 2026-05-20 move: pre-move this lived in do.ts and was invoked at the
// DO boundary. Resolution now happens at the Worker tier; the function
// signature is unchanged, only the file location moved.

import { describe, expect, test } from 'bun:test';
import { resolveGoFallback } from '../src/worker/score/resolve-spec';

type FetchHandler = (url: string) => Response | Promise<Response>;

function fakeFetcher(handler: FetchHandler): typeof fetch {
  return (async (input: Request | string | URL, _init?: RequestInit) => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url;
    return await handler(url);
  }) as unknown as typeof fetch;
}

const EMPTY_HINTS = { by_owner_repo: {} };

function ok<T>(body: T): Response {
  return new Response(JSON.stringify(body), { status: 200, headers: { 'content-type': 'application/json' } });
}

function notFound(): Response {
  return new Response('', { status: 404 });
}

describe('resolveGoFallback — happy paths', () => {
  test('github.com module with release asset → resolves to pm=direct', async () => {
    const fetcher = fakeFetcher((url) => {
      if (url.includes('api.github.com/repos/charmbracelet/glow/releases/latest')) {
        return ok({
          assets: [
            {
              name: 'glow_2.1.2_Linux_x86_64.tar.gz',
              browser_download_url: 'https://example.com/glow_2.1.2_Linux_x86_64.tar.gz',
            },
          ],
        });
      }
      return notFound();
    });
    const result = await resolveGoFallback('github.com/charmbracelet/glow', EMPTY_HINTS, fetcher);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.pm).toBe('direct');
  });

  test('github.com module subpath (cmd/foo) is normalized to repo root', async () => {
    // `go install github.com/owner/repo/cmd/foo@latest` parses to
    // package=`github.com/owner/repo/cmd/foo`. The fallback strips
    // subpaths so the GitHub release for the repo applies.
    const fetcher = fakeFetcher((url) => {
      if (url.includes('api.github.com/repos/owner/repo/releases/latest')) {
        return ok({
          assets: [{ name: 'tool-linux-x86_64.tar.gz', browser_download_url: 'https://example.com/x.tar.gz' }],
        });
      }
      return notFound();
    });
    const result = await resolveGoFallback('github.com/owner/repo/cmd/foo', EMPTY_HINTS, fetcher);
    expect(result.ok).toBe(true);
  });

  test('github.com module with crates.io alternative → resolves via Step 3', async () => {
    // Defensive: if a Go module's GitHub repo ALSO ships a crate
    // with a binary, discoverBinary picks the cargo path. The Go
    // fallback accepts any non-go resolution.
    const fetcher = fakeFetcher((url) => {
      if (url.includes('api.github.com/repos/BurntSushi/ripgrep/releases/latest')) return notFound();
      if (url === 'https://crates.io/api/v1/crates/ripgrep') {
        return ok({
          crate: { repository: 'https://github.com/BurntSushi/ripgrep', max_stable_version: '14.0.0' },
        });
      }
      if (url === 'https://crates.io/api/v1/crates/ripgrep/14.0.0') {
        return ok({ version: { bin_names: ['rg'] } });
      }
      return notFound();
    });
    const result = await resolveGoFallback('github.com/BurntSushi/ripgrep', EMPTY_HINTS, fetcher);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.pm).toBe('cargo-binstall');
  });
});

describe('resolveGoFallback — bounce paths', () => {
  test('non-github module (rsc.io/quote) → install_unsupported pm=go_no_binary', async () => {
    const fetcher = fakeFetcher(() => notFound());
    const result = await resolveGoFallback('rsc.io/quote/v3', EMPTY_HINTS, fetcher);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error).toBe('install_unsupported');
    expect(result.details).toBe('pm=go_no_binary');
  });

  test('golang.org/x/... module → install_unsupported pm=go_no_binary', async () => {
    const fetcher = fakeFetcher(() => notFound());
    const result = await resolveGoFallback('golang.org/x/tools/cmd/godoc', EMPTY_HINTS, fetcher);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error).toBe('install_unsupported');
    expect(result.details).toBe('pm=go_no_binary');
  });

  test('github.com module with no release binary → install_unsupported pm=go_no_binary', async () => {
    // The repo exists on github but ships no GitHub release, no
    // crates / npm / pypi alternative, no README-parseable install
    // command. discoverBinary returns chain_no_resolve.
    const fetcher = fakeFetcher(() => notFound());
    const result = await resolveGoFallback('github.com/no-binary/tool', EMPTY_HINTS, fetcher);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error).toBe('install_unsupported');
    expect(result.details).toBe('pm=go_no_binary');
  });

  test('module path with only two segments (github.com/owner) → install_unsupported', async () => {
    // Defensive: a malformed module path with no repo segment
    // bounces fast rather than calling discoverBinary with an empty
    // repo name.
    const fetcher = fakeFetcher(() => notFound());
    const result = await resolveGoFallback('github.com/owner', EMPTY_HINTS, fetcher);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error).toBe('install_unsupported');
    expect(result.details).toBe('pm=go_no_binary');
  });

  test('module path with @version suffix is stripped before parsing', async () => {
    // parse-install normally strips @version, but the fallback is
    // defensive against callers that don't.
    const fetcher = fakeFetcher((url) => {
      if (url.includes('api.github.com/repos/charmbracelet/glow/releases/latest')) {
        return ok({
          assets: [{ name: 'glow-linux-x86_64.tar.gz', browser_download_url: 'https://example.com/g.tar.gz' }],
        });
      }
      return notFound();
    });
    const result = await resolveGoFallback('github.com/charmbracelet/glow@v1.5.1', EMPTY_HINTS, fetcher);
    expect(result.ok).toBe(true);
  });
});
