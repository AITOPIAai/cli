import { withSession, type Context } from '../context.js';
import { confirmAction, notConfirmed } from '../confirm.js';
import { UsageError, failureToError } from '../errors.js';
import { isFailed } from '../envelope.js';
import { renderTable } from '../output.js';
import { resolveVoice } from '../resolve.js';
import { allowHttpLoopback, deliver, deliverEstimate, settle, startActivity, type DeliverOptions } from '../results.js';
import { assertLocalFile, isRemoteUrl, uploadSource } from '../upload.js';
import { paidCall } from './generate.js';
import { shortDate } from './projects.js';

/** What one clone costs (billed by AITOPIA; the --dry-run shows the live price). */
export const VOICE_CLONE_CREDITS = 150;

export const CONSENT_TEXT =
  'Cloning needs --consent: it confirms that the recording is your own voice, or that the speaker gave you permission to clone it. Never clone anyone else (no celebrities or public figures), and never use a voice to impersonate or deceive.';

function str(value: unknown): string {
  return typeof value === 'string' ? value : value === null || value === undefined ? '' : String(value);
}

/** aitopia voices [list]: your cloned voices. */
export async function voicesListCommand(ctx: Context): Promise<void> {
  await withSession(ctx, async (session) => {
    const outcome = await session.callTool('list_voices', {});
    if (isFailed(outcome)) throw failureToError(outcome.payload);
    const { out } = ctx;
    if (out.jsonMode) {
      out.json(outcome.payload);
      return;
    }
    const voices = Array.isArray(outcome.payload.voices) ? outcome.payload.voices.filter((v): v is Record<string, unknown> => Boolean(v) && typeof v === 'object') : [];
    if (voices.length === 0) {
      out.line('No voices yet. Clone your own with: aitopia voices create "My voice" sample.mp3 --consent');
      return;
    }
    const rows = [['NAME', 'STATE', 'CREATED', 'LAST USED', 'ID', 'NOTE']];
    for (const v of voices) {
      const note = v.mayHaveExpired === true ? 'may have expired (never used for speech in 7 days)' : v.state === 'cloning' ? 'still being created' : '';
      rows.push([str(v.name), str(v.state), shortDate(v.createdAt), v.lastUsedAt ? shortDate(v.lastUsedAt) : 'never', str(v.voiceId), note]);
    }
    for (const row of renderTable(rows, [30, 8, 10, 10, 36])) out.line(row);
    if (voices.some((v) => v.mayHaveExpired === true)) {
      out.note(`A voice that expired at the provider can be re-created from its stored sample: aitopia voices create <name> --consent (${VOICE_CLONE_CREDITS} credits).`);
    }
    out.note('Speak with one: aitopia audio "Hello there." --voice <name>');
  });
}

export interface VoicesCreateOptions extends DeliverOptions {
  consent?: boolean;
  /** Re-create a voice that is ready without asking (it costs again). */
  yes?: boolean;
  language?: string;
  dryRun?: boolean;
}

/** An AITOPIA-hosted file is passed as is; any other URL is imported first (create_voice takes only your own uploads). */
function isAitopiaUrl(url: string): boolean {
  try {
    const host = new URL(url).hostname.toLowerCase();
    return host === 'aitopia.ai' || host.endsWith('.aitopia.ai');
  } catch {
    return false;
  }
}

/**
 * aitopia voices create <name> [sample] --consent: clones a voice from a
 * recording (a local file is uploaded first). Without a sample, <name> must be
 * one of your voices: a voice still being created is finished (no new charge),
 * an expired one is re-created from its stored sample.
 */
