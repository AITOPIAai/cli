import type { Context } from './context.js';
import { CliError, EXIT, UsageError, failureToError } from './errors.js';
import { isFailed } from './envelope.js';
import type { Session } from './mcp.js';

/** Something the user names by its name or its id (a project, folder or voice). */
export interface Named {
  id: string;
  name: string;
}

/** Pages read when looking a project up by name (100 projects each). */
const MAX_PROJECT_PAGES = 20;

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function str(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() ? value.trim() : undefined;
}

/**
 * Picks the entry a user meant: an exact id first, then an exact name, then a
 * case-insensitive name. Several equal names (different case or parents) are
 * ambiguous: exit 2 listing their ids. Undefined when nothing matches.
 */
export function matchNamed<T extends Named>(entries: T[], ref: string, what: string): T | undefined {
  const wanted = ref.trim();
  const byId = entries.find((e) => e.id === wanted);
  if (byId) return byId;
  const exact = entries.filter((e) => e.name === wanted);
  if (exact.length === 1) return exact[0];
  const lower = wanted.toLowerCase();
  const loose = exact.length > 1 ? exact : entries.filter((e) => e.name.toLowerCase() === lower);
  if (loose.length === 1) return loose[0];
  if (loose.length > 1) {
    throw new CliError(`${loose.length} ${what}s are named "${wanted}".`, EXIT.USAGE, {
      code: 'AMBIGUOUS_NAME',
      hint: `Use the id instead: ${loose.map((e) => `${e.id} (${e.name})`).join(', ')}.`,
      data: { matches: loose.map((e) => ({ id: e.id, name: e.name })) },
    });
  }
  return undefined;
}

function namedList(value: unknown, idKey = 'id'): Array<Named & Record<string, unknown>> {
  if (!Array.isArray(value)) return [];
  return value.filter(isObject).flatMap((e) => {
    const id = str(e[idKey]);
    const name = typeof e.name === 'string' ? e.name : undefined;
    return id && name !== undefined ? [{ ...e, id, name }] : [];
  });
}

/** Every project of the user (list_projects, page by page). */
export async function listAllProjects(session: Session): Promise<Array<Named & Record<string, unknown>>> {
  const projects: Array<Named & Record<string, unknown>> = [];
  let offset = 0;
  for (let page = 0; page < MAX_PROJECT_PAGES; page++) {
    const outcome = await session.callTool('list_projects', { limit: 100, offset });
    if (isFailed(outcome)) throw failureToError(outcome.payload);
    projects.push(...namedList(outcome.payload.projects));
    const next = outcome.payload.nextOffset;
    if (typeof next !== 'number' || next <= offset) break;
    offset = next;
  }
  return projects;
}

export function projectNotFound(ref: string): CliError {
  return new CliError(`No project named "${ref.trim()}".`, EXIT.FAILED, {
    code: 'PROJECT_NOT_FOUND',
    hint: 'See your projects with `aitopia projects`, or make one with `aitopia projects create <name>`. Nothing was spent.',
  });
}

/** A project (with its listed fields, e.g. assetCount) by name (case-insensitive) or id; PROJECT_NOT_FOUND (exit 1) when there is none. */
export async function findProject(session: Session, ref: string): Promise<Named & Record<string, unknown>> {
  const found = matchNamed(await listAllProjects(session), ref, 'project');
  if (!found) throw projectNotFound(ref);
  return found;
}

/** A project by name (case-insensitive) or id; PROJECT_NOT_FOUND (exit 1) when there is none. */
export async function resolveProject(session: Session, ref: string): Promise<Named> {
  const found = await findProject(session, ref);
  return { id: found.id, name: found.name };
}

/** The folders of a project (list_project_assets returns all of them with any page). */
export async function listFolders(session: Session, projectId: string): Promise<Array<Named & { parentFolderId?: string | null }>> {
  const outcome = await session.callTool('list_project_assets', { projectId, limit: 1 });
  if (isFailed(outcome)) throw failureToError(outcome.payload);
  return namedList(outcome.payload.folders).map((f) => ({ ...f, parentFolderId: str(f.parentFolderId) ?? null }));
}

/** A folder of a project by name (case-insensitive) or id; FOLDER_NOT_FOUND (exit 1) when there is none. */
export async function resolveFolder(session: Session, project: Named, ref: string): Promise<Named> {
  const found = matchNamed(await listFolders(session, project.id), ref, 'folder');
  if (!found) {
    throw new CliError(`No folder named "${ref.trim()}" in the project "${project.name}".`, EXIT.FAILED, {
      code: 'FOLDER_NOT_FOUND',
      hint: `See its folders with \`aitopia projects show "${project.name}"\`. Nothing was spent.`,
    });
  }
  return { id: found.id, name: found.name };
}

export interface ScopeOptions {
  /** --project <name|id> */
  project?: string;
  /** --folder <name|id> (needs --project) */
  folder?: string;
}

/** Checks --project / --folder before connecting (exit 2). */
export function checkScopeOptions(options: ScopeOptions): void {
  if (options.folder !== undefined && options.project === undefined) {
    throw new UsageError('--folder needs --project: name the project the folder is in.');
  }
  if (options.project !== undefined && !options.project.trim()) throw new UsageError('--project needs a project name or id.');
  if (options.folder !== undefined && !options.folder.trim()) throw new UsageError('--folder needs a folder name or id.');
}

/**
 * Resolves --project / --folder to the top-level projectId / folderId of a
 * generation call. Run once, before the paid call: a project or folder that
 * does not exist stops the command before anything is spent.
 */
export async function resolveScope(ctx: Context, session: Session, options: ScopeOptions): Promise<{ projectId?: string; folderId?: string }> {
  checkScopeOptions(options);
  if (options.project === undefined) return {};
  const project = await resolveProject(session, options.project);
  const folder = options.folder !== undefined ? await resolveFolder(session, project, options.folder) : undefined;
  if (!ctx.out.jsonMode) ctx.out.note(`Saving to project "${project.name}"${folder ? `, folder "${folder.name}"` : ''}.`);
  return { projectId: project.id, ...(folder ? { folderId: folder.id } : {}) };
}

/** The user's voices (list_voices). */
export async function listVoices(session: Session): Promise<Array<Named & Record<string, unknown>>> {
  const outcome = await session.callTool('list_voices', {});
  if (isFailed(outcome)) throw failureToError(outcome.payload);
  return namedList(outcome.payload.voices, 'voiceId');
}

/** A voice by name (case-insensitive) or voiceId; VOICE_NOT_FOUND (exit 1) when there is none. */
export async function resolveVoice(session: Session, ref: string): Promise<Named & Record<string, unknown>> {
  const found = matchNamed(await listVoices(session), ref, 'voice');
  if (!found) {
    throw new CliError(`No voice named "${ref.trim()}" in your voices.`, EXIT.FAILED, {
      code: 'VOICE_NOT_FOUND',
      hint: 'See your voices with `aitopia voices`, or clone one with `aitopia voices create <name> <sample> --consent`. Nothing was spent.',
    });
  }
  return found;
}
