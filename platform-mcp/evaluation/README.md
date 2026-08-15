# MCP evaluation fixture

`evaluation.xml` contains ten independent, read-only questions for the deterministic fixture in `test/fixtures.ts`. The fixture timestamp is fixed at 2026-08-15 so direct-string answers do not drift with the live machine.

`npm test` starts the real MCP HTTP handler against that fixture, calls all 12 advertised tools through the official MCP client, derives every answer, and compares it with the XML. The production server never exposes a fixture switch and always reads the configured loopback services.
