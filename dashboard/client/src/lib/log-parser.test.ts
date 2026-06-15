import { describe, it, expect } from 'vitest';
import { parseLogs } from './log-parser';

describe('log-parser', () => {
  it('parses mixed codex and exec logs', () => {
    const rawLines = [
      '\x1b[35m\x1b[3mcodex\x1b[0m\x1b[0m',
      'I will run a command.',
      '\x1b[35m\x1b[3mexec\x1b[0m\x1b[0m',
      '\x1b[1m/usr/bin/zsh -lc "ls -la" \x1b[0m in /home/user',
      '\x1b[32m succeeded in 0ms:\x1b[0m',
      'file1.txt',
      'file2.txt',
      '\x1b[35m\x1b[3mexec\x1b[0m\x1b[0m',
      '\x1b[1m/usr/bin/zsh -lc "cat file1.txt" \x1b[0m in /home/user',
      '\x1b[31m exited 1 in 10ms:\x1b[0m',
      'cat: file1.txt: No such file or directory'
    ];

    const blocks = parseLogs(rawLines);
    expect(blocks.length).toBe(2);

    expect(blocks[0].type).toBe('text');
    expect(blocks[0].header).toBe('codex');
    expect(blocks[0].lines).toEqual(['I will run a command.']);

    expect(blocks[1].type).toBe('command_group');
    expect(blocks[1].commands!.length).toBe(2);

    expect(blocks[1].commands![0].command).toBe('/usr/bin/zsh -lc "ls -la"');
    expect(blocks[1].commands![0].status).toBe('success');
    expect(blocks[1].commands![0].summary).toBe('Listed files');
    expect(blocks[1].commands![0].output).toBe('file1.txt\nfile2.txt');

    expect(blocks[1].commands![1].command).toBe('/usr/bin/zsh -lc "cat file1.txt"');
    expect(blocks[1].commands![1].status).toBe('error');
    expect(blocks[1].commands![1].summary).toBe('Read a file');
    expect(blocks[1].commands![1].output).toBe('cat: file1.txt: No such file or directory');
  });

  it('parses git diff logs', () => {
    const rawLines = [
      'diff --git a/test.md b/test.md',
      'index abc..def',
      '--- a/test.md',
      '+++ b/test.md',
      '@@ -1,2 +1,3 @@',
      ' line 1',
      '-line 2',
      '+line 2 changed',
      'diff --git a/second.md b/second.md',
      '--- a/second.md',
      '+++ b/second.md'
    ];

    const blocks = parseLogs(rawLines);
    expect(blocks.length).toBe(1);
    expect(blocks[0].type).toBe('git_diff');
    expect(blocks[0].diffs!.length).toBe(2);

    expect(blocks[0].diffs![0].files).toEqual(['test.md', 'test.md']);
    expect(blocks[0].diffs![0].output).toContain('-line 2');

    expect(blocks[0].diffs![1].files).toEqual(['second.md', 'second.md']);
  });
});