export async function voicesCreateCommand(ctx: Context, name: string, sample: string | undefined, options: VoicesCreateOptions): Promise<void> {
  if (!options.consent) throw new UsageError(CONSENT_TEXT, 'Add --consent only when that is true.');
  if (!name.trim()) throw new UsageError('Give the voice a name, e.g. aitopia voices create "My voice" sample.mp3 --consent.');
  if (sample !== undefined && !isRemoteUrl(sample)) assertLocalFile(sample);
  const { out } = ctx;

  await withSession(ctx, async (session) => {
    const args: Record<string, unknown> = { consent: true };
    let label = `Creating the voice "${name.trim()}"`;
    if (sample === undefined) {
      // Without a sample: finish a voice still being created (free), or re-create
      // one from its stored sample (charged again). A ready voice that has not
      // been flagged as expired is re-created only after a yes (or --yes).
      const voice = await resolveVoice(session, name);
      args.voiceId = voice.id;
      if (voice.state === 'cloning') {
        label = `Finishing the voice "${voice.name}"`;
        if (!out.jsonMode) out.note('It is still being created; finishing it is not charged again.');
      } else {
        label = `Re-creating the voice "${voice.name}"`;
        const expired = voice.mayHaveExpired === true || voice.state === 'expired';
        if (!expired && !options.dryRun) {
          const ok = await confirmAction(
            ctx,
            {
              question: `The voice "${voice.name}" is ready and does not look expired. Re-create it from its stored sample for ${VOICE_CLONE_CREDITS} credits?`,
              action: `re-create the ready voice "${voice.name}" (${VOICE_CLONE_CREDITS} credits)`,
            },
            options.yes,
          );
          if (!ok) throw notConfirmed('Not re-created.');
        }
        if (!options.dryRun) out.note(`${label} from its stored sample (${VOICE_CLONE_CREDITS} credits)...`);
      }
    } else {
      let sampleUrl = sample;
      if (!isRemoteUrl(sample) || !isAitopiaUrl(sample)) {
        // The sample must be your own upload, also for --dry-run (uploading is free).
        if (!out.jsonMode) out.note(`Uploading ${sample}...`);
        sampleUrl = (
          await uploadSource(session.callTool, sample, {
            wait: (o) => settle(ctx, session, o, `Importing ${sample}`),
            allowHttpLoopback: allowHttpLoopback(ctx.serverUrl),
          })
        ).assetUrl;
      }
      args.name = name.trim();
      args.sampleUrl = sampleUrl;
      if (options.language) args.language = options.language;
    }
    if (options.dryRun) args.dryRun = true;
    if (!options.dryRun && sample !== undefined) out.note(`${label} (${VOICE_CLONE_CREDITS} credits)...`);

    const activity = startActivity(ctx, options.dryRun ? 'Checking the price' : label);
    try {
      const first = await paidCall(options.dryRun, () => session.callTool('create_voice', args, { ...activity.callOptions, paid: !options.dryRun }));
      if (options.dryRun) {
        activity.stop();
        deliverEstimate(ctx, first);
        return;
      }
      const done = await settle(ctx, session, first, label, activity);
      const p = done.payload;
      const voiceName = str(p.name) || name.trim();
      if (!out.jsonMode) {
        if (p.alreadyExists === true) out.line(`The voice "${voiceName}" already exists; nothing was charged.`);
        else out.line(`${out.out.green('Ready:')} the voice "${voiceName}"${p.recreated === true ? ' was re-created' : ''} (${str(p.voiceId)})`);
        if (typeof p.previewUrl === 'string' && p.previewUrl) out.line(`Preview: ${p.previewUrl}`);
        if (typeof p.warning === 'string') out.warn(p.warning);
      }
      await deliver(ctx, done, options, { prompt: `${voiceName} preview` });
      if (!out.jsonMode) {
        out.line(`Speak with it: aitopia audio "Hello there." --voice "${voiceName}"`);
        out.note('Use it for speech soon: the voice provider removes a cloned voice that is never used within about 7 days.');
      }
    } finally {
      activity.stop();
    }
  });
}

/** aitopia voices delete <name|id> [--yes] [--force]. */
export async function voicesDeleteCommand(ctx: Context, ref: string, options: { yes?: boolean; force?: boolean }): Promise<void> {
  await withSession(ctx, async (session) => {
    const voice = await resolveVoice(session, ref);
    const cloning = voice.state === 'cloning';
    const ok = await confirmAction(
      ctx,
      {
        question: `Delete the voice "${voice.name}"?${cloning ? ' It is still being created; that result will be lost.' : ''} It cannot be used again afterwards.`,
        action: `delete the voice "${voice.name}"`,
      },
      options.yes,
    );
    if (!ok) throw notConfirmed('Not deleted.');
    const args: Record<string, unknown> = { voiceId: voice.id };
    if (options.force) args.force = true;
    const outcome = await session.callTool('delete_voice', args);
    if (isFailed(outcome)) throw failureToError(outcome.payload);
    const { out } = ctx;
    if (out.jsonMode) {
      out.json(outcome.payload);
      return;
    }
    out.line(`${out.out.green('Deleted')} the voice "${voice.name}".`);
    out.note("The voice provider's own copy cannot be deleted from AITOPIA and may remain there until it expires.");
  });
}
