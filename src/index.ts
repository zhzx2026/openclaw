interface ExecutionContext {
  waitUntil(promise: Promise<unknown>): void;
  passThroughOnException(): void;
}

interface AssetFetcher {
  fetch(input: RequestInfo | URL, init?: RequestInit): Promise<Response>;
}

interface R2HttpMetadata {
  contentType?: string;
  contentDisposition?: string;
  cacheControl?: string;
}

interface R2ObjectRecord {
  key: string;
  size: number;
  uploaded: Date;
  httpMetadata?: R2HttpMetadata;
  customMetadata?: Record<string, string>;
}

interface R2ObjectBody extends R2ObjectRecord {
  arrayBuffer(): Promise<ArrayBuffer>;
  body: ReadableStream<Uint8Array> | null;
}

interface R2ListResult {
  objects: R2ObjectRecord[];
  truncated: boolean;
  cursor?: string;
}

interface R2PutOptions {
  httpMetadata?: R2HttpMetadata;
  customMetadata?: Record<string, string>;
}

interface R2Bucket {
  get(key: string): Promise<R2ObjectBody | null>;
  put(
    key: string,
    value: ReadableStream<Uint8Array> | ArrayBuffer | string | Blob,
    options?: R2PutOptions,
  ): Promise<R2ObjectRecord | null>;
  delete(key: string | string[]): Promise<void>;
  list(options?: {
    cursor?: string;
    include?: Array<"httpMetadata" | "customMetadata">;
    limit?: number;
    prefix?: string;
  }): Promise<R2ListResult>;
}

interface Env {
  ASSETS: AssetFetcher;
  CHAT_FILES: R2Bucket;
  APP_NAME?: string;
  CHAT_PASSWORD: string;
  OPENAI_API_KEY: string;
  OPENAI_BASE_URL?: string;
  OPENAI_MODEL?: string;
  SESSION_SECRET: string;
}

interface SessionPayload {
  exp: number;
  iat: number;
  sub: string;
  v: number;
}

interface FileSummary {
  id: string;
  name: string;
  size: number;
  type: string;
  uploadedAt: string;
}

interface ChatMessageInput {
  attachments?: FileSummary[];
  role: "assistant" | "user";
  text: string;
}

interface ChatRequestBody {
  messages: ChatMessageInput[];
}

const encoder = new TextEncoder();

const APP_NAME = "OpenClaw Chat";
const COOKIE_NAME = "openclaw_session";
const COOKIE_TTL_SECONDS = 60 * 60 * 24 * 7;
const COOKIE_SUBJECT = "openclaw-authenticated";
const COOKIE_VERSION = 1;
const FILE_PREFIX = "uploads/";
const MAX_UPLOAD_BYTES = 20 * 1024 * 1024;
const MAX_ATTACHMENTS_PER_MESSAGE = 8;
const MAX_CONTEXT_BYTES = 6 * 1024 * 1024;
const MAX_CONVERSATION_MESSAGES = 14;
const MAX_TEXT_CHARS = 10_000;
const SUPPORTED_DOC_TYPES = new Set([
  "application/json",
  "application/pdf",
  "application/xml",
  "application/yaml",
  "application/x-yaml",
  "text/csv",
  "text/html",
  "text/markdown",
  "text/plain",
  "text/xml",
]);
const IMAGE_TYPES = new Set([
  "image/gif",
  "image/jpeg",
  "image/png",
  "image/webp",
]);

const OPENCLAW_INSTRUCTIONS =
  "You are OpenClaw, a concise Chinese-first assistant hosted on a Cloudflare Worker. " +
  "Answer helpfully, keep a collaborative tone, and use uploaded images or documents when they are relevant. " +
  "If a file was attached but is not usable, say so clearly and continue with the available context.";

