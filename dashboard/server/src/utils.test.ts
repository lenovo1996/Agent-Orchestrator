import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { getOutputFilename } from "./utils.js";

describe("getOutputFilename", () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "dashboard-utils-test-"));
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it("reads custom agent output filenames from team.json next to scripts/", () => {
    const scriptDir = path.join(tmpDir, "scripts");
    fs.mkdirSync(scriptDir);
    fs.writeFileSync(
      path.join(tmpDir, "team.json"),
      JSON.stringify({
        members: {
          analyzer: {
            outputs: ["output/analyzer.md"],
          },
          "refactor-planner": {
            outputs: ["output/refactor-plan.md"],
          },
        },
      }),
    );

    expect(getOutputFilename("analyzer", scriptDir)).toBe("analyzer.md");
    expect(getOutputFilename("refactor-planner", scriptDir)).toBe(
      "refactor-plan.md",
    );
  });
});
