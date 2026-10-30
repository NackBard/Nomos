import fs from "node:fs";
import path from "node:path";
import AjvDraft04 from "ajv-draft-04";
import type { Ajv2020, ValidateFunction } from "ajv/dist/2020.js";
import { repoRoot } from "./paths.ts";

// The official schema is published by OASIS as draft-04. It is not copied into the repository (no explicit licence
// for redistribution), so it is downloaded on demand into an ignored folder: `npm run fetch-sarif-schema`.
export const sarifSchemaUrl = "https://raw.githubusercontent.com/oasis-tcs/sarif-spec/main/sarif-2.1/schema/sarif-schema-2.1.0.json";
export const sarifSchemaFile = path.join(repoRoot, "conformance", "runner", ".cache", "sarif-schema-2.1.0.json");

export function sarifSchemaAvailable(): boolean {
  return fs.existsSync(sarifSchemaFile);
}

// The package is CommonJS: under NodeNext its default import is the module object, the class is on .default.
const Ajv04 = ((AjvDraft04 as any).default ?? AjvDraft04) as new (options: object) => InstanceType<typeof Ajv2020>;

let validator: ValidateFunction<any> | undefined;

/** Validates a SARIF log by the official schema; returns no errors when the schema has not been downloaded. */
export function validateSarifSchema(log: unknown): string[] {
  if (!sarifSchemaAvailable()) return [];
  if (!validator) {
    const ajv = new Ajv04({ allErrors: true, strict: false, validateFormats: false });
    validator = ajv.compile<any>(JSON.parse(fs.readFileSync(sarifSchemaFile, "utf8")));
  }
  const validate = validator;
  if (validate(log)) return [];
  return (validate.errors ?? []).slice(0, 10).map((e: any) => `${e.instancePath || "/"} ${e.message}`);
}
