"use strict";

// HUB-13a (docs/overhaul/03-hub.md §15, §20): the vllm manager's job routes and
// SSE `jobs` relay as signed hub shims, against a fake hub that verifies every
// signature with internal-auth.js. Temporary AI root and ports only; no live
// service is called and no process is spawned.

const path = require("node:path");
const express = require("express");
const { runHubShimSuite } = require("../../manager-core/test/helpers/hub-shim-suite");

runHubShimSuite({ managerId: "vllm", serverPath: path.join(__dirname, "..", "server.js"), express });
