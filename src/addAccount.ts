#!/usr/bin/env node

import { runAddAccountCli } from "./cli/addAccount.js";

try {
  await runAddAccountCli(process.argv.slice(2));
} catch (err) {
  process.stderr.write(`Failed to link account: ${(err as Error).message}\n`);
  process.exit(1);
}
