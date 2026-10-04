// The server card check validates a card against the required fields of the
// vendored SEP-2127 extension schema, which the registry build reads into the
// built registry. These pin the two together: the built lists are the
// schema's own, the handler refuses every omission a full JSON Schema
// validator refuses, and the build stops when it cannot read the schema.

import { afterAll, describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import Ajv2020 from 'ajv/dist/2020';
import addFormats from 'ajv-formats';
import * as yaml from 'js-yaml';
import { emitWebAuditRegistry, normalizeWebAuditRegistry } from '../src/build/13-web-audit-registry.mjs';
import { cardRequirements, readCardSchema, VENDORED_CARD_SCHEMA_PATH } from '../src/build/web-audit-card-schema.mjs';
import { type CardFieldRule, sep2127Problems } from '../src/worker/audit-web/handlers/server-card';

const REGISTRY_PATH = join(new URL('..', import.meta.url).pathname, 'src', 'data', 'web-audit', 'registry.yaml');

type Schema = { $defs: Record<string, { required?: string[]; properties?: Record<string, unknown> }> };
const SCHEMA = readCardSchema() as Schema;

const VALID_CARD = {
  $schema: 'https://static.modelcontextprotocol.io/schemas/v1/server-card.schema.json',
  name: 'com.example/example',
  version: '1.0.0',
  description: 'Example MCP server',
  remotes: [{ type: 'streamable-http', url: 'https://example.com/mcp' }],
};

const tmpDirs: string[] = [];
afterAll(async () => {
  for (const dir of tmpDirs) await rm(dir, { recursive: true, force: true });
});

async function tmp(prefix: string): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), prefix));
  tmpDirs.push(dir);
  return dir;
}

/** The registry the build writes, read back from its output file. */
async function builtCardCheck(cardSchemaPath: string) {
  const distDir = await tmp('web-audit-registry-');
  await mkdir(join(distDir, '_internal'));
  await emitWebAuditRegistry({ registryPath: REGISTRY_PATH, distDir, cardSchemaPath });
  const built = JSON.parse(await readFile(join(distDir, '_internal', 'web-audit-registry.json'), 'utf8')) as {
    checks: Array<{ id: string; with: { required: CardFieldRule[]; remote_required: CardFieldRule[] } }>;
  };
  const check = built.checks.find((c) => c.id === 'mcp-server-card');
  if (check === undefined) throw new Error('no mcp-server-card in the built registry');
  return check;
}

function fullValidator() {
  const ajv = new Ajv2020({ allErrors: true });
  addFormats(ajv);
  ajv.addSchema(SCHEMA, 'card');
  const validate = ajv.getSchema('card#/$defs/ServerCard');
  if (validate === undefined) throw new Error('the vendored schema defines no ServerCard');
  return validate;
}

