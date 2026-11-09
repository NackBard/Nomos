// The model the person has in VS Code (Copilot or another provider of the language model API). No key and no
// dependency: VS Code asks the person for consent the first time an extension uses a model.
import * as vscode from "vscode";
import type { Backend, Cancellation } from "./backend";
import { BackendError } from "./backend";

export class VsCodeLmBackend implements Backend {
  /** `model` is the model chosen in the chat; without it, the first model of the family setting. */
  constructor(private readonly model: vscode.LanguageModelChat | undefined, private readonly family: string, private readonly noModel: string) {}

  private async pick(): Promise<vscode.LanguageModelChat> {
    if (this.model) return this.model;
    const models = await vscode.lm.selectChatModels(this.family ? { family: this.family } : {});
    if (!models.length) throw new BackendError(this.noModel);
    return models[0];
  }

  async send(system: string, user: string, onText: (text: string) => void, cancellation: Cancellation): Promise<void> {
    const model = await this.pick();
    // The API has no system role; the instructions go first as a user message.
    const messages = [vscode.LanguageModelChatMessage.User(system), vscode.LanguageModelChatMessage.User(user)];
    const response = await model.sendRequest(messages, {}, cancellation as vscode.CancellationToken);
    for await (const part of response.text) onText(part);
  }
}
