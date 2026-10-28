// Cards and clips persist in SCORE_CACHE, one object per finished-score key:
// the PNG under og/score/<sha256(target)>/<key>.png and the clip under
// og/clip/<sha256(target)>/<key>.mp4. Storing a key deletes the target's
// objects of the same kind scored before it: a rescore moves the page to a
// new key, and the object it replaced has no reader left. Only older ones
// go, because two stores can finish out of order. The og-30day-ttl
// lifecycle rule (RELEASES.md) bounds whatever remains.

import { LOGO_SOURCES, type LogoSource } from '../../shared/og-render';
import { SCORE_OG_TEMPLATE } from '../../shared/score-og';
import { sha256Hex } from '../audit-web/cache';

type StoredKind = { prefix: string; ext: string; contentType: string };

const CARD: StoredKind = { prefix: 'og/score/', ext: '.png', contentType: 'image/png' };
const CLIP: StoredKind = { prefix: 'og/clip/', ext: '.mp4', contentType: 'video/mp4' };

export const STORED_CARD_PREFIX = CARD.prefix;
export const STORED_CLIP_PREFIX = CLIP.prefix;

export type StoredMeta = { scoredAt: string | null; logo: LogoSource };

export type StoredCard = { png: Uint8Array; logo: LogoSource | null };

async function targetPrefix(kind: StoredKind, target: string): Promise<string> {
  return `${kind.prefix}${await sha256Hex(target)}/`;
}

async function objectKey(kind: StoredKind, target: string, key: string): Promise<string> {
  return `${await targetPrefix(kind, target)}${key}${kind.ext}`;
}

/** The logo source a stored object's metadata names, or null when it names none. */
export function storedLogo(object: { customMetadata?: Record<string, string> }): LogoSource | null {
  const logo = object.customMetadata?.logo;
  return LOGO_SOURCES.find((source) => source === logo) ?? null;
}

/** The stored PNG and the logo source it was drawn with, or null when none is stored. */
export async function readStoredCard(bucket: R2Bucket, target: string, key: string): Promise<StoredCard | null> {
  const object = await bucket.get(await objectKey(CARD, target, key));
  if (!object) return null;
  return { png: new Uint8Array(await object.arrayBuffer()), logo: storedLogo(object) };
}

/** The stored clip's metadata without its body, or null when none is stored. */
export async function headClip(bucket: R2Bucket, target: string, key: string): Promise<R2Object | null> {
  return bucket.head(await objectKey(CLIP, target, key));
}

/** Store the card, then delete the target's cards scored before it. */
export function storeCard(bucket: R2Bucket, target: string, key: string, png: Uint8Array, meta: StoredMeta) {
  return storeObject(CARD, bucket, target, key, png, meta);
}

/** Store the clip, then delete the target's clips scored before it. */
export function storeClip(bucket: R2Bucket, target: string, key: string, mp4: Uint8Array, meta: StoredMeta) {
  return storeObject(CLIP, bucket, target, key, mp4, meta);
}

async function storeObject(
  kind: StoredKind,
  bucket: R2Bucket,
  target: string,
  key: string,
  bytes: Uint8Array,
  meta: StoredMeta,
): Promise<void> {
  const prefix = await targetPrefix(kind, target);
  const name = `${prefix}${key}${kind.ext}`;
  const customMetadata: Record<string, string> = {
    target,
    key,
    logo: meta.logo,
    template: String(SCORE_OG_TEMPLATE),
  };
  if (meta.scoredAt) customMetadata.scored_at = meta.scoredAt;
  await bucket.put(name, bytes, { httpMetadata: { contentType: kind.contentType }, customMetadata });
  const scoredAt = scoredAtMs(meta.scoredAt);
  if (scoredAt === null) return;
  const listed = await bucket.list({ prefix, include: ['customMetadata'] });
  const older = listed.objects
    .filter((object) => object.key !== name)
    .filter((object) => (scoredAtMs(object.customMetadata?.scored_at) ?? Number.NEGATIVE_INFINITY) < scoredAt)
    .map((object) => object.key);
  if (older.length > 0) await bucket.delete(older);
}

function scoredAtMs(stamp: string | null | undefined): number | null {
  if (!stamp) return null;
  const ms = Date.parse(stamp);
  return Number.isNaN(ms) ? null : ms;
}
