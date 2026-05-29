---
name: type_correction
description: >-
  Fixes clear typographical and spelling mistakes in prose (Markdown, comments,
  strings) without changing meaning, tone, or author style. Use when cleaning
  typos before commit, when the user names type_correction, or when another
  skill (e.g. smart-commit) asks to apply this pass.
---

# Type correction

## Scope (allowed)

- Obvious **misspellings** and **keyboard slips** (e.g. `beyong` -> `beyond`, duplicated letters).
- Clear **wrong character** in a word where intent is unambiguous.
- **Broken** Markdown or code that is clearly accidental (e.g. `` ` `` only half-closed) **if** the fix is one character and does not alter voice.

## Out of scope (forbidden)

- Do **not** rewrite sentences, reorder paragraphs, or "polish" clarity.
- Do **not** change the author's **voice**, **register**, **Korean vs English mix**, or **explanation depth**.
- Do **not** impose a different **formatting style** (bullet vs prose, heading levels, table layout) unless the line is objectively broken (e.g. invalid MD that renders wrong because of a single typo).
- Do **not** rename identifiers, APIs, or file paths except for an obvious typo in **narrative text only** (not in code symbols the compiler relies on).

## How to apply

1. Restrict edits to files (or hunks) in the current task scope.
2. Prefer the **smallest diff** that fixes the typo; one word or one letter is ideal.
3. If a line could be "wrong" stylistically but not orthographically, **leave it alone**.
