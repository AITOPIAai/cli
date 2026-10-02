import { withSession, type Context } from '../context.js';
import { confirmAction, notConfirmed } from '../confirm.js';
import { CliError, EXIT, UsageError, failureToError } from '../errors.js';
import { isFailed, type ToolOutcome } from '../envelope.js';
import type { Session } from '../mcp.js';
import { renderTable } from '../output.js';
import { findProject, resolveFolder, resolveProject, type Named } from '../resolve.js';
import { isRemoteUrl } from '../upload.js';

export const PROJECT_MEDIA_TYPES = ['image', 'video', 'audio', 'file'];
/** Most files one move_assets call takes. */
export const MAX_MOVE = 100;

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function str(value: unknown): string {
  return typeof value === 'string' ? value : value === null || value === undefined ? '' : String(value);
}

function objects(value: unknown): Array<Record<string, unknown>> {
  return Array.isArray(value) ? value.filter(isObject) : [];
}

/** "2026-10-01" from an ISO time (as is when it does not parse). */
export function shortDate(value: unknown): string {
  const text = str(value);
  return /^\d{4}-\d{2}-\d{2}T/.test(text) ? text.slice(0, 10) : text;
}

async function call(session: Session, tool: string, args: Record<string, unknown>): Promise<ToolOutcome> {
  const outcome = await session.callTool(tool, args);
  if (isFailed(outcome)) throw failureToError(outcome.payload);
  return outcome;
}

function pagingNote(ctx: Context, payload: Record<string, unknown>, shown: number, noun: string): void {
  const next = payload.nextOffset;
  if (typeof next !== 'number') return;
  const total = typeof payload.total === 'number' ? ` of ${payload.total}` : '';
  ctx.out.note(`Showing ${shown}${total} ${noun}. Next page: --offset ${next}`);
}

export interface ProjectsListOptions {
  limit?: number;
  offset?: number;
}

/** aitopia projects [list]: name, file count, id and link of each project (newest first). */
export async function projectsListCommand(ctx: Context, options: ProjectsListOptions): Promise<void> {
  await withSession(ctx, async (session) => {
    const args: Record<string, unknown> = {};
    if (options.limit !== undefined) args.limit = options.limit;
    if (options.offset !== undefined) args.offset = options.offset;
    const { payload } = await call(session, 'list_projects', args);
    const { out } = ctx;
    if (out.jsonMode) {
      out.json(payload);
      return;
    }
    const projects = objects(payload.projects);
    if (projects.length === 0) {
      out.line(options.offset ? 'No more projects.' : 'No projects yet. Make one with: aitopia projects create "<name>"');
      return;
    }
    const rows = [['NAME', 'FILES', 'ID', 'LINK']];
    for (const p of projects) rows.push([str(p.name), str(p.assetCount), str(p.id), str(p.openInAitopia)]);
    for (const row of renderTable(rows, [40, 6, 36])) out.line(row);
    pagingNote(ctx, payload, projects.length, 'projects');
  });
}

/** aitopia projects create <name> [--description]. */
export async function projectsCreateCommand(ctx: Context, name: string, options: { description?: string }): Promise<void> {
  if (!name.trim()) throw new UsageError('Give the project a name, e.g. aitopia projects create "Spring campaign".');
  await withSession(ctx, async (session) => {
    const args: Record<string, unknown> = { name: name.trim() };
    if (options.description !== undefined) args.description = options.description;
    const { payload } = await call(session, 'create_project', args);
    const { out } = ctx;
    if (out.jsonMode) {
      out.json(payload);
      return;
    }
    const project = isObject(payload.project) ? payload.project : {};
    out.line(`${out.out.green('Created')} project "${str(project.name) || name.trim()}" (${str(project.id)})`);
    if (typeof payload.openInAitopia === 'string') out.line(`${out.out.dim('Open in AITOPIA:')} ${payload.openInAitopia}`);
    out.note(`Save new results there with --project "${str(project.name) || name.trim()}" on image, video, audio, edit or batch.`);
  });
}

export interface ProjectsShowOptions {
  folder?: string;
  type?: string;
  limit?: number;
  offset?: number;
}

/** "Stills" or "Stills / Close-ups": a folder's path from the project root. */
function folderPath(folders: Array<Named & { parentFolderId?: string | null }>, id: string | null | undefined): string {
  const byId = new Map(folders.map((f) => [f.id, f]));
  const parts: string[] = [];
  let current = id ? byId.get(id) : undefined;
  for (let guard = 0; current && guard < 20; guard++) {
    parts.unshift(current.name);
    current = current.parentFolderId ? byId.get(current.parentFolderId) : undefined;
  }
  return parts.join(' / ');
}

