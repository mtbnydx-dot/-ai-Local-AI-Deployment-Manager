#!/usr/bin/env node

"use strict";

const fs = require("node:fs");

const marker = process.env.SUBSCRIPTION_PROXY_BROWSER_MARKER;
const dashboardUrl = process.argv[2] || "";

if (!marker || !dashboardUrl) {
  process.exit(1);
}

fs.writeFileSync(marker, dashboardUrl, "utf8");
