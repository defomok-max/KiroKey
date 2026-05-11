#!/usr/bin/env node
/**
 * kiro-router password CLI.
 *
 * Manages the persistent password stored at ~/.kiro-router/password
 * (mode 0600). The server reads this file automatically on startup,
 * so the user only has to set the password once.
 *
 *   npm run set-password                  # prompt interactively
 *   npm run set-password -- <password>    # set in one line
 *   npm run set-password -- --random      # generate a strong random one
 *   npm run set-password -- --show        # print the current password
 *   npm run set-password -- --clear       # delete the stored password
 *   npm run clear-password                # alias for --clear
 */

import { mkdirSync, writeFileSync, readFileSync, unlinkSync, existsSync } from "node:fs";
import { dirname } from "node:path";
import { createInterface } from "node:readline";
import { randomBytes } from "node:crypto";
import { passwordFilePath } from "../src/config.js";

function readPassword(): string | null {
  try {
    const raw = readFileSync(passwordFilePath(), "utf-8").trim();
    return raw === "" ? null : raw;
  } catch {
    return null;
  }
}

function writePassword(value: string): void {
  const path = passwordFilePath();
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  writeFileSync(path, value + "\n", { mode: 0o600 });
}

function clearPassword(): void {
  const path = passwordFilePath();
  if (existsSync(path)) unlinkSync(path);
}

async function prompt(question: string, hidden: boolean): Promise<string> {
  const rl = createInterface({ input: process.stdin, output: process.stdout, terminal: true });
  return new Promise<string>((resolve) => {
    if (hidden) {
      // Mute output while user types.
      const out = rl as unknown as { output: NodeJS.WritableStream; _writeToOutput?: (s: string) => void };
      out._writeToOutput = (s: string) => {
        if (s.includes(question)) out.output.write(s);
      };
    }
    rl.question(question, (answer) => {
      rl.close();
      if (hidden) process.stdout.write("\n");
      resolve(answer);
    });
  });
}

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const isClear = args.includes("--clear") || args.includes("-c") || args.includes("--clear-password");
  const isShow = args.includes("--show") || args.includes("--print");
  const isRandom = args.includes("--random") || args.includes("-r");
  const path = passwordFilePath();

  if (isShow) {
    const current = readPassword();
    if (current === null) {
      console.log("kiro-router: no password set (open access on bind address)");
      console.log("file:", path, "(does not exist)");
    } else {
      console.log("kiro-router: password is set");
      console.log("file:", path);
      console.log("value:", current);
    }
    return;
  }

  if (isClear) {
    if (existsSync(path)) {
      clearPassword();
      console.log("kiro-router: password cleared (" + path + " removed)");
      console.log("WARNING: the proxy is now open on its bind address. Restart the server.");
    } else {
      console.log("kiro-router: no password was set (" + path + " not found)");
    }
    return;
  }

  let value = args.find((a) => !a.startsWith("-")) ?? "";

  if (!value && isRandom) {
    value = randomBytes(24).toString("base64url");
    console.log("kiro-router: generated random password:");
    console.log("  " + value);
    console.log("Copy this — clients must send Authorization: Bearer <password>.");
  }

  if (!value) {
    const a = await prompt("New password (input hidden): ", true);
    const b = await prompt("Confirm password (input hidden): ", true);
    if (a !== b) {
      console.error("kiro-router: passwords did not match. Nothing written.");
      process.exit(1);
    }
    if (a.length < 8) {
      console.error("kiro-router: password must be at least 8 characters. Nothing written.");
      process.exit(1);
    }
    value = a;
  }

  writePassword(value);
  console.log("kiro-router: password saved to " + path + " (mode 0600).");
  console.log("Restart the server (npm start) for the new password to take effect.");
  console.log("Clients must send: Authorization: Bearer " + value);
}

main().catch((err) => {
  console.error("kiro-router: set-password failed:", err);
  process.exit(1);
});
