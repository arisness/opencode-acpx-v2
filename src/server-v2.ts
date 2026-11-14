import { randomUUID } from "node:crypto";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

import { z } from "zod";

import {
  parsePluginOptions,
  serverWorkingDirectory,
  type PluginOptions,
  type ServerConfig,
} from "./config.js";
import { PACKAGE_NAME, PERMISSION_TOOL_NAME } from "./constants.js";
import { CatalogueCache } from "./catalogue-cache.js";
import {
  DEFAULT_CATALOGUE_MODEL_PROBE_CAP,
  mergeCatalogueModelConfigOptions,
  unprobedModelIds,
  withTimeout,
} from "./catalogue-probe.js";
import {
  isSessionDeletedEvent,
  sessionDeletedId,
} from "./interactions/events.js";
import {
  PermissionInteractionBroker,
  type PermissionToolContext,
  type PermissionToolInput,
} from "./interactions/permission.js";
import { createOpencodeAcpx } from "./provider.js";
import { providerId } from "./presets.js";
import { registerProviderRuntime } from "./registry.js";
import { createSessionKey } from "./session/identity.js";
import { BindingLedger } from "./session/ledger.js";
import { buildProviderProjection, type ProviderProjection } from "./server.js";
import { WorkerClient, type WorkerClientOptions } from "./worker/client.js";
import type { CatalogueResult, WorkerDiagnostic } from "./worker/messages.js";

const SOURCE_DIRECTORY = dirname(fileURLToPath(import.meta.url));
const DEFAULT_PROVIDER_URL = new URL("./provider.js", import.meta.url);
const DEFAULT_WORKER_PATH = join(SOURCE_DIRECTORY, "worker.js");
const V2_CONFIG_ENV = "OPENCODE_ACPX_V2_CONFIG";
const V2_PERMISSION_ENV = "OPENCODE_ACPX_V2_PERMISSIONS";

interface Disposable {
  dispose(): Promise<void>;
}
type UnknownRecord = Record<string, unknown>;

export interface OpenCode2ToolContext {
  id: string;
  sessionID: string;
  messageID: string;
  agent?: string;
  signal?: AbortSignal;
  abort?: AbortSignal;
  metadata?: (input: { title?: string; metadata?: UnknownRecord }) => void;
}

export interface OpenCode2ToolResult {
  title?: string;
  output: string;
  content: string;
  metadata?: UnknownRecord;
}

export interface OpenCode2ToolEditor {
  add<Input = UnknownRecord>(value: {
    name: string;
    description: string;
    input: z.ZodType<Input>;
    execute(
      input: Input,
      context: OpenCode2ToolContext,
    ): Promise<OpenCode2ToolResult>;
  }): void;
}

const permissionToolInputSchema = z.object({
  interactionId: z.string().min(1),
  serverId: z.string().min(1),
  sessionKey: z.string().min(1),
  expiresAt: z.number().int().nonnegative(),
  request: z.unknown().optional(),
  inferredKind: z.string().optional(),
});

export interface OpenCode2Context {
  location?: { directory?: string };
  options?: Readonly<Record<string, unknown>>;
  provider: {
    transform(
      fn: (editor: { add(value: unknown): void }) => void,
    ): Promise<Disposable>;
    reload(): Promise<void>;
  };
  aisdk: {
    hook(
      name: "sdk" | "language",
      fn: (event: UnknownRecord) => void | Promise<void>,
    ): Promise<Disposable>;
  };
  session: {
    hook(
      name: string,
      fn: (event: UnknownRecord) => void | Promise<void>,
    ): Promise<Disposable>;
  };
  event?: {
    subscribe(options?: Record<string, unknown>): AsyncIterable<UnknownRecord>;
  };
  tool?: {
    transform(fn: (editor: OpenCode2ToolEditor) => void): Promise<Disposable>;
    reload(): Promise<void>;
    hook?: (
      name: "execute.before" | "execute.after",
      fn: (event: UnknownRecord) => void | Promise<void>,
    ) => Promise<Disposable>;
  };
  permission?: {
    assert(input: {
      sessionID: string;
      agent?: string;
      action: string;
      resources: string[];
      save?: string[];
      metadata?: UnknownRecord;
      source?: { type: "tool"; messageID: string; id: string };
    }): Promise<void>;
  };
}

