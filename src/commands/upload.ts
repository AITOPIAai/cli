import { withSession, type Context } from '../context.js';
import { CliError, UsageError, toCliError } from '../errors.js';
import { inFlight } from '../interrupt.js';
import { allowHttpLoopback, settle } from '../results.js';
import { uploadSource, type UploadResult } from '../upload.js';

/**
 * Uploads each source in turn. A failed one does not stop the others; the
 * command then exits with the first failure's code, and --json still lists
 * every upload that worked.
 */
export async function uploadCommand(ctx: Context, sources: string[]): Promise<void> {
  if (sources.length === 0) throw new UsageError('Give at least one file or URL to upload.');
  const { out } = ctx;
  await withSession(ctx, async (session) => {
    const results: UploadResult[] = [];
    const failures: Array<{ source: string; error: CliError }> = [];
    for (const source of sources) {
      if (!out.jsonMode) out.note(`Uploading ${source}...`);
      try {
        const result = await inFlight(() =>
          uploadSource(session.callTool, source, {
            wait: (o) => settle(ctx, session, o, `Importing ${source}`),
            allowHttpLoopback: allowHttpLoopback(ctx.serverUrl),
          }),
        );
        results.push(result);
        if (!out.jsonMode) out.line(result.assetUrl);
      } catch (error) {
        const cliError = toCliError(error, ctx.serverUrl);
        // Signing in again or buying credits applies to all: stop here.
        if (cliError.exitCode === 3 || cliError.exitCode === 4) throw withUploads(cliError, results);
        failures.push({ source, error: cliError });
        if (!out.jsonMode) out.note(out.err.red(`Failed: ${source}: ${cliError.message}`));
      }
    }
    const uploads = results.map((r) => ({ source: r.source, assetUrl: r.assetUrl, ...(r.fileName ? { fileName: r.fileName } : {}) }));
    const firstFailure = failures[0];
    if (!firstFailure) {
      if (out.jsonMode) out.json({ status: 'completed', uploads });
      return;
    }
    const summary = `${failures.length} of ${sources.length} uploads failed.`;
    throw new CliError(summary, firstFailure.error.exitCode, {
      code: firstFailure.error.code,
      hint: firstFailure.error.hint,
      notes: failures.map((f) => `${f.source}: ${f.error.message}`),
      data: {
        status: results.length > 0 ? 'partial' : 'failed',
        uploads,
        failed: failures.map((f) => ({ source: f.source, code: f.error.code, error: f.error.message })),
      },
    });
  });
}

function withUploads(error: CliError, results: UploadResult[]): CliError {
  Object.assign(error.data, { uploads: results.map((r) => ({ source: r.source, assetUrl: r.assetUrl })) });
  return error;
}
