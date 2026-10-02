// A rendered page as just enough DOM for the in-page readers: elements with
// attributes, text, and simple class and attribute selectors. Built with the
// HTMLRewriter the runtime ships, so the readers under test see the markup
// the Worker actually emitted rather than a hand-built stand-in.

type Node = {
  tag: string;
  attrs: Map<string, string>;
  children: Node[];
  /** Text and child elements in document order. */
  content: Array<string | Node>;
};

const VOID = new Set(['area', 'base', 'br', 'col', 'embed', 'hr', 'img', 'input', 'link', 'meta', 'source', 'wbr']);

const HTML_ENTITIES: Record<string, string> = { amp: '&', lt: '<', gt: '>', quot: '"', '#39': "'" };

function decode(text: string): string {
  return text.replace(/&(amp|lt|gt|quot|#39);/g, (_, name: string) => HTML_ENTITIES[name]);
}

function matches(node: Node, selector: string): boolean {
  const parts = selector.match(/(\.[A-Za-z][\w-]*|\[[^\]]+\]|^[a-z]+)/g);
  if (!parts || parts.join('') !== selector) throw new Error(`unsupported selector ${selector}`);
  return parts.every((part) => {
    if (part.startsWith('.')) return (node.attrs.get('class') ?? '').split(/\s+/).includes(part.slice(1));
    if (!part.startsWith('[')) return node.tag === part;
    const m = /^\[([^=\]]+)(?:="([^"]*)")?\]$/.exec(part);
    if (!m) return false;
    const value = node.attrs.get(m[1]);
    return m[2] === undefined ? value !== undefined : value === m[2];
  });
}

function textOf(node: Node): string {
  return node.content.map((part) => (typeof part === 'string' ? part : textOf(part))).join('');
}

function descendants(node: Node, selector: string, out: Node[]): Node[] {
  for (const child of node.children) {
    if (matches(child, selector)) out.push(child);
    descendants(child, selector, out);
  }
  return out;
}

function element(node: Node): Element {
  return {
    getAttribute: (name: string) => node.attrs.get(name) ?? null,
    querySelector: (selector: string) => {
      const [found] = descendants(node, selector, []);
      return found ? element(found) : null;
    },
    querySelectorAll: (selector: string) => descendants(node, selector, []).map(element),
    get textContent() {
      return textOf(node);
    },
  } as unknown as Element;
}

/** Parse `html` into a document the readers can query. */
export async function parseHtml(html: string): Promise<Document> {
  const root: Node = { tag: '#document', attrs: new Map(), children: [], content: [] };
  const stack: Node[] = [root];
  await new HTMLRewriter()
    .on('*', {
      element(el) {
        const node: Node = { tag: el.tagName, attrs: new Map(), children: [], content: [] };
        for (const [name, value] of el.attributes) node.attrs.set(name, decode(value));
        const parent = stack[stack.length - 1];
        parent.children.push(node);
        parent.content.push(node);
        if (VOID.has(el.tagName)) return;
        stack.push(node);
        el.onEndTag(() => {
          stack.pop();
        });
      },
      text(chunk) {
        stack[stack.length - 1].content.push(decode(chunk.text));
      },
    })
    .transform(new Response(html))
    .text();
  const doc = element(root);
  return doc as unknown as Document;
}
