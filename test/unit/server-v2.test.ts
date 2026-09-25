/* eslint-disable @typescript-eslint/no-empty-function, @typescript-eslint/require-await, @typescript-eslint/no-unsafe-assignment */
import { randomUUID } from "node:crypto";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it, vi } from "vitest";

import { createOpenCode2Setup, openCode2Options } from "../../src/server-v2.js";
import type { WorkerClient } from "../../src/worker/client.js";
import type { RuntimeWorkerEvent } from "../../src/worker/messages.js";

function fakeWorker() {
  let listener: ((event: RuntimeWorkerEvent) => void) | undefined;
  return {
    configure: vi.fn(async () => {}),
    catalogue: vi.fn(
      async ({ serverId, cwd }: { serverId: string; cwd: string }) => ({
        serverId,
        cwd,
        currentModelId: "composer",
        models: [{ id: "composer", name: "Composer" }],
        configOptions: [],
        modelConfigOptions: {},
        availableCommands: [],
        runtimeCapabilities: { controls: [] },
        featureSupport: {},
      }),
    ),
    request: vi.fn(async () => ({ ok: true })),
    respondElicitation: vi.fn(async () => ({ ok: true })),
    respondExtension: vi.fn(async () => ({ ok: true })),
    closeSession: vi.fn(async () => ({ ok: true, state: "closed" as const })),
    dispose: vi.fn(async () => {}),
    subscribe: vi.fn((next: (event: RuntimeWorkerEvent) => void) => {
      listener = next;
      return vi.fn(() => {
        listener = undefined;
      });
    }),
    emit(event: RuntimeWorkerEvent) {
      listener?.(event);
    },
  };
}

function fakeContext(directory: string) {
  const providerTransforms: ((editor: unknown) => void)[] = [];
  const sdkHooks: ((event: Record<string, unknown>) => void | Promise<void>)[] =
    [];
  const languageHooks: ((
    event: Record<string, unknown>,
  ) => void | Promise<void>)[] = [];
  const sessionHooks = new Map<
    string,
    (event: Record<string, unknown>) => void | Promise<void>
  >();
  const events: unknown[] = [];
  return {
    location: { directory },
    provider: {
      transform: vi.fn(async (fn: (editor: unknown) => void) => {
        providerTransforms.push(fn);
        return { dispose: vi.fn(async () => {}) };
      }),
      reload: vi.fn(async () => {}),
    },
    aisdk: {
      hook: vi.fn(
        async (
          name: string,
          fn: (event: Record<string, unknown>) => void | Promise<void>,
        ) => {
          (name === "sdk" ? sdkHooks : languageHooks).push(fn);
          return { dispose: vi.fn(async () => {}) };
        },
      ),
    },
    session: {
      hook: vi.fn(
        async (
          name: string,
          fn: (event: Record<string, unknown>) => void | Promise<void>,
        ) => {
          sessionHooks.set(name, fn);
          return { dispose: vi.fn(async () => {}) };
        },
      ),
      get: vi.fn(async () => ({ location: { directory } })),
    },
    event: {
      subscribe: vi.fn(() => ({
        async *[Symbol.asyncIterator]() {
          for (const event of events) yield event;
        },
      })),
    },
    providerTransforms,
    sdkHooks,
    languageHooks,
    sessionHooks,
  };
}

describe("OpenCode 2 server", () => {
  it("defaults to an isolated Cursor ACP server without forwarding secrets", () => {
    const parsed = openCode2Options({}, join(tmpdir(), randomUUID()));
    expect(parsed.servers.cursor).toMatchObject({
      preset: "cursor",
      enabled: true,
      forwardEnv: [],
    });
    expect(parsed.permissions).toEqual({ default: "deny", fallback: "deny" });
  });

  it("registers discovered ACP models through the OpenCode 2 provider editor", async () => {
    const directory = mkdtempSync(join(tmpdir(), "opencode-acpx-v2-"));
    const worker = fakeWorker();
    const context = fakeContext(directory);
    const setup = createOpenCode2Setup({
      createWorkerClient: () => worker as unknown as WorkerClient,
      pluginInstanceId: () => "v2-instance",
      providerUrl: new URL("file:///plugin/provider.js"),
      workerPath: "/plugin/worker.js",
      env: {},
    });

    const dispose = await setup(context as never);
    const add = vi.fn();
    context.providerTransforms[0]?.({ add });

    expect(add).toHaveBeenCalledWith(
      expect.objectContaining({
        info: expect.objectContaining({
          id: "acp.cursor",
          name: "Cursor (ACP)",
          activation: "enabled",
          package: "aisdk:file:///plugin/provider.js",
        }),
        models: expect.arrayContaining([
          expect.objectContaining({
            id: "composer",
            providerID: "acp.cursor",
            cost: [],
            settings: expect.objectContaining({
              pluginInstanceId: "v2-instance",
              serverId: "cursor",
            }),
          }),
        ]),
      }),
    );
    expect(context.provider.reload).toHaveBeenCalled();

    const sdkEvent: Record<string, unknown> = {
      package: "aisdk:file:///plugin/provider.js",
      model: { providerID: "acp.cursor", id: "composer" },
      options: { pluginInstanceId: "v2-instance", serverId: "cursor" },
    };
    await context.sdkHooks[0]?.(sdkEvent);
    expect(sdkEvent.sdk).toMatchObject({ specificationVersion: "v3" });

    await dispose?.();
    expect(worker.dispose).toHaveBeenCalled();
  });

  it("adds session and exact model routing to each OpenCode 2 request", async () => {
    const directory = mkdtempSync(join(tmpdir(), "opencode-acpx-v2-"));
    const worker = fakeWorker();
    const context = fakeContext(directory);
    const setup = createOpenCode2Setup({
      createWorkerClient: () => worker as unknown as WorkerClient,
      pluginInstanceId: () => "v2-routing",
      providerUrl: new URL("file:///plugin/provider.js"),
      workerPath: "/plugin/worker.js",
      env: {},
    });
    const dispose = await setup(context as never);
    const event: Record<string, unknown> = {
      sessionID: "session-1",
      agent: "build",
      model: { providerID: "acp.cursor", id: "composer", modelID: "composer" },
      options: {},
    };

    await context.sessionHooks.get("context")?.(event);

    expect(event.options).toMatchObject({
      openCodeSessionId: "session-1",
      requestId: expect.any(String),
      generation: 0,
      agent: "build",
      opencodeAcpx: {
        schema: 1,
        variantId: null,
        modelId: "composer",
      },
    });
    await dispose?.();
  });
});