export default {
  async fetch(request: Request, env: Env, _ctx: ExecutionContext): Promise<Response> {
    const url = new URL(request.url);

    try {
      if (request.method === "POST" && url.pathname === "/api/login") {
        return handleLogin(request, env);
      }

      if (request.method === "POST" && url.pathname === "/api/logout") {
        return handleLogout(request);
      }

      if (request.method === "GET" && url.pathname === "/api/session") {
        return handleSession(request, env);
      }

      if (request.method === "GET" && url.pathname === "/api/files") {
        const session = await requireSession(request, env);
        if (session instanceof Response) {
          return session;
        }

        return handleListFiles(env);
      }

      if (request.method === "POST" && url.pathname === "/api/files/upload") {
        const session = await requireSession(request, env);
        if (session instanceof Response) {
          return session;
        }

        return handleUpload(request, env);
      }

      if (request.method === "POST" && url.pathname === "/api/chat") {
        const session = await requireSession(request, env);
        if (session instanceof Response) {
          return session;
        }

        return handleChat(request, env);
      }

      const fileMatch = url.pathname.match(/^\/api\/files\/([^/]+)\/download$/);
      if (request.method === "GET" && fileMatch) {
        const session = await requireSession(request, env);
        if (session instanceof Response) {
          return session;
        }

        return handleDownload(fileMatch[1], request, env);
      }

      return serveStatic(request, env);
    } catch (error) {
      console.error(error);
      return json(
        {
          error: error instanceof Error ? error.message : "Unexpected server error.",
        },
        500,
      );
    }
  },
};

async function handleLogin(request: Request, env: Env): Promise<Response> {
  const body = await readJson<{ password?: string }>(request);
  const password = body.password?.trim();

  if (!password) {
    return json({ error: "Please enter the password." }, 400);
  }

  if (password !== env.CHAT_PASSWORD) {
    return json({ error: "Incorrect password." }, 401);
  }

  const now = Math.floor(Date.now() / 1000);
  const payload: SessionPayload = {
    sub: COOKIE_SUBJECT,
    iat: now,
    exp: now + COOKIE_TTL_SECONDS,
    v: COOKIE_VERSION,
  };
  const cookieValue = await createSignedCookie(payload, env.SESSION_SECRET);

  return new Response(
    JSON.stringify({
      appName: env.APP_NAME || APP_NAME,
      loggedIn: true,
    }),
    {
      headers: {
        "Content-Type": "application/json; charset=utf-8",
        "Set-Cookie": serializeCookie(COOKIE_NAME, cookieValue, {
          httpOnly: true,
          maxAge: COOKIE_TTL_SECONDS,
          path: "/",
          sameSite: "Lax",
          secure: isSecureRequest(request),
        }),
      },
    },
  );
}

function handleLogout(request: Request): Response {
  return new Response(JSON.stringify({ loggedIn: false }), {
    headers: {
      "Content-Type": "application/json; charset=utf-8",
      "Set-Cookie": serializeCookie(COOKIE_NAME, "", {
        httpOnly: true,
        maxAge: 0,
        path: "/",
        sameSite: "Lax",
        secure: isSecureRequest(request),
      }),
    },
  });
}

async function handleSession(request: Request, env: Env): Promise<Response> {
  const session = await getSession(request, env);

  return json({
    appName: env.APP_NAME || APP_NAME,
    loggedIn: Boolean(session),
  });
}

async function handleListFiles(env: Env): Promise<Response> {
  const files = await listRecentFiles(env.CHAT_FILES);
  return json({ files });
}

