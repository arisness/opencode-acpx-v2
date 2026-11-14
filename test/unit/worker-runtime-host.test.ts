import { join } from "node:path";

import type { AcpRuntime, AcpRuntimeHandle } from "acpx/runtime";
import { describe, expect, it, vi } from "vitest";

import { parsePluginOptions } from "../../src/config.js";
import type { RuntimeWorkerEvent } from "../../src/worker/messages.js";
import {
  RuntimeHost,
  STOCK_ACPX_FEATURE_SUPPORT,
  type RuntimeFactoryInput,
} from "../../src/worker/runtime-host.js";

function configuration() {
  return {
    pluginInstanceId: "plugin-1",
    directory: process.cwd(),
    options: parsePluginOptions({
      stateDir: join(process.cwd(), ".artifacts", "worker-runtime-host-test"),
      idleTimeoutMs: 60_000,
      servers: {
        cursor: {
          preset: "custom",
          command: "cursor-agent",
        },
      },
    }),
  };
}

function fakeRuntime() {
  const handles = new Map<string, AcpRuntimeHandle>();
  const operations: string[] = [];
  const ensureSession = vi.fn(
    ({ sessionKey, cwd }: { sessionKey: string; cwd?: string }) => {
      const handle: AcpRuntimeHandle = {
        sessionKey,
        backend: "cursor",
        runtimeSessionName: sessionKey,
        backendSessionId: `backend:${sessionKey}`,
        ...(cwd === undefined ? {} : { cwd }),
      };
      handles.set(sessionKey, handle);
      return Promise.resolve(handle);
    },
  );
  const close = vi.fn(({ handle }: { handle: AcpRuntimeHandle }) => {
    handles.delete(handle.sessionKey);
    return Promise.resolve();
  });
  const setConfigOption = vi.fn(
    ({ key, value }: { key: string; value: string | boolean }) => {
      operations.push(`config:${key}:${String(value)}`);
      return Promise.resolve();
    },
  );
  const runtime = {
    ensureSession,
    close,
    getCapabilities: vi.fn(() => ({ controls: ["session/status"] })),
    getStatus: vi.fn(() =>
      Promise.resolve({
        models: {
          currentModelId: "fast",
          availableModelIds: ["fast", "smart"],
        },
        availableCommands: [
          { name: "compact", description: "Compact context" },
        ],
        details: {
          configOptions: [
            {
              id: "model",
              category: "model",
              options: [{ value: "fast", label: "Fast model" }],
            },
          ],
        },
      }),
    ),
    setConfigOption,
  } as unknown as AcpRuntime;
  return { runtime, ensureSession, close, setConfigOption, operations };
}

