// JSON inlined in a `<script>` element. The HTML tokenizer knows nothing of
// JSON: `</script` inside a string ends the element, and `<!--` changes how the
// rest of it tokenizes, so `JSON.stringify` output is not safe there. `&` matters
// to anything reading the page as XML, and U+2028 and U+2029 end a line in older
// script parsers. Each escape is still valid JSON, so a parser reads back the
// original value.
//
// Imported by the build and the Worker, so only pure functions over values live
// here.

const SCRIPT_UNSAFE = /[<>&\u2028\u2029]/g;

const SCRIPT_ESCAPES: Readonly<Record<string, string>> = {
  '<': '\\u003c',
  '>': '\\u003e',
  '&': '\\u0026',
  '\u2028': '\\u2028',
  '\u2029': '\\u2029',
};

function scriptSafe(json: string): string {
  return json.replace(SCRIPT_UNSAFE, (ch) => SCRIPT_ESCAPES[ch]);
}

/** `value` as JSON that can sit inside a script element. */
export function jsonForScript(value: object): string {
  return scriptSafe(JSON.stringify(value));
}

/** `text` as the inside of a JSON string, for a template that already wrote the quotes. */
export function jsonStringBodyForScript(text: string): string {
  return scriptSafe(JSON.stringify(text)).slice(1, -1);
}
