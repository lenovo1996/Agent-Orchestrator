# MCP Bitbucket Cloud (PR review)

This is a small MCP server (stdio) that wraps Bitbucket Cloud REST API for pull request review.

## Setup

Create env vars (recommended: export in your shell profile or a `.env` you source):

```bash
export BITBUCKET_USERNAME="lephi96"
export BITBUCKET_APP_PASSWORD="<paste-your-app-password-here>"
```

## Use via mcporter

Call tools directly:

```bash
mcporter call --stdio "node ./server.js" parse_pr_url prUrl="https://bitbucket.org/jinjer-products/<repo>/pull-requests/123"

mcporter call --stdio "node ./server.js" get_pullrequest workspace=jinjer-products repo_slug=<repo> prId=123

mcporter call --stdio "node ./server.js" get_diff workspace=jinjer-products repo_slug=<repo> prId=123

mcporter call --stdio "node ./server.js" get_diffstat workspace=jinjer-products repo_slug=<repo> prId=123

mcporter call --stdio "node ./server.js" add_comment workspace=jinjer-products repo_slug=<repo> prId=123 content="Looks good" \
  filePath="src/index.ts" line=42

mcporter call --stdio "node ./server.js" approve workspace=jinjer-products repo_slug=<repo> prId=123
```

## Notes
- This uses Bitbucket Cloud API base: `https://api.bitbucket.org/2.0`
- Auth is Basic using `username:appPassword`.
