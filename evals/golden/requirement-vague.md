# Requirement: Faster export

## Problem Statement
The export is reported as too slow, but no figure, data size or user complaint is given.

## Goal
Reduce the time the export takes for the case users care about.

## Scope
### In
- Time taken by `exportAll`
### Out
- Changing the export format

## Acceptance Criteria
1. The export of the agreed reference data set finishes within the agreed time.

## Assumptions
- "Faster" refers to wall-clock time of `exportAll`, not to memory use.

## Open Questions
- **Q1.** How slow is it today, and what time would count as fast enough?
  - Why it matters: without a target the work cannot be called done.
  - Suggested default: none
- **Q2.** How many rows does a typical slow export have?
  - Why it matters: it decides what to measure.
  - Suggested default: 100,000 rows
