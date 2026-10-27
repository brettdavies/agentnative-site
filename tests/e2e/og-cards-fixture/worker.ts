// Fixture sites for the live scorecard-card smoke (scripts/og/smoke.sh). The
// smoke deploys this Worker on fresh `og-<kind>-<run>.anc.dev` hosts each
// run, so every audit, card and logo lookup starts from nothing; the host's
// first label picks which logo shape the homepage offers:
//   og-hires-*    a 512px apple-touch-icon       -> the card uses it
//   og-lowres-*   only a 32px favicon             -> too small; brand fallback
//   og-baddata-*  an icon data URI that won't decode -> brand fallback, never a 500

import { ICON_32_PNG, ICON_512_PNG } from './icons';

type Kind = 'hires' | 'lowres' | 'baddata';

const HEAD: Record<Kind, string> = {
  hires: '<link rel="apple-touch-icon" href="/apple-touch-icon.png">',
  lowres: '<link rel="icon" href="/favicon-32.png">',
  baddata: '<link rel="icon" href="data:image/png;base64,%%%%">',
};

function kindOf(host: string): Kind | null {
  const match = /^og-(hires|lowres|baddata)-[a-z0-9]+\./.exec(host);
  return match ? (match[1] as Kind) : null;
}

function png(base64: string): Response {
  const bytes = Uint8Array.from(atob(base64), (c) => c.charCodeAt(0));
  return new Response(bytes, { headers: { 'content-type': 'image/png', 'cache-control': 'no-store' } });
}

function page(kind: Kind, host: string): string {
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<title>anc.dev card fixture (${kind})</title>
<meta name="description" content="A fixture site the anc.dev scorecard-card smoke audits.">
${HEAD[kind]}
</head>
<body>
<main>
<h1>Card fixture: ${kind}</h1>
<p>${host} exists for a live check of the scorecard social card. It serves one page and the icons its head names.</p>
</main>
</body>
</html>
`;
}

export default {
  fetch(request: Request): Response {
    const url = new URL(request.url);
    const kind = kindOf(url.hostname);
    if (!kind) return new Response('not a card fixture host\n', { status: 404 });
    if (url.pathname === '/') {
      return new Response(page(kind, url.hostname), {
        headers: { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' },
      });
    }
    if (kind === 'hires' && url.pathname === '/apple-touch-icon.png') return png(ICON_512_PNG);
    if (kind === 'lowres' && url.pathname === '/favicon-32.png') return png(ICON_32_PNG);
    return new Response('not found\n', { status: 404, headers: { 'cache-control': 'no-store' } });
  },
};
