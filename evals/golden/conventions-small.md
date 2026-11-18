# Conventions: shop

Source: shop@0123abc

## Build and run
- The solution is built with `dotnet build Shop.sln`. `README.md:3`

## Test
- Tests use xunit and live in Shop.Core.Tests; they run with `dotnet test`, and CI runs `dotnet test Shop.sln` on Windows. `Shop.Core.Tests/OrderServiceTests.cs:2` `.github/workflows/ci.yml:7`

## Data and migrations
- Not found. No schema scripts or migration tooling are in the repository.

## Code structure and naming
- Money rules live in Shop.Core and the API only calls it. `README.md:3` `Shop.Core/OrderService.cs:2`

## Configuration and secrets
- Configuration comes from appsettings.json with the keys `Payment:ApiKey` and `Features:GiftWrap`; how the secret is supplied in each environment is not shown. `Shop.Api/appsettings.json:1`

## Branching, review and delivery
- A GitHub Actions workflow runs on every push. `.github/workflows/ci.yml:2`

## Risky areas
- None found.

## Open Questions
- **Q1.** How are the payment key and other secrets supplied outside local development?
  - Why it matters: coding and deployment sessions must not put secrets in configuration files.
  - Suggested default: none
