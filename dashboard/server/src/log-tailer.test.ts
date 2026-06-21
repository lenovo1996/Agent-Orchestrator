import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { readNewLogLines } from "./log-tailer.js";

describe("readNewLogLines", () => {
  let tmpDir: string;
  let logFile: string;
  let offsets: Map<string, number>;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "log-tailer-test-"));
    logFile = path.join(tmpDir, "test.log");
    offsets = new Map();
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it("returns all lines on first read of existing file", () => {
    fs.writeFileSync(logFile, "line1\nline2\nline3\n");

    const lines = readNewLogLines(logFile, offsets);

    expect(lines).toEqual(["line1", "line2", "line3"]);
    expect(offsets.get(logFile)).toBe(fs.statSync(logFile).size);
  });

  it("returns empty array when no new content", () => {
    fs.writeFileSync(logFile, "line1\nline2\n");
    readNewLogLines(logFile, offsets); // first read

    const lines = readNewLogLines(logFile, offsets);

    expect(lines).toEqual([]);
  });

  it("returns only new lines on subsequent reads", () => {
    fs.writeFileSync(logFile, "line1\nline2\n");
    readNewLogLines(logFile, offsets); // first read

    fs.appendFileSync(logFile, "line3\nline4\n");
    const lines = readNewLogLines(logFile, offsets);

    expect(lines).toEqual(["line3", "line4"]);
  });

  it("returns empty array when file does not exist", () => {
    const nonExistent = path.join(tmpDir, "nope.log");

    const lines = readNewLogLines(nonExistent, offsets);

    expect(lines).toEqual([]);
  });

  it("handles file truncation by resetting offset", () => {
    fs.writeFileSync(logFile, "long line content here\nanother long line\n");
    readNewLogLines(logFile, offsets);

    // Truncate file with new shorter content
    fs.writeFileSync(logFile, "new\n");
    const lines = readNewLogLines(logFile, offsets);

    expect(lines).toEqual(["new"]);
    expect(offsets.get(logFile)).toBe(fs.statSync(logFile).size);
  });

  it("handles multiple files independently", () => {
    const logFile2 = path.join(tmpDir, "test2.log");
    fs.writeFileSync(logFile, "a1\na2\n");
    fs.writeFileSync(logFile2, "b1\n");

    const lines1 = readNewLogLines(logFile, offsets);
    const lines2 = readNewLogLines(logFile2, offsets);

    expect(lines1).toEqual(["a1", "a2"]);
    expect(lines2).toEqual(["b1"]);

    // Append only to file2
    fs.appendFileSync(logFile2, "b2\n");
    const newLines1 = readNewLogLines(logFile, offsets);
    const newLines2 = readNewLogLines(logFile2, offsets);

    expect(newLines1).toEqual([]);
    expect(newLines2).toEqual(["b2"]);
  });

  it("handles lines without trailing newline", () => {
    fs.writeFileSync(logFile, "line1\nline2");

    const lines = readNewLogLines(logFile, offsets);

    expect(lines).toEqual(["line1", "line2"]);
  });

  it("removes deleted file from offsets map", () => {
    fs.writeFileSync(logFile, "data\n");
    readNewLogLines(logFile, offsets);
    expect(offsets.has(logFile)).toBe(true);

    fs.unlinkSync(logFile);
    const lines = readNewLogLines(logFile, offsets);

    expect(lines).toEqual([]);
    expect(offsets.has(logFile)).toBe(false);
  });
});
