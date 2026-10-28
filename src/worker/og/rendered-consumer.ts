// The og-rendered consumer: the render Worker stored a clip, so the page that
// should now name it is purged and its next fetch carries og:video. Purge
// works only inside the cached entrypoint, which invokeCachedPurge reaches
// through ctx.exports.
//
// Workers Cache purges run at Cloudflare's Free-tier rate whatever the plan:
// 5 requests a minute with a burst of 25, at most 100 tags each, shared with
// every other purge on the account
// (https://developers.cloudflare.com/workers/cache/purge/). A curated pass
// lands about 150 clips in a minute, so one batch's tags go out in as few
// purge calls as the tag limit allows. A refused purge retries its messages
// after a delay instead of acknowledging them: a minute refills 5 purges, and
// the delays add up to 15 minutes, a full bucket three times over. On the
// last attempt the message is acknowledged and logged as given up, and the
// page names its clip once its cached copy expires (300 s for a live result,
// a day for a curated page).

import type { OgRenderedMessage } from '../../shared/og-render';
import { invokeCachedPurge, type PurgeCtx } from '../audit-web/hit-min-purge';
import { resultTag } from '../audit-web/hit-min-tags';
import { emitLog } from '../telemetry/log';

/** One purge call's tag limit, and so the consumer's batch size in wrangler.jsonc. */
export const OG_RENDERED_PURGE_TAG_LIMIT = 100;

/** Deliveries before a refused purge gives up; wrangler.jsonc retries one fewer time. */
export const OG_RENDERED_MAX_ATTEMPTS = 6;

const RETRY_STEP_SECONDS = 60;

type RenderedMessage = Message<OgRenderedMessage>;

export async function handleOgRendered(batch: MessageBatch<OgRenderedMessage>, ctx: PurgeCtx): Promise<void> {
  const byTag = new Map<string, RenderedMessage[]>();
  for (const message of batch.messages) {
    const tag = resultTag(message.body.lane, message.body.target);
    byTag.set(tag, [...(byTag.get(tag) ?? []), message]);
  }
  const tags = [...byTag.keys()];
  for (let start = 0; start < tags.length; start += OG_RENDERED_PURGE_TAG_LIMIT) {
    const chunk = tags.slice(start, start + OG_RENDERED_PURGE_TAG_LIMIT);
    const purged = await invokeCachedPurge(ctx, chunk);
    for (const tag of chunk) {
      for (const message of byTag.get(tag) ?? []) settle(message, tag, purged);
    }
  }
}

function settle(message: RenderedMessage, tag: string, purged: boolean): void {
  if (purged) {
    message.ack();
  } else if (message.attempts >= OG_RENDERED_MAX_ATTEMPTS) {
    emitLog({ scope: 'hit-min-purge' }, { error: 'og_rendered_gave_up', tags: [tag], attempts: message.attempts });
    message.ack();
  } else {
    message.retry({ delaySeconds: RETRY_STEP_SECONDS * message.attempts });
  }
}
