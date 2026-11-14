type UnknownRecord = Record<string, unknown>;

export interface PermissionAskedEvent {
  type: "permission.asked";
  properties: {
    id: string;
    sessionID: string;
    permission: string;
    patterns: string[];
    always: string[];
    metadata: UnknownRecord;
    tool?: {
      messageID: string;
      callID: string;
    };
  };
}

export interface PermissionRepliedEvent {
  type: "permission.replied";
  properties: {
    sessionID: string;
    requestID: string;
    reply: "once" | "always" | "reject";
  };
}

export interface SessionDeletedPayload {
  sessionID?: string;
  info?: {
    id: string;
  };
}

export type PermissionAskedPayload = PermissionAskedEvent["properties"];
export type PermissionRepliedPayload = PermissionRepliedEvent["properties"];

export type SessionDeletedEvent =
  | {
      type: "session.deleted";
      properties: SessionDeletedPayload;
    }
  | {
      type: "session.deleted";
      data: SessionDeletedPayload;
    };

function isRecord(value: unknown): value is UnknownRecord {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isStringArray(value: unknown): value is string[] {
  return (
    Array.isArray(value) && value.every((item) => typeof item === "string")
  );
}

function payloadOf(
  value: unknown,
  type: string,
  field: "properties" | "data",
): UnknownRecord | undefined {
  if (!isRecord(value) || value.type !== type) return undefined;
  const payload = value[field];
  return isRecord(payload) ? payload : undefined;
}

function propertiesOf(value: unknown, type: string): UnknownRecord | undefined {
  return payloadOf(value, type, "properties");
}

function deletedPayloadId(
  payload: SessionDeletedPayload | UnknownRecord | undefined,
): string | undefined {
  if (payload === undefined) return undefined;
  if (typeof payload.sessionID === "string" && payload.sessionID.length > 0) {
    return payload.sessionID;
  }
  if (
    isRecord(payload.info) &&
    typeof payload.info.id === "string" &&
    payload.info.id.length > 0
  ) {
    return payload.info.id;
  }
  return undefined;
}

function parseAskedFields(candidate: {
  id: unknown;
  sessionID: unknown;
  permission: unknown;
  patterns: unknown;
  always: unknown;
  metadata: unknown;
  tool?: PermissionAskedPayload["tool"];
}): PermissionAskedPayload | undefined {
  if (
    typeof candidate.id !== "string" ||
    typeof candidate.sessionID !== "string" ||
    typeof candidate.permission !== "string" ||
    !isStringArray(candidate.patterns) ||
    !isStringArray(candidate.always) ||
    !isRecord(candidate.metadata)
  ) {
    return undefined;
  }
  return {
    id: candidate.id,
    sessionID: candidate.sessionID,
    permission: candidate.permission,
    patterns: candidate.patterns,
    always: candidate.always,
    metadata: candidate.metadata,
    ...(candidate.tool === undefined ? {} : { tool: candidate.tool }),
  };
}

function parseOc1Asked(
  properties: UnknownRecord,
): PermissionAskedPayload | undefined {
  let tool: PermissionAskedPayload["tool"];
  if (properties.tool !== undefined) {
    if (
      !isRecord(properties.tool) ||
      typeof properties.tool.messageID !== "string" ||
      typeof properties.tool.callID !== "string"
    ) {
      return undefined;
    }
    tool = {
      messageID: properties.tool.messageID,
      callID: properties.tool.callID,
    };
  }
  return parseAskedFields({
    id: properties.id,
    sessionID: properties.sessionID,
    permission: properties.permission,
    patterns: properties.patterns,
    always: properties.always,
    metadata: properties.metadata,
    ...(tool === undefined ? {} : { tool }),
  });
}

function parseOc2Asked(
  data: UnknownRecord,
): PermissionAskedPayload | undefined {
  let tool: PermissionAskedPayload["tool"];
  if (data.source !== undefined) {
    if (!isRecord(data.source)) return undefined;
    if (data.source.type === "tool") {
      if (
        typeof data.source.messageID !== "string" ||
        typeof data.source.id !== "string"
      ) {
        return undefined;
      }
      tool = {
        messageID: data.source.messageID,
        callID: data.source.id,
      };
    }
  }
  return parseAskedFields({
    id: data.id,
    sessionID: data.sessionID,
    permission: data.action,
    patterns: data.resources,
    always: data.save === undefined ? [] : data.save,
    metadata: data.metadata === undefined ? {} : data.metadata,
    ...(tool === undefined ? {} : { tool }),
  });
}

function parseRepliedPayload(
  payload: UnknownRecord | undefined,
): PermissionRepliedPayload | undefined {
  if (
    payload === undefined ||
    typeof payload.sessionID !== "string" ||
    typeof payload.requestID !== "string" ||
    (payload.reply !== "once" &&
      payload.reply !== "always" &&
      payload.reply !== "reject")
  ) {
    return undefined;
  }
  return {
    sessionID: payload.sessionID,
    requestID: payload.requestID,
    reply: payload.reply,
  };
}

export function readPermissionAskedEvent(
  value: unknown,
): PermissionAskedPayload | undefined {
  const properties = propertiesOf(value, "permission.asked");
  if (properties !== undefined) return parseOc1Asked(properties);
  const data = payloadOf(value, "permission.asked", "data");
  return data === undefined ? undefined : parseOc2Asked(data);
}

export function readPermissionRepliedEvent(
  value: unknown,
): PermissionRepliedPayload | undefined {
  return (
    parseRepliedPayload(propertiesOf(value, "permission.replied")) ??
    parseRepliedPayload(payloadOf(value, "permission.replied", "data"))
  );
}

export function isPermissionAskedEvent(
  value: unknown,
): value is PermissionAskedEvent {
  const properties = propertiesOf(value, "permission.asked");
  return properties !== undefined && parseOc1Asked(properties) !== undefined;
}

export function isPermissionRepliedEvent(
  value: unknown,
): value is PermissionRepliedEvent {
  return (
    parseRepliedPayload(propertiesOf(value, "permission.replied")) !== undefined
  );
}

export function isSessionDeletedEvent(
  value: unknown,
): value is SessionDeletedEvent {
  return (
    deletedPayloadId(payloadOf(value, "session.deleted", "properties")) !==
      undefined ||
    deletedPayloadId(payloadOf(value, "session.deleted", "data")) !== undefined
  );
}

export function sessionDeletedId(event: SessionDeletedEvent): string {
  const fromProperties =
    "properties" in event ? deletedPayloadId(event.properties) : undefined;
  const fromData = "data" in event ? deletedPayloadId(event.data) : undefined;
  const id = fromProperties ?? fromData;
  if (id !== undefined) return id;
  throw new Error("Invalid session deletion event");
}
