# Jira MCP Server

Local MCP server adapter for Jira Cloud issue/task operations.

## Setup

Install dependencies:

```bash
npm ci
```
copy `.env.example` to `.env`:

```bash
cp .env.example .env
vi .env
node server.js
```

`server.js` automatically loads `.env` from this directory.

Do not commit `.env` or any token/password values.

## Tools

- `search_issues`
- `get_issue`
- `get_comments`
- `create_issue`
- `list_transitions`
- `transition_issue`
- `add_comment`
