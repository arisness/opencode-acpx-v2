/* eslint-disable @typescript-eslint/no-empty-function, @typescript-eslint/require-await, @typescript-eslint/no-unsafe-assignment */
import { randomUUID } from "node:crypto";
import { mkdirSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

import { describe, expect, it, vi } from "vitest";

import {
  isSessionDeletedEvent,
  sessionDeletedId,
} from "../../src/interactions/events.js";
import { createOpenCode2Setup, openCode2Options } from "../../src/server-v2.js";
import { createSessionKey } from "../../src/session/identity.js";
import type { WorkerClient } from "../../src/worker/client.js";
import type {
  CatalogueParams,
  CatalogueResult,
  RuntimeWorkerEvent,
  TurnStartParams,
} from "../../src/worker/messages.js";
import { TurnChannel } from "../../src/worker/turn-channel.js";

function fakeWorker() {
  let listener: ((event: RuntimeWorkerEvent) => void) | undefined;
  const starts: TurnStartParams[] = [];
  return {
    starts,
    configure: vi.fn(async () => {}),
    catalogue: vi.fn(
      async ({ serverId, cwd }: CatalogueParams): Promise<CatalogueResult> => ({
        serverId,
        cwd,
        currentModelId: "composer",
        models: [{ id: "composer", name: "Composer" }],
        configOptions: [],
        modelConfigOptions: {},
        availableCommands: [],
        runtimeCapabilities: { controls: [] },
        featureSupport: {} as CatalogueResult["featureSupport"],
      }),
    ),
    startTurn: vi.fn(async (params: TurnStartParams) => {
      starts.push(params);
      const channel = new TurnChannel(params.turnId);
      queueMicrotask(() => {
        channel.push({
          type: "turn.result",
          turnId: params.turnId,
          index: 0,
          result: { status: "completed", stopReason: "end_turn" },
        });
      });
      return channel;
    }),
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

function fakeContext(directory: string, options?: Record<string, unknown>) {
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
  const queuedEvents: Record<string, unknown>[] = [];
  let waitEvent: (() => void) | undefined;
  let closed = false;
  const returnSpy = vi.fn(async () => {
    closed = true;
    waitEvent?.();
    return { value: undefined, done: true as const };
  });
  return {
    location: { directory },
    ...(options === undefined ? {} : { options }),
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
        [Symbol.asyncIterator]() {
          return {
            async next() {
              while (queuedEvents.length === 0 && !closed) {
                await new Promise<void>((resolveNext) => {
                  waitEvent = resolveNext;
                });
                waitEvent = undefined;
              }
              const value = queuedEvents.shift();
              if (value !== undefined) {
                return { value, done: false as const };
              }
              return { value: undefined, done: true as const };
            },
            return: returnSpy,
          };
        },
      })),
    },
    emitEvent(event: Record<string, unknown>) {
      queuedEvents.push(event);
      waitEvent?.();
    },
    returnSpy,
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

  it("resolves options with env JSON > ctx.options > cursor default precedence", () => {
    const stateDir = join(tmpdir(), randomUUID());
    const fromCtx = openCode2Options({}, stateDir, {
      servers: {
        antigravity: {
          preset: "antigravity",
          forwardEnv: ["GEMINI_API_KEY"],
        },
      },
    });
    expect(Object.keys(fromCtx.servers)).toEqual(["antigravity"]);
    expect(fromCtx.servers.antigravity).toMatchObject({
      preset: "antigravity",
      forwardEnv: ["GEMINI_API_KEY"],
    });
    expect(fromCtx.permissions).toEqual({ default: "deny", fallback: "deny" });

    const fromEnv = openCode2Options(
      {
        OPENCODE_ACPX_V2_CONFIG: JSON.stringify({
          servers: { codex: { preset: "codex" } },
        }),
      },
      stateDir,
      {
        servers: { antigravity: { preset: "antigravity" } },
      },
    );
    expect(Object.keys(fromEnv.servers)).toEqual(["codex"]);

    const fromEmptyCtx = openCode2Options({}, stateDir, {});
    expect(Object.keys(fromEmptyCtx.servers)).toEqual(["cursor"]);
    expect(
      openCode2Options({ OPENCODE_ACPX_V2_PERMISSIONS: "ask" }, stateDir)
        .permissions,
    ).toEqual({ default: "ask", fallback: "deny" });

    expect(() => openCode2Options({}, stateDir, { servers: {} })).toThrow(
      "At least one ACP server is required",
    );
    expect(() =>
      openCode2Options({}, stateDir, { servers: "invalid" }),
    ).toThrow();
    expect(() =>
      openCode2Options({}, stateDir, { unknownField: true }),
    ).toThrow();
  });

  it("configures providers from ctx.options and resolves absolute and relative server.cwd", async () => {
    const directory = mkdtempSync(join(tmpdir(), "opencode-acpx-v2-"));
    const worker = fakeWorker();
    const context = fakeContext(directory, {
      servers: {
        antigravity: { preset: "antigravity", cwd: "/custom/repo" },
        nested: { preset: "cursor", cwd: "packages/app" },
      },
    });
    const setup = createOpenCode2Setup({
      createWorkerClient: () => worker as unknown as WorkerClient,
      pluginInstanceId: () => "v2-ctx-options",
      providerUrl: new URL("file:///plugin/provider.js"),
      workerPath: "/plugin/worker.js",
      env: {},
    });

    const dispose = await setup(context as never);

    expect(worker.catalogue).toHaveBeenCalledWith({
      serverId: "antigravity",
      cwd: "/custom/repo",
    });
    expect(worker.catalogue).toHaveBeenCalledWith({
      serverId: "nested",
      cwd: resolve(directory, "packages/app"),
    });

    const add = vi.fn();
    context.providerTransforms[0]?.({ add });
    expect(add).toHaveBeenCalledWith(
      expect.objectContaining({
        info: expect.objectContaining({
          id: "acp.antigravity",
          name: "Antigravity (ACP)",
        }),
      }),
    );

    await dispose?.();
  });

  it("passes relative server.cwd through turn execution without resolving twice", async () => {
    const directory = mkdtempSync(join(tmpdir(), "opencode-acpx-v2-"));
    mkdirSync(join(directory, "packages", "app"), { recursive: true });
    const worker = fakeWorker();
    const context = fakeContext(directory, {
      stateDir: join(directory, "state"),
      servers: {
        nested: { preset: "cursor", cwd: "packages/app" },
      },
    });
    const setup = createOpenCode2Setup({
      createWorkerClient: () => worker as unknown as WorkerClient,
      pluginInstanceId: () => "v2-relative-cwd-turn",
      providerUrl: new URL("file:///plugin/provider.js"),
      workerPath: "/plugin/worker.js",
      env: {},
    });

    const dispose = await setup(context as never);
    const contextEvent: Record<string, unknown> = {
      sessionID: "oc2-cwd-session",
      messageID: "msg-cwd-1",
      model: { providerID: "acp.nested", id: "composer", modelID: "composer" },
      options: {},
    };
    await context.sessionHooks.get("context")?.(contextEvent);

    const sdkEvent: Record<string, unknown> = {
      package: "aisdk:file:///plugin/provider.js",
      model: { providerID: "acp.nested", id: "composer" },
      options: { pluginInstanceId: "v2-relative-cwd-turn", serverId: "nested" },
    };
    await context.sdkHooks[0]?.(sdkEvent);
    const sdk = sdkEvent.sdk as {
      languageModel(id: string): {
        doStream(call: Record<string, unknown>): Promise<{
          stream: AsyncIterable<unknown>;
        }>;
      };
    };
    const result = await sdk.languageModel("composer").doStream({
      prompt: [{ role: "user", content: [{ type: "text", text: "hi" }] }],
      providerOptions: { "acp.nested": contextEvent.options },
    });
    for await (const part of result.stream) {
      void part;
    }

    expect(worker.starts).toHaveLength(1);
    expect(worker.starts[0]?.cwd).toBe(resolve(directory, "packages/app"));

    await dispose?.();
  });

  it("forwards warning and error worker diagnostics without leaking secrets and unsubscribes", async () => {
    const directory = mkdtempSync(join(tmpdir(), "opencode-acpx-v2-"));
    const worker = fakeWorker();
    const context = fakeContext(directory);
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      const setup = createOpenCode2Setup({
        createWorkerClient: () => worker as unknown as WorkerClient,
        pluginInstanceId: () => "v2-diag",
        providerUrl: new URL("file:///plugin/provider.js"),
        workerPath: "/plugin/worker.js",
        env: {},
      });

      const dispose = await setup(context as never);

      worker.emit({
        type: "diagnostic",
        level: "debug",
        code: "ACP_DEBUG",
        message: "ignored-debug",
      });
      worker.emit({
        type: "diagnostic",
        level: "info",
        code: "ACP_INFO",
        message: "ignored-info",
      });
      worker.emit({
        type: "diagnostic",
        level: "warning",
        code: "ACP_AUTH_WARN",
        serverId: "cursor",
        message: "secret-warn-message",
        details: { token: "secret-warn-token" },
      });
      worker.emit({
        type: "diagnostic",
        level: "error",
        code: "ACP_AUTH_ERROR",
        message: "secret-err-message",
        details: { apiKey: "secret-err-token" },
      });

      expect(warnSpy).toHaveBeenCalledTimes(1);
      expect(warnSpy.mock.calls[0]?.join(" ")).toContain("ACP_AUTH_WARN");
      expect(warnSpy.mock.calls[0]?.join(" ")).not.toContain("secret-warn");

      expect(errorSpy).toHaveBeenCalledTimes(1);
      expect(errorSpy.mock.calls[0]?.join(" ")).toContain("ACP_AUTH_ERROR");
      expect(errorSpy.mock.calls[0]?.join(" ")).not.toContain("secret-err");

      await dispose?.();

      worker.emit({
        type: "diagnostic",
        level: "error",
        code: "ACP_AFTER_DISPOSE",
        message: "should-not-log",
      });
      expect(errorSpy).toHaveBeenCalledTimes(1);
    } finally {
      warnSpy.mockRestore();
      errorSpy.mockRestore();
    }
  });

  it("closes bound ACP sessions and increments generation on OC2 and OC1 session.deleted events", async () => {
    const directory = mkdtempSync(join(tmpdir(), "opencode-acpx-v2-"));
    const worker = fakeWorker();
    const context = fakeContext(directory);
    const setup = createOpenCode2Setup({
      createWorkerClient: () => worker as unknown as WorkerClient,
      pluginInstanceId: () => "v2-lifecycle",
      providerUrl: new URL("file:///plugin/provider.js"),
      workerPath: "/plugin/worker.js",
      env: {},
    });
    const dispose = await setup(context as never);

    const parsed = openCode2Options({});
    const cursorServer = parsed.servers.cursor;
    if (cursorServer === undefined) throw new Error("cursor server missing");

    const contextHook = context.sessionHooks.get("context");
    const firstTurn: Record<string, unknown> = {
      sessionID: "oc2-session-1",
      model: { providerID: "acp.cursor", id: "composer" },
      options: {},
    };
    await contextHook?.(firstTurn);
    expect(firstTurn.options).toMatchObject({ generation: 0 });

    const expectedGen0Key = await createSessionKey({
      serverId: "cursor",
      server: cursorServer,
      worktree: directory,
      openCodeSessionId: "oc2-session-1",
      generation: 0,
    });

    context.emitEvent({
      type: "session.deleted",
      data: { sessionID: "oc2-session-1" },
    });

    await vi.waitFor(() => {
      expect(worker.closeSession).toHaveBeenCalledWith(
        "cursor",
        expectedGen0Key,
        true,
      );
    });

    const secondTurn: Record<string, unknown> = {
      sessionID: "oc2-session-1",
      model: { providerID: "acp.cursor", id: "composer" },
      options: {},
    };
    await contextHook?.(secondTurn);
    expect(secondTurn.options).toMatchObject({ generation: 1 });

    const expectedGen1Key = await createSessionKey({
      serverId: "cursor",
      server: cursorServer,
      worktree: directory,
      openCodeSessionId: "oc2-session-1",
      generation: 1,
    });

    worker.closeSession.mockRejectedValueOnce(new Error("close failed"));
    context.emitEvent({
      type: "session.deleted",
      properties: { info: { id: "oc2-session-1" } },
    });

    await vi.waitFor(() => {
      expect(worker.closeSession).toHaveBeenCalledWith(
        "cursor",
        expectedGen1Key,
        true,
      );
    });

    const thirdTurn: Record<string, unknown> = {
      sessionID: "oc2-session-1",
      model: { providerID: "acp.cursor", id: "composer" },
      options: {},
    };
    await contextHook?.(thirdTurn);
    expect(thirdTurn.options).toMatchObject({ generation: 2 });

    await dispose?.();
    expect(context.returnSpy).toHaveBeenCalled();
  });

  it("supports minimal context without options or event subscription and cancels blocking iterators cleanly", async () => {
    const directory = mkdtempSync(join(tmpdir(), "opencode-acpx-v2-"));
    const worker = fakeWorker();
    const baseContext = fakeContext(directory);
    const minimalContext = {
      location: baseContext.location,
      provider: baseContext.provider,
      aisdk: baseContext.aisdk,
      session: baseContext.session,
    };
    const setup = createOpenCode2Setup({
      createWorkerClient: () => worker as unknown as WorkerClient,
      pluginInstanceId: () => "v2-minimal",
      providerUrl: new URL("file:///plugin/provider.js"),
      workerPath: "/plugin/worker.js",
      env: {},
    });

    const disposeMinimal = await setup(minimalContext as never);
    await disposeMinimal?.();

    const blockingReturnSpy = vi.fn(async () => ({
      value: undefined,
      done: true as const,
    }));
    const blockingContext = {
      ...minimalContext,
      event: {
        subscribe: vi.fn(() => ({
          [Symbol.asyncIterator]() {
            return {
              next: () =>
                new Promise<IteratorResult<Record<string, unknown>>>(() => {}),
              return: blockingReturnSpy,
            };
          },
        })),
      },
    };
    const disposeBlocking = await setup(blockingContext as never);
    await disposeBlocking?.();
    expect(blockingReturnSpy).toHaveBeenCalled();
  });

  it("parses session.deleted events for both OC1 properties and OC2 data shapes", () => {
    const oc1 = {
      type: "session.deleted",
      properties: { info: { id: "oc1-id" } },
    };
    const oc1Session = {
      type: "session.deleted",
      properties: { sessionID: "oc1-prop-id" },
    };
    const oc2 = {
      type: "session.deleted",
      data: { sessionID: "oc2-id" },
    };

    expect(isSessionDeletedEvent(oc1)).toBe(true);
    expect(isSessionDeletedEvent(oc1Session)).toBe(true);
    expect(isSessionDeletedEvent(oc2)).toBe(true);
    expect(isSessionDeletedEvent({ type: "session.deleted", data: {} })).toBe(
      false,
    );

    if (!isSessionDeletedEvent(oc1)) throw new Error("expected oc1");
    if (!isSessionDeletedEvent(oc1Session))
      throw new Error("expected oc1Session");
    if (!isSessionDeletedEvent(oc2)) throw new Error("expected oc2");

    expect(sessionDeletedId(oc1)).toBe("oc1-id");
    expect(sessionDeletedId(oc1Session)).toBe("oc1-prop-id");
    expect(sessionDeletedId(oc2)).toBe("oc2-id");
  });

  it("reports fallback hostCapabilities when OpenCode 2 lacks tool or permission domains", async () => {
    const directory = mkdtempSync(join(tmpdir(), "acpx-v2-host-caps-"));
    const worker = fakeWorker();
    const setup = createOpenCode2Setup({
      createWorkerClient: () => worker as unknown as WorkerClient,
      pluginInstanceId: () => "plugin-v2-caps",
      env: {
        OPENCODE_ACPX_V2_CONFIG: JSON.stringify({
          stateDir: join(directory, "state"),
          permissions: { default: "allow", fallback: "deny" },
          servers: { cursor: { preset: "cursor" } },
        }),
      },
    });
    const ctx = fakeContext(directory);
    const dispose = await setup(ctx);
    expect(worker.configure).toHaveBeenCalledWith(
      expect.objectContaining({
        hostCapabilities: {
          permissionPrompt: false,
          questionPrompt: false,
          directNonInteractivePermissions: true,
        },
      }),
    );
    await dispose?.();
  });

  it("wires opencode_acp_permission tool, hooks, and OC2 events for interactive ask permissions", async () => {
    const directory = mkdtempSync(join(tmpdir(), "acpx-v2-ask-"));
    const worker = fakeWorker();
    const v2Config = JSON.stringify({
      stateDir: join(directory, "state"),
      permissions: { default: "ask", fallback: "deny" },
      servers: { cursor: { preset: "cursor" } },
    });
    const parsed = openCode2Options({ OPENCODE_ACPX_V2_CONFIG: v2Config });
    const setup = createOpenCode2Setup({
      createWorkerClient: () => worker as unknown as WorkerClient,
      pluginInstanceId: () => "plugin-v2-ask",
      env: { OPENCODE_ACPX_V2_CONFIG: v2Config },
    });

    const baseCtx = fakeContext(directory);
    const registeredTools: Record<string, unknown>[] = [];
    const toolTransformDispose = vi.fn(async () => {});
    const toolHookDispose = vi.fn(async () => {});
    const toolHooks = new Map<
      string,
      (event: Record<string, unknown>) => void | Promise<void>
    >();
    const toolReload = vi.fn(async () => {});
    const assertPermission = vi.fn(
      async (input: {
        sessionID: string;
        agent?: string;
        action: string;
        resources: string[];
        save?: string[];
        metadata?: Record<string, unknown>;
        source?: { type: "tool"; messageID: string; id: string };
      }) => {
        baseCtx.emitEvent({
          type: "permission.asked",
          data: {
            id: "perm-oc2-1",
            sessionID: input.sessionID,
            action: input.action,
            resources: input.resources,
            save: input.save ?? [],
            metadata: input.metadata ?? {},
            source: input.source,
          },
        });
        baseCtx.emitEvent({
          type: "permission.replied",
          data: {
            sessionID: input.sessionID,
            requestID: "perm-oc2-1",
            reply: "always",
          },
        });
        await new Promise<void>((resolveTick) => setTimeout(resolveTick, 10));
      },
    );

    const ctx = {
      ...baseCtx,
      tool: {
        transform: vi.fn(
          async (fn: (editor: { add(value: unknown): void }) => void) => {
            fn({
              add(value: unknown) {
                registeredTools.push(value as Record<string, unknown>);
              },
            });
            return { dispose: toolTransformDispose };
          },
        ),
        hook: vi.fn(
          async (
            name: "execute.before" | "execute.after",
            fn: (event: Record<string, unknown>) => void | Promise<void>,
          ) => {
            toolHooks.set(name, fn);
            return { dispose: toolHookDispose };
          },
        ),
        reload: toolReload,
      },
      permission: {
        assert: assertPermission,
      },
    };

    const dispose = await setup(ctx);
    expect(worker.configure).toHaveBeenCalledWith(
      expect.objectContaining({
        hostCapabilities: {
          permissionPrompt: true,
          questionPrompt: false,
          directNonInteractivePermissions: true,
        },
      }),
    );
    expect(toolReload).toHaveBeenCalledTimes(1);
    const permissionTool = registeredTools.find(
      (entry) => entry.name === "opencode_acp_permission",
    ) as
      | {
          name: string;
          description: string;
          input: unknown;
          execute: (
            input: Record<string, unknown>,
            context: Record<string, unknown>,
          ) => Promise<{
            output: string;
            content: string;
            metadata?: Record<string, unknown>;
          }>;
        }
      | undefined;
    expect(permissionTool).toBeDefined();

    const contextHook = baseCtx.sessionHooks.get("context");
    if (contextHook === undefined) throw new Error("missing session hook");
    const sessionEvent: Record<string, unknown> = {
      sessionID: "oc-session-2",
      messageID: "msg-oc2-1",
      model: { providerID: "acp.cursor", id: "composer" },
    };
    await contextHook(sessionEvent);
    const cursorServer = parsed.servers.cursor;
    if (cursorServer === undefined) throw new Error("missing cursor server");
    const sessionKey = await createSessionKey({
      serverId: "cursor",
      server: cursorServer,
      worktree: directory,
      openCodeSessionId: "oc-session-2",
      generation: 0,
    });

    const expiresAt = Date.now() + 60_000;
    const request = {
      sessionId: "backend-1",
      toolCall: {
        toolCallId: "acp-call-1",
        title: "Write file",
        kind: "edit" as const,
        rawInput: { path: "/repo/a.ts" },
      },
      options: [
        { optionId: "once", name: "Allow once", kind: "allow_once" as const },
        {
          optionId: "always",
          name: "Always allow",
          kind: "allow_always" as const,
        },
        { optionId: "reject", name: "Reject", kind: "reject_once" as const },
      ],
    };
    worker.emit({
      type: "interaction.permission",
      turnId: "turn-1",
      index: 0,
      interactionId: "int-oc2-1",
      serverId: "cursor",
      sessionKey,
      expiresAt,
      request,
      inferredKind: "edit",
    });

    const toolArgs = {
      interactionId: "int-oc2-1",
      serverId: "cursor",
      sessionKey,
      expiresAt,
      request,
      inferredKind: "edit",
    };
    await toolHooks.get("execute.before")?.({
      tool: "opencode_acp_permission",
      sessionID: "oc-session-2",
      id: "tool-call-oc2-1",
      input: toolArgs,
    });

    if (permissionTool === undefined) {
      throw new Error("missing opencode_acp_permission tool");
    }
    const result = await permissionTool.execute(toolArgs, {
      id: "tool-call-oc2-1",
      sessionID: "oc-session-2",
      messageID: "msg-oc2-1",
      agent: "build",
      signal: new AbortController().signal,
    });

    expect(assertPermission).toHaveBeenCalledWith({
      sessionID: "oc-session-2",
      agent: "build",
      action: "acp.cursor.edit",
      resources: ["/repo/a.ts"],
      save: ["/repo/a.ts"],
      metadata: {
        title: "Write file",
        acpServer: "cursor",
        acpToolKind: "edit",
      },
      source: {
        type: "tool",
        messageID: "msg-oc2-1",
        id: "tool-call-oc2-1",
      },
    });
    expect(result.content).toBe(result.output);
    expect(JSON.parse(result.output)).toEqual({
      interactionId: "int-oc2-1",
      decision: { outcome: "allow_always" },
    });

    await dispose?.();
    expect(toolTransformDispose).toHaveBeenCalled();
    expect(toolHookDispose).toHaveBeenCalled();
  });

  it("reads model.variant in session context and finishes partial per-model probes in background", async () => {
    const directory = mkdtempSync(join(tmpdir(), "opencode-acpx-v2-"));
    const optionSnapshot = (values: string[]) => [
      { id: "model", category: "model", currentValue: "alpha", options: [] },
      {
        id: "thought_level",
        category: "thought_level",
        type: "select",
        currentValue: values[0],
        options: values.map((value) => ({ value, name: value })),
      },
    ];
    const worker = fakeWorker();
    worker.catalogue.mockImplementation(
      async ({
        serverId,
        cwd,
        modelIds,
      }: CatalogueParams): Promise<CatalogueResult> => ({
        serverId,
        cwd,
        currentModelId: "alpha",
        models: [
          { id: "alpha", name: "Alpha" },
          { id: "beta", name: "Beta" },
        ],
        configOptions: optionSnapshot(["low", "medium", "high"]),
        modelConfigOptions:
          modelIds === undefined
            ? { alpha: optionSnapshot(["low", "medium", "high"]) }
            : { beta: optionSnapshot(["medium", "high", "xhigh"]) },
        availableCommands: [],
        runtimeCapabilities: { controls: [] },
        featureSupport: {} as CatalogueResult["featureSupport"],
      }),
    );

    const context = fakeContext(directory);
    const setup = createOpenCode2Setup({
      createWorkerClient: () => worker as unknown as WorkerClient,
      pluginInstanceId: () => "v2-variants",
      providerUrl: new URL("file:///plugin/provider.js"),
      workerPath: "/plugin/worker.js",
      env: {},
    });

    const dispose = await setup(context as never);
    await vi.waitFor(() =>
      expect(context.provider.reload).toHaveBeenCalledTimes(2),
    );

    const providers: Record<string, unknown>[] = [];
    context.providerTransforms[0]?.({
      add(entry: Record<string, unknown>) {
        providers.push(entry);
      },
    });
    const registeredModels = (providers[0]?.models ?? []) as {
      id: string;
      variants?: { id: string }[];
    }[];
    expect(
      registeredModels
        .find((m) => m.id === "default")
        ?.variants?.map((v) => v.id),
    ).toEqual(["low", "medium", "high"]);
    expect(
      registeredModels.find((m) => m.id === "beta")?.variants?.map((v) => v.id),
    ).toEqual(["medium", "high", "xhigh"]);

    const selectedEvent: Record<string, unknown> = {
      sessionID: "session-variant",
      agent: "build",
      model: {
        providerID: "acp.cursor",
        id: "beta",
        modelID: "beta",
        variant: "xhigh",
      },
      options: {},
    };
    await context.sessionHooks.get("context")?.(selectedEvent);
    expect(selectedEvent.options).toMatchObject({
      opencodeAcpx: {
        schema: 1,
        variantId: "xhigh",
        modelId: "beta",
        config: { thought_level: "xhigh" },
      },
    });

    const defaultVariantEvent: Record<string, unknown> = {
      sessionID: "session-default-variant",
      agent: "build",
      model: {
        providerID: "acp.cursor",
        id: "default",
        variant: "high",
      },
      options: {},
    };
    await context.sessionHooks.get("context")?.(defaultVariantEvent);
    expect(defaultVariantEvent.options).toMatchObject({
      opencodeAcpx: {
        schema: 1,
        variantId: "high",
        modelId: "alpha",
        config: { thought_level: "high" },
      },
    });

    const unknownVariantEvent: Record<string, unknown> = {
      sessionID: "session-unknown-variant",
      agent: "build",
      model: {
        providerID: "acp.cursor",
        id: "alpha",
        variant: "stale",
      },
      options: {},
    };
    await context.sessionHooks.get("context")?.(unknownVariantEvent);
    expect(unknownVariantEvent.options).toMatchObject({
      opencodeAcpx: {
        schema: 1,
        variantId: null,
        modelId: "alpha",
        config: { thought_level: "low" },
      },
    });

    await dispose?.();
  });
});
