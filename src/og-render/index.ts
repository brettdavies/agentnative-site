// anc-og-render: the Worker that draws every scorecard card and clip. The
// site Worker reaches it only through this RPC entrypoint over its RENDER
// service binding; it serves no public route. Drawing runs here, apart from
// the site, because one isolate serves its requests on a single thread and
// seconds of rendering there would stall pages.

import { WorkerEntrypoint } from 'cloudflare:workers';
import type { DrawnCard, RenderInputs, RenderJobStatus, RenderService } from '../shared/og-render';
import { drawCard } from './draw-card';
import type { RenderEnv } from './render-job';
import type { RenderJob } from './render-job-do';

export { RenderJob } from './render-job-do';

/** Spacing between the alarms of one batch, so a curated pass starts its renders over a minute, not at once. */
const BATCH_ALARM_SPACING_MS = 400;

export default class OgRender extends WorkerEntrypoint<RenderEnv> implements RenderService {
  async request(inputs: RenderInputs): Promise<RenderJobStatus> {
    return this.job(inputs.target, inputs.key).request(inputs);
  }

  async requestMany(inputs: RenderInputs[]): Promise<RenderJobStatus[]> {
    return Promise.all(
      inputs.map((input, index) => this.job(input.target, input.key).request(input, index * BATCH_ALARM_SPACING_MS)),
    );
  }

  async status(target: string, key: string): Promise<RenderJobStatus> {
    return this.job(target, key).status();
  }

  async drawCard(inputs: RenderInputs): Promise<DrawnCard> {
    return drawCard(this.env, inputs, this.job(inputs.target, inputs.key));
  }

  private job(target: string, key: string): DurableObjectStub<RenderJob> {
    return this.env.RENDER_JOB.get(this.env.RENDER_JOB.idFromName(`${target}:${key}`));
  }
}
