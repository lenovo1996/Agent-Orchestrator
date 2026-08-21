import { useEffect, useState } from 'react';
import { ArrowDownLeft, ArrowUpRight, ChevronDown, LoaderCircle } from 'lucide-react';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import type { SessionItemDetail, SessionItemSummary } from '@devteam-dashboard/shared';

interface Presentation {
  label: string;
  marker: string;
  tone: string;
  row: string;
}

function presentation(item: SessionItemSummary): Presentation {
  if (item.kind === 'message' && item.role === 'user') {
    return { label: 'YOU', marker: '›', tone: 'text-cyan-700 dark:text-cyan-300', row: 'bg-cyan-500/[0.04]' };
  }
  if (item.kind === 'message' && item.phase === 'final') {
    return { label: 'FINAL', marker: '◆', tone: 'text-emerald-700 dark:text-emerald-300', row: 'bg-emerald-500/[0.035]' };
  }
  if (item.kind === 'message') {
    return { label: 'ASSISTANT', marker: '·', tone: 'text-blue-700 dark:text-blue-300', row: '' };
  }

  const values: Record<SessionItemSummary['kind'], Presentation> = {
    message: { label: 'ASSISTANT', marker: '·', tone: 'text-blue-700 dark:text-blue-300', row: '' },
    reasoning: { label: 'THINK', marker: '∴', tone: 'text-violet-700 dark:text-violet-300', row: 'bg-violet-500/[0.035]' },
    command: { label: 'COMMAND', marker: '$', tone: 'text-amber-700 dark:text-amber-300', row: '' },
    patch: { label: 'PATCH', marker: '+', tone: 'text-emerald-700 dark:text-emerald-300', row: '' },
    plan: { label: 'PLAN', marker: '≡', tone: 'text-sky-700 dark:text-sky-300', row: '' },
    search: { label: 'SEARCH', marker: '?', tone: 'text-cyan-700 dark:text-cyan-300', row: '' },
    tool: { label: 'TOOL', marker: '↳', tone: 'text-blue-700 dark:text-blue-300', row: '' },
    error: { label: 'ERROR', marker: '!', tone: 'text-red-600 dark:text-red-400', row: 'bg-red-500/[0.045]' },
    unknown: { label: 'EVENT', marker: '·', tone: 'text-muted-foreground', row: '' },
  };
  return values[item.kind];
}

function time(value: string): string {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return '--:--:--';
  return date.toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit', second: '2-digit' });
}

function statusTone(status?: string): string {
  if (!status) return 'text-muted-foreground';
  if (/fail|error|abort/i.test(status)) return 'text-red-600 dark:text-red-400';
  if (/complete|success|done/i.test(status)) return 'text-emerald-700 dark:text-emerald-400';
  if (/running|progress|start/i.test(status)) return 'text-blue-700 dark:text-blue-400';
  return 'text-muted-foreground';
}

function planMarker(status: string): { marker: string; tone: string } {
  if (/complete|success|done/i.test(status)) return { marker: '✓', tone: 'text-emerald-700 dark:text-emerald-400' };
  if (/fail|error|abort/i.test(status)) return { marker: '×', tone: 'text-red-600 dark:text-red-400' };
  if (/running|progress|start/i.test(status)) return { marker: '●', tone: 'text-blue-700 dark:text-blue-400' };
  return { marker: '○', tone: 'text-muted-foreground' };
}

