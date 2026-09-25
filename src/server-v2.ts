import { randomUUID } from "node:crypto";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

import {
  parsePluginOptions,
  type PluginOptions,
  type ServerConfig,
} from "./config.js";
import { CatalogueCache } from "./catalogue-cache.js";
import { createOpencodeAcpx } from "./provider.js";
import { providerId } from "./presets.js";
import { registerProviderRuntime } from "./registry.js";

import { BindingLedger } from "./session/ledger.js";
import { buildProviderProjection, type ProviderProjection } from "./server.js";
import { WorkerClient, type WorkerClientOptions } from "./worker/client.js";
import type { CatalogueResult } from "./worker/messages.js";

const SOURCE_DIRECTORY = dirname(fileURLToPath(import.meta.url));
const DEFAULT_PROVIDER_URL = new URL("./provider.js", import.meta.url);
const DEFAULT_WORKER_PATH = join(SOURCE_DIRECTORY, "worker.js");
const V2_CONFIG_ENV = "OPENCODE_ACPX_V2_CONFIG";
const V2_PERMISSION_ENV = "OPENCODE_ACPX_V2_PERMISSIONS";

interface Disposable {
  dispose(): Promise<void>;
}
type UnknownRecord = Record<string, unknown>;

export interface OpenCode2Context {
  location?: { directory?: string };
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
}

export interface OpenCode2Dependencies {
  createWorkerClient?: (options: WorkerClientOptions) => WorkerClient;
  pluginInstanceId?: () => string;
  providerUrl?: URL;
  workerPath?: string;
  env?: NodeJS.ProcessEnv;
}

function permissionMode(env: NodeJS.ProcessEnv): "allow" | "deny" {
  return env[V2_PERMISSION_ENV]?.toLowerCase() === "allow" ? "allow" : "deny";
}

export function openCode2Options(
  env: NodeJS.ProcessEnv = process.env,
  stateDir = "~/.local/share/opencode/acpx-v2",
): PluginOptions {
  const encoded = env[V2_CONFIG_ENV];
  if (encoded !== undefined && encoded.trim().length > 0) {
    return parsePluginOptions(JSON.parse(encoded) as unknown);
  }
  return parsePluginOptions({
    stateDir,
    permissions: { default: permissionMode(env), fallback: "deny" },
    servers: {
      cursor: {
        preset: "cursor",
        forwardEnv: [],
      },
    },
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

async function discover(
  worker: WorkerClient,
  options: PluginOptions,
  directory: string,
): Promise<Map<string, CatalogueResult>> {
  const cache = new CatalogueCache(options.stateDir);
  const result = new Map<string, CatalogueResult>();
  for (const [serverId, server] of Object.entries(options.servers)) {
    if (!server.enabled) continue;
    const cwd =
      server.cwd === undefined ? directory : join(directory, server.cwd);
    try {
      const catalogue = await worker.catalogue({ serverId, cwd });
      result.set(serverId, catalogue);
      await cache.put(serverId, server, cwd, catalogue).catch(() => undefined);
    } catch {
      const cached = await cache.get(serverId, server, cwd);
      if (cached !== undefined) result.set(serverId, cached);
    }
  }
  return result;
}

export function createOpenCode2Setup(dependencies: OpenCode2Dependencies = {}) {
  return async (
    ctx: OpenCode2Context,
  ): Promise<(() => Promise<void>) | undefined> => {
    const env = dependencies.env ?? process.env;
    const directory = ctx.location?.directory ?? process.cwd();
    const options = openCode2Options(env);
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
    await worker.configure({ pluginInstanceId, directory, options });
    const catalogues = await discover(worker, options, directory);
    const providerUrl = dependencies.providerUrl ?? DEFAULT_PROVIDER_URL;
    const aisdkPackage = `aisdk:${pathToFileURL(fileURLToPath(providerUrl)).href}`;
    const ledger = new BindingLedger({
      path: join(options.stateDir, "bindings.json"),
    });
    const projections = new Map<string, ProviderProjection>();
    const unregister: (() => void)[] = [];
    const registrations: Disposable[] = [];

    for (const [serverId, server] of Object.entries(options.servers)) {
      if (!server.enabled) continue;
      const projection = buildProviderProjection(
        serverId,
        server,
        catalogues.get(serverId),
      );
      projections.set(serverId, projection);
      unregister.push(
        registerProviderRuntime({
          pluginInstanceId,
          providerId: providerId(serverId),
          client: worker,
          serverId,
          server,
          directory,
          worktree: directory,
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
        if (id === undefined || serverIdForProvider(options, id) === undefined)
          return;
        const sdk = event.sdk as
          | { languageModel?: (modelId: string) => unknown }
          | undefined;
        const modelId = stringField(model, "modelID", "id");
        if (modelId !== undefined && typeof sdk?.languageModel === "function") {
          event.language = sdk.languageModel(modelId);
        }
      }),
    );
    registrations.push(
      await ctx.session.hook("context", (event) => {
        const model = eventModel(event);
        const id = stringField(model, "providerID");
        const serverId =
          id === undefined ? undefined : serverIdForProvider(options, id);
        if (serverId === undefined) return;
        const server = options.servers[serverId];
        const projection = projections.get(serverId);
        if (server === undefined || projection === undefined) return;
        const modelId = stringField(model, "id", "modelID") ?? "default";
        const variantId = stringField(event, "variant");
        const selection =
          projection.routes.get(modelRouteKey(modelId, variantId)) ??
          projection.routes.get(modelRouteKey(modelId));
        if (selection === undefined)
          throw new Error(
            `Unknown ACP model route ${id ?? providerId(serverId)}/${modelId}`,
          );
        const sessionID = stringField(event, "sessionID");
        const requestId =
          stringField(event, "messageID", "requestID", "id") ?? randomUUID();
        if (sessionID === undefined) {
          throw new Error("OpenCode 2 session context omitted its session id");
        }

        const output =
          typeof event.options === "object" &&
          event.options !== null &&
          !Array.isArray(event.options)
            ? (event.options as UnknownRecord)
            : {};
        event.options = output;
        output.openCodeSessionId = sessionID;
        output.requestId = requestId;
        output.generation = 0;
        const agent = stringField(event, "agent");
        if (agent !== undefined) output.agent = agent;
        if (server.mode !== undefined) output.mode = server.mode;
        output.opencodeAcpx = {
          schema: 1,
          variantId: variantId ?? null,
          ...structuredClone(selection),
        };
      }),
    );

    await ctx.provider.reload();
    return async () => {
      for (const registration of registrations.reverse()) {
        await registration.dispose().catch(() => undefined);
      }
      for (const release of unregister.splice(0)) release();
      await worker.dispose();
    };
  };
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
  if (server.preset === "cursor") return "Cursor";
  if (server.preset === "claude") return "Claude";
  if (server.preset === "codex") return "Codex";
  if (server.preset === "grok-build") return "Grok Build";
  if (server.preset === "hermes") return "Hermes";
  return serverId;
}
