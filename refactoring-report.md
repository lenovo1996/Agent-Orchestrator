# Web Dashboard Refactoring Report

## Refactoring Overview

Performed a focused, production-grade refactor to clean up the Web Dashboard application. The primary focus was identifying and eliminating unused features, legacy implementations, and dead code, particularly the entire unused "Parallel Execution" feature. All types, websocket events, state management, UI components, and API routes specifically built to support the deprecated parallel features have been safely excised while preserving full test coverage.

## Removed Files/Folders List

### Client
* `dashboard/client/src/components/parallel/ParallelOverview.tsx`
* `dashboard/client/src/components/parallel/QueueList.tsx`
* `dashboard/client/src/components/agent/StepDetail.tsx` (unused)
* `dashboard/client/src/components/agent/TokenDisplay.tsx` (unused)
* `dashboard/client/src/components/parallel` (deleted folder)

## New Project Structure Tree

```
dashboard
├── QUICK-START.md
├── README.md
├── check-status.sh
├── client
│   ├── index.html
│   ├── package.json
│   ├── postcss.config.js
│   ├── src
│   │   ├── App.tsx
│   │   ├── components
│   │   │   ├── agent
│   │   │   │   ├── AgentPanel.tsx
│   │   │   │   └── FlowActions.tsx
│   │   │   ├── flow
│   │   │   │   ├── FlowCard.tsx
│   │   │   │   ├── FlowList.tsx
│   │   │   │   ├── NewTaskDialog.tsx
│   │   │   │   └── StepIndicator.tsx
│   │   │   ├── layout
│   │   │   │   ├── Header.tsx
│   │   │   │   └── Sidebar.tsx
│   │   │   ├── log
│   │   │   │   ├── LogLine.tsx
│   │   │   │   └── LogViewer.tsx
│   │   │   ├── output
│   │   │   │   └── OutputPreview.tsx
│   │   │   └── ui
│   │   │       ├── badge.tsx
│   │   │       ├── card.tsx
│   │   │       ├── progress.tsx
│   │   │       ├── scroll-area.tsx
│   │   │       └── tabs.tsx
│   │   ├── globals.css
│   │   ├── hooks
│   │   │   ├── use-auto-scroll.test.ts
│   │   │   ├── use-auto-scroll.ts
│   │   │   └── use-socket-events.ts
│   │   ├── lib
│   │   │   ├── constants.ts
│   │   │   ├── format.test.ts
│   │   │   ├── format.ts
│   │   │   ├── socket.ts
│   │   │   └── utils.ts
│   │   ├── main.tsx
│   │   └── store
│   │       ├── use-dashboard-store.test.ts
│   │       └── use-dashboard-store.ts
│   ├── tailwind.config.ts
│   ├── tsconfig.json
│   ├── tsconfig.tsbuildinfo
│   ├── vite-env.d.ts
│   └── vite.config.ts
├── package-lock.json
├── package.json
├── server
│   ├── package.json
│   ├── src
│   │   ├── config.test.ts
│   │   ├── config.ts
│   │   ├── events.test.ts
│   │   ├── events.ts
│   │   ├── flow-reader.test.ts
│   │   ├── flow-reader.ts
│   │   ├── index.ts
│   │   ├── log-tailer.test.ts
│   │   ├── log-tailer.ts
│   │   ├── routes
│   │   │   ├── flows.test.ts
│   │   │   └── flows.ts
│   │   └── watcher.ts
│   ├── tsconfig.json
│   └── tsconfig.tsbuildinfo
├── shared
│   ├── package.json
│   ├── src
│   │   └── index.ts
│   ├── tsconfig.json
│   └── tsconfig.tsbuildinfo
└── tsconfig.json
```

## Remaining Technical Debt & Recommendations

* **Client Store Splitting**: The main Zustand `use-dashboard-store.ts` file handles connection, flows, UI selection, and log buffering states. Breaking this out into modular bounded contexts (e.g. `useFlowStore`, `useLogStore`) would improve scalability and testability as the application grows.
* **Server Dependency Injections**: Tests actively modify the local filesystem, such as the `flow-reader` and `log-tailer` tests interacting directly with the filesystem instead of injecting interfaces/abstractions. Refactoring to depend on abstractions over file I/O operations will dramatically ease server testing and test performance without leaving tmp dir artifacts.
* **Config Over-Responsibility**: `config.ts` recursively traverses folders up from the current directory using hardcoded relative paths logic to find `.dev-team/team.json`. An environment-variable or parameter-injection-based strategy for setting the core paths instead of manual path discovery would be more resilient and robust.
* **Error Handling Consolidation**: Some REST API handlers manually format standard error responses across `try-catch` structures. Consolidating this into reusable middleware components on the express app level would prevent duplication and unify the API's contract signature on failure scenarios.
