// Bindings for the render Worker under Bun: an R2 bucket that keeps upload
// times, a Media binding that records what it was asked to do, a queue that
// keeps what it was sent, and Durable Object storage with a hand-fired alarm.

import { readFile } from 'node:fs/promises';
import type { ScoreOgFonts } from '../../src/og-render/render';
import type { OgRenderedMessage } from '../../src/shared/og-render';

const FONT_DIR = new URL('../../src/og-render/fonts/', import.meta.url);

let fontBuffers: ScoreOgFonts | null = null;

export async function cardFonts(): Promise<ScoreOgFonts> {
  if (fontBuffers) return fontBuffers;
  const [regular, bold, mono] = await Promise.all(
    ['uncut-sans-600.ttf', 'uncut-sans-700.ttf', 'monaspace-xenon-500.otf'].map(
      async (file) => new Uint8Array(await readFile(new URL(file, FONT_DIR))),
    ),
  );
  fontBuffers = [regular, bold, mono];
  return fontBuffers;
}

export type FakeObject = {
  bytes: Uint8Array;
  contentType?: string;
  meta: Record<string, string>;
  uploaded: Date;
};

export type FakeBucket = R2Bucket & { objects: Map<string, FakeObject>; gets: number };

/** An R2 bucket over a Map. `failReads` makes every read reject, the way an R2 outage does. */
export function fakeBucket(options: { failReads?: boolean } = {}): FakeBucket {
  const objects = new Map<string, FakeObject>();
  const meta = (key: string, object: FakeObject) => ({
    key,
    size: object.bytes.byteLength,
    uploaded: object.uploaded,
    etag: `"${object.bytes.byteLength}-${object.uploaded.getTime()}"`,
    httpEtag: `"${object.bytes.byteLength}-${object.uploaded.getTime()}"`,
    customMetadata: object.meta,
    httpMetadata: { contentType: object.contentType },
    writeHttpMetadata(headers: Headers) {
      if (object.contentType) headers.set('content-type', object.contentType);
    },
  });
  const bucket = {
    objects,
    gets: 0,
    async head(key: string) {
      if (options.failReads) throw new Error('r2 unavailable');
      const object = objects.get(key);
      return object ? meta(key, object) : null;
    },
    async get(key: string) {
      bucket.gets += 1;
      if (options.failReads) throw new Error('r2 unavailable');
      const object = objects.get(key);
      if (!object) return null;
      return {
        ...meta(key, object),
        body: new Response(object.bytes.slice()).body,
        arrayBuffer: async () => object.bytes.slice().buffer,
      };
    },
    async put(
      key: string,
      value: Uint8Array,
      opts: { httpMetadata?: { contentType?: string }; customMetadata?: Record<string, string> } = {},
    ) {
      objects.set(key, {
        bytes: new Uint8Array(value),
        contentType: opts.httpMetadata?.contentType,
        meta: opts.customMetadata ?? {},
        uploaded: new Date(),
      });
    },
    async list({ prefix, include }: { prefix: string; include?: string[] }) {
      const withMeta = include?.includes('customMetadata') ?? false;
      return {
        objects: [...objects.entries()]
          .filter(([key]) => key.startsWith(prefix))
          .map(([key, object]) => (withMeta ? { key, customMetadata: object.meta } : { key })),
      };
    },
    async delete(keys: string | string[]) {
      for (const key of Array.isArray(keys) ? keys : [keys]) objects.delete(key);
    },
  };
  return bucket as unknown as FakeBucket;
}

export const FAKE_MP4 = new Uint8Array([0, 0, 0, 24, 0x66, 0x74, 0x79, 0x70, 0x69, 0x73, 0x6f, 0x6d]);

export type MediaCall = { input: Uint8Array; transform: unknown; output: unknown };

export type FakeMedia = MediaBinding & { calls: MediaCall[] };

/** A Media binding that returns FAKE_MP4, or throws `fail` from the output step the way the binding reports errors. */
export function fakeMedia(fail?: { code: number; message: string }): FakeMedia {
  const calls: MediaCall[] = [];
  const media = {
    calls,
    input(stream: ReadableStream<Uint8Array>) {
      const call: MediaCall = { input: new Uint8Array(), transform: undefined, output: undefined };
      const generator = {
        output(output: unknown) {
          call.output = output;
          return {
            async response() {
              call.input = new Uint8Array(await new Response(stream).arrayBuffer());
              calls.push(call);
              if (fail) throw Object.assign(new Error(fail.message), { code: fail.code });
              return new Response(FAKE_MP4, { headers: { 'content-type': 'video/mp4' } });
            },
          };
        },
      };
      return {
        transform(transform: unknown) {
          call.transform = transform;
          return generator;
        },
        output: generator.output,
      };
    },
  };
  return media as unknown as FakeMedia;
}

export type FakeQueue = Queue<OgRenderedMessage> & { sent: OgRenderedMessage[] };

export function fakeQueue(): FakeQueue {
  const sent: OgRenderedMessage[] = [];
  return {
    sent,
    async send(message: OgRenderedMessage) {
      sent.push(message);
    },
  } as unknown as FakeQueue;
}

export type FakeDoState = {
  alarm: number | null;
  values: Map<string, unknown>;
  storage: {
    get<T>(key: string): Promise<T | undefined>;
    put(key: string, value: unknown): Promise<void>;
    setAlarm(at: number): Promise<void>;
    getAlarm(): Promise<number | null>;
    deleteAlarm(): Promise<void>;
    deleteAll(): Promise<void>;
  };
};

/**
 * Durable Object state over a Map. Values round-trip through structuredClone, as storage does. deleteAll clears the
 * alarm with the data, as it does from compatibility date 2026-02-24 on.
 */
export function fakeDoState(): FakeDoState {
  const values = new Map<string, unknown>();
  const state: FakeDoState = {
    alarm: null,
    values,
    storage: {
      async get<T>(key: string) {
        const value = values.get(key);
        return value === undefined ? undefined : (structuredClone(value) as T);
      },
      async put(key: string, value: unknown) {
        values.set(key, structuredClone(value));
      },
      async setAlarm(at: number) {
        state.alarm = at;
      },
      async getAlarm() {
        return state.alarm;
      },
      async deleteAlarm() {
        state.alarm = null;
      },
      async deleteAll() {
        values.clear();
        state.alarm = null;
      },
    },
  };
  return state;
}
