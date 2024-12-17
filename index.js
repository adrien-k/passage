#!/usr/bin/env node

import yargs from "yargs/yargs";
import { hideBin } from "yargs/helpers";
import version from "./src/version.js";

import { loggerFactory, errorMessage } from "./src/logger.js";
import relay from "./src/relay/index.js";
import expose from "./src/expose/index.js";
import logo from "./src/logo.js";
import { settings, saveSetting } from "./src/config.js";

yargs(hideBin(process.argv))
  .scriptName("couloir")
  .version(false)
  .middleware((argv) => ({
    ...settings,
    ...argv,
  }))
  .middleware((argv) => ({
    ...argv,
    relayPort: argv.relayPort || (argv.http ? 80 : 443),
    log: loggerFactory(argv),
  }))
  .command("version", "Show the current version\n", () => {
    console.log(version);
  })
  .command(
    "relay <domain>",
    "Start the relay server on port 443 (or --port), and cert validation on port 80.\n\n  \
     Note that if you use --http option, it will only run the relay server on port 80 (or --port option).\n\n",
    (yargs) => {
      return yargs
        .positional("domain", {
          describe: "Domain under which to couloir hosts will be created.",
        })
        .option("relay-port", {
          alias: "port",
          describe: "Port on which the relay will be exposed. Default 443, or 80 in HTTP mode.",
          type: "integer",
        })
        .option("http", {
          describe: "When enabled, the relay will serve http traffic instead of https.",
          type: "boolean",
          default: false,
        })
        .options("password", {
          describe: `Require a password to access the relay.${settings["password"] ? "\n[default: <hidden>]" : ""}`,
          type: "string",
        })
        .option("email", {
          describe: "Email used for Let's Encrypt cert generation",
          default: settings["email"] || "test@example.com",
        });
    },
    async (argv) => {
      console.log(logo(`Relay Server | Version ${version}`, { stdout: true, center: true }));
      if (argv.password && argv.http) {
        console.warn(
          "Warning: password protection is not recommended in HTTP-only mode as the password will be sent in plain text to the relay. Use with caution.\n",
        );
      }
      await relay(argv).start();
    },
  )
  .command(
    ["expose <local-port>", "$0 <local-port>"],
    "Expose the given local port on the given remote hostname.\n",
    (yargs) =>
      yargs
        .positional("local-port", {
          describe: "Local port to proxy to.",
          type: "integer",
        })
        .option("relay-host", {
          alias: "on",
          type: "string",
          describe: "Hostname of the relay server.",
        })
        .option("name", {
          alias: "as",
          describe: "Name for the couloir subdomain. By default it will be couloir.<relay-host>.",
        })
        .option("relay-port", {
          describe: "Port on which the relay is running if not the default port",
          type: "integer",
        })
        .option("relay-ip", {
          describe: "Connect to the relay using an IP address instead of the given hostname.",
        })
        .option("local-host", {
          describe: "Local host to proxy to if not localhost.",
          default: "localhost",
        })
        .options("override-host", {
          describe: "Override the host header in the request.",
        })
        .option("http", {
          describe: "Must be enabled to connect to a relay running in HTTP mode.",
          type: "boolean",
          default: false,
        })
        .options("password", {
          describe: `Password to access the relay, if required.${settings["password"] ? "\n[default: <hidden>]" : ""}`,
          type: "string",
        }),
    async (argv) => {
      console.log(logo(`Host Server | Version ${version}`, { stdout: true, center: true }));
      await expose(argv).start();
    },
  )
  .command(
    "set <config> [value]",
    "Set default values for the `relay-host`, `relay-port` and `password` values",
    (yargs) =>
      yargs
        .positional("config", {
          describe: "Setting to persist",
        })
        .positional("value", {
          describe: "Value to persist for the setting. Providing no value will clear the setting.",
        }),
    async (argv) => {
      saveSetting(argv.config, argv.value);
      console.log(`Setting "${argv.config}" saved.`);
    },
  )
  .option("verbose", {
    alias: "v",
    type: "boolean",
    default: false,
  })
  .demandCommand(1)
  .fail((msg, err, yargs) => {
    const verbose = process.argv.includes("-v") || process.argv.includes("-verbose");
    if (msg) {
      console.log(yargs.help());
      console.error("\n" + msg);
    } else if (err) {
      console.error(errorMessage(err, { verbose }));
    }
    process.exit(-1);
  })
  .showHelpOnFail(false)
  .strict()
  .parse();
