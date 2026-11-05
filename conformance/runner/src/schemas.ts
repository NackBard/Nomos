import fs from "node:fs";
import path from "node:path";
import { Ajv2020 } from "ajv/dist/2020.js";
import type { ValidateFunction } from "ajv/dist/2020.js";
import { contractsDir } from "./paths.ts";

export type SchemaName = "manifest" | "facts" | "rule" | "practice" | "nomos" | "conformance-case";

export function readJson(file: string): any {
  return JSON.parse(fs.readFileSync(file, "utf8").replace(/^﻿/, ""));
}

export function createAjv(): Ajv2020 {
  // Contracts carry x-contractVersion as a documentation keyword; strictTypes is off because
  // the schemas use type unions such as ["integer", "null"] next to numeric keywords.
  const ajv = new Ajv2020({ allErrors: true, strict: true, strictTypes: false });
  ajv.addKeyword({ keyword: "x-contractVersion", schemaType: "string" });
  return ajv;
}

export function schemaFiles(): string[] {
  return fs.readdirSync(contractsDir).filter((f) => f.endsWith(".schema.json")).sort();
}

/** Compiles every contract; compile errors are metavalidation failures. */
export function loadValidators(): Map<SchemaName, ValidateFunction<any>> {
  const ajv = createAjv();
  const result = new Map<SchemaName, ValidateFunction<any>>();
  for (const file of schemaFiles()) {
    const name = file.replace(/\.schema\.json$/, "") as SchemaName;
    result.set(name, ajv.compile<any>(readJson(path.join(contractsDir, file))));
  }
  return result;
}

export function formatErrors(validate: ValidateFunction<any>): string[] {
  return (validate.errors ?? []).map((e) => `${e.instancePath || "/"} ${e.message}${e.params && Object.keys(e.params).length ? " " + JSON.stringify(e.params) : ""}`);
}
