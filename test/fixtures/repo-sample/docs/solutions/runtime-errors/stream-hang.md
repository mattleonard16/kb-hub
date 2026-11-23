---
title: "Stream stays open after the done event"
problem_type: runtime_error
applies_when:
  - A streaming route does background work after the answer
symptoms:
  - The client sees the answer but the request never closes
---
Move background work into after().