describe("RuntimeHost", () => {
  it("configures idempotently and reports Acpx compatibility support", async () => {
    const fake = fakeRuntime();
    const events: unknown[] = [];
    const host = new RuntimeHost({
      emit: (event) => events.push(event),
      runtimeFactory: () => fake.runtime,
    });
    const config = configuration();
    await host.configure(config);
    await host.configure(structuredClone(config));

    expect(host.capabilities).not.toEqual(STOCK_ACPX_FEATURE_SUPPORT);
    expect(host.capabilities.elicitation.supported).toBe(true);
    expect(events).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          type: "diagnostic",
          code: "ACPX_RUNTIME_CLIENT_CAPABILITIES_PARTIAL",
          serverId: "cursor",
        }),
      ]),
    );
    await expect(
      host.configure({
        ...config,
        directory: join(config.directory, "different"),
      }),
    ).rejects.toMatchObject({
      code: "CONFIGURATION_CONFLICT",
    });
    await host.dispose();
    await host.dispose();
  });

  it("extracts a catalogue and explicitly closes its session", async () => {
    const fake = fakeRuntime();
    const host = new RuntimeHost({
      emit: () => undefined,
      runtimeFactory: () => fake.runtime,
    });
    await host.configure(configuration());

    const catalogue = await host.catalogue({
      serverId: "cursor",
      cwd: process.cwd(),
    });
    expect(catalogue.currentModelId).toBe("fast");
    expect(catalogue.models).toEqual([
      { id: "fast", name: "Fast model" },
      { id: "smart" },
    ]);
    expect(catalogue.availableCommands).toEqual([
      { name: "compact", description: "Compact context" },
    ]);
    expect(fake.ensureSession).toHaveBeenCalledOnce();
    expect(fake.close).toHaveBeenCalledTimes(1);
    expect(fake.close).toHaveBeenCalledWith(
      expect.objectContaining({
        reason: "OpenCode catalogue probe completed",
        discardPersistentState: true,
      }),
    );
    await host.dispose();
  });

  it("keeps a discovered catalogue when the agent lacks session/close", async () => {
    const fake = fakeRuntime();
    fake.close.mockRejectedValueOnce(
      Object.assign(new Error("session/close is unsupported"), {
        code: "ACP_BACKEND_UNSUPPORTED_CONTROL",
      }),
    );
    const events: Record<string, unknown>[] = [];
    const host = new RuntimeHost({
      emit: (event) => events.push(event as unknown as Record<string, unknown>),
      runtimeFactory: () => fake.runtime,
    });
    await host.configure(configuration());

    await expect(
      host.catalogue({ serverId: "cursor", cwd: process.cwd() }),
    ).resolves.toMatchObject({ currentModelId: "fast" });
    expect(events).toContainEqual(
      expect.objectContaining({
        type: "diagnostic",
        level: "info",
        code: "CATALOGUE_SESSION_CLOSE_UNSUPPORTED",
        serverId: "cursor",
      }),
    );
    await host.dispose();
  });

  it("correlates elicitation and extension requests with typed responses", async () => {
    const fake = fakeRuntime();
    const events: Record<string, unknown>[] = [];
    let factoryInput: RuntimeFactoryInput | undefined;
    const host = new RuntimeHost({
      emit: (event) => events.push(event as unknown as Record<string, unknown>),
      runtimeFactory: (input) => {
        factoryInput = input;
        return fake.runtime;
      },
    });
    await host.configure(configuration());
    const callbacks = factoryInput?.compatCallbacks;
    expect(callbacks).toBeDefined();

    const elicitation = callbacks?.onElicitationRequest?.(
      { sessionId: "backend:session", message: "Choose" } as never,
      { signal: new AbortController().signal },
    );
    const elicitationEvent = events.find(
      (event) => event.type === "interaction.elicitation",
    );
    expect(elicitationEvent).toMatchObject({ serverId: "cursor" });
    host.respondElicitation({
      interactionId: String(elicitationEvent?.interactionId),
      response: { action: "cancel" },
    });
    await expect(elicitation).resolves.toEqual({ action: "cancel" });

    const extension = callbacks?.onExtensionRequest?.(
      "vendor/example",
      { sessionId: "backend:session", value: 1 },
      { signal: new AbortController().signal },
    );
    const extensionEvent = events.find(
      (event) => event.type === "interaction.extension",
    );
    expect(extensionEvent).toMatchObject({
      serverId: "cursor",
      method: "vendor/example",
    });
    host.respondExtension({
      interactionId: String(extensionEvent?.interactionId),
      result: { accepted: true },
    });
    await expect(extension).resolves.toEqual({ accepted: true });
    await host.dispose();
  });

  it("correlates Cursor task notifications that identify only a tool call", async () => {
    const fake = fakeRuntime();
    const events: Record<string, unknown>[] = [];
    let factoryInput: RuntimeFactoryInput | undefined;
    let finishTurn: (() => void) | undefined;
    const finished = new Promise<void>((resolve) => {
      finishTurn = resolve;
    });
    fake.runtime.startTurn = vi.fn(() => ({
      requestId: "request-1",
      events: {
        async *[Symbol.asyncIterator]() {
          yield {
            type: "tool_call" as const,
            text: "Explore",
            toolCallId: "cursor-task-1",
            kind: "other" as const,
            status: "in_progress",
          };
          await finished;
        },
      },
      result: finished.then(() => ({
        status: "completed" as const,
        stopReason: "end_turn",
      })),
      cancel: () => Promise.resolve(),
      closeStream: () => Promise.resolve(),
    }));
    const host = new RuntimeHost({
      emit: (event) => events.push(event as unknown as Record<string, unknown>),
      runtimeFactory: (input) => {
        factoryInput = input;
        return fake.runtime;
      },
    });
    await host.configure(configuration());
    await host.startTurn({
      turnId: "turn-1",
      serverId: "cursor",
      sessionKey: "session-1",
      cwd: process.cwd(),
      requestId: "request-1",
      text: "Explore",
    });
    await vi.waitFor(() =>
      expect(events).toContainEqual(
        expect.objectContaining({ type: "turn.event", turnId: "turn-1" }),
      ),
    );

    await factoryInput?.compatCallbacks.onExtensionNotification?.(
      "cursor/task",
      { toolCallId: "cursor-task-1", description: "Explore" },
    );

    expect(events).toContainEqual(
      expect.objectContaining({
        type: "extension.notification",
        serverId: "cursor",
        sessionKey: "session-1",
        turnId: "turn-1",
        method: "cursor/task",
      }),
    );
    finishTurn?.();
    await vi.waitFor(() =>
      expect(events).toContainEqual(
        expect.objectContaining({ type: "turn.result", turnId: "turn-1" }),
      ),
    );
    await host.dispose();
  });

  it("applies exact model and typed config selections before prompting", async () => {
    const fake = fakeRuntime();
    fake.runtime.startTurn = vi.fn(({ requestId }: { requestId: string }) => {
      fake.operations.push(`prompt:${requestId}`);
      return {
        requestId,
        events: {
          async *[Symbol.asyncIterator]() {
            await Promise.resolve();
            yield* [];
          },
        },
        result: Promise.resolve({
          status: "completed" as const,
          stopReason: "end_turn",
        }),
        cancel: () => Promise.resolve(),
        closeStream: () => Promise.resolve(),
      };
    });
    const events: RuntimeWorkerEvent[] = [];
    const host = new RuntimeHost({
      emit: (event) => events.push(event),
      runtimeFactory: () => fake.runtime,
    });
    await host.configure(configuration());

    await host.startTurn({
      turnId: "variant-turn",
      serverId: "cursor",
      sessionKey: "variant-session",
      cwd: process.cwd(),
      requestId: "variant-request",
      text: "Think carefully",
      modelId: "smart",
      config: { effort: "high", fast: false },
    });
    await vi.waitFor(() =>
      expect(events).toContainEqual(
        expect.objectContaining({
          type: "turn.result",
          turnId: "variant-turn",
        }),
      ),
    );

    expect(fake.operations).toEqual([
      "config:model:smart",
      "config:effort:high",
      "config:fast:false",
      "prompt:variant-request",
    ]);
    expect(fake.setConfigOption.mock.calls[2]?.[0]).toMatchObject({
      key: "fast",
      value: false,
    });
    await host.dispose();
  });

  it("settles allow/deny permissions directly when directNonInteractivePermissions is enabled", async () => {
    const withTimeout = <T>(promise: Promise<T>): Promise<T> =>
      Promise.race([
        promise,
        new Promise<never>((_resolve, reject) =>
          setTimeout(
            () => reject(new Error("Timed out waiting for direct permission")),
            50,
          ),
        ),
      ]);

    const runDirectCase = async (
      mode: "allow" | "deny",
      options: { optionId: string; name: string; kind: string }[],
      expectedOutcome: string,
    ) => {
      const fake = fakeRuntime();
      let finishTurn: (() => void) | undefined;
      const finished = new Promise<void>((resolve) => {
        finishTurn = resolve;
      });
      let factoryInput: RuntimeFactoryInput | undefined;
      const startTurnSpy = vi.fn(() => ({
        requestId: "request-1",
        events: {
          async *[Symbol.asyncIterator]() {
            await finished;
            yield* [];
          },
        },
        result: finished.then(() => ({
          status: "completed" as const,
          stopReason: "end_turn",
        })),
        cancel: () => Promise.resolve(),
        closeStream: () => Promise.resolve(),
      }));
      fake.runtime.startTurn = startTurnSpy;
      const events: RuntimeWorkerEvent[] = [];
      const host = new RuntimeHost({
        emit: (event) => events.push(event),
        runtimeFactory: (input) => {
          factoryInput = input;
          return fake.runtime;
        },
      });
      const base = configuration();
      await host.configure({
        ...base,
        options: {
          ...base.options,
          permissions: { default: mode, fallback: "deny" },
        },
        hostCapabilities: {
          permissionPrompt: true,
          questionPrompt: false,
          directNonInteractivePermissions: true,
        },
      });
      await host.startTurn({
        turnId: "turn-1",
        serverId: "cursor",
        sessionKey: "session-1",
        cwd: process.cwd(),
        requestId: "request-1",
        text: "Edit file",
      });
      await vi.waitFor(() => expect(startTurnSpy).toHaveBeenCalledTimes(1));
      const request = {
        sessionId: "backend:session-1",
        raw: {
          sessionId: "backend:session-1",
          toolCall: { toolCallId: "tool-1", title: "Edit file", kind: "edit" },
          options,
        },
        inferredKind: "edit" as const,
      };
      const onPermissionRequest = factoryInput?.onPermissionRequest;
      if (onPermissionRequest === undefined) {
        throw new Error("missing onPermissionRequest");
      }
      const decision = await withTimeout(
        onPermissionRequest(request as never, {
          signal: new AbortController().signal,
        }),
      );
      expect(decision).toEqual({ outcome: expectedOutcome });
      expect(
        events.filter((event) => event.type === "interaction.permission"),
      ).toHaveLength(0);
      finishTurn?.();
      await vi.waitFor(() =>
        expect(events).toContainEqual(
          expect.objectContaining({ type: "turn.result", turnId: "turn-1" }),
        ),
      );
      await host.dispose();
    };

    await runDirectCase(
      "allow",
      [
        { optionId: "once", name: "Allow once", kind: "allow_once" },
        { optionId: "always", name: "Allow always", kind: "allow_always" },
      ],
      "allow_once",
    );
    await runDirectCase(
      "allow",
      [{ optionId: "always", name: "Allow always", kind: "allow_always" }],
      "allow_always",
    );
    await runDirectCase("allow", [], "cancel");
    await runDirectCase(
      "deny",
      [
        { optionId: "reject", name: "Reject", kind: "reject_once" },
        {
          optionId: "reject-always",
          name: "Always reject",
          kind: "reject_always",
        },
      ],
      "reject_once",
    );
    await runDirectCase(
      "deny",
      [
        {
          optionId: "reject-always",
          name: "Always reject",
          kind: "reject_always",
        },
      ],
      "reject_always",
    );
    await runDirectCase("deny", [], "cancel");
  });

  it("settles ask permissions via fallback and emits a diagnostic when permissionPrompt is false", async () => {
    const withTimeout = <T>(promise: Promise<T>): Promise<T> =>
      Promise.race([
        promise,
        new Promise<never>((_resolve, reject) =>
          setTimeout(
            () =>
              reject(new Error("Timed out waiting for permission fallback")),
            50,
          ),
        ),
      ]);

    const runFallbackCase = async (
      fallback: "deny" | "fail",
      expectedOutcome: string,
    ) => {
      const fake = fakeRuntime();
      let finishTurn: (() => void) | undefined;
      const finished = new Promise<void>((resolve) => {
        finishTurn = resolve;
      });
      let factoryInput: RuntimeFactoryInput | undefined;
      const startTurnSpy = vi.fn(() => ({
        requestId: "request-1",
        events: {
          async *[Symbol.asyncIterator]() {
            await finished;
            yield* [];
          },
        },
        result: finished.then(() => ({
          status: "completed" as const,
          stopReason: "end_turn",
        })),
        cancel: () => Promise.resolve(),
        closeStream: () => Promise.resolve(),
      }));
      fake.runtime.startTurn = startTurnSpy;
      const events: RuntimeWorkerEvent[] = [];
      const host = new RuntimeHost({
        emit: (event) => events.push(event),
        runtimeFactory: (input) => {
          factoryInput = input;
          return fake.runtime;
        },
      });
      const base = configuration();
      await host.configure({
        ...base,
        options: {
          ...base.options,
          permissions: { default: "ask", fallback },
        },
        hostCapabilities: {
          permissionPrompt: false,
          questionPrompt: false,
          directNonInteractivePermissions: true,
        },
      });
      await host.startTurn({
        turnId: "turn-1",
        serverId: "cursor",
        sessionKey: "session-1",
        cwd: process.cwd(),
        requestId: "request-1",
        text: "Edit file",
      });
      await vi.waitFor(() => expect(startTurnSpy).toHaveBeenCalledTimes(1));
      const onPermissionRequest = factoryInput?.onPermissionRequest;
      if (onPermissionRequest === undefined) {
        throw new Error("missing onPermissionRequest");
      }
      const decision = await withTimeout(
        onPermissionRequest(
          {
            sessionId: "backend:session-1",
            raw: {
              sessionId: "backend:session-1",
              toolCall: { toolCallId: "tool-1", title: "Edit file" },
              options: [
                { optionId: "yes", name: "Allow once", kind: "allow_once" },
                { optionId: "no", name: "Reject once", kind: "reject_once" },
              ],
            },
          } as never,
          { signal: new AbortController().signal },
        ),
      );
      expect(decision).toEqual({ outcome: expectedOutcome });
      expect(events).toContainEqual(
        expect.objectContaining({
          type: "diagnostic",
          level: "warning",
          code: "ACP_PERMISSION_PROMPT_UNAVAILABLE",
          serverId: "cursor",
          details: { sessionKey: "session-1", fallback },
        }),
      );
      expect(
        events.filter((event) => event.type === "interaction.permission"),
      ).toHaveLength(0);
      finishTurn?.();
      await host.dispose();
    };

    await runFallbackCase("deny", "reject_once");
    await runFallbackCase("fail", "cancel");
  });

  it("fails closed for reverse interactions when questionPrompt is false", async () => {
    const fake = fakeRuntime();
    let factoryInput: RuntimeFactoryInput | undefined;
    const events: RuntimeWorkerEvent[] = [];
    const host = new RuntimeHost({
      emit: (event) => events.push(event),
      runtimeFactory: (input) => {
        factoryInput = input;
        return fake.runtime;
      },
    });
    const base = configuration();
    await host.configure({
      ...base,
      hostCapabilities: {
        permissionPrompt: false,
        questionPrompt: false,
        directNonInteractivePermissions: true,
      },
    });

    const onElicitationRequest =
      factoryInput?.compatCallbacks.onElicitationRequest;
    const onExtensionRequest = factoryInput?.compatCallbacks.onExtensionRequest;
    if (
      onElicitationRequest === undefined ||
      onExtensionRequest === undefined
    ) {
      throw new Error("missing compat reverse interaction callbacks");
    }

    const elicitation = await Promise.race([
      onElicitationRequest(
        { sessionId: "backend:session", message: "Choose" } as never,
        { signal: new AbortController().signal },
      ),
      new Promise<never>((_resolve, reject) =>
        setTimeout(() => reject(new Error("Elicitation hung")), 50),
      ),
    ]);
    expect(elicitation).toEqual({ action: "cancel" });

    await expect(
      Promise.race([
        onExtensionRequest(
          "vendor/example",
          { sessionId: "backend:session", value: 1 },
          { signal: new AbortController().signal },
        ),
        new Promise<never>((_resolve, reject) =>
          setTimeout(() => reject(new Error("Extension hung")), 50),
        ),
      ]),
    ).rejects.toMatchObject({
      code: "UNSUPPORTED_INTERACTION",
    });

    expect(
      events.filter(
        (event) =>
          event.type === "interaction.elicitation" ||
          event.type === "interaction.extension",
      ),
    ).toHaveLength(0);
    await host.dispose();
  });

  it("probes per-model configOptions across discovered models and respects time budget", async () => {
    let clock = 0;
    let advancePerSwitch = 0;
    const fake = fakeRuntime();
    let activeModel = "alpha";
    const statusFor = (modelId: string) => {
      const thoughtOptions =
        modelId === "beta"
          ? [
              { value: "medium", name: "Medium" },
              { value: "xhigh", name: "Extra" },
            ]
          : [
              { value: "low", name: "Low" },
              { value: "high", name: "High" },
            ];
      return {
        models: {
          currentModelId: "alpha",
          availableModelIds: ["alpha", "beta", "gamma"],
        },
        availableCommands: [],
        details: {
          configOptions: [
            {
              id: "model",
              category: "model",
              currentValue: modelId,
              options: [
                { value: "alpha", name: "Alpha" },
                { value: "beta", name: "Beta" },
                { value: "gamma", name: "Gamma" },
              ],
            },
            {
              id: "thought_level",
              category: "thought_level",
              currentValue: thoughtOptions[0]?.value,
              options: thoughtOptions,
            },
          ],
        },
      };
    };
    const getStatusSpy = vi.fn(() => Promise.resolve(statusFor(activeModel)));
    const setConfigOptionSpy = vi.fn(
      ({ key, value }: { key: string; value: string | boolean }) => {
        if (key === "model" && typeof value === "string") {
          activeModel = value;
          clock += advancePerSwitch;
        }
        return Promise.resolve();
      },
    );
    fake.runtime.getStatus = getStatusSpy;
    fake.runtime.setConfigOption = setConfigOptionSpy;

    const host = new RuntimeHost({
      emit: () => undefined,
      runtimeFactory: () => fake.runtime,
      now: () => clock,
    });
    await host.configure(configuration());

    const full = await host.catalogue({
      serverId: "cursor",
      cwd: process.cwd(),
    });
    expect(Object.keys(full.modelConfigOptions)).toEqual([
      "alpha",
      "beta",
      "gamma",
    ]);
    expect(full.modelConfigOptions.beta).toEqual(
      statusFor("beta").details.configOptions,
    );
    expect(setConfigOptionSpy).toHaveBeenCalledTimes(2);

    advancePerSwitch = 5_000;
    clock = 0;
    activeModel = "alpha";
    const budgeted = await host.catalogue({
      serverId: "cursor",
      cwd: process.cwd(),
    });
    expect(Object.keys(budgeted.modelConfigOptions)).toEqual(["alpha", "beta"]);

    const targeted = await host.catalogue({
      serverId: "cursor",
      cwd: process.cwd(),
      modelIds: ["gamma"],
    });
    expect(Object.keys(targeted.modelConfigOptions)).toEqual(["gamma"]);
    await host.dispose();
  });
});