export interface OpenCode2Dependencies {
  createWorkerClient?: (options: WorkerClientOptions) => WorkerClient;
  pluginInstanceId?: () => string;
  providerUrl?: URL;
  workerPath?: string;
  env?: NodeJS.ProcessEnv;
}

function permissionMode(env: NodeJS.ProcessEnv): "allow" | "ask" | "deny" {
  const value = env[V2_PERMISSION_ENV]?.trim().toLowerCase();
  if (value === "allow") return "allow";
  if (value === "ask") return "ask";
  return "deny";
}

function isPlainRecord(value: unknown): value is UnknownRecord {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function defaultServers(): Record<
  string,
  { preset: "cursor"; forwardEnv: string[] }
> {
  return {
    cursor: {
      preset: "cursor",
      forwardEnv: [],
    },
  };
}

export function openCode2Options(
  env: NodeJS.ProcessEnv = process.env,
  stateDir = "~/.local/share/opencode/acpx-v2",
  ctxOptions?: unknown,
): PluginOptions {
  const encoded = env[V2_CONFIG_ENV];
  if (encoded !== undefined && encoded.trim().length > 0) {
    return parsePluginOptions(JSON.parse(encoded) as unknown);
  }
  if (isPlainRecord(ctxOptions) && Object.keys(ctxOptions).length > 0) {
    return parsePluginOptions({
      ...ctxOptions,
      stateDir:
        ctxOptions.stateDir === undefined ? stateDir : ctxOptions.stateDir,
      permissions:
        ctxOptions.permissions === undefined
          ? { default: permissionMode(env), fallback: "deny" }
          : ctxOptions.permissions,
      servers:
        ctxOptions.servers === undefined
          ? defaultServers()
          : ctxOptions.servers,
    });
  }
  return parsePluginOptions({
    stateDir,
    permissions: { default: permissionMode(env), fallback: "deny" },
    servers: defaultServers(),
  });
}

function modelRouteKey(modelId: string, variantId?: string): string {
  return `${modelId}\u0000${variantId ?? ""}`;
}

function modelInfos(
  providerID: string,
  serverId: string,
  pluginInstanceId: string,
  projection: ProviderProjection,
): UnknownRecord[] {
  return Object.entries(projection.models).map(([id, model]) => {
    const variants = Object.entries(model.variants ?? {}).map(
      ([variantId, settings]) => ({
        id: variantId,
        settings,
      }),
    );
    return {
      id,
      modelID: id,
      providerID,
      name: model.name ?? id,
      capabilities: {
        tools: model.tool_call !== false,
        input: model.modalities?.input ?? ["text"],
        output: model.modalities?.output ?? ["text"],
      },
      limit: {
        context: model.limit?.context ?? 0,
        output: model.limit?.output ?? 0,
      },
      variants,
      cost: [],
      settings: {
        ...(model.options ?? {}),
        pluginInstanceId,
        serverId,
      },
      status: "active",
      enabled: true,
      time: { released: 0 },
    };
  });
}

function eventModel(event: UnknownRecord): UnknownRecord | undefined {
  const model = event.model;
  return typeof model === "object" && model !== null && !Array.isArray(model)
    ? (model as UnknownRecord)
    : undefined;
}

function stringField(
  record: UnknownRecord | undefined,
  ...names: string[]
): string | undefined {
  for (const name of names) {
    const value = record?.[name];
    if (typeof value === "string" && value.length > 0) return value;
  }
  return undefined;
}

function logWorkerDiagnostic(event: WorkerDiagnostic): void {
  if (event.level !== "warning" && event.level !== "error") return;
  const code = event.code ?? "ACP_WORKER_DIAGNOSTIC";
  const message =
    event.serverId === undefined
      ? `[${PACKAGE_NAME}] ${code}`
      : `[${PACKAGE_NAME}] ${code} (${event.serverId})`;
  if (event.level === "error") console.error(message);
  else console.warn(message);
}

async function discover(
  worker: WorkerClient,
  options: PluginOptions,
  directory: string,
): Promise<Map<string, CatalogueResult>> {
  const cache = new CatalogueCache(options.stateDir);
  const result = new Map<string, CatalogueResult>();
  await Promise.all(
    Object.entries(options.servers).map(async ([serverId, server]) => {
      if (!server.enabled) return;
      const cwd = serverWorkingDirectory(server, directory);
      try {
        const catalogue = await withTimeout(
          worker.catalogue({ serverId, cwd }),
          options.discoveryTimeoutMs,
        );
        result.set(serverId, catalogue);
        await cache
          .put(serverId, server, cwd, catalogue)
          .catch(() => undefined);
      } catch {
        const cached = await cache.get(serverId, server, cwd);
        if (cached !== undefined) result.set(serverId, cached);
      }
    }),
  );
  return result;
}

async function probeRemainingModelConfigOptions(input: {
  worker: WorkerClient;
  options: PluginOptions;
  directory: string;
  catalogues: Map<string, CatalogueResult>;
  projections: Map<string, ProviderProjection>;
  isDisposed: () => boolean;
  abortSignal: Promise<never>;
  reloadProviders: () => Promise<void>;
}): Promise<void> {
  const cache = new CatalogueCache(input.options.stateDir);
  const outcomes = await Promise.all(
    Object.entries(input.options.servers).map(async ([serverId, server]) => {
      if (!server.enabled || input.isDisposed()) return false;
      const current = input.catalogues.get(serverId);
      if (current === undefined) return false;
      const missing = unprobedModelIds(current);
      if (missing.length === 0) return false;
      const cwd = serverWorkingDirectory(server, input.directory);
      let serverUpdated = false;
      for (
        let offset = 0;
        offset < missing.length;
        offset += DEFAULT_CATALOGUE_MODEL_PROBE_CAP
      ) {
        if (input.isDisposed()) return serverUpdated;
        const chunk = missing.slice(
          offset,
          offset + DEFAULT_CATALOGUE_MODEL_PROBE_CAP,
        );
        try {
          const update = await Promise.race([
            withTimeout(
              input.worker.catalogue({ serverId, cwd, modelIds: chunk }),
              input.options.discoveryTimeoutMs,
            ),
            input.abortSignal,
          ]);
          if (input.isDisposed()) return serverUpdated;
          const merged = mergeCatalogueModelConfigOptions(
            input.catalogues.get(serverId),
            update,
          );
          input.catalogues.set(serverId, merged);
          input.projections.set(
            serverId,
            buildProviderProjection(serverId, server, merged),
          );
          serverUpdated = true;
          await Promise.race([
            cache.put(serverId, server, cwd, merged).catch(() => undefined),
            input.abortSignal,
          ]);
        } catch {
          return serverUpdated;
        }
      }
      return serverUpdated;
    }),
  );
  if (outcomes.some(Boolean) && !input.isDisposed()) {
    await input.reloadProviders().catch(() => undefined);
  }
}

export function createOpenCode2Setup(dependencies: OpenCode2Dependencies = {}) {
  return async (
    ctx: OpenCode2Context,
  ): Promise<(() => Promise<void>) | undefined> => {
    const env = dependencies.env ?? process.env;
    const directory = ctx.location?.directory ?? process.cwd();
    const options = openCode2Options(env, undefined, ctx.options);
    const pluginInstanceId = dependencies.pluginInstanceId?.() ?? randomUUID();
    const worker =
      dependencies.createWorkerClient?.({
        workerPath: dependencies.workerPath ?? DEFAULT_WORKER_PATH,
        pluginOptions: options,
      }) ??
      new WorkerClient({
        workerPath: dependencies.workerPath ?? DEFAULT_WORKER_PATH,
        pluginOptions: options,
      });
    const permissionBroker = new PermissionInteractionBroker({
      mode: options.permissions.default,
      fallback: options.permissions.fallback,
    });
    const permissionBridge =
      ctx.tool !== undefined &&
      ctx.permission !== undefined &&
      ctx.event !== undefined
        ? { tool: ctx.tool, permission: ctx.permission }
        : undefined;
    const unsubscribeWorker = worker.subscribe((event) => {
      if (event.type === "diagnostic") {
        logWorkerDiagnostic(event);
        return;
      }
      if (event.type === "interaction.permission") {
        permissionBroker.observeWorkerEvent(event, event.serverId);
      }
    });
    const unregister: (() => void)[] = [];
    const registrations: Disposable[] = [];
    const generationBySession = new Map<string, number>();
    const sessionsByOpenCodeId = new Map<string, Map<string, string>>();
    const backgroundTasks = new Set<Promise<void>>();
    let abortBackgroundTasks = (): void => undefined;
    const backgroundAbortSignal = new Promise<never>((_resolve, reject) => {
      abortBackgroundTasks = (): void => reject(new Error("disposed"));
    });
    backgroundAbortSignal.catch(() => undefined);
    let disposed = false;
    let cancelEvents: () => void = () => undefined;

    const teardown = async (): Promise<void> => {
      if (disposed) return;
      disposed = true;
      abortBackgroundTasks();
      cancelEvents();
      unsubscribeWorker();
      for (const registration of registrations.reverse()) {
        await registration.dispose().catch(() => undefined);
      }
      for (const release of unregister.splice(0)) release();
      await worker.dispose();
      await Promise.allSettled([...backgroundTasks]);
    };

    try {
      await worker.configure({
        pluginInstanceId,
        directory,
        options,
        hostCapabilities: {
          permissionPrompt: permissionBridge !== undefined,
          questionPrompt: false,
          directNonInteractivePermissions: true,
        },
      });
      const catalogues = await discover(worker, options, directory);
      const providerUrl = dependencies.providerUrl ?? DEFAULT_PROVIDER_URL;
      const aisdkPackage = `aisdk:${pathToFileURL(fileURLToPath(providerUrl)).href}`;
      const ledger = new BindingLedger({
        path: join(options.stateDir, "bindings.json"),
      });
      const projections = new Map<string, ProviderProjection>();

      for (const [serverId, server] of Object.entries(options.servers)) {
        if (!server.enabled) continue;
        const projection = buildProviderProjection(
          serverId,
          server,
          catalogues.get(serverId),
        );
        projections.set(serverId, projection);
        const serverCwd = serverWorkingDirectory(server, directory);
        unregister.push(
          registerProviderRuntime({
            pluginInstanceId,
            providerId: providerId(serverId),
            client: worker,
            serverId,
            server,
            directory: serverCwd,
            worktree: serverCwd,
            ledger,
          }),
        );
      }

      registrations.push(
        await ctx.provider.transform((editor) => {
          for (const [serverId, server] of Object.entries(options.servers)) {
            if (!server.enabled) continue;
            const id = providerId(serverId);
            const projection = projections.get(serverId);
            if (projection === undefined) continue;
            editor.add({
              info: {
                id,
                name: `${serverTitle(serverId, server)} (ACP)`,
                activation: "enabled",
                package: aisdkPackage,
              },
              models: modelInfos(id, serverId, pluginInstanceId, projection),
            });
          }
        }),
      );

      registrations.push(
        await ctx.aisdk.hook("sdk", (event) => {
          if (event.sdk !== undefined || event.package !== aisdkPackage) return;
          const model = eventModel(event);
          const id = stringField(model, "providerID");
          const serverId =
            id === undefined ? undefined : serverIdForProvider(options, id);
          if (id === undefined || serverId === undefined) return;
          event.sdk = createOpencodeAcpx({
            name: id,
            pluginInstanceId,
            serverId,
          });
        }),
      );
      registrations.push(
        await ctx.aisdk.hook("language", (event) => {
          if (event.language !== undefined) return;
          const model = eventModel(event);
          const id = stringField(model, "providerID");
          if (
            id === undefined ||
            serverIdForProvider(options, id) === undefined
          )
            return;
          const sdk = event.sdk as
            | { languageModel?: (modelId: string) => unknown }
            | undefined;
          const modelId = stringField(model, "modelID", "id");
          if (
            modelId !== undefined &&
            typeof sdk?.languageModel === "function"
          ) {
            event.language = sdk.languageModel(modelId);
          }
        }),
      );
      registrations.push(
        await ctx.session.hook("context", async (event) => {
          const model = eventModel(event);
          const id = stringField(model, "providerID");
          const serverId =
            id === undefined ? undefined : serverIdForProvider(options, id);
          if (serverId === undefined) return;
          const server = options.servers[serverId];
          const projection = projections.get(serverId);
          if (server === undefined || projection === undefined) return;
          const modelId = stringField(model, "id", "modelID") ?? "default";
          const variantId =
            stringField(model, "variant") ?? stringField(event, "variant");
          const variantSelection =
            variantId === undefined
              ? undefined
              : projection.routes.get(modelRouteKey(modelId, variantId));
          const selection =
            variantSelection ?? projection.routes.get(modelRouteKey(modelId));
          if (selection === undefined)
            throw new Error(
              `Unknown ACP model route ${id ?? providerId(serverId)}/${modelId}`,
            );
          const sessionID = stringField(event, "sessionID");
          const requestId =
            stringField(event, "messageID", "requestID", "id") ?? randomUUID();
          if (sessionID === undefined) {
            throw new Error(
              "OpenCode 2 session context omitted its session id",
            );
          }

          const generation = generationBySession.get(sessionID) ?? 0;
          const sessionKey = await createSessionKey({
            serverId,
            server,
            worktree: serverWorkingDirectory(server, directory),
            openCodeSessionId: sessionID,
            generation,
          });
          let bound = sessionsByOpenCodeId.get(sessionID);
          if (bound === undefined) {
            bound = new Map<string, string>();
            sessionsByOpenCodeId.set(sessionID, bound);
          }
          bound.set(sessionKey, serverId);
          permissionBroker.bindSession(sessionKey, sessionID);

          const output =
            typeof event.options === "object" &&
            event.options !== null &&
            !Array.isArray(event.options)
              ? (event.options as UnknownRecord)
              : {};
          event.options = output;
          output.openCodeSessionId = sessionID;
          output.requestId = requestId;
          output.generation = generation;
          const agent = stringField(event, "agent");
          if (agent !== undefined) output.agent = agent;
          if (server.mode !== undefined) output.mode = server.mode;
          output.opencodeAcpx = {
            schema: 1,
            variantId:
              variantSelection === undefined ? null : (variantId ?? null),
            ...structuredClone(selection),
          };
        }),
      );

      cancelEvents = subscribeOpenCodeEvents(
        ctx.event,
        () => disposed,
        async (runtimeEvent) => {
          permissionBroker.ingestRuntimeEvent(runtimeEvent);
          await handleOpenCodeEvent(
            runtimeEvent,
            sessionsByOpenCodeId,
            generationBySession,
            permissionBroker,
            worker,
          );
        },
      );

      if (permissionBridge !== undefined) {
        const { tool: toolDomain, permission: permissionDomain } =
          permissionBridge;
        if (toolDomain.hook !== undefined) {
          registrations.push(
            await toolDomain.hook("execute.before", (event) => {
              const tool = stringField(event, "tool");
              const sessionID = stringField(event, "sessionID");
              const callID = stringField(event, "id", "callID");
              if (
                tool === undefined ||
                sessionID === undefined ||
                callID === undefined
              ) {
                return;
              }
              permissionBroker.beforeToolExecute(
                PERMISSION_TOOL_NAME,
                { tool, sessionID, callID },
                event.input,
              );
            }),
          );
        }
        registrations.push(
          await toolDomain.transform((editor) => {
            editor.add({
              name: PERMISSION_TOOL_NAME,
              description:
                "Completes a pending ACP agent permission request. This tool is reserved for opencode-acpx.",
              input: permissionToolInputSchema,
              execute: async (rawInput, toolContext) => {
                const parsedInput: PermissionToolInput = {
                  interactionId: rawInput.interactionId,
                  serverId: rawInput.serverId,
                  sessionKey: rawInput.sessionKey,
                  expiresAt: rawInput.expiresAt,
                  ...(rawInput.request === undefined
                    ? {}
                    : { request: rawInput.request }),
                  ...(rawInput.inferredKind === undefined
                    ? {}
                    : { inferredKind: rawInput.inferredKind }),
                };
                const abortSignal = toolContext.signal ?? toolContext.abort;
                const adaptedContext: PermissionToolContext = {
                  sessionID: toolContext.sessionID,
                  callID: toolContext.id,
                  ...(abortSignal === undefined ? {} : { abort: abortSignal }),
                  ...(toolContext.metadata === undefined
                    ? {}
                    : { metadata: toolContext.metadata }),
                  ask: async (request) => {
                    await permissionDomain.assert({
                      sessionID: toolContext.sessionID,
                      ...(toolContext.agent === undefined
                        ? {}
                        : { agent: toolContext.agent }),
                      action: request.permission,
                      resources: request.patterns,
                      save: request.always,
                      metadata: request.metadata,
                      source: {
                        type: "tool",
                        messageID: toolContext.messageID,
                        id: toolContext.id,
                      },
                    });
                  },
                };
                const result = await permissionBroker.execute(
                  parsedInput,
                  adaptedContext,
                );
                return {
                  output: result.output,
                  content: result.output,
                  metadata: result.metadata,
                };
              },
            });
          }),
        );
        await toolDomain.reload();
      }

      await ctx.provider.reload();
      if (
        [...catalogues.values()].some(
          (catalogue) => unprobedModelIds(catalogue).length > 0,
        )
      ) {
        const refreshTask = probeRemainingModelConfigOptions({
          worker,
          options,
          directory,
          catalogues,
          projections,
          isDisposed: () => disposed,
          abortSignal: backgroundAbortSignal,
          reloadProviders: () => ctx.provider.reload(),
        }).finally(() => {
          backgroundTasks.delete(refreshTask);
        });
        backgroundTasks.add(refreshTask);
      }
      return teardown;
    } catch (error) {
      await teardown().catch(() => undefined);
      throw error;
    }
  };
}

function subscribeOpenCodeEvents(
  eventSource: OpenCode2Context["event"],
  isDisposed: () => boolean,
  onEvent: (event: unknown) => Promise<void>,
): () => void {
  if (eventSource === undefined) return () => undefined;
  let iterator: AsyncIterator<UnknownRecord> | undefined;
  try {
    const activeIterator = eventSource.subscribe()[Symbol.asyncIterator]();
    iterator = activeIterator;
    void (async () => {
      try {
        while (!isDisposed()) {
          const step = await activeIterator.next();
          if (isDisposed() || step.done) break;
          await onEvent(step.value);
        }
      } catch {
        // Event subscription failures are non-fatal for provider teardown.
      }
    })();
  } catch {
    // Ignore event subscription setup failures when optional stream fails.
  }
  return () => {
    try {
      const stopped = iterator?.return?.();
      if (stopped !== undefined) {
        void Promise.resolve(stopped).catch(() => undefined);
      }
    } catch {
      // Ignore synchronous iterator cancellation errors during teardown.
    }
  };
}

async function handleOpenCodeEvent(
  runtimeEvent: unknown,
  sessionsByOpenCodeId: Map<string, Map<string, string>>,
  generationBySession: Map<string, number>,
  permissionBroker: PermissionInteractionBroker,
  worker: WorkerClient,
): Promise<void> {
  if (!isSessionDeletedEvent(runtimeEvent)) return;
  const deletedId = sessionDeletedId(runtimeEvent);
  permissionBroker.deleteSession(deletedId);
  const bound = sessionsByOpenCodeId.get(deletedId);
  sessionsByOpenCodeId.delete(deletedId);
  if (bound === undefined || bound.size === 0) return;
  generationBySession.set(
    deletedId,
    (generationBySession.get(deletedId) ?? 0) + 1,
  );
  await Promise.all(
    [...bound.entries()].map(([sessionKey, serverId]) =>
      worker.closeSession(serverId, sessionKey, true).catch(() => {
        console.warn(
          `[${PACKAGE_NAME}] ACP_SESSION_CLOSE_FAILED (${serverId})`,
        );
      }),
    ),
  );
}

function serverIdForProvider(
  options: PluginOptions,
  id: string,
): string | undefined {
  return Object.entries(options.servers).find(
    ([serverId, server]) => server.enabled && providerId(serverId) === id,
  )?.[0];
}

function serverTitle(serverId: string, server: ServerConfig): string {
  switch (server.preset) {
    case "cursor":
      return "Cursor";
    case "claude":
      return "Claude";
    case "codex":
      return "Codex";
    case "grok-build":
      return "Grok Build";
    case "hermes":
      return "Hermes";
    case "antigravity":
      return "Antigravity";
    case "custom":
      return serverId;
  }
}
