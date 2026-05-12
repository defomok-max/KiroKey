import { linkAccount, type LinkAccountOptions } from "../kiro/linkAccount.js";

const MIN_TIMEOUT_SEC = 30;
const MAX_TIMEOUT_SEC = 30 * 60;

export async function runAddAccountCli(argv: string[]): Promise<void> {
  const options = parseArgs(argv);
  const result = await linkAccount({ ...options, out: process.stdout });
  process.stdout.write(`Linked account: ${result.account.id} (${result.account.label})\n`);
  process.stdout.write(`Token cache file: ${result.path}\n`);
  process.stdout.write("If kiro-router is already running, call POST /admin/reload or restart it.\n");
}

function usage(code = 1): never {
  process.stderr.write(`Usage:
  npm run add-account -- --google [--label name]
  npm run add-account -- --github [--label name]
  npm run add-account -- --builder-id [--label name] [--region us-east-1]
  npm run add-account -- --idc --start-url https://example.awsapps.com/start [--region us-east-1]

Options:
  --no-browser       Print the login URL/code but do not open a browser
  --cache-dir PATH   Write token JSON files to this cache dir
  --timeout SEC      Login timeout in seconds (30..1800, default 600)
`);
  process.exit(code);
}

function parseArgs(argv: string[]): LinkAccountOptions {
  const options: Partial<LinkAccountOptions> = {};
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    switch (arg) {
      case "--google":
        options.method = "google";
        break;
      case "--github":
        options.method = "github";
        break;
      case "--builder-id":
        options.method = "builder-id";
        break;
      case "--idc":
        options.method = "idc";
        break;
      case "--label":
        options.label = value(argv, ++i, arg);
        break;
      case "--region":
        options.region = value(argv, ++i, arg);
        break;
      case "--start-url":
        options.startUrl = value(argv, ++i, arg);
        break;
      case "--cache-dir":
        options.cacheDir = value(argv, ++i, arg);
        break;
      case "--timeout": {
        const raw = value(argv, ++i, arg);
        const seconds = Number.parseInt(raw, 10);
        if (`${seconds}` !== raw || seconds < MIN_TIMEOUT_SEC || seconds > MAX_TIMEOUT_SEC) {
          process.stderr.write(`--timeout must be an integer from ${MIN_TIMEOUT_SEC} to ${MAX_TIMEOUT_SEC}\n`);
          usage();
        }
        options.timeoutMs = seconds * 1000;
        break;
      }
      case "--no-browser":
        options.openBrowser = false;
        break;
      case "-h":
      case "--help":
        usage(0);
        break;
      default:
        process.stderr.write(`Unknown option: ${arg}\n`);
        usage();
    }
  }
  if (!options.method) usage();
  if (options.method === "idc" && !options.startUrl) usage();
  return options as LinkAccountOptions;
}

function value(argv: string[], index: number, flag: string): string {
  const raw = argv[index];
  if (!raw || raw.startsWith("--")) {
    process.stderr.write(`Missing value for ${flag}\n`);
    usage();
  }
  return raw;
}
