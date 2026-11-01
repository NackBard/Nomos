import fs from "node:fs";
import path from "node:path";
import Ajv2020 from "ajv/dist/2020";
import type { ValidateFunction } from "ajv/dist/2020";

/** The major contract version this extension understands. */
export const SupportedMajor = 1;

export type ContractName = "manifest" | "facts" | "nomos";

export class ContractError extends Error {}

const contractsDir = path.resolve(__dirname, "..", "..", "contracts");
const validators = new Map<ContractName, ValidateFunction>();

function validator(name: ContractName): ValidateFunction {
  const known = validators.get(name);
  if (known) return known;
  const ajv = new Ajv2020({ allErrors: true, strict: true, strictTypes: false });
  ajv.addKeyword({ keyword: "x-contractVersion", schemaType: "string" });
  const compiled = ajv.compile(JSON.parse(fs.readFileSync(path.join(contractsDir, `${name}.schema.json`), "utf8")));
  validators.set(name, compiled);
  return compiled;
}

/** Checks a document against its contract: an unknown major version gets its own message, the rest goes through the schema. */
export function checkContract<T>(name: ContractName, document: unknown, source: string): T {
  const version = (document as { schemaVersion?: unknown } | null)?.schemaVersion;
  const major = typeof version === "string" ? Number(version.split(".")[0]) : NaN;
  if (major !== SupportedMajor) {
    throw new ContractError(`${source}: schemaVersion is ${JSON.stringify(version)}, this extension understands ${SupportedMajor}.x`);
  }
  const validate = validator(name);
  if (!validate(document)) {
    const details = (validate.errors ?? []).slice(0, 3).map((e) => `${e.instancePath || "/"} ${e.message}`).join("; ");
    throw new ContractError(`${source}: does not match ${name}.schema.json: ${details}`);
  }
  return document as T;
}

export function parseJson(text: string, source: string): unknown {
  try {
    return JSON.parse(text.replace(/^﻿/, ""));
  } catch (e) {
    throw new ContractError(`${source}: not valid JSON: ${(e as Error).message}`);
  }
}
