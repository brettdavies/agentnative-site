// Drawn cards persist in SCORE_CACHE under og/score/<sha256(target)>/, one
// object per finished-score key, so an edge miss reads the PNG instead of
// drawing it again. Storing a key deletes the target's other keys: a rescore
// moves the page to a new key, and the card it replaced has no reader left.
// The og-30day-ttl lifecycle rule (RELEASES.md) bounds whatever remains.

import { sha256Hex } from '../audit-web/cache';

export const STORED_CARD_PREFIX = 'og/score/';

async function targetPrefix(target: string): Promise<string> {
  return `${STORED_CARD_PREFIX}${await sha256Hex(target)}/`;
}

/** The stored PNG for this target and key, or null when none is stored. */
export async function readStoredCard(bucket: R2Bucket, target: string, key: string): Promise<Uint8Array | null> {
  const object = await bucket.get(`${await targetPrefix(target)}${key}.png`);
  if (!object) return null;
  return new Uint8Array(await object.arrayBuffer());
}

/** Store the card, then delete every other card stored for the same target. */
export async function storeCard(bucket: R2Bucket, target: string, key: string, png: Uint8Array): Promise<void> {
  const prefix = await targetPrefix(target);
  const name = `${prefix}${key}.png`;
  await bucket.put(name, png, { httpMetadata: { contentType: 'image/png' }, customMetadata: { target, key } });
  const listed = await bucket.list({ prefix });
  const stale = listed.objects.map((object) => object.key).filter((objectKey) => objectKey !== name);
  if (stale.length > 0) await bucket.delete(stale);
}
