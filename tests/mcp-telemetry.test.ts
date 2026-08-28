import { describe, expect, test } from 'bun:test';
import { servedResponseFormat } from '../src/worker/mcp/telemetry';

function withContentType(value?: string): Response {
  return new Response('', { headers: value === undefined ? {} : { 'content-type': value } });
}

describe('servedResponseFormat', () => {
  test('text/event-stream is sse', () => {
    expect(servedResponseFormat(withContentType('text/event-stream'))).toBe('sse');
  });

  test('text/event-stream with parameters is sse', () => {
    expect(servedResponseFormat(withContentType('text/event-stream; charset=utf-8'))).toBe('sse');
  });

  test('an uppercased content-type is sse', () => {
    expect(servedResponseFormat(withContentType('Text/Event-Stream'))).toBe('sse');
  });

  test('application/json is json', () => {
    expect(servedResponseFormat(withContentType('application/json; charset=utf-8'))).toBe('json');
  });

  test('the text/plain bodies of the kill switch and the Accept rejection are json', () => {
    // The field answers "was this a stream"; a pre-dispatch exit is not one.
    expect(servedResponseFormat(withContentType('text/plain; charset=utf-8'))).toBe('json');
  });

  test('an absent content-type is json', () => {
    expect(servedResponseFormat(withContentType())).toBe('json');
  });
});
