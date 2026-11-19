#!/usr/bin/env node
import { runCli } from "./cliMain.js";
import { KeyringStore } from "./credentials.js";
import { describeError } from "./errors.js";

runCli(process.argv.slice(2), {
  env: process.env,
  store: new KeyringStore(),
  out: (line) => process.stdout.write(`${line}\n`),
  err: (line) => process.stderr.write(`${line}\n`),
}).then(
  (code) => {
    if (code >= 0) process.exitCode = code;
  },
  (err: unknown) => {
    process.stderr.write(`butlerbridge: ${describeError(err)}\n`);
    process.exitCode = 1;
  },
);
