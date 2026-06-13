#!/usr/bin/env node
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { CallToolRequestSchema, ListToolsRequestSchema } from "@modelcontextprotocol/sdk/types.js";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import dotenv from "dotenv";
import yaml from "js-yaml";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
dotenv.config({ path: path.join(__dirname, ".env"), quiet: true });

function loadJiraConfig() {
  const configPath = process.env.JIRA_CONFIG || path.join(os.homedir(), ".config/.jira/.config.yml");
  const cfg = fs.existsSync(configPath) ? yaml.load(fs.readFileSync(configPath, "utf8")) : {};
  const server = process.env.JIRA_SERVER || cfg?.server;
  const email = process.env.JIRA_EMAIL || cfg?.login;
  const token = process.env.JIRA_API_TOKEN || cfg?.password;
  if (!server || !email || !token) throw new Error("Missing Jira config: server/login/password");
  return { server: server.replace(/\/$/, ""), email, token };
}

function authHeader(email, token) {
  return { Authorization: `Basic ${Buffer.from(`${email}:${token}`).toString("base64")}` };
}

async function jiraFetch(apiPath, { method = "GET", query, body } = {}) {
  const { server, email, token } = loadJiraConfig();
  const url = new URL(`${server}/rest/api/3${apiPath}`);
  if (query) {
    for (const [k, v] of Object.entries(query)) {
      if (v === undefined || v === null || v === "") continue;
      url.searchParams.set(k, String(v));
    }
  }
  const res = await fetch(url, {
    method,
    headers: {
      Accept: "application/json",
      ...authHeader(email, token),
      ...(body ? { "Content-Type": "application/json" } : {}),
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  const textBody = await res.text();
  const data = textBody ? JSON.parse(textBody) : null;
  if (!res.ok) throw new Error(`Jira API error ${res.status} ${res.statusText}: ${textBody}`);
  return data;
}

function text(content) {
  return { content: [{ type: "text", text: typeof content === "string" ? content : JSON.stringify(content, null, 2) }] };
}

function adfFromText(rawText) {
  return {
    type: "doc",
    version: 1,
    content: rawText.split("\n").map((line) => ({
      type: "paragraph",
      content: line ? [{ type: "text", text: line }] : [],
    })),
  };
}

const server = new Server(
  { name: "mcp-jira-cloud-local", version: "0.1.0" },
  { capabilities: { tools: {} } }
);

server.setRequestHandler(ListToolsRequestSchema, async () => ({
  tools: [
    {
      name: "search_issues",
      description: "Search Jira issues by JQL",
      inputSchema: { type: "object", properties: { jql: { type: "string" }, maxResults: { type: "number", default: 20 } }, required: ["jql"] },
    },
    {
      name: "get_issue",
      description: "Get Jira issue details",
      inputSchema: { type: "object", properties: { issueKey: { type: "string" } }, required: ["issueKey"] },
    },
    {
      name: "get_comments",
      description: "Get Jira issue comments",
      inputSchema: {
        type: "object",
        properties: {
          issueKey: { type: "string" },
          maxResults: { type: "number", default: 20 },
          startAt: { type: "number", default: 0 },
          orderBy: { type: "string", default: "created" },
        },
        required: ["issueKey"],
      },
    },
    {
      name: "create_issue",
      description: "Create Jira issue/task. issueType default Task.",
      inputSchema: {
        type: "object",
        properties: {
          projectKey: { type: "string" },
          summary: { type: "string" },
          description: { type: "string" },
          issueType: { type: "string", default: "Task" },
        },
        required: ["projectKey", "summary"],
      },
    },
    {
      name: "list_transitions",
      description: "List available Jira status transitions for issue",
      inputSchema: { type: "object", properties: { issueKey: { type: "string" } }, required: ["issueKey"] },
    },
    {
      name: "transition_issue",
      description: "Move Jira issue status by transition id or transition/status name",
      inputSchema: { type: "object", properties: { issueKey: { type: "string" }, transitionId: { type: "string" }, transitionName: { type: "string" } }, required: ["issueKey"] },
    },
    {
      name: "add_comment",
      description: "Add Jira issue comment",
      inputSchema: { type: "object", properties: { issueKey: { type: "string" }, comment: { type: "string" } }, required: ["issueKey", "comment"] },
    },
  ],
}));

server.setRequestHandler(CallToolRequestSchema, async (req) => {
  const { name, arguments: args } = req.params;
  try {
    switch (name) {
      case "search_issues":
        return text(await jiraFetch("/search/jql", { query: { jql: args.jql, maxResults: args.maxResults || 20, fields: "summary,status,assignee,issuetype,project" } }));
      case "get_issue":
        return text(await jiraFetch(`/issue/${encodeURIComponent(args.issueKey)}`, { query: { fields: "summary,description,status,assignee,reporter,issuetype,project,created,updated" } }));
      case "get_comments":
        return text(await jiraFetch(`/issue/${encodeURIComponent(args.issueKey)}/comment`, { query: { startAt: args.startAt || 0, maxResults: args.maxResults || 20, orderBy: args.orderBy || "created" } }));
      case "create_issue": {
        const fields = { project: { key: args.projectKey }, summary: args.summary, issuetype: { name: args.issueType || "Task" } };
        if (args.description) fields.description = adfFromText(args.description);
        return text(await jiraFetch("/issue", { method: "POST", body: { fields } }));
      }
      case "list_transitions":
        return text(await jiraFetch(`/issue/${encodeURIComponent(args.issueKey)}/transitions`));
      case "transition_issue": {
        let transitionId = args.transitionId;
        if (!transitionId) {
          const data = await jiraFetch(`/issue/${encodeURIComponent(args.issueKey)}/transitions`);
          const wanted = String(args.transitionName || "").toLowerCase();
          const hit = data.transitions.find((t) => t.name.toLowerCase() === wanted || t.to?.name?.toLowerCase() === wanted);
          if (!hit) throw new Error(`Transition not found: ${args.transitionName}`);
          transitionId = hit.id;
        }
        await jiraFetch(`/issue/${encodeURIComponent(args.issueKey)}/transitions`, { method: "POST", body: { transition: { id: transitionId } } });
        return text({ ok: true, issueKey: args.issueKey, transitionId });
      }
      case "add_comment":
        return text(await jiraFetch(`/issue/${encodeURIComponent(args.issueKey)}/comment`, { method: "POST", body: { body: adfFromText(args.comment) } }));
      default:
        throw new Error(`Unknown tool: ${name}`);
    }
  } catch (e) {
    return text(`ERROR: ${e?.message || String(e)}`);
  }
});

const transport = new StdioServerTransport();
await server.connect(transport);
