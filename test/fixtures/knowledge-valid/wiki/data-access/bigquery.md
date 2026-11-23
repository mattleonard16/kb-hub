---
type: data_source
title: Revenue data in BigQuery
description: Revenue lives in BigQuery table finance.revenue; ARR column is arr_usd.
scope: global
status: stable
sensitivity: personal
confidence: high
tags: [revenue, arr, finance]
sources:
  - resource: inbox/processed/2026-11-22-claude-code.yaml
    origin: project_files
verified: [{ by: "human:matt", at: 2026-11-24 }]
---
Query `finance.revenue`. The ARR column was renamed from revenue_usd to arr_usd.
