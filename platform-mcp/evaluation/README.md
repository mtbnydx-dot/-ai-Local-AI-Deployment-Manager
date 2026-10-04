# MCP evaluation fixture

`evaluation.xml` contains seventeen independent, read-only questions for the deterministic fixture in `test/fixtures.ts`. The fixture timestamp is fixed at 2026-08-15 so direct-string answers do not drift with the live machine.

`npm test` starts the real MCP HTTP handler against that fixture, calls every advertised tool through the official MCP client, derives every answer, and compares it with the XML. The count is asserted against `TOOL_NAMES`, so adding a tool without a question fails the suite rather than quietly leaving it unexercised. The production server never exposes a fixture switch and always reads the configured loopback services.

The four tools that reach the public internet are covered here, and the invariants around the text they return — that an injected instruction stays a string inside `data.*.content`, cannot forge a warning or flip the envelope, and cannot escape the fenced block in the text channel — are asserted in `test/protocol-surface.test.ts` against a deliberately hostile fixture page.
