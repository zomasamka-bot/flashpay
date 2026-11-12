"use strict";
const fs = require("node:fs"), path = require("node:path"), cp = require("node:child_process");
const root = path.resolve(__dirname, "..");
const compiler = require.resolve("typescript/bin/tsc");
const kernel = path.dirname(require.resolve("@flashpay/financial-kernel/package.json"));
// Compile the visible source tree so declaration paths never depend on pnpm's
// private store layout. Runtime workers stay at the original package entrypoints.
const result = cp.spawnSync(process.execPath, [compiler, "--project", path.join(root, "vendor/financial-kernel/tsconfig.json"), "--outDir", path.join(kernel, "dist")], { cwd: root, stdio: "inherit" });
if (result.error) throw result.error;
if (result.status !== 0) process.exit(result.status || 1);
for (const name of ["r36-operator-cli", "r36-automatic-lifecycle", "r36-certificate-worker", "r36-registration-operator"])
  if (!fs.existsSync(path.join(kernel, "dist/lib", name + ".js"))) throw Error("KERNEL_WORKER_MISSING");
console.log("KERNEL_WORKERS_BUILT_FROM_SOURCE");
