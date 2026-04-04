## Plan: 24h AI Canvas MVP

Build a collaborative whiteboard MVP where users can trigger an on-canvas AI agent, and the agent responds by mutating shared canvas state in real time. The fastest reliable approach is React + TypeScript + tldraw on frontend, Node + TypeScript backend, tldraw sync server for shared state, and Claude tool-calling for structured canvas actions. Prioritize end-to-end reliability and demo clarity over feature breadth.

**Steps**
1. Phase 0 - Repo bootstrap and contracts (Hour 0-2): Initialize monorepo/workspace with frontend app, backend API/agent service, and sync server package. Define shared TypeScript types for tool schemas and canvas action envelopes so frontend/backend agree on payloads. This is a hard dependency for all later work.
2. Phase 1 - Shared canvas foundation (Hour 2-6): Integrate tldraw editor, connect to WebSocket sync room, and validate multi-client edits (2 browser tabs minimum). Implement stable room/session IDs and connection status UI. Depends on step 1.
3. Phase 2 - Agent trigger and context builder (Hour 4-10): Build trigger UX using @agent mention in text shape plus a sidebar fallback trigger. Implement context builder with viewport windowing + margin and cap shape count. Add recency weighting and minimal semantic compression for grouped/clustered content. Depends on step 1; can run in parallel with step 2 after type contracts are set.
4. Phase 3 - Claude tool loop and executor (Hour 8-14): Implement backend Claude streaming endpoint using tool definitions for place_sticky, draw_arrow, cluster_shapes, and summarize_region. Parse streaming tool calls, validate arguments, and emit canvas action events to clients. Add idempotency key per agent turn to avoid duplicate mutations on reconnect/retry. Depends on steps 1 and 3.
5. Phase 4 - Wire full loop to tldraw mutations (Hour 12-17): Execute validated tool calls against editor store through a mutation adapter layer. Batch related mutations into single history transactions so undo/redo stays coherent. Ensure remote vs local source filtering avoids recursive retriggers. Depends on steps 2 and 4.
6. Phase 5 - Reliability, guardrails, and UX polish (Hour 16-21): Add error handling states (agent timeout, malformed tool call, sync disconnect), request cancellation, loading indicators, and retry affordances. Add safety limits (max operations per turn, max shape creation burst). Depends on step 5.
7. Phase 6 - Demo hardening and fallback path (Hour 20-24): Freeze scope, run scripted demo flow, prepare seeded canvas examples, and create fallback mode where AI response is rendered as suggested actions if tool execution fails. Must-have sync remains enabled. Depends on all previous steps.
8. Parallel ownership plan for 4 builders: Builder A owns tldraw + sync integration, Builder B owns trigger UX + context builder, Builder C owns Claude tool loop backend, Builder D owns mutation adapter + testing/demo harness. Daily-style checkpoints every 3 hours to integrate and cut scope quickly.
9. Stretch lane (only if core passes verification by Hour 18): Add generate_image tool via async job + placeholder shape update flow. This is explicitly non-blocking and cut first if instability appears.

**Relevant files**
- /app/frontend/src/App.tsx - Mount tldraw canvas, room wiring, and top-level agent interaction state.
- /app/frontend/src/features/agent/AgentTrigger.tsx - @agent detection UI and manual fallback trigger.
- /app/frontend/src/features/agent/contextBuilder.ts - Viewport filtering, recency weighting, and compression logic.
- /app/frontend/src/features/canvas/mutationAdapter.ts - Safe mapping of tool calls to editor.store mutations.
- /app/frontend/src/features/sync/syncClient.ts - WebSocket room connection and connection health.
- /app/backend/src/server.ts - API routes and streaming endpoint orchestration.
- /app/backend/src/agent/claudeClient.ts - Anthropic client and stream handling.
- /app/backend/src/agent/tools.ts - Tool schemas and argument validators.
- /app/backend/src/agent/toolExecutor.ts - Server-side execution policy and action envelope emission.
- /app/backend/src/types/contracts.ts - Shared request/response + tool action types.
- /app/sync-server/src/index.ts - tldraw sync server bootstrap and room lifecycle.
- /app/e2e/demo-smoke.spec.ts - End-to-end deterministic demo path checks.

**Verification**
1. Multi-client sync check: open two clients in same room and verify bidirectional shape create/edit/delete with under 300ms local network latency.
2. Trigger flow check: create text shape with @agent and verify trigger appears exactly once per edit finalization.
3. Context window check: move viewport and confirm only in-window shapes plus margin are sent; verify token budget cap remains under configured threshold.
4. Tool execution check: run deterministic prompt and verify each tool mutation appears on canvas and in action logs.
5. Undo/redo check: one agent turn should undo as a coherent batch, not as dozens of micro-operations.
6. Failure-path check: simulate Claude timeout and malformed tool arguments, confirm graceful error UI and no partial corrupt writes.
7. Demo rehearsal check: complete scripted story from blank canvas to clustered map with arrows in under 2 minutes.
8. Optional stretch validation: generate_image can fail silently to placeholder without impacting core collaborative flow.

**Decisions**
- Include scope: collaborative tldraw canvas, real-time sync (must-have), @agent trigger, tool-driven mutations, and baseline summarization/cluster behavior.
- Exclude from 24h core: voice input, proactive autonomous agent behavior, persistent long-term memory, runway/video generation.
- Image generation is stretch-only and implemented behind feature flag.
- Prefer deterministic, constrained tools over free-form AI drawing commands to improve reliability.

**Further Considerations**
1. Deployment choice recommendation: single region deploy (frontend static + backend/sync container) to reduce latency and demo risk.
2. Security recommendation: use temporary hackathon API key vaulting on backend only; never expose provider keys to frontend.
3. Observability recommendation: add lightweight structured logs per agent turn (turn_id, tool_count, duration_ms, failures) for rapid debugging during demo prep.
