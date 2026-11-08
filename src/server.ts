import { DurableObject } from "cloudflare:workers";
import { createModels } from "@earendil-works/pi-ai/models";
import { createRegistry, Harness } from "@earendil-works/pi-durable";
import type { ToolRegistration } from "@earendil-works/pi-durable";
import { obj, str } from "@earendil-works/pi-schema";
import { routeAgentRequest } from "agents";
import { PiHarness } from "agents/harness/pi";
import { Lifecycle } from "agents/lifecycle";
import { createAI } from "agents/models/pi-ai";
import { WebSockets } from "agents/websockets";
import { PiSessionSockets } from "./sockets";

const MODEL_ID = "@cf/zai-org/glm-5.3-flash";

const PREAMBLE =
  "You are a concise management assistant for a team gateway. You triage requests, coordinate follow-ups, and hand heavy work (code changes, builds, tests) to the CI pipeline instead of doing it inline. Use tools whenever they can answer the request, and explain their results plainly.";

// Free-tier note: no durable workspace / exec here. Those need Dynamic
// Workers + Containers (paid-only, wrangler code 10195). Heavy execution
// lives in the CI pipeline; this object only manages sessions and dispatches.
const CurrentTime = obj({});

const currentTime: ToolRegistration<typeof CurrentTime> = {
  name: "current_time",
  description: "Return the current UTC time. Proves the tool loop works.",
  parameters: CurrentTime,
  replay: "safe",
  async execute() {
    return { output: [{ type: "text", text: new Date().toISOString() }] };
  }
};

const DispatchInput = obj({ task: str() });

const dispatchToPipeline: ToolRegistration<typeof DispatchInput> = {
  name: "dispatch_to_pipeline",
  description:
    "Record a heavy task for the CI pipeline (code changes, builds, tests). Returns a receipt the user can track; it does not execute anything here.",
  parameters: DispatchInput,
  replay: "safe",
  async execute({ task }) {
    const receipt = `pipe-${Date.now().toString(36)}`;
    return {
      output: [
        {
          type: "text",
          text: `Queued for pipeline: ${task} (receipt ${receipt}). Wire this tool to your dispatch API next.`
        }
      ]
    };
  }
};

/** Free-tier pi session backed by one Durable Object (SQLite only). */
export class PiAgent extends DurableObject<Env> {
  // Workers AI and AI Gateway over the AI binding, as a pi-ai provider.
  readonly ai = createAI({ binding: this.env.AI });
  readonly registry = createRegistry();
  readonly harness = new PiHarness({
    harness: async ({ storage, context, onWake }) => {
      // pi's own extension: the system prompt and the free-tier tools.
      this.registry.install({
        name: "gateway",
        sections: [{ key: "preamble", render: () => PREAMBLE, tag: false }],
        tools: [currentTime, dispatchToPipeline]
      });
      const models = createModels();
      models.setProvider(this.ai.provider);
      return Harness.open(
        storage,
        {
          models,
          registry: this.registry,
          onWake,
          settings: {
            // pi doubles the delay before each retry: 1, 2, 4, 8 and 16 seconds,
            // so a rate-limited model gets about 30 seconds to recover.
            retry: { enabled: true, maxRetries: 5, baseDelayMs: 1000 }
          },
          onReport: (report) => console.warn("pi report", report)
        },
        context
      );
    },
    defaults: { model: this.ai(MODEL_ID), thinkingLevel: "low" }
  });

  // App glue, not the harness: how this app puts sessions on a socket.
  readonly sockets = new PiSessionSockets(this.harness, this.registry, (tag) =>
    this.ctx.getWebSockets(tag)
  );
  readonly webSockets = new WebSockets(this.sockets.options());
  readonly lifecycle = Lifecycle.install(this)
    .use(this.webSockets)
    .use(this.harness);

  /** Host startup, after the harness has opened pi. */
  async onStart(): Promise<void> {
    await this.sockets.reattach();
  }
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    if (new URL(request.url).pathname === "/api/session") {
      // A fresh session id for the client to open its WebSocket against.
      return Response.json({ session: crypto.randomUUID() });
    }
    try {
      return (
        (await routeAgentRequest(request, env, { cors: true })) ??
        new Response("Not found", { status: 404 })
      );
    } catch (error) {
      console.error("Pi gateway request failed", error);
      return Response.json(
        { error: error instanceof Error ? error.message : String(error) },
        { status: 500 }
      );
    }
  }
} satisfies ExportedHandler<Env>;
