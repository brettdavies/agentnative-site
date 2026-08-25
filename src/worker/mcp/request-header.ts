/** Read a request header from SDK v2 tool context (Headers object or plain record). */
import { getMcpRequest } from './request-context';

export function requestHeader(extra: unknown, name: string): string | null {
  const headers = (extra as { requestInfo?: { headers?: Headers | Record<string, string | string[] | undefined> } })
    ?.requestInfo?.headers;
  if (headers) {
    if (headers instanceof Headers) {
      const v = headers.get(name);
      if (v) return v;
    } else {
      const target = name.toLowerCase();
      for (const [key, value] of Object.entries(headers)) {
        if (key.toLowerCase() !== target) continue;
        if (typeof value === 'string') return value;
        if (Array.isArray(value) && typeof value[0] === 'string') return value[0];
      }
    }
  }
  return getMcpRequest()?.headers.get(name) ?? null;
}
