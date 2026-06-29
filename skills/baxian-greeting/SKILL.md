---
name: baxian-greeting
description: One-time startup capability handshake. baxian force-loads this before assigning any task; emit the greeting signal per the baxian-signals skill to prove you can load skills and signal back through your pane.
disable-model-invocation: true
---

baxian force-loads this skill once, right after your REPL is ready and before any task is assigned. It verifies you can load a skill, reach the signal protocol, and signal baxian back through your pane.

Do exactly one thing: emit the `greeting` signal, following the **baxian-signals** skill for the wire format and emit rules.

```
[bx:greeting:<token>]
```

Substitute `<token>` with the value on the `token:` line of this message and emit the filled signal alone on its own line. Output nothing else.
