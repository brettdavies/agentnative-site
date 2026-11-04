import { describe, expect, test } from 'bun:test';
import { jsonForScript, jsonStringBodyForScript } from '../src/shared/json-script';

const HOSTILE = '</script><!--&>\u2028\u2029"\\\n';
const RAW = /[<>&\u2028\u2029]/;

describe('jsonForScript', () => {
  test('leaves none of the five characters raw', () => {
    expect(jsonForScript({ name: HOSTILE, nested: [HOSTILE] })).not.toMatch(RAW);
  });

  test('parses back to the value it was given', () => {
    const value = { name: HOSTILE, nested: [HOSTILE, { deep: HOSTILE }], n: 1, ok: true, none: null };
    expect(JSON.parse(jsonForScript(value))).toEqual(value);
  });

  test('leaves JSON with nothing to escape byte-equal to JSON.stringify', () => {
    const value = { a: 'plain text', b: ['{{TOKEN}}', "it's"], c: 1 };
    expect(jsonForScript(value)).toBe(JSON.stringify(value));
  });
});

describe('jsonStringBodyForScript', () => {
  test('fits between authored quotes and reads back as the input', () => {
    const body = jsonStringBodyForScript(HOSTILE);
    expect(body).not.toMatch(RAW);
    expect(JSON.parse(`"${body}"`)).toBe(HOSTILE);
  });
});
