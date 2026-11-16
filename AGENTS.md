@/Users/nhatnp/.codex/RTK.md

## T3 orchestration

When running as the parent agent in T3 Code with its orchestration tools available,
use Codex to plan, assign work, review results, and integrate changes. Delegate
implementation to Cursor through T3's delegate_task tool, targeting
providerInstanceId "cursor" and model "grok-4.7", with role "implementation"
and target.options {"reasoning_effort": "medium"}.

Delegate web search, legal or financial work, and video or image related tasks
to Antigravity through T3's delegate_task tool, targeting providerInstanceId
"antigravity". Use its default model unless the user specifies one. This routing
takes precedence over Cursor for these task categories; use Cursor for other
implementation work.

For research, if Antigravity explicitly fails because its quota is exhausted,
continue directly in Codex. If Codex also exhausts its quota, delegate the research
to Cursor with providerInstanceId "cursor", model "grok-4.7", role "research",
and target.options {"reasoning_effort": "high"}. These quota fallbacks are
preauthorized; report each switch. Other provider failures do not authorize a switch.

Check orchestrator_capabilities before the first delegation and after a provider
change or error. If the selected provider or requested model is unavailable,
report it instead of switching providers, except for the research quota fallbacks above.

Give each child a complete task brief, relevant paths, constraints, and acceptance
criteria because it receives no parent conversation history. Use isolation
"worktree" for independent parallel changes; use shared isolation for work that
must operate on current uncommitted edits. Review the result and relevant checks
before integrating. Child agents should execute their assigned task without
delegating further unless explicitly asked. Outside T3, use the normal workflow.
