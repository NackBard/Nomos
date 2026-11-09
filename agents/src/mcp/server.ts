#!/usr/bin/env node
// Nomos MCP server over stdio (newline-delimited JSON-RPC 2.0, MCP 2025-06-18): tools over the last analysis and
// the prompts of the two agents. Written without the MCP SDK: the server needs a handful of methods, and the
// package then has no dependency for it (D-063). Logs go to stderr; stdout carries only protocol messages.
//
// Usage: node out/mcp/server.js [--snapshot <folder>] [--root <folder>] [--locale en|ru]
//   --snapshot  folder with <language>.facts.json and .findings.json or .sarif (default .nomos, as nomos-ci writes)
//   --root      analyzed root, when the snapshot has no snapshot.json (default: the parent of the snapshot folder)
import path from "node:path";
import readline from "node:readline";
import { GitError } from "../core/git";
import { SnapshotError, readSnapshot } from "../core/snapshot";
import type { Locale } from "../core/prompts";
import { ToolInputError, callTool, getPrompt, prompts, tools } from "./tools";

const SupportedVersions = ["2025-06-18", "2025-03-26", "2024-11-05"];
const ServerVersion = "0.1.0";

interface Options { snapshot: string; root?: string; locale: Locale }

export function parseArgs(args: string[]): Options {
  const options: Options = { snapshot: ".nomos", locale: "en" };
  for (let i = 0; i < args.length; i += 2) {
    const value = args[i + 1];
    if (value === undefined) throw new Error(`no value for ${args[i]}`);
    if (args[i] === "--snapshot") options.snapshot = value;
    else if (args[i] === "--root") options.root = value;
    else if (args[i] === "--locale" && (value === "en" || value === "ru")) options.locale = value;
    else throw new Error(`unknown option ${args[i]} ${value}`);
  }
  return options;
}

interface Message { jsonrpc: "2.0"; id?: string | number | null; method?: string; params?: any }

/** Answers one JSON-RPC message; undefined for notifications. */
export function handle(message: Message, options: Options): object | undefined {
  const reply = (result: object) => ({ jsonrpc: "2.0", id: message.id, result });
  const error = (code: number, text: string) => ({ jsonrpc: "2.0", id: message.id ?? null, error: { code, message: text } });
  if (message.id === undefined) return undefined;
  const snapshot = () => readSnapshot(path.resolve(options.snapshot), options.root && path.resolve(options.root));
  try {
    switch (message.method) {
      case "initialize": {
        const asked = message.params?.protocolVersion;
        return reply({
          protocolVersion: SupportedVersions.includes(asked) ? asked : SupportedVersions[0],
          capabilities: { tools: {}, prompts: {} },
          serverInfo: { name: "nomos", version: ServerVersion },
          instructions: "Nomos gives statistics and heuristic observations about code, not verdicts. Run the Nomos analysis first; tools read its last result.",
        });
      }
      case "ping":
        return reply({});
      case "tools/list":
        return reply({ tools });
      case "tools/call": {
        const name = String(message.params?.name ?? "");
        try {
          return reply({ content: [{ type: "text", text: callTool(name, message.params?.arguments ?? {}, snapshot) }] });
        } catch (e) {
          // Problems the model can act on are results with isError, not protocol errors.
          if (e instanceof ToolInputError || e instanceof SnapshotError || e instanceof GitError) {
            return reply({ content: [{ type: "text", text: e.message }], isError: true });
          }
          throw e;
        }
      }
      case "prompts/list":
        return reply({ prompts });
      case "prompts/get": {
        const name = String(message.params?.name ?? "");
        const text = getPrompt(name, message.params?.arguments ?? {}, snapshot, options.locale);
        return reply({ description: prompts.find((p) => p.name === name)?.description, messages: [{ role: "user", content: { type: "text", text } }] });
      }
      default:
        return error(-32601, `method not found: ${message.method}`);
    }
  } catch (e) {
    const invalid = e instanceof ToolInputError || e instanceof SnapshotError || e instanceof GitError;
    return error(invalid ? -32602 : -32603, (e as Error).message);
  }
}

function main(): void {
  let options: Options;
  try {
    options = parseArgs(process.argv.slice(2));
  } catch (e) {
    process.stderr.write(`nomos-mcp: ${(e as Error).message}\nUsage: node server.js [--snapshot <folder>] [--root <folder>] [--locale en|ru]\n`);
    process.exitCode = 2;
    return;
  }
  const input = readline.createInterface({ input: process.stdin, crlfDelay: Infinity });
  input.on("line", (line) => {
    if (!line.trim()) return;
    let message: Message;
    try {
      message = JSON.parse(line);
    } catch {
      process.stdout.write(JSON.stringify({ jsonrpc: "2.0", id: null, error: { code: -32700, message: "parse error" } }) + "\n");
      return;
    }
    const answer = handle(message, options);
    if (answer) process.stdout.write(JSON.stringify(answer) + "\n");
  });
}

if (require.main === module) main();
