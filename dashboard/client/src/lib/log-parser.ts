import ansiRegex from 'ansi-regex';

export type LogBlockType = 'text' | 'command_group' | 'git_diff' | 'system';

export interface CommandLog {
  command: string;
  output: string;
  status?: 'success' | 'error';
  duration?: string;
  summary?: string;
  hasVisibleContent?: boolean;
}

export interface GitDiffLog {
  files: string[];
  output: string;
  hasVisibleContent?: boolean;
}

export interface LogBlock {
  type: LogBlockType;
  lines?: string[];
  commands?: CommandLog[];
  diffs?: GitDiffLog[];
  header?: string; // e.g., 'codex' or 'user'
  isOpen?: boolean; // For UI state
}

export interface ParseLogsOptions {
  visibleStartLine?: number;
}

const stripAnsi = (str: string) => str.replace(ansiRegex(), '');

export function parseLogs(rawLines: string[], options: ParseLogsOptions = {}): LogBlock[] {
  const blocks: LogBlock[] = [];
  let currentBlock: LogBlock | null = null;
  let currentCommand: CommandLog | null = null;
  let currentDiff: GitDiffLog | null = null;
  const visibleStartLine = Math.max(0, options.visibleStartLine ?? 0);
  const isVisibleLine = (lineIndex: number) => lineIndex >= visibleStartLine;

  for (let i = 0; i < rawLines.length; i++) {
    const rawLine = rawLines[i];
    const line = stripAnsi(rawLine);

    // Git diff block
    if (line.startsWith('diff --git ')) {
      if (currentBlock && currentBlock.type !== 'git_diff') {
        blocks.push(currentBlock);
        currentBlock = { type: 'git_diff', diffs: [] };
      } else if (!currentBlock) {
        currentBlock = { type: 'git_diff', diffs: [] };
      }

      // Parse filenames like: a/path/to/file b/path/to/file
      const match = line.match(/^diff --git a\/(.*?) b\/(.*?)$/);
      const files = match ? [match[1], match[2]] : [];

      currentDiff = {
        files,
        output: isVisibleLine(i) ? line : '',
        hasVisibleContent: isVisibleLine(i),
      };
      currentBlock.diffs!.push(currentDiff);
      currentCommand = null;
      continue;
    }

    if (currentBlock?.type === 'git_diff' && currentDiff) {
      // If we encounter a new header that breaks the diff, catch it
      if (
        rawLine.match(/\x1b\[35m\x1b\[3m(codex|user|exec)\x1b\[0m/) ||
        line.match(/^(codex|user|exec)$/i)
      ) {
        // Break out of diff, let next handlers process it
      } else {
        if (isVisibleLine(i)) {
          currentDiff.output += (currentDiff.output ? '\n' : '') + line;
          currentDiff.hasVisibleContent = true;
        }
        continue;
      }
    }

    // Identify agent/user headers (e.g., codex, user)
    // Often logged like: [35m[3mcodex[0m[0m or [36muser[0m
    if (rawLine.match(/\x1b\[35m\x1b\[3m(codex|user)\x1b\[0m/) || line.match(/^(codex|user)$/i)) {
      if (currentBlock) blocks.push(currentBlock);
      currentBlock = { type: 'text', lines: [], header: line.trim().toLowerCase() };
      currentCommand = null;
      currentDiff = null;
      continue;
    }

    // Identify exec command headers
    // Often logged like: [35m[3mexec[0m[0m
    if (rawLine.match(/\x1b\[35m\x1b\[3mexec\x1b\[0m/) || line.match(/^exec$/i)) {
      // If we're not already in a command group, start one
      if (!currentBlock || currentBlock.type !== 'command_group') {
        if (currentBlock) blocks.push(currentBlock);
        currentBlock = { type: 'command_group', commands: [] };
      }

      // Look ahead for command and status
      const nextLineRaw = rawLines[i + 1] || '';
      const nextNextLineRaw = rawLines[i + 2] || '';
      const nextLine = stripAnsi(nextLineRaw);
      const nextNextLine = stripAnsi(nextNextLineRaw);

      // Match something like "/usr/bin/zsh -lc '...' in /home/..."
      let command = nextLine.replace(/in \/.*$/, '').trim();
      let status: 'success' | 'error' | undefined;
      let duration: string | undefined;

      if (nextNextLine.includes('succeeded in')) {
        status = 'success';
        duration = nextNextLine.match(/succeeded in (\d+ms)/)?.[1] || '';
      } else if (nextNextLine.includes('exited')) {
        status = 'error';
        duration = nextNextLine.match(/exited \d+ in (\d+ms)/)?.[1] || '';
      }

      currentCommand = {
        command,
        status,
        duration,
        output: '',
        hasVisibleContent: isVisibleLine(i) || isVisibleLine(i + 1) || isVisibleLine(i + 2),
      };
      currentBlock.commands!.push(currentCommand);
      currentDiff = null;

      // Skip the lines we just parsed
      if (status) i += 2;
      else i += 1;

      continue;
    }

    // If it's a command output
    if (currentBlock?.type === 'command_group' && currentCommand) {
      // If we encounter another agent/user or exec header, the loop will catch it on the next iteration
      // Check if it's an empty line that might just be padding between commands
      if (isVisibleLine(i)) {
        currentCommand.output += (currentCommand.output ? '\n' : '') + line;
        currentCommand.hasVisibleContent = true;
      }
      continue;
    }

    // Default: just text
    if (!currentBlock) {
      currentBlock = { type: 'text', lines: [] };
    }

    if (currentBlock.type === 'text') {
      if (isVisibleLine(i)) {
        currentBlock.lines!.push(line);
      }
    }
  }

  if (currentBlock) {
    blocks.push(currentBlock);
  }

  const visibleBlocks = visibleStartLine > 0 ? filterVisibleBlocks(blocks) : blocks;

  // Post-process command blocks to generate summaries
  for (const block of visibleBlocks) {
    if (block.type === 'command_group' && block.commands) {
      for (const cmd of block.commands) {
         cmd.summary = generateCommandSummary(cmd.command);
      }
    }
  }

  return visibleBlocks;
}

function filterVisibleBlocks(blocks: LogBlock[]): LogBlock[] {
  const visibleBlocks: LogBlock[] = [];

  for (const block of blocks) {
    if (block.type === 'text') {
      if (block.lines && block.lines.length > 0) {
        visibleBlocks.push(block);
      }
      continue;
    }

    if (block.type === 'git_diff') {
      const diffs = block.diffs?.filter((diff) => diff.hasVisibleContent) ?? [];
      if (diffs.length > 0) {
        visibleBlocks.push({ ...block, diffs });
      }
      continue;
    }

    if (block.type === 'command_group') {
      const commands = block.commands?.filter((command) => command.hasVisibleContent) ?? [];
      if (commands.length > 0) {
        visibleBlocks.push({ ...block, commands });
      }
      continue;
    }

    visibleBlocks.push(block);
  }

  return visibleBlocks;
}

function generateCommandSummary(command: string): string {
  const cmd = command.toLowerCase();
  if (cmd.includes('cat ') || cmd.includes('sed ') || cmd.includes('read_file')) return 'Read a file';
  if (cmd.includes('grep ') || cmd.includes('rg ') || cmd.includes('search')) return 'Searched code';
  if (cmd.includes('ls ') || cmd.includes('find ')) return 'Listed files';
  if (cmd.includes('git ')) return 'Ran git command';
  if (cmd.includes('node ') || cmd.includes('npm ') || cmd.includes('composer ')) return 'Ran build/test command';
  return 'Ran a command';
}
