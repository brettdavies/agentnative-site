// Drawn cards persist in SCORE_CACHE under og/score/<sha256(target)>/, one
// object per finished-score key, so an edge miss reads the PNG instead of
// drawing it again. Storing a key deletes the target's cards scored before
// it: a rescore moves the page to a new key, and the card it replaced has no
// reader left. Only older cards go, because two stores can finish out of
// order. The og-30day-ttl lifecycle rule (RELEASES.md) bounds whatever
// remains.

import { sha256Hex } from '../audit-web/cache';
import { LOGO_SOURCES, type LogoSource } from './find-logo';

export const STORED_CARD_PREFIX = 'og/score/';

export type StoredCardMeta = { scoredAt: string | null; logo: LogoSource };

export type StoredCard = { png: Uint8Array; logo: LogoSource | null };

async function targetPrefix(target: string): Promise<string> {
  return `${STORED_CARD_PREFIX}${await sha256Hex(target)}/`;
}

/** The stored PNG and the logo source it was drawn with, or null when none is stored. */
export async function readStoredCard(bucket: R2Bucket, target: string, key: string): Promise<StoredCard | null> {
  const object = await bucket.get(`${await targetPrefix(target)}${key}.png`);
  if (!object) return null;
  const logo = object.customMetadata?.logo;
  return {
    png: new Uint8Array(await object.arrayBuffer()),
    logo: LOGO_SOURCES.find((source) => source === logo) ?? null,
  };
}

/** Store the card, then delete the target's cards scored before it. */
export async function storeCard(
  bucket: R2Bucket,
  target: string,
  key: string,
  png: Uint8Array,
  meta: StoredCardMeta,
): Promise<void> {
  const prefix = await targetPrefix(target);
  const name = `${prefix}${key}.png`;
  const customMetadata: Record<string, string> = { target, key, logo: meta.logo };
  if (meta.scoredAt) customMetadata.scored_at = meta.scoredAt;
  await bucket.put(name, png, { httpMetadata: { contentType: 'image/png' }, customMetadata });
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
