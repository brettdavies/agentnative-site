// Field caps the emitter applies at the boundary. They live apart from the
// emitter so the MCP telemetry module can share them without importing the
// emitter it also feeds.

export function msBucket(ms: number): '<50' | '50-200' | '200-1000' | '>1000' {
  if (ms < 50) return '<50';
  if (ms < 200) return '50-200';
  if (ms < 1000) return '200-1000';
  return '>1000';
}

export function truncateClientName(name: string | null | undefined, max = 64): string | null {
  if (name == null || name === '') return null;
  return name.length <= max ? name : `${name.slice(0, max - 1)}…`;
}