async function handleUpload(request: Request, env: Env): Promise<Response> {
  const contentLength = request.headers.get("content-length");
  if (contentLength && Number(contentLength) > MAX_UPLOAD_BYTES + 1024 * 128) {
    return json({ error: "File is too large." }, 413);
  }

  const formData = await request.formData();
  const fileEntry = formData.get("file");

  if (!(fileEntry instanceof File)) {
    return json({ error: "Missing file payload." }, 400);
  }

  if (fileEntry.size > MAX_UPLOAD_BYTES) {
    return json({ error: "The file exceeds the 20 MB limit." }, 413);
  }

  const safeName = sanitizeFilename(fileEntry.name || "upload.bin");
  const fileId = createFileId(safeName);
  const key = toBucketKey(fileId);
  const contentType = normalizeContentType(fileEntry.type, safeName);

  await env.CHAT_FILES.put(key, fileEntry.stream(), {
    httpMetadata: {
      cacheControl: "private, max-age=0, no-store",
      contentDisposition: buildContentDisposition(safeName, false),
      contentType,
    },
    customMetadata: {
      originalName: safeName,
      uploadedAt: new Date().toISOString(),
    },
  });

  return json({
    file: {
      id: fileId,
      name: safeName,
      size: fileEntry.size,
      type: contentType,
      uploadedAt: new Date().toISOString(),
    } satisfies FileSummary,
  });
}

async function handleDownload(rawId: string, request: Request, env: Env): Promise<Response> {
  const fileId = decodeURIComponent(rawId);
  assertFileId(fileId);

  const object = await env.CHAT_FILES.get(toBucketKey(fileId));
  if (!object) {
    return json({ error: "File not found." }, 404);
  }

  const inline = new URL(request.url).searchParams.get("inline") === "1";
  const filename = object.customMetadata?.originalName || fileId;
  const headers = new Headers();
  headers.set(
    "Content-Type",
    normalizeContentType(object.httpMetadata?.contentType, filename),
  );
  headers.set("Cache-Control", "private, max-age=0, no-store");
  headers.set("Content-Length", String(object.size));
  headers.set("Content-Disposition", buildContentDisposition(filename, inline));

  return new Response(object.body, { headers });
}

