# Domain rules: Orders core

Source: shop@0123abc

## Rules
### R1. Orders need a positive total
- Rule: an order whose total is zero or less cannot be placed. `Shop.Core/OrderService.cs:3`
- Basis: implemented
- Applies to: placing an order
- Tested: yes `Shop.Core.Tests/OrderServiceTests.cs:2`
### R2. Free shipping above a threshold
- Rule: shipping is free when the total is over 1000, otherwise 9.9. `Shop.Core/OrderService.cs:7`
- Basis: implemented
- Applies to: shipping calculation
- Tested: no
### R3. Cancelling an order sets its status
- Rule: cancelling sets the status to Cancelled. `Shop.Core/OrderService.cs:9`
- Basis: implemented
- Applies to: order cancellation
- Tested: no

## States and calculations
- Order status becomes "Cancelled" on cancel; no code reopens it. `Shop.Core/OrderService.cs:9`

## Permissions
- None found.

## Open Questions
- **Q1.** The document says orders over 500 ship free, but the code uses 1000. Which is intended?
  - Why it matters: customers are charged shipping between 500 and 1000 today.
  - Suggested default: none
- **Q2.** The document says a manager can reopen a cancelled order; no code does this. Is the feature missing?
  - Why it matters: a ticket may assume it exists.
  - Suggested default: none
