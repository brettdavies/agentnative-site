// Agent-friendly 404 bodies for negotiated HTML/markdown. Both variants
// are HTTP 404 (soft-200 SPA shells fail the audit). Markdown includes
// absolute sitemap + llms.txt recovery links for the request origin so
// staging never emits the production host.

export function notFoundMarkdown(origin: string): string {
  const base = origin.replace(/\/$/, '');
  return `# Not found

This path is not a page on this site. Recover from the machine index:

- [Sitemap](${base}/sitemap.xml)
- [llms.txt](${base}/llms.txt)
`;
}

export function notFoundHtml(origin: string): string {
  const base = origin.replace(/\/$/, '');
  const sitemap = `${base}/sitemap.xml`;
  const llms = `${base}/llms.txt`;
  return `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <title>Not found</title>
  </head>
  <body>
    <h1>Not found</h1>
    <p>This path is not a page on this site. Recover from the machine index:</p>
    <ul>
      <li><a href="${sitemap}">Sitemap</a></li>
      <li><a href="${llms}">llms.txt</a></li>
    </ul>
  </body>
</html>
`;
}
