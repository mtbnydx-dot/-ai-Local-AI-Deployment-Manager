# Privacy

This page says what the service records when you use the API, and what it does not.

## What is logged

For every API request the service keeps request metadata only:

- the time of the request
- the key id (never the key itself)
- the model and the endpoint
- token counts: input, cached input and output
- timings: time to first token and total duration
- the result: the HTTP status or the error code, and the request id
- the network address (IP) and the country derived from it

## What is not logged

The prompt and the response of an API request are not stored. The service keeps counts and timings, not content. The Playground in this portal keeps its transcript in your browser's memory only, and it is gone when you close the tab.

## How long it is kept

Request metadata is kept for {{RETENTION_DAYS}} days. After that the detailed rows are deleted and only aggregate totals remain.

## The chat site

Conversations in the Open WebUI chat site are different: that product stores your chats so you can come back to them, and the service owner may audit them. Do not put anything into it that you would not want the owner to read.

## Who can see what

- A key holder sees the model names and the aggregate load of the service, because the status and models pages show them.
- The owner sees the metadata above, per key.
- If the service is reached through Cloudflare, Cloudflare ends the TLS connection and can see the traffic that passes through it.
- Over a plain HTTP connection on a local network, traffic can be read by others on that network.

## Your key

The service stores only a hash of your key and a short preview. This portal keeps a pasted key in your browser's session storage for the tab only, and sends it only in the Authorization header to this site.
