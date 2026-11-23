---
'@e2e-dev/core': patch
---

An action the agent sends in the same turn as `complete_step` now runs. Before, `agent.act` skipped it and the step still passed. The verdict now waits for the calls sent before it in the turn, and is refused when one of them failed or the last one changed nothing. Calls sent after it do not run. The agent is also told that a step which only asks for actions may end in the turn of its last action, without another model call.
