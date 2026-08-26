import { AsyncLocalStorage } from 'node:async_hooks';

const storage = new AsyncLocalStorage<Request>();

export function runWithMcpRequest<T>(request: Request, fn: () => T | Promise<T>): T | Promise<T> {
  return storage.run(request, fn);
}

export function getMcpRequest(): Request | undefined {
  return storage.getStore();
}
