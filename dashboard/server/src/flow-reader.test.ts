import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import {
  readWorkflowJson,
  readOutputContent,
  listAllFlows,
} from "./flow-reader.js";
import type { WorkflowState } from "@devteam-dashboard/shared";

function createTmpDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), "flow-reader-test-"));
}

function makeWorkflow(overrides: Partial<WorkflowState> = {}): WorkflowState {
  return {
    flowId: "flow_test_001",
    jiraKey: "TEST-1",
    status: "running",
    currentStep: "clarifier",
    startedAt: "2025-01-01T00:00:00.000Z",
    steps: {
      clarifier: "running",
      architect: "waiting",
      planner: "waiting",
      implementer: "waiting",
      verifier: "waiting",
    },
    ...overrides,
  };
}

describe("readWorkflowJson", () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = createTmpDir();
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it("should parse a valid workflow.json", () => {
    const workflow = makeWorkflow();
    fs.writeFileSync(
      path.join(tmpDir, "workflow.json"),
      JSON.stringify(workflow),
    );

    const result = readWorkflowJson(tmpDir);
    expect(result).not.toBeNull();
    expect(result!.flowId).toBe("flow_test_001");
    expect(result!.jiraKey).toBe("TEST-1");
    expect(result!.status).toBe("running");
  });

  it("should return null when directory does not exist", () => {
    const result = readWorkflowJson("/nonexistent/path/flow_xyz");
    expect(result).toBeNull();
  });

  it("should return null when workflow.json is missing", () => {
    const result = readWorkflowJson(tmpDir);
    expect(result).toBeNull();
  });

  it("should return null on invalid JSON", () => {
    fs.writeFileSync(path.join(tmpDir, "workflow.json"), "{invalid json!!}");
    const result = readWorkflowJson(tmpDir);
    expect(result).toBeNull();
  });

  it("should return null when flowId is missing", () => {
    fs.writeFileSync(
      path.join(tmpDir, "workflow.json"),
      JSON.stringify({ status: "running" }),
    );
    const result = readWorkflowJson(tmpDir);
    expect(result).toBeNull();
  });

  it("should return null when status is missing", () => {
    fs.writeFileSync(
      path.join(tmpDir, "workflow.json"),
      JSON.stringify({ flowId: "test" }),
    );
    const result = readWorkflowJson(tmpDir);
    expect(result).toBeNull();
  });
});

describe("readOutputContent", () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = createTmpDir();
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it("should read markdown content and metadata", () => {
    const mdContent = "# Architecture\n\nSome design notes.";
    const filePath = path.join(tmpDir, "architecture.md");
    fs.writeFileSync(filePath, mdContent);

    const result = readOutputContent(filePath);
    expect(result).not.toBeNull();
    expect(result!.content).toBe(mdContent);
    expect(result!.metadata.size).toBe(Buffer.byteLength(mdContent));
    expect(result!.metadata.lastModified).toMatch(/^\d{4}-\d{2}-\d{2}T/);
  });

  it("should return null for nonexistent file", () => {
    const result = readOutputContent("/nonexistent/file.md");
    expect(result).toBeNull();
  });
});

describe("listAllFlows", () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = createTmpDir();
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it("should return empty record for nonexistent directory", () => {
    const result = listAllFlows("/nonexistent/directory");
    expect(result).toEqual({});
  });

  it("should return empty record for empty directory", () => {
    const result = listAllFlows(tmpDir);
    expect(result).toEqual({});
  });

  it("should scan all valid flow directories", () => {
    // Create two valid flows
    const flow1Dir = path.join(tmpDir, "flow_001");
    const flow2Dir = path.join(tmpDir, "flow_002");
    fs.mkdirSync(flow1Dir);
    fs.mkdirSync(flow2Dir);

    fs.writeFileSync(
      path.join(flow1Dir, "workflow.json"),
      JSON.stringify(makeWorkflow({ flowId: "flow_001", jiraKey: "A-1" })),
    );
    fs.writeFileSync(
      path.join(flow2Dir, "workflow.json"),
      JSON.stringify(
        makeWorkflow({
          flowId: "flow_002",
          jiraKey: "A-2",
          status: "completed",
        }),
      ),
    );

    const result = listAllFlows(tmpDir);
    expect(Object.keys(result)).toHaveLength(2);
    expect(result["flow_001"]!.jiraKey).toBe("A-1");
    expect(result["flow_002"]!.status).toBe("completed");
  });

  it("should skip directories with invalid workflow.json", () => {
    const validDir = path.join(tmpDir, "flow_valid");
    const invalidDir = path.join(tmpDir, "flow_bad");
    const noJsonDir = path.join(tmpDir, "flow_empty");
    fs.mkdirSync(validDir);
    fs.mkdirSync(invalidDir);
    fs.mkdirSync(noJsonDir);

    fs.writeFileSync(
      path.join(validDir, "workflow.json"),
      JSON.stringify(makeWorkflow({ flowId: "flow_valid" })),
    );
    fs.writeFileSync(path.join(invalidDir, "workflow.json"), "broken{{{");

    const result = listAllFlows(tmpDir);
    expect(Object.keys(result)).toHaveLength(1);
    expect(result["flow_valid"]).toBeDefined();
  });

  it("should skip regular files (non-directories)", () => {
    // Create a file at the top level (not a directory)
    fs.writeFileSync(path.join(tmpDir, "some-file.txt"), "hello");

    const validDir = path.join(tmpDir, "flow_ok");
    fs.mkdirSync(validDir);
    fs.writeFileSync(
      path.join(validDir, "workflow.json"),
      JSON.stringify(makeWorkflow({ flowId: "flow_ok" })),
    );

    const result = listAllFlows(tmpDir);
    expect(Object.keys(result)).toHaveLength(1);
    expect(result["flow_ok"]).toBeDefined();
  });
});