/** aitopia projects show <project> [--folder] [--type]: the project's folders and files. */
export async function projectsShowCommand(ctx: Context, ref: string, options: ProjectsShowOptions): Promise<void> {
  await withSession(ctx, async (session) => {
    const project = await resolveProject(session, ref);
    const folder = options.folder !== undefined ? await resolveFolder(session, project, options.folder) : undefined;
    const args: Record<string, unknown> = { projectId: project.id };
    if (folder) args.folderId = folder.id;
    if (options.type) args.mediaType = options.type;
    if (options.limit !== undefined) args.limit = options.limit;
    if (options.offset !== undefined) args.offset = options.offset;
    const { payload } = await call(session, 'list_project_assets', args);
    const { out } = ctx;
    if (out.jsonMode) {
      out.json(payload);
      return;
    }
    const folders = objects(payload.folders).map((f) => ({ id: str(f.id), name: str(f.name), parentFolderId: str(f.parentFolderId) || null }));
    const assets = objects(payload.assets);
    const total = typeof payload.total === 'number' ? payload.total : assets.length;
    const where = folder ? `${project.name} / ${folderPath(folders, folder.id) || folder.name}` : project.name;
    out.line(`${out.out.bold(where)}  ${total} file${total === 1 ? '' : 's'}${options.type ? ` (${options.type})` : ''}`);
    if (!folder && folders.length > 0) {
      out.line('');
      out.line('Folders:');
      const rows = [['NAME', 'ID']];
      for (const f of folders) rows.push([folderPath(folders, f.id), f.id]);
      for (const row of renderTable(rows, [50])) out.line(`  ${row}`);
    }
    out.line('');
    if (assets.length === 0) {
      out.line(options.offset ? 'No more files.' : 'No files here yet.');
    } else {
      const rows = [['NAME', 'TYPE', 'FOLDER', 'CREATED', 'URL']];
      for (const a of assets) {
        rows.push([str(a.name), str(a.mediaType), folderPath(folders, str(a.folderId) || null) || '-', shortDate(a.createdAt), str(a.assetUrl)]);
      }
      for (const row of renderTable(rows, [40, 5, 24, 10])) out.line(row);
      pagingNote(ctx, payload, assets.length, 'files');
    }
    if (typeof payload.openInAitopia === 'string') out.line(`${out.out.dim('Open in AITOPIA:')} ${payload.openInAitopia}`);
  });
}

/** aitopia projects folder <project> <name> [--parent]: a new folder (inside --parent when given). */
export async function projectsFolderCommand(ctx: Context, ref: string, name: string, options: { parent?: string }): Promise<void> {
  if (!name.trim()) throw new UsageError('Give the folder a name, e.g. aitopia projects folder "Spring campaign" Stills.');
  await withSession(ctx, async (session) => {
    const project = await resolveProject(session, ref);
    const parent = options.parent !== undefined ? await resolveFolder(session, project, options.parent) : undefined;
    const args: Record<string, unknown> = { projectId: project.id, name: name.trim() };
    if (parent) args.parentFolderId = parent.id;
    const { payload } = await call(session, 'create_folder', args);
    const { out } = ctx;
    if (out.jsonMode) {
      out.json(payload);
      return;
    }
    const created = isObject(payload.folder) ? payload.folder : {};
    const path = parent ? `${parent.name} / ${name.trim()}` : name.trim();
    out.line(`${out.out.green('Created')} folder "${path}" in "${project.name}" (${str(created.id)})`);
    if (typeof payload.openInAitopia === 'string') out.line(`${out.out.dim('Open in AITOPIA:')} ${payload.openInAitopia}`);
  });
}

export interface ProjectsMoveOptions {
  to?: string;
  folder?: string;
  /** --out: take the files out of any project. */
  out?: boolean;
}

/** Splits move targets into asset URLs and asset ids. */
export function moveTargets(items: string[]): { assetUrls: string[]; assetIds: string[] } {
  const assetUrls: string[] = [];
  const assetIds: string[] = [];
  for (const raw of items) {
    const item = raw.trim();
    if (!item) continue;
    if (isRemoteUrl(item)) assetUrls.push(item);
    else if (/^[A-Za-z0-9_-]{8,}$/.test(item)) assetIds.push(item);
    else {
      throw new UsageError(
        `"${item}" is not an asset URL or id.`,
        'Pass the https URL of a file in AITOPIA (from `aitopia projects show` or a result), or its id. Local files: `aitopia upload` them first.',
      );
    }
  }
  return { assetUrls, assetIds };
}

