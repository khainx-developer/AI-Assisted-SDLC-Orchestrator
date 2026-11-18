# Survey: shop

## Repository
A small .NET 8 shop back end: one web API and one core library with its tests. Nine files, three projects, all on net8.0.

## Modules
### M1. Orders core
- Projects and folders: `Shop.Core/`, `Shop.Core.Tests/`
- Responsibility: order rules (placing an order) and the unit tests for them.
- Kind: library
- Depends on: none
- Evidence: `Shop.Core/OrderService.cs:2`, `Shop.Core.Tests/Shop.Core.Tests.csproj`
- Priority: high. Most changed since 12 months ago (40 changes) and the API depends on it.
### M2. Shop API
- Projects and folders: `Shop.Api/`
- Responsibility: HTTP entry point that exposes order placement.
- Kind: api
- Depends on: M1
- Evidence: `Shop.Api/Program.cs:2`, `Shop.Api/Shop.Api.csproj`
- Priority: medium. Fewer changes (12) and a thin layer over the core.

## Coverage
Projects in the scan: 3. Assigned: 3. Unassigned: none.

## Cross-cutting concerns
- No authentication, logging or configuration code found in the three projects. `Shop.Api/Program.cs`

## Existing guidance
None found.

## Open Questions
- **Q1.** Is Shop.Core.Tests the only test project, or are API tests kept elsewhere?
  - Why it matters: it decides whether the API module needs its own test coverage section.
  - Suggested default: assume Shop.Core.Tests is the only one.
