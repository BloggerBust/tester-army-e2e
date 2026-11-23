---
"@e2e-dev/core": patch
---

Values the agent types in a row into several fields, with only taps or `Tab` presses between them, are judged joined: when they join into a code the screen showed, the recording becomes a gap from the first piece, so recordings made after this fix do not replay the last run's code into boxes that declare no `autocomplete="one-time-code"`. This reaches boxes the web engine reports without that purpose, and every field on iOS and Android, where the mobile engine reports no one-time-code purpose at all. Recordings made before this fix still replay once until their step is re-recorded. The accepted cost: unrelated short values typed in a row whose join happens to match text on screen are also left out of the recording and run live.