/** aitopia projects move <asset...> --to <project> [--folder] | --out. */
export async function projectsMoveCommand(ctx: Context, items: string[], options: ProjectsMoveOptions): Promise<void> {
  if (options.out && options.to !== undefined) throw new UsageError('Use either --to <project> or --out, not both.');
  if (!options.out && options.to === undefined) {
    throw new UsageError('Say where the files go: --to <project> (and --folder), or --out to take them out of their project.');
  }
  if (options.out && options.folder !== undefined) throw new UsageError('--folder goes with --to, not with --out.');
  const { assetUrls, assetIds } = moveTargets(items);
  const count = assetUrls.length + assetIds.length;
  if (count === 0) throw new UsageError('Give at least one file URL or id to move.');
  if (count > MAX_MOVE) throw new UsageError(`At most ${MAX_MOVE} files can be moved at once; got ${count}.`);
  await withSession(ctx, async (session) => {
    let project: Named | undefined;
    let folder: Named | undefined;
    if (options.to !== undefined) {
      project = await resolveProject(session, options.to);
      if (options.folder !== undefined) folder = await resolveFolder(session, project, options.folder);
    }
    const args: Record<string, unknown> = { projectId: project ? project.id : null };
    if (assetUrls.length > 0) args.assetUrls = assetUrls;
    if (assetIds.length > 0) args.assetIds = assetIds;
    if (folder) args.folderId = folder.id;
    const { payload } = await call(session, 'move_assets', args);
    const { out } = ctx;
    const moved = typeof payload.moved === 'number' ? payload.moved : objects(payload.assets).length;
    const notFound = Array.isArray(payload.notFound) ? payload.notFound.map(str) : [];
    const where = project ? `"${project.name}"${folder ? ` / "${folder.name}"` : ''}` : 'out of their project (they stay in Creations)';
    if (!out.jsonMode) {
      out.line(`${moved > 0 ? out.out.green('Moved') : 'Moved'} ${moved} file${moved === 1 ? '' : 's'} ${project ? `to ${where}` : where}.`);
      for (const missing of notFound) out.note(out.err.red(`Not found: ${missing}`));
      if (typeof payload.openInAitopia === 'string') out.line(`${out.out.dim('Open in AITOPIA:')} ${payload.openInAitopia}`);
    }
    if (notFound.length > 0) {
      throw new CliError(`${notFound.length} of ${count} files were not found in your AITOPIA files.`, EXIT.FAILED, {
        code: 'ASSETS_NOT_FOUND',
        hint: 'Check the URLs or ids (`aitopia projects show <project>` lists them). The others were moved.',
        data: { ...payload, status: moved > 0 ? 'partial' : 'failed', moved, notFound },
      });
    }
    if (out.jsonMode) out.json(payload);
  });
}

/** aitopia projects rename <project> <newName> [--description]. */
export async function projectsRenameCommand(ctx: Context, ref: string, newName: string, options: { description?: string }): Promise<void> {
  if (!newName.trim()) throw new UsageError('Give the new name, e.g. aitopia projects rename "Spring" "Spring 2027".');
  await withSession(ctx, async (session) => {
    const project = await resolveProject(session, ref);
    const args: Record<string, unknown> = { projectId: project.id, name: newName.trim() };
    if (options.description !== undefined) args.description = options.description;
    const { payload } = await call(session, 'rename_project', args);
    const { out } = ctx;
    if (out.jsonMode) {
      out.json(payload);
      return;
    }
    out.line(`${out.out.green('Renamed')} "${project.name}" to "${newName.trim()}".`);
    if (typeof payload.openInAitopia === 'string') out.line(`${out.out.dim('Open in AITOPIA:')} ${payload.openInAitopia}`);
  });
}

/** aitopia projects delete <project> [--yes]: asks first on a terminal; the files stay in Creations. */
export async function projectsDeleteCommand(ctx: Context, ref: string, options: { yes?: boolean }): Promise<void> {
  await withSession(ctx, async (session) => {
    const project = await findProject(session, ref);
    const files = typeof project.assetCount === 'number' ? project.assetCount : undefined;
    const kept = files === undefined ? 'Its files' : `Its ${files} file${files === 1 ? '' : 's'}`;
    const ok = await confirmAction(
      ctx,
      { question: `Delete the project "${project.name}" and its folders? ${kept} stay in your AITOPIA Creations.`, action: `delete the project "${project.name}"` },
      options.yes,
    );
    if (!ok) throw notConfirmed('Not deleted.');
    const { payload } = await call(session, 'delete_project', { projectId: project.id });
    const { out } = ctx;
    if (out.jsonMode) {
      out.json(payload);
      return;
    }
    const keptCount = typeof payload.assetsKept === 'number' ? payload.assetsKept : files;
    out.line(`${out.out.green('Deleted')} the project "${project.name}" and its folders.`);
    out.line(
      keptCount === undefined
        ? 'Its files stay in your AITOPIA Creations, outside any project.'
        : `Its ${keptCount} file${keptCount === 1 ? '' : 's'} stay${keptCount === 1 ? 's' : ''} in your AITOPIA Creations, outside any project.`,
    );
  });
}
