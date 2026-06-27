# Architecture Decision Records

Short records of the **why** behind the load-bearing structural decisions in the scheduling/money
domain. Each captures the context, the decision, the alternatives weighed, and the consequences —
so a future contributor can tell whether a constraint is essential or incidental before changing it.

For the *what* (the entity map + the rules), see [`../DOMAIN_MODEL.md`](../DOMAIN_MODEL.md); for the
*how* (the change playbook + checklist), see [`../EXTENDING_THE_DOMAIN.md`](../EXTENDING_THE_DOMAIN.md).

| ADR | Decision |
|---|---|
| [0001](./0001-registrations-cycles-split.md) | Split the overloaded `cycles` table into `registrations` (form) + `cycles` (training) |
| [0002](./0002-slot-is-price-source-of-truth.md) | The slot is the single source of truth for what a booking costs |
| [0003](./0003-mutation-boundary-facades.md) | Every domain write goes through a canonical facade / RPC, never a raw page-level mutation |
| [0004](./0004-rebooking-priority-claims.md) | Rebooking via priority-claim invites + a group captain who books all & pays once |

Format: each ADR is **Status · Context · Decision · Alternatives considered · Consequences**.
New ADRs get the next number; supersede rather than rewrite a decision.
