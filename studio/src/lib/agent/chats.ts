import { Chat } from "@ai-sdk/react";
import {
  DirectChatTransport,
  ToolLoopAgent,
  isStepCount,
  type InferUITools,
  type UIMessage,
} from "ai";
import { createAnthropic } from "@ai-sdk/anthropic";
import { createOpenAI } from "@ai-sdk/openai";
import type { Sandbox } from "@boxsh/sandbox";
import { DEFAULT_MODELS, type Provider } from "../models";
import { createSession, sharedFs } from "../sandbox";
import { emitFsChanged } from "../events";
import { useStudio } from "../store";
import { makeTools, type StudioTools } from "./tools";
import { prompts } from "./prompts";

export type StudioUIMessage = UIMessage<unknown, never, InferUITools<StudioTools>>;

function resolveModel(sessionId: string, provider: Provider) {
  const { keys, sessions } = useStudio.getState();
  const model =
    sessions.find((s) => s.id === sessionId)?.model ?? DEFAULT_MODELS[provider];
  if (provider === "anthropic") {
    return createAnthropic({
      apiKey: keys.anthropic,
      headers: { "anthropic-dangerous-direct-browser-access": "true" },
    })(model);
  }
  return createOpenAI({ apiKey: keys.openai })(model);
}

const chats = new Map<string, Chat<StudioUIMessage>>();
const sandboxes = new Map<string, Promise<Sandbox>>();

/** Each agent session gets its own shell session over the shared filesystem. */
function sandboxFor(sessionId: string): Promise<Sandbox> {
  let sb = sandboxes.get(sessionId);
  if (!sb) {
    sb = createSession();
    sandboxes.set(sessionId, sb);
  }
  return sb;
}

export function chatFor(sessionId: string, provider: Provider): Chat<StudioUIMessage> {
  let chat = chats.get(sessionId);
  if (!chat) {
    const agent = new ToolLoopAgent({
      model: resolveModel(sessionId, provider),
      instructions: prompts[provider],
      tools: makeTools({
        session: () => sandboxFor(sessionId),
        fs: sharedFs,
        onMutate: emitFsChanged,
      }),
      stopWhen: isStepCount(30),
      // Key and model choice live in the store and may change after this
      // agent is constructed; re-resolve on every call.
      prepareCall: ({ options: _options, ...rest }) => ({
        ...rest,
        model: resolveModel(sessionId, provider),
      }),
    });
    chat = new Chat<StudioUIMessage>({
      transport: new DirectChatTransport({ agent }),
    });
    chats.set(sessionId, chat);
  }
  return chat;
}

export function disposeChat(sessionId: string): void {
  chats.delete(sessionId);
  sandboxes.delete(sessionId);
}
