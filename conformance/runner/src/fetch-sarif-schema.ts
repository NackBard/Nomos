import fs from "node:fs";
import path from "node:path";
import { sarifSchemaFile, sarifSchemaUrl } from "./sarif-schema.ts";

const response = await fetch(sarifSchemaUrl);
if (!response.ok) {
  console.error(`Could not download ${sarifSchemaUrl}: HTTP ${response.status}`);
  process.exit(1);
}
const text = await response.text();
JSON.parse(text);
fs.mkdirSync(path.dirname(sarifSchemaFile), { recursive: true });
fs.writeFileSync(sarifSchemaFile, text);
console.log(`Saved ${sarifSchemaFile} (${text.length} bytes)`);
