I'm consolidating what my AI assistants know about me into one personal knowledge base. Please export everything you have about me and my work.

1. List every stored memory, saved preference, and custom instruction you have, verbatim where possible. Mark these origin: memory or origin: custom_instructions.
2. Then list durable things you can infer from our past conversations that are not stored yet: my projects, tools I use, people I work with, recurring tasks and how I like them done, and where my data lives. Mark these origin: inferred_from_chats and give a confidence.
3. Include corrections I've made to you, as kind: instruction.
4. Skip one-off details, anything about other people that isn't work-related, and any passwords, keys, or account numbers.

Reply with ONE fenced yaml code block and nothing else, using exactly this schema:

```yaml
export:
  tool: {{TOOL}}
  prompt_version: 1
  exported_at: {{TODAY}}
  complete: true           # your own judgment: false if anything was left out
items:
  - kind: preference       # preference | fact | project | procedure | data_source | instruction | person
    title: Short title
    content: The memory or fact, verbatim where possible.
    scope: global          # global | project:<slug> | tool:<name>
    origin: memory         # memory | custom_instructions | project_files | inferred_from_chats
    saved_at: unknown      # YYYY-MM-DD when you know it
    confidence: high       # high | medium | low
gaps:
  - Things that would help you help me that you don't know.
```

One item per fact, no merging. If the list is too long for one reply, set complete to false and say so after the code block; I'll ask for the rest.