function parseToolValue(value: string): unknown {
  try {
    const parsed = JSON.parse(value) as unknown;
    if (typeof parsed === 'string' && /^[\s]*[\[{]/.test(parsed)) {
      try { return JSON.parse(parsed) as unknown; } catch { /* keep the decoded string */ }
    }
    return parsed;
  } catch {
    return value;
  }
}

function toolContentValue(value: unknown): unknown {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return value;
  const block = value as Record<string, unknown>;
  if (block.type === 'text' && typeof block.text === 'string') return parseToolValue(block.text);
  if (block.type === 'resource' && block.resource && typeof block.resource === 'object') return block.resource;
  return value;
}

function normalizedToolPayload(value: string, direction: 'request' | 'response'): unknown {
  const parsed = parseToolValue(value);
  if (direction === 'request' || !parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return parsed;
  const response = parsed as Record<string, unknown>;
  if (response.isError !== true && response.structuredContent !== undefined) return response.structuredContent;
  if (Array.isArray(response.content)) {
    const content = response.content.map(toolContentValue);
    return content.length === 1 ? content[0] : content;
  }
  return parsed;
}

function fieldLabel(key: string): string {
  const words = key
    .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
    .replace(/[_-]+/g, ' ')
    .trim();
  return words ? `${words.charAt(0).toUpperCase()}${words.slice(1)}` : key;
}

function PrimitiveToolValue({ value }: { value: string | number | boolean | null }) {
  if (value === null) return <span className="italic text-muted-foreground">No value</span>;
  if (typeof value === 'boolean') {
    return (
      <span className={`font-semibold ${value
        ? 'text-emerald-700 dark:text-emerald-300'
        : 'text-slate-600 dark:text-slate-300'}`}>
        {value ? 'True' : 'False'}
      </span>
    );
  }
  if (typeof value === 'number') {
    return <span className="font-semibold tabular-nums text-violet-700 dark:text-violet-300">{value}</span>;
  }
  if (value.includes('\n') || value.length > 160) {
    return (
      <pre className="max-h-64 min-w-0 overflow-auto whitespace-pre-wrap break-words border-l border-border/70 py-1 pl-3 text-[11px] leading-5 text-foreground [overflow-wrap:anywhere]">
        {value}
      </pre>
    );
  }
  return <span className="break-words text-foreground [overflow-wrap:anywhere]">{value || 'Empty text'}</span>;
}

function StructuredToolValue({ value, depth = 0 }: { value: unknown; depth?: number }) {
  if (typeof value === 'string' && /^[\s]*[\[{]/.test(value)) {
    const parsed = parseToolValue(value);
    if (parsed !== value) return <StructuredToolValue value={parsed} depth={depth} />;
  }
  if (value === null || ['string', 'number', 'boolean'].includes(typeof value)) {
    return <PrimitiveToolValue value={value as string | number | boolean | null} />;
  }

  if (Array.isArray(value)) {
    if (value.length === 0) return <span className="italic text-muted-foreground">Empty list</span>;
    const primitiveList = value.every((entry) => entry === null || ['string', 'number', 'boolean'].includes(typeof entry));
    if (primitiveList) {
      return (
        <ul className="flex flex-wrap gap-x-3 gap-y-1" aria-label={`${value.length} list items`}>
          {value.map((entry, index) => (
            <li key={index} className="inline-flex items-center gap-1.5">
              <span className="text-muted-foreground/50" aria-hidden="true">•</span>
              <PrimitiveToolValue value={entry as string | number | boolean | null} />
            </li>
          ))}
        </ul>
      );
    }
    if (depth >= 6) return <span className="text-muted-foreground">{value.length} nested items</span>;
    return (
      <ol className="space-y-2 border-l border-border/60 pl-3" aria-label={`${value.length} structured list items`}>
        {value.map((entry, index) => (
          <li key={index} className="grid min-w-0 grid-cols-[2rem_minmax(0,1fr)] gap-2">
            <span className="pt-0.5 text-[9px] font-semibold tabular-nums text-muted-foreground">#{index + 1}</span>
            <div className="min-w-0"><StructuredToolValue value={entry} depth={depth + 1} /></div>
          </li>
        ))}
      </ol>
    );
  }

  if (typeof value === 'object') {
    const entries = Object.entries(value as Record<string, unknown>);
    if (entries.length === 0) return <span className="italic text-muted-foreground">Empty object</span>;
    if (depth >= 6) return <span className="text-muted-foreground">{entries.length} nested fields</span>;
    return (
      <dl className={depth > 0 ? 'border-l border-border/60 pl-3' : ''}>
        {entries.map(([key, entry]) => (
          <div
            key={key}
            className="grid min-w-0 gap-1 py-1 sm:grid-cols-[minmax(6.5rem,0.35fr)_minmax(0,1fr)] sm:gap-3"
          >
            <dt className="break-words text-[10px] font-semibold text-muted-foreground" title={key}>{fieldLabel(key)}</dt>
            <dd className="min-w-0 text-[11px]"><StructuredToolValue value={entry} depth={depth + 1} /></dd>
          </div>
        ))}
      </dl>
    );
  }

  return <span className="text-muted-foreground">Unsupported value</span>;
}

function ToolDetailSection({
  direction,
  value,
}: {
  direction: 'request' | 'response';
  value: string;
}) {
  const request = direction === 'request';
  const Icon = request ? ArrowUpRight : ArrowDownLeft;
  const label = request ? 'Request' : 'Response';
  const parsed = value ? normalizedToolPayload(value, direction) : null;

  return (
    <div className="grid min-w-0 gap-2 py-2.5 sm:grid-cols-[5.5rem_minmax(0,1fr)] sm:gap-3">
      <div className={`flex items-center gap-1.5 self-start text-[9px] font-bold uppercase tracking-[0.16em] ${request
        ? 'text-cyan-700 dark:text-cyan-300'
        : 'text-emerald-700 dark:text-emerald-300'}`}>
        <Icon className="h-3.5 w-3.5" aria-hidden="true" />
        {label}
      </div>
      <div
        aria-label={`Tool ${direction}`}
        tabIndex={0}
        className="max-h-[28rem] min-w-0 overflow-auto py-0.5 text-[11px] leading-5 text-foreground"
      >
        {value
          ? <StructuredToolValue value={parsed} />
          : <span className="block px-2 py-1.5 italic text-muted-foreground">{request ? 'No request payload' : 'Waiting for tool response…'}</span>}
      </div>
    </div>
  );
}

function ToolDetailBody({ item, detail }: { item: SessionItemSummary; detail?: SessionItemDetail }) {
  const input = detail?.toolInput || '';
  const output = detail?.toolOutput || detail?.output
    || [detail?.stdout, detail?.stderr].filter(Boolean).join('\n');
  const name = item.toolName || item.title || 'tool';

  return (
    <div className="border-t border-border/60 bg-muted/[0.12] px-3 pb-2 pt-1.5 sm:pl-[5.75rem]">
      <section
        aria-label={`Tool details: ${name}`}
        className="min-w-0"
      >
        {!detail ? (
          <div className="flex items-center gap-2 py-2.5 text-[11px] text-muted-foreground">
            <LoaderCircle className="h-3.5 w-3.5 animate-spin motion-reduce:animate-none" aria-hidden="true" />
            Loading tool details…
          </div>
        ) : (
          <div className="divide-y divide-border/50">
            {input && <ToolDetailSection direction="request" value={input} />}
            <ToolDetailSection direction="response" value={output} />
          </div>
        )}
      </section>
    </div>
  );
}

function DetailBody({ item, detail }: { item: SessionItemSummary; detail?: SessionItemDetail }) {
  if (item.kind === 'tool' || item.kind === 'search') {
    return <ToolDetailBody item={item} detail={detail} />;
  }
  if (!detail) {
    return <div className="border-t border-border bg-muted/30 py-2 pl-[6.75rem] pr-3 font-mono text-[11px] text-muted-foreground">loading output…</div>;
  }
  const value = item.kind === 'patch'
    ? detail.diff
    : detail.output || detail.toolOutput || [detail.stdout, detail.stderr].filter(Boolean).join('\n');

  return (
    <div className="border-t border-border bg-muted/30 py-2 pl-[6.75rem] pr-3 font-mono text-[11px] leading-relaxed text-foreground">
      <pre className="max-h-96 overflow-auto whitespace-pre-wrap break-words border-l border-border pl-3">{value || 'no output'}</pre>
    </div>
  );
}

function RowLead({ item, value }: { item: SessionItemSummary; value: Presentation }) {
  return (
    <>
      <time className="select-none pt-px text-[10px] tabular-nums text-muted-foreground/60">{time(item.timestamp)}</time>
      <div className="min-w-0">
        <div className="flex min-w-0 items-center gap-2">
          <span className={`w-3 shrink-0 text-center text-sm font-bold leading-none ${value.tone}`} aria-hidden="true">{value.marker}</span>
          <span className={`text-[10px] font-bold tracking-[0.14em] ${value.tone}`}>{value.label}</span>
        </div>
      </div>
    </>
  );
}

export function SessionItem({
  item,
  detail,
  loadDetail,
}: {
  item: SessionItemSummary;
  detail?: SessionItemDetail;
  loadDetail: (item: SessionItemSummary) => void;
}) {
  const autoOpen = item.kind === 'command' && Boolean(item.outputPreview) && (item.outputPreview?.length || 0) < 180;
  const [open, setOpen] = useState(autoOpen);
  const value = presentation(item);

  useEffect(() => {
    if (open && item.hasDetail && !detail) loadDetail(item);
  }, [detail, item, loadDetail, open]);

  useEffect(() => {
    if (item.kind === 'command' && item.status === 'completed' && item.outputPreview && item.outputPreview.length < 180) {
      setOpen(true);
    }
  }, [item.kind, item.outputPreview, item.status]);

  if (item.kind === 'message' || item.kind === 'reasoning') {
    return (
      <article
        aria-label={`Session item: ${value.label}`}
        className={`grid gap-1 px-3 py-2.5 font-mono ${value.row}`}
      >
        <div className="min-w-0">
          <div className="flex items-center gap-2">
            <span className={`w-3 shrink-0 text-center text-sm font-bold leading-none ${value.tone}`} aria-hidden="true">{value.marker}</span>
            <span className={`text-[10px] font-bold tracking-[0.14em] ${value.tone}`}>{value.label}</span>
            <span className="select-none pt-px text-[10px] tabular-nums text-muted-foreground/60">—</span>
            <time className="select-none pt-px text-[10px] tabular-nums text-muted-foreground/60">{time(item.timestamp)}</time>
          </div>
          <div className={`prose prose-sm mt-1 max-w-none break-words pl-5 text-foreground dark:prose-invert prose-headings:mb-2 prose-headings:mt-3 prose-headings:text-foreground prose-p:my-1 prose-p:leading-relaxed prose-pre:my-2 prose-pre:border prose-pre:border-border prose-pre:bg-muted/60 prose-pre:text-xs prose-code:text-cyan-700 dark:prose-code:text-cyan-200 prose-headings:text-sm prose-li:text-xs prose-p:text-xs`}>
            <ReactMarkdown remarkPlugins={[remarkGfm]}>{item.text || ''}</ReactMarkdown>
          </div>
        </div>
      </article>
    );
  }

  if (item.kind === 'plan') {
    return (
      <article
        aria-label="Session item: PLAN"
        className="grid grid-cols-[4.25rem_minmax(0,1fr)] gap-2 px-3 py-2.5 font-mono"
      >
        <RowLead item={item} value={value} />
        <ol className="col-start-2 ml-5 mt-1 space-y-1.5 text-[11px]">
          {(item.plan || []).map((entry, index) => {
            const state = planMarker(entry.status);
            return (
              <li key={`${entry.step}-${index}`} className="grid grid-cols-[0.75rem_minmax(0,1fr)_auto] gap-2">
                <span className={state.tone}>{state.marker}</span>
                <span className="text-foreground">{entry.step}</span>
                <span className="text-muted-foreground/70">{entry.status.replaceAll('_', ' ')}</span>
              </li>
            );
          })}
        </ol>
        {item.text && (item.plan || []).length === 0 && (
          <div className="prose prose-sm col-start-2 ml-5 mt-1 max-w-none text-foreground dark:prose-invert">
            <ReactMarkdown remarkPlugins={[remarkGfm]}>{item.text}</ReactMarkdown>
          </div>
        )}
      </article>
    );
  }

  return (
    <article aria-label={`Session item: ${value.label}`} className={`font-mono ${value.row}`}>
      <button
        type="button"
        aria-expanded={item.hasDetail ? open : undefined}
        className={`grid w-full grid-cols-[4.25rem_minmax(0,1fr)_auto] gap-2 px-3 py-2.5 text-left ${item.hasDetail ? 'cursor-pointer hover:bg-accent/40' : 'cursor-default'}`}
        onClick={() => item.hasDetail && setOpen((current) => !current)}
      >
        <time className="select-none pt-px text-[10px] tabular-nums text-muted-foreground/60">{time(item.timestamp)}</time>
        <div className="min-w-0">
          <div className="flex min-w-0 items-center gap-2">
            <span className={`w-3 shrink-0 text-center text-sm font-bold leading-none ${value.tone}`} aria-hidden="true">{value.marker}</span>
            <span className={`shrink-0 text-[10px] font-bold tracking-[0.14em] ${value.tone}`}>{value.label}</span>
            <span className="truncate text-[11px] font-medium text-foreground/85">{item.title || item.kind}</span>
            {item.status && <span className={`shrink-0 text-[10px] ${statusTone(item.status)}`}>[{item.status}]</span>}
            {item.exitCode !== undefined && item.exitCode !== null && <span className="shrink-0 text-[10px] text-muted-foreground">[exit {item.exitCode}]</span>}
          </div>
          {item.command && <code className="mt-1 block truncate pl-5 text-[11px] text-amber-800 dark:text-amber-100">{item.command}</code>}
          {item.text && <span className="mt-1 block pl-5 text-[11px] text-muted-foreground">{item.text}</span>}
          {item.filePaths?.length ? <span className="mt-1 block truncate pl-5 text-[10px] text-muted-foreground/70">files: {item.filePaths.join(', ')}</span> : null}
          {item.outputPreview && !open && <span className="mt-1 block truncate pl-5 text-[10px] text-muted-foreground">└─ {item.outputPreview}</span>}
        </div>
        {item.hasDetail && <ChevronDown className={`h-3.5 w-3.5 shrink-0 text-muted-foreground transition-transform ${open ? 'rotate-180' : ''}`} />}
      </button>
      {open && item.hasDetail && <DetailBody item={item} detail={detail} />}
    </article>
  );
}
