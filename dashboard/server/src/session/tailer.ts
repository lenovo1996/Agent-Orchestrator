import { EventEmitter } from 'node:events';
import fs from 'node:fs';
import path from 'node:path';

export interface JsonlTailerOptions {
  startAtEnd?: boolean;
  allowedRoot?: string;
}

export class JsonlTailer extends EventEmitter {
  private committedOffset = 0;
  private carry = Buffer.alloc(0);
  private watcher: fs.FSWatcher | null = null;
  private polling = false;
  private repoll = false;
  private fileIdentity: string | null = null;

  constructor(
    readonly filePath: string,
    private readonly options: JsonlTailerOptions = {},
  ) {
    super();
  }

  get offset(): number {
    return this.committedOffset;
  }

  get partialLine(): string {
    return this.carry.toString('utf8');
  }

  private isContained(): boolean {
    if (!this.options.allowedRoot) return true;
    try {
      const root = fs.realpathSync(this.options.allowedRoot);
      const target = fs.realpathSync(this.filePath);
      return target === root || target.startsWith(`${root}${path.sep}`);
    } catch {
      return false;
    }
  }

  start(): void {
    if (this.watcher) return;
    if (!this.isContained()) throw new Error('Rollout path is outside the configured Codex home');
    if (this.options.startAtEnd) {
      try {
        const stat = fs.statSync(this.filePath);
        const tailLength = Math.min(stat.size, 64 * 1024);
        const tailStart = stat.size - tailLength;
        const tail = Buffer.alloc(tailLength);
        const descriptor = fs.openSync(this.filePath, 'r');
        try { fs.readSync(descriptor, tail, 0, tailLength, tailStart); }
        finally { fs.closeSync(descriptor); }
        const lastNewline = tail.lastIndexOf(0x0a);
        this.committedOffset = lastNewline < 0 ? 0 : tailStart + lastNewline + 1;
        this.carry = this.committedOffset < stat.size
          ? tail.subarray(Math.max(0, this.committedOffset - tailStart))
          : Buffer.alloc(0);
        this.fileIdentity = `${stat.dev}:${stat.ino}`;
      } catch { /* wait for file */ }
    } else {
      void this.poll();
    }
    const directory = path.dirname(this.filePath);
    const basename = path.basename(this.filePath);
    this.watcher = fs.watch(directory, (_event, filename) => {
      if (!filename || filename.toString() === basename) void this.poll();
    });
  }

  async poll(): Promise<void> {
    if (this.polling) {
      this.repoll = true;
      return;
    }
    this.polling = true;
    try {
      if (!this.isContained()) throw new Error('Rollout path is outside the configured Codex home');
      const stat = await fs.promises.stat(this.filePath);
      const identity = `${stat.dev}:${stat.ino}`;
      if ((this.fileIdentity && identity !== this.fileIdentity) || stat.size < this.committedOffset) {
        this.committedOffset = 0;
        this.carry = Buffer.alloc(0);
        this.emit('reset');
      }
      this.fileIdentity = identity;
      if (stat.size === this.committedOffset) return;

      const length = stat.size - this.committedOffset;
      const handle = await fs.promises.open(this.filePath, 'r');
      const buffer = Buffer.alloc(length);
      try {
        await handle.read(buffer, 0, length, this.committedOffset);
      } finally {
        await handle.close();
      }

      const lastNewline = buffer.lastIndexOf(0x0a);
      if (lastNewline < 0) {
        this.carry = buffer;
        return;
      }

      const complete = buffer.subarray(0, lastNewline + 1);
      this.carry = buffer.subarray(lastNewline + 1);
      this.committedOffset += complete.length;
      for (const rawLine of complete.toString('utf8').split('\n')) {
        const line = rawLine.endsWith('\r') ? rawLine.slice(0, -1) : rawLine;
        if (!line) continue;
        try {
          this.emit('record', JSON.parse(line));
        } catch (error) {
          this.emit('diagnostic', { offset: this.committedOffset, message: (error as Error).message });
        }
      }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') this.emit('error', error);
    } finally {
      this.polling = false;
      if (this.repoll) {
        this.repoll = false;
        void this.poll();
      }
    }
  }

  close(): void {
    this.watcher?.close();
    this.watcher = null;
    this.removeAllListeners();
  }
}
