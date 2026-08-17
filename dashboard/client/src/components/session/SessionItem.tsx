import { useEffect, useState } from 'react';
import {
  AlertTriangle,
  BrainCircuit,
  ChevronDown,
  CircleUserRound,
  FileDiff,
  Globe2,
  ListChecks,
  MessageSquareText,
  TerminalSquare,
  Wrench,
} from 'lucide-react';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import type { SessionItemDetail, SessionItemSummary } from '@devteam-dashboard/shared';

const icons = {
  message: MessageSquareText,
  reasoning: BrainCircuit,
  command: TerminalSquare,
  patch: FileDiff,
  plan: ListChecks,
  search: Globe2,
  tool: Wrench,
  error: AlertTriangle,
  unknown: AlertTriangle,
};

function statusColor(status?: string): string {
  if (!status) return 'text-muted-foreground';
  if (/fail|error|abort/i.test(status)) return 'text-red-500';
  if (/complete|success/i.test(status)) return 'text-emerald-500';
  return 'text-blue-500';
}

function DetailBody({ item, detail }: { item: SessionItemSummary; detail?: SessionItemDetail }) {
  if (!detail) return <div className="p-3 text-xs text-muted-foreground">Loading detail…</div>;
  const value = item.kind === 'patch'
    ? detail.diff
    : detail.output || detail.toolOutput || [detail.stdout, detail.stderr].filter(Boolean).join('\n');
  const input = item.kind === 'tool' || item.kind === 'search' ? detail.toolInput : null;
  return (
    <div className="border-t border-border/60 bg-zinc-950 text-zinc-100">
      {input && (
        <pre className="max-h-56 overflow-auto whitespace-pre-wrap border-b border-zinc-800 p-3 text-[11px] leading-relaxed text-zinc-300">{input}</pre>
      )}
      <pre className="max-h-96 overflow-auto whitespace-pre-wrap p-3 text-[11px] leading-relaxed">{value || 'No detail output'}</pre>
    </div>
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
  const Icon = item.role === 'user' ? CircleUserRound : icons[item.kind];

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
      <article className={`rounded-xl border p-3 ${
        item.role === 'user' ? 'border-blue-500/20 bg-blue-500/5' : item.kind === 'reasoning' ? 'border-violet-500/20 bg-violet-500/5' : 'border-border/70 bg-card/70'
      }`}>
        <div className="mb-2 flex items-center gap-2 text-[11px] font-semibold uppercase tracking-wide text-muted-foreground">
          <Icon className="h-3.5 w-3.5" />
          <span>{item.role === 'user' ? 'User' : item.kind === 'reasoning' ? 'Reasoning' : item.phase === 'final' ? 'Final answer' : 'Commentary'}</span>
          <time className="ml-auto font-normal normal-case">{new Date(item.timestamp).toLocaleTimeString()}</time>
        </div>
        <div className="prose prose-sm max-w-none break-words text-foreground dark:prose-invert prose-pre:overflow-auto prose-pre:text-xs">
          <ReactMarkdown remarkPlugins={[remarkGfm]}>{item.text || ''}</ReactMarkdown>
        </div>
      </article>
    );
  }

  if (item.kind === 'plan') {
    return (
      <article className="rounded-xl border border-border/70 bg-card/70 p-3">
        <div className="mb-2 flex items-center gap-2 text-xs font-semibold"><ListChecks className="h-4 w-4" /> Plan</div>
        <ol className="space-y-1.5 text-xs">
          {(item.plan || []).map((entry, index) => (
            <li key={`${entry.step}-${index}`} className="flex gap-2">
              <span className={statusColor(entry.status)}>●</span>
              <span className="flex-1">{entry.step}</span>
              <span className="text-muted-foreground">{entry.status.replace('_', ' ')}</span>
            </li>
          ))}
        </ol>
        {item.text && (item.plan || []).length === 0 && (
          <div className="prose prose-sm mt-2 max-w-none text-foreground dark:prose-invert">
            <ReactMarkdown remarkPlugins={[remarkGfm]}>{item.text}</ReactMarkdown>
          </div>
        )}
      </article>
    );
  }

  return (
    <article className={`overflow-hidden rounded-xl border bg-card/70 ${item.kind === 'error' ? 'border-red-500/40' : 'border-border/70'}`}>
      <button
        type="button"
        className="flex w-full items-start gap-2 p-3 text-left"
        onClick={() => item.hasDetail && setOpen((value) => !value)}
      >
        <Icon className={`mt-0.5 h-4 w-4 shrink-0 ${item.kind === 'error' ? 'text-red-500' : 'text-muted-foreground'}`} />
        <span className="min-w-0 flex-1">
          <span className="flex items-center gap-2 text-xs font-semibold">
            <span className="truncate">{item.title || item.kind}</span>
            {item.status && <span className={`font-mono text-[10px] ${statusColor(item.status)}`}>{item.status}</span>}
            {item.exitCode !== undefined && item.exitCode !== null && <span className="text-[10px] text-muted-foreground">exit {item.exitCode}</span>}
          </span>
          {item.command && <code className="mt-1 block truncate text-[11px] text-muted-foreground">{item.command}</code>}
          {item.text && <span className="mt-1 block text-xs text-muted-foreground">{item.text}</span>}
          {item.filePaths?.length ? <span className="mt-1 block text-[11px] text-muted-foreground">{item.filePaths.join(', ')}</span> : null}
          {item.outputPreview && !open && <span className="mt-1 block truncate text-[11px] text-muted-foreground">{item.outputPreview}</span>}
        </span>
        {item.hasDetail && <ChevronDown className={`h-4 w-4 shrink-0 text-muted-foreground transition-transform ${open ? 'rotate-180' : ''}`} />}
      </button>
      {open && item.hasDetail && <DetailBody item={item} detail={detail} />}
    </article>
  );
}
