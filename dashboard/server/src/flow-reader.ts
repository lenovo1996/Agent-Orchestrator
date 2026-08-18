import fs from 'node:fs';
import type { FileMetadata } from '@devteam-dashboard/shared';

/**
 * Read markdown output file content along with metadata (size, lastModified).
 * Returns null if the file doesn't exist or can't be read.
 */
export function readOutputContent(
  filePath: string
): { content: string; metadata: FileMetadata } | null {
  try {
    const stat = fs.statSync(filePath);
    const content = fs.readFileSync(filePath, 'utf8');
    return {
      content,
      metadata: {
        size: stat.size,
        lastModified: stat.mtime.toISOString(),
      },
    };
  } catch {
    return null;
  }
}
