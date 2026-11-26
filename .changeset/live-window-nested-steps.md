---
"e2e": patch
---

The live window keeps showing a running step after another step inside it or beside it ends. An `agent.act` whose `onAction` hook took a screenshot used to lose its calls and its Thinking or Acting row for the rest of the act. A step that a timed-out attempt starts while its retry runs no longer replaces the retry's step in the window.
