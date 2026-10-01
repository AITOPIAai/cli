import { withSession, type Context } from '../context.js';
import type { ToolInfo } from '../mcp.js';
import { renderTable } from '../output.js';

export function firstLine(text: string | undefined): string {
  if (!text) return '';
  const line = text.split(/\r?\n/).find((l) => l.trim()) ?? '';
  const sentence = /^(.+?[.!?])(\s|$)/.exec(line.trim());
  return (sentence?.[1] ?? line).trim();
}

export function filterTools(tools: ToolInfo[], q: string | undefined): ToolInfo[] {
  const needle = q?.trim().toLowerCase();
  const list = needle
    ? tools.filter((t) => t.name.toLowerCase().includes(needle) || (t.description ?? '').toLowerCase().includes(needle))
    : tools;
  return [...list].sort((a, b) => a.name.localeCompare(b.name));
}

export async function toolsCommand(ctx: Context, options: { q?: string }): Promise<void> {
  await withSession(ctx, async (session) => {
    const tools = filterTools(await session.listTools(), options.q);
    const { out } = ctx;
    if (out.jsonMode) {
      out.json({ count: tools.length, tools: tools.map((t) => ({ name: t.name, description: t.description })) });
      return;
    }
    if (tools.length === 0) {
      out.line('No tools found.');
      return;
    }
    const nameWidth = Math.min(40, Math.max(...tools.map((t) => t.name.length)));
    const descWidth = Math.max(20, out.columns - nameWidth - 2);
    for (const row of renderTable(tools.map((t) => [t.name, firstLine(t.description)]), [nameWidth, descWidth])) out.line(row);
    out.note(`${tools.length} tools. Run one with: aitopia run <tool> --json-args '{...}'`);
  });
}