describe('the built registry carries the vendored schema required fields', () => {
  test('top level and remotes[] items, in the schema order', async () => {
    const check = await builtCardCheck(VENDORED_CARD_SCHEMA_PATH);
    expect(check.with.required.map((rule) => rule.field)).toEqual(SCHEMA.$defs.ServerCard.required ?? []);
    expect(check.with.remote_required.map((rule) => rule.field)).toEqual(SCHEMA.$defs.Remote.required ?? []);
    for (const rule of [...check.with.required, ...check.with.remote_required]) expect(rule.type).toEqual(['string']);
  });

  test('the handler refuses each required-field omission the full schema refuses', async () => {
    const check = await builtCardCheck(VENDORED_CARD_SCHEMA_PATH);
    const validate = fullValidator();
    expect(validate(VALID_CARD)).toBe(true);
    expect(sep2127Problems(VALID_CARD, check.with)).toEqual([]);
    const omissions: Array<{ field: string; card: Record<string, unknown> }> = [
      ...check.with.required.map(({ field }) => {
        const card: Record<string, unknown> = { ...VALID_CARD };
        delete card[field];
        return { field, card };
      }),
      ...check.with.remote_required.map(({ field }) => {
        const remote: Record<string, unknown> = { ...VALID_CARD.remotes[0] };
        delete remote[field];
        return { field: `remotes[0] ${field}`, card: { ...VALID_CARD, remotes: [remote] } };
      }),
    ];
    expect(omissions.length).toBe(6);
    for (const { field, card } of omissions) {
      const problems = sep2127Problems(card, check.with).join('; ');
      expect({ field, schemaAccepts: validate(card), problems }).toEqual({
        field,
        schemaAccepts: false,
        problems: expect.stringContaining(field.replace(/^remotes\[0\] /, '')),
      });
    }
  });

  test('the handler names each mistyped field and malformed remotes the full schema refuses', async () => {
    const check = await builtCardCheck(VENDORED_CARD_SCHEMA_PATH);
    const validate = fullValidator();
    const [remote] = VALID_CARD.remotes;
    const cases: Array<{ card: Record<string, unknown>; problem: string }> = [
      ...check.with.required.map(({ field }) => ({
        card: { ...VALID_CARD, [field]: 42 },
        problem: `${field} is not string`,
      })),
      ...check.with.remote_required.map(({ field }) => ({
        card: { ...VALID_CARD, remotes: [{ ...remote, [field]: 42 }] },
        problem: `remotes[0] ${field} is not string`,
      })),
      { card: { ...VALID_CARD, remotes: remote }, problem: 'remotes is not an array' },
      { card: { ...VALID_CARD, remotes: [42] }, problem: 'remotes[0] is not an object' },
    ];
    for (const { card, problem } of cases) {
      expect({ problem, schemaAccepts: validate(card), problems: sep2127Problems(card, check.with) }).toEqual({
        problem,
        schemaAccepts: false,
        problems: [problem],
      });
    }
  });
});

describe('the registry build stops without a readable server card schema', () => {
  test('a missing vendored file fails the build, naming the sync script', async () => {
    const dir = await tmp('web-audit-schema-missing-');
    await expect(builtCardCheck(join(dir, 'server-card.schema.json'))).rejects.toThrow(
      /server card schema not readable.*sync-server-card-schema\.sh/,
    );
  });

  test('a schema whose card definition carries no required array fails the build', async () => {
    const dir = await tmp('web-audit-schema-no-required-');
    const { required: _required, ...card } = SCHEMA.$defs.ServerCard;
    const path = join(dir, 'server-card.schema.json');
    await writeFile(path, JSON.stringify({ ...SCHEMA, $defs: { ...SCHEMA.$defs, ServerCard: card } }));
    await expect(builtCardCheck(path)).rejects.toThrow(/no required array at \$defs\.ServerCard/);
  });

  test('a schema whose remote definition carries no required array fails too', () => {
    const { required: _required, ...remote } = SCHEMA.$defs.Remote;
    expect(() => cardRequirements({ ...SCHEMA, $defs: { ...SCHEMA.$defs, Remote: remote } })).toThrow(
      /no required array at ServerCard\.remotes\[\]/,
    );
  });
});

describe('the registry build guards the server card check', () => {
  const doc = () => yaml.load(readFileSync(REGISTRY_PATH, 'utf8')) as { checks: Array<Record<string, unknown>> };
  const withCard = (edit: (card: Record<string, unknown>) => Record<string, unknown>) => {
    const parsed = doc();
    return { ...parsed, checks: parsed.checks.map((c) => (c.id === 'mcp-server-card' ? edit(c) : c)) };
  };

  test('a hand-authored required list is refused, since the build reads it from the schema', () => {
    const edited = withCard((c) => ({ ...c, with: { retained: 'server-card', required: [] } }));
    expect(() => normalizeWebAuditRegistry(edited)).toThrow(/hand-authors with\.required/);
  });

  test('the server-card handler is refused outside the retained-document rule', () => {
    const { eval: _rule, ...bare } = doc().checks.find((c) => c.id === 'mcp-server-card') ?? {};
    expect(() => normalizeWebAuditRegistry(withCard(() => bare))).toThrow(/needs eval retained-document/);
  });
});
