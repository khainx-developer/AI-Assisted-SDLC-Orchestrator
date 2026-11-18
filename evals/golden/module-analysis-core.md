# Module: Orders core

Source: shop@0123abc

## Purpose
Holds the order rules of the shop and the tests for them. `Shop.Core/OrderService.cs:1-7`

## Responsibilities
- Decides whether an order can be placed: a total of zero or less is rejected. `Shop.Core/OrderService.cs:4-5`
- Defines the order data (id and total). `Shop.Core/Order.cs:1`

## Public surface
- `OrderService.Place(Order)` - returns whether the order was accepted. `Shop.Core/OrderService.cs:3`
- `Order` - record with `Id` and `Total`. `Shop.Core/Order.cs:1`

## Dependencies
### Uses inside the repo
- None. `Shop.Core/Shop.Core.csproj`
### Uses outside the repo
- A payment gateway whose address comes from the environment variable PAYMENT_GATEWAY_URL; no call to it was found in this module. `Shop.Core/OrderService.cs:2`
### Used by
- Shop.Api, through a project reference. `Shop.Api/Shop.Api.csproj`
- Shop.Core.Tests, through a project reference. `Shop.Core.Tests/Shop.Core.Tests.csproj`

## Data and configuration
- Environment variable PAYMENT_GATEWAY_URL - read into a private field. `Shop.Core/OrderService.cs:2`
- Configuration keys Payment.Gateway, Payment.ApiKey and Features.GiftWrap exist in the settings file; no code in this module reads them. `Shop.Core/appsettings.json:1`

## Runtime and deployment
- Not found: no pipeline or deployment file for this module.

## Build and test
- Builds as a net8.0 library. `Shop.Core/Shop.Core.csproj:1`
- One xunit test checks that a zero total is rejected. `Shop.Core.Tests/OrderServiceTests.cs:2`

## Known risks and technical debt
- The gateway address is read but never used, so the payment path is not implemented here. `Shop.Core/OrderService.cs:2`
- Only the zero-total rule has a test. `Shop.Core.Tests/OrderServiceTests.cs:2`

## How to change it safely
- No instruction files or docs exist in the repo for this module.

## Open Questions
- **Q1.** Where is the payment gateway actually called?
  - Why it matters: the module page cannot describe the payment flow until the caller is known.
  - Suggested default: assume payment is not implemented yet.