async function handleChat(request: Request, env: Env): Promise<Response> {
  const body = await readJson<ChatRequestBody>(request);
  const rawMessages = Array.isArray(body.messages) ? body.messages : [];

  const messages = trimConversation(rawMessages);
  if (!messages.length) {
    return json({ error: "Please send a message first." }, 400);
  }

  const warnings: string[] = [];
  const input: Array<Record<string, unknown>> = [];
  let contextBytes = 0;

  for (const message of messages) {
    if (message.role === "assistant") {
      const assistantText = truncateText(message.text || "", MAX_TEXT_CHARS);
      if (!assistantText) {
        continue;
      }

      input.push({
        type: "message",
        role: "assistant",
        content: [{ type: "input_text", text: assistantText }],
      });
      continue;
    }

    const content: Array<Record<string, unknown>> = [];
    const text = truncateText(message.text || "", MAX_TEXT_CHARS);
    if (text) {
      content.push({ type: "input_text", text });
    }

    const attachments = Array.isArray(message.attachments)
      ? message.attachments.slice(0, MAX_ATTACHMENTS_PER_MESSAGE)
      : [];

    for (const attachment of attachments) {
      try {
        const addition = await loadAttachmentForModel(attachment.id, attachment.name, env);
        if (!addition) {
          warnings.push(`"${attachment.name || attachment.id}" was kept in storage but not sent to the model.`);
          continue;
        }

        if (contextBytes + addition.approximateBytes > MAX_CONTEXT_BYTES) {
          warnings.push(`"${attachment.name || attachment.id}" was skipped because the attachment context is already full.`);
          continue;
        }

        contextBytes += addition.approximateBytes;
        content.push(addition.item);
      } catch (error) {
        warnings.push(
          `"${attachment.name || attachment.id}" could not be loaded (${error instanceof Error ? error.message : "unknown error"}).`,
        );
      }
    }

    if (!content.length) {
      continue;
    }

    input.push({
      type: "message",
      role: "user",
      content,
    });
  }

  if (!input.length) {
    return json({ error: "No usable chat content was found." }, 400);
  }

  const response = await fetch(`${resolveOpenAIBaseUrl(env)}/v1/responses`, {
    method: "POST",
    headers: {
      "Authorization": `Bearer ${env.OPENAI_API_KEY}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      model: env.OPENAI_MODEL || "gpt-5.4-mini",
      store: false,
      instructions: OPENCLAW_INSTRUCTIONS,
      max_output_tokens: 1400,
      input,
      text: {
        format: {
          type: "text",
        },
      },
    }),
  });

  const data = (await response.json()) as Record<string, unknown>;

  if (!response.ok) {
    return json(
      {
        error: extractOpenAIError(data) || "OpenAI request failed.",
      },
      response.status,
    );
  }

  const text = extractAssistantText(data);

  return json({
    message: {
      role: "assistant",
      text,
    },
    warnings,
    usage: data.usage ?? null,
  });
}

async function serveStatic(request: Request, env: Env): Promise<Response> {
  const assetResponse = await env.ASSETS.fetch(request);
  if (assetResponse.status !== 404) {
    return assetResponse;
  }

  if (request.method === "GET" && acceptsHtml(request)) {
    const url = new URL(request.url);
    url.pathname = "/index.html";
    return env.ASSETS.fetch(new Request(url.toString(), request));
  }

  return assetResponse;
}

async function requireSession(request: Request, env: Env): Promise<SessionPayload | Response> {
  const session = await getSession(request, env);
  if (!session) {
    return json({ error: "Please log in first." }, 401);
  }

  return session;
}

async function getSession(request: Request, env: Env): Promise<SessionPayload | null> {
  const cookies = parseCookies(request.headers.get("cookie"));
  const cookieValue = cookies.get(COOKIE_NAME);
  if (!cookieValue) {
    return null;
  }

  const [encodedPayload, encodedSignature] = cookieValue.split(".");
  if (!encodedPayload || !encodedSignature) {
    return null;
  }

  const expectedSignature = await signValue(encodedPayload, env.SESSION_SECRET);
  if (encodedSignature !== expectedSignature) {
    return null;
  }

  const payload = JSON.parse(atob(fromBase64Url(encodedPayload))) as SessionPayload;
  const now = Math.floor(Date.now() / 1000);

  if (
    payload.sub !== COOKIE_SUBJECT ||
    payload.v !== COOKIE_VERSION ||
    payload.exp <= now ||
    payload.iat > now
  ) {
    return null;
  }

  return payload;
}

async function createSignedCookie(payload: SessionPayload, secret: string): Promise<string> {
  const encodedPayload = toBase64Url(
    encoder.encode(JSON.stringify(payload)).buffer as ArrayBuffer,
  );
  const signature = await signValue(encodedPayload, secret);
  return `${encodedPayload}.${signature}`;
}

async function signValue(value: string, secret: string): Promise<string> {
  const key = await crypto.subtle.importKey(
    "raw",
    encoder.encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const signature = await crypto.subtle.sign("HMAC", key, encoder.encode(value));
  return toBase64Url(signature);
}

async function readJson<T>(request: Request): Promise<T> {
  return (await request.json()) as T;
}

function json(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: {
      "Content-Type": "application/json; charset=utf-8",
      "Cache-Control": "no-store",
    },
  });
}

function serializeCookie(
  name: string,
  value: string,
  options: {
    httpOnly?: boolean;
    maxAge?: number;
    path?: string;
    sameSite?: "Lax" | "None" | "Strict";
    secure?: boolean;
  },
): string {
  const parts = [`${name}=${value}`];
  parts.push(`Path=${options.path || "/"}`);

  if (typeof options.maxAge === "number") {
    parts.push(`Max-Age=${options.maxAge}`);
  }
  if (options.httpOnly) {
    parts.push("HttpOnly");
  }
  if (options.sameSite) {
    parts.push(`SameSite=${options.sameSite}`);
  }
  if (options.secure) {
    parts.push("Secure");
  }

  return parts.join("; ");
}

function parseCookies(cookieHeader: string | null): Map<string, string> {
  const cookies = new Map<string, string>();
  if (!cookieHeader) {
    return cookies;
  }

  for (const segment of cookieHeader.split(";")) {
    const [name, ...rest] = segment.trim().split("=");
    if (!name) {
      continue;
    }

    cookies.set(name, rest.join("="));
  }

  return cookies;
}

function toBase64Url(value: ArrayBuffer): string {
  return arrayBufferToBase64(value)
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/g, "");
}

function fromBase64Url(value: string): string {
  const normalized = value.replace(/-/g, "+").replace(/_/g, "/");
  const padding = normalized.length % 4 === 0 ? "" : "=".repeat(4 - (normalized.length % 4));
  return normalized + padding;
}

function arrayBufferToBase64(value: ArrayBuffer): string {
  const bytes = new Uint8Array(value);
  const chunkSize = 0x8000;
  let binary = "";

  for (let index = 0; index < bytes.length; index += chunkSize) {
    const chunk = bytes.subarray(index, index + chunkSize);
    binary += String.fromCharCode(...chunk);
  }

  return btoa(binary);
}

async function listRecentFiles(bucket: R2Bucket): Promise<FileSummary[]> {
  const listed = await bucket.list({
    include: ["customMetadata", "httpMetadata"],
    limit: 100,
    prefix: FILE_PREFIX,
  });

  return listed.objects
    .slice()
    .sort((left, right) => right.uploaded.getTime() - left.uploaded.getTime())
    .map(toFileSummary)
    .slice(0, 50);
}

function toFileSummary(object: R2ObjectRecord): FileSummary {
  const fileId = object.key.slice(FILE_PREFIX.length);
  const originalName = object.customMetadata?.originalName || fileId;
  return {
    id: fileId,
    name: originalName,
    size: object.size,
    type: normalizeContentType(object.httpMetadata?.contentType, originalName),
    uploadedAt:
      object.customMetadata?.uploadedAt ||
      (object.uploaded instanceof Date ? object.uploaded.toISOString() : new Date().toISOString()),
  };
}

function sanitizeFilename(name: string): string {
  const baseName = name
    .trim()
    .replace(/[^\p{L}\p{N}._-]+/gu, "-")
    .replace(/-+/g, "-")
    .replace(/^-|-$/g, "");

  return baseName || "upload.bin";
}

function createFileId(filename: string): string {
  const extension = filename.includes(".")
    ? `.${(filename.split(".").pop() || "").toLowerCase().replace(/[^a-z0-9]/g, "")}`.replace(/\.$/, "")
    : "";
  const random = crypto.randomUUID().replace(/-/g, "").slice(0, 12);
  return `${Date.now().toString(36)}-${random}${extension}`.slice(0, 120);
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function normalizeContentType(contentType: string | undefined, filename: string): string {
  if (contentType && contentType !== "application/octet-stream") {
    return contentType;
  }

  const lower = filename.toLowerCase();
  if (lower.endsWith(".csv")) return "text/csv";
  if (lower.endsWith(".gif")) return "image/gif";
  if (lower.endsWith(".html")) return "text/html";
  if (lower.endsWith(".jpeg") || lower.endsWith(".jpg")) return "image/jpeg";
  if (lower.endsWith(".json")) return "application/json";
  if (lower.endsWith(".md")) return "text/markdown";
  if (lower.endsWith(".pdf")) return "application/pdf";
  if (lower.endsWith(".png")) return "image/png";
  if (lower.endsWith(".txt")) return "text/plain";
  if (lower.endsWith(".webp")) return "image/webp";
  if (lower.endsWith(".xml")) return "application/xml";
  if (lower.endsWith(".yaml") || lower.endsWith(".yml")) return "application/yaml";

  return "application/octet-stream";
}

function buildContentDisposition(filename: string, inline: boolean): string {
  const fallback = filename.replace(/["\\]/g, "_");
  const encoded = encodeURIComponent(filename);
  return `${inline ? "inline" : "attachment"}; filename="${fallback}"; filename*=UTF-8''${encoded}`;
}

function toBucketKey(fileId: string): string {
  return `${FILE_PREFIX}${fileId}`;
}

function assertFileId(fileId: string): void {
  if (!/^[a-z0-9._-]{1,140}$/i.test(fileId)) {
    throw new Error("Invalid file identifier.");
  }
}

function trimConversation(messages: ChatMessageInput[]): ChatMessageInput[] {
  return messages
    .filter((message) => message.role === "user" || message.role === "assistant")
    .slice(-MAX_CONVERSATION_MESSAGES)
    .map((message) => ({
      attachments: Array.isArray(message.attachments)
        ? message.attachments.map((attachment) => ({
            id: attachment.id,
            name: attachment.name,
            size: attachment.size,
            type: attachment.type,
            uploadedAt: attachment.uploadedAt,
          }))
        : [],
      role: message.role,
      text: truncateText(message.text || "", MAX_TEXT_CHARS),
    }));
}

function truncateText(value: string, limit: number): string {
  return value.trim().slice(0, limit);
}

async function loadAttachmentForModel(
  fileId: string,
  fileName: string | undefined,
  env: Env,
): Promise<{ approximateBytes: number; item: Record<string, unknown> } | null> {
  assertFileId(fileId);
  const object = await env.CHAT_FILES.get(toBucketKey(fileId));

  if (!object) {
    throw new Error("missing file");
  }

  const name = object.customMetadata?.originalName || fileName || fileId;
  const contentType = normalizeContentType(object.httpMetadata?.contentType, name);

  if (!isContextSupported(contentType, name)) {
    return null;
  }

  const buffer = await object.arrayBuffer();
  const base64 = arrayBufferToBase64(buffer);

  if (contentType.startsWith("image/")) {
    return {
      approximateBytes: base64.length,
      item: {
        type: "input_image",
        detail: "auto",
        image_url: `data:${contentType};base64,${base64}`,
      },
    };
  }

  return {
    approximateBytes: base64.length,
    item: {
      type: "input_file",
      filename: name,
      file_data: base64,
    },
  };
}

function isContextSupported(contentType: string, fileName: string): boolean {
  if (IMAGE_TYPES.has(contentType)) {
    return true;
  }

  if (SUPPORTED_DOC_TYPES.has(contentType)) {
    return true;
  }

  const lower = fileName.toLowerCase();
  return (
    lower.endsWith(".csv") ||
    lower.endsWith(".json") ||
    lower.endsWith(".md") ||
    lower.endsWith(".pdf") ||
    lower.endsWith(".txt") ||
    lower.endsWith(".xml") ||
    lower.endsWith(".yaml") ||
    lower.endsWith(".yml")
  );
}

function resolveOpenAIBaseUrl(env: Env): string {
  const base = (env.OPENAI_BASE_URL || "https://api.openai.com").replace(/\/+$/g, "");
  return base.endsWith("/v1") ? base.slice(0, -3) : base;
}

function isSecureRequest(request: Request): boolean {
  return new URL(request.url).protocol === "https:";
}

function extractOpenAIError(data: Record<string, unknown>): string | null {
  const error = data.error;
  if (!error || typeof error !== "object") {
    return null;
  }

  const message = (error as Record<string, unknown>).message;
  return typeof message === "string" ? message : null;
}

function extractAssistantText(data: Record<string, unknown>): string {
  if (typeof data.output_text === "string" && data.output_text.trim()) {
    return data.output_text;
  }

  const output = Array.isArray(data.output) ? data.output : [];
  const parts: string[] = [];

  for (const item of output) {
    if (!item || typeof item !== "object") {
      continue;
    }

    const maybeMessage = item as Record<string, unknown>;
    if (maybeMessage.type !== "message") {
      continue;
    }

    const content = Array.isArray(maybeMessage.content) ? maybeMessage.content : [];
    for (const part of content) {
      if (!part || typeof part !== "object") {
        continue;
      }

      const maybeText = part as Record<string, unknown>;
      if (maybeText.type === "output_text" && typeof maybeText.text === "string") {
        parts.push(maybeText.text);
      }
    }
  }

  return parts.join("\n\n").trim() || "OpenClaw did not return text.";
}

function acceptsHtml(request: Request): boolean {
  return request.headers.get("accept")?.includes("text/html") ?? false;
}
