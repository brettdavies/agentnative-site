// The og-rendered consumer: the render Worker stored a clip, so the page that
// should now name it is purged and its next fetch carries og:video. Purge
// works only inside the cached entrypoint, which invokeCachedPurge reaches
// through ctx.exports. A failed purge is logged there and the page refreshes
// at its own TTL, so every message is acknowledged.

import type { OgRenderedMessage } from '../../shared/og-render';
import { invokeCachedPurge, type PurgeCtx } from '../audit-web/hit-min-purge';
import { resultTag } from '../audit-web/hit-min-tags';

export async function handleOgRendered(batch: MessageBatch<OgRenderedMessage>, ctx: PurgeCtx): Promise<void> {
  for (const message of batch.messages) {
    await invokeCachedPurge(ctx, [resultTag(message.body.lane, message.body.target)]);
    message.ack();
  }
}
