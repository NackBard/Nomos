import { tick } from "./ping";

export function pong(): string {
  return String(tick());
}
