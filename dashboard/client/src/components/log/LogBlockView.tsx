import { memo } from 'react';
import { cn } from '@/lib/utils';
import { LogBlock } from '@/lib/log-parser';
import { Terminal, Bot, User, Search, FileText, CheckCircle2, XCircle } from 'lucide-react';
import { AccordionRoot, AccordionItem, AccordionTrigger, AccordionContent } from '@/components/ui/accordion';

interface LogBlockViewProps {
  block: LogBlock;
}

export const LogBlockView = memo(function LogBlockView({ block }: LogBlockViewProps) {
  if (block.type === 'text') {
    const isBot = block.header === 'codex';
    const isUser = block.header === 'user';
    const Icon = isBot ? Bot : isUser ? User : Terminal;

    return (
      <div className={cn("px-4 py-3 border-b border-border/50", isBot ? "bg-primary/5" : "")}>
        {block.header && (
          <div className="flex items-center gap-2 mb-2">
            <Icon className="w-4 h-4 text-muted-foreground" />
            <span className="text-xs font-semibold uppercase tracking-wider text-muted-foreground">
              {block.header}
            </span>
          </div>
        )}
        <div className="text-sm font-sans whitespace-pre-wrap text-foreground/90 leading-relaxed">
          {block.lines?.join('\n')}
        </div>
      </div>
    );
  }

  if (block.type === 'command_group' && block.commands) {
    // Generate a group summary
    const cmdCount = block.commands.length;
    let summaryIcon = <Terminal className="w-4 h-4" />;

    // Attempt to aggregate summary
    const types = new Set(block.commands.map(c => c.summary));
    let groupTitle = `Ran ${cmdCount} command${cmdCount > 1 ? 's' : ''}`;

    if (types.size === 1) {
       groupTitle = Array.from(types)[0] || groupTitle;
    } else if (types.size > 1) {
       groupTitle = Array.from(types).join(', ');
    }

    if (groupTitle.toLowerCase().includes('search')) {
      summaryIcon = <Search className="w-4 h-4" />;
    } else if (groupTitle.toLowerCase().includes('file')) {
      summaryIcon = <FileText className="w-4 h-4" />;
    }

    return (
      <div className="px-4 py-3 border-b border-border/50 bg-muted/10">
        <AccordionRoot type="multiple">
           <AccordionItem value="group-1" className="border-none bg-transparent">
             <AccordionTrigger className="hover:bg-transparent px-0 py-1 flex justify-start gap-2 group">
               <div className="flex items-center gap-2 text-muted-foreground group-hover:text-foreground transition-colors">
                 {summaryIcon}
                 <span className="text-sm font-medium">{groupTitle}</span>
                 {cmdCount > 1 && (
                   <span className="text-xs px-1.5 py-0.5 rounded-full bg-muted text-muted-foreground">
                     {cmdCount}
                   </span>
                 )}
               </div>
             </AccordionTrigger>
             <AccordionContent className="border-none px-0 pt-2 pb-0">
               <div className="flex flex-col gap-3">
                 {block.commands.map((cmd, i) => (
                   <div key={i} className="rounded-md border border-border bg-card overflow-hidden">
                     <div className="flex items-center justify-between px-3 py-2 bg-muted/30 border-b border-border text-xs font-mono">
                       <span className="truncate text-muted-foreground flex-1" title={cmd.command}>
                         $ {cmd.command}
                       </span>
                       <div className="flex items-center gap-2 ml-4 shrink-0">
                         {cmd.duration && <span className="text-muted-foreground/70">{cmd.duration}</span>}
                         {cmd.status === 'success' && <CheckCircle2 className="w-3.5 h-3.5 text-green-500" />}
                         {cmd.status === 'error' && <XCircle className="w-3.5 h-3.5 text-red-500" />}
                       </div>
                     </div>
                     {cmd.output && (
                       <div className="p-3 text-xs font-mono bg-background text-foreground/80 overflow-x-auto whitespace-pre-wrap max-h-96 overflow-y-auto">
                         {cmd.output}
                       </div>
                     )}
                   </div>
                 ))}
               </div>
             </AccordionContent>
           </AccordionItem>
        </AccordionRoot>
      </div>
    );
  }

  return null;
});
