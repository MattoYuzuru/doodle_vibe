// Typed client of /api/v1 (docs/backend-api.md). Types come from the backend contract so the two cannot drift.
// Task C owns this file; login methods follow docs/architecture/auth-sessions-contract.md and answer 404/409 where the server has no Chromium.
import type {
  AuthMethod, AuthRequest, Connection, Job, LoginMfaRequest, LoginSession, LoginStartRequest, LoginTicket, SourceItem, UniversitySpace,
} from "../../../../backend/contracts";

export type { AuthMethod, AuthRequest, Connection, Job, LoginSession, LoginStartRequest, LoginTicket, SourceItem, UniversitySpace };
export type {
  StreamClientMessage, StreamServerMessage, StoredSession, LearnedRecipe, SourceErrorCode,
} from "../../../../backend/contracts";

/** Text document stored for a space (GET /spaces/:id/documents). */
export interface SourceDocument { id: string; connectionId: string; url: string; title: string; text: string; fetchedAt: string }
export interface SourceFreshness { connectionId: string; fetchedAt: string; stale: boolean }

export class ApiV1Error extends Error {
  constructor(readonly status: number, readonly code: string, readonly requestId?: string) { super(code); }
}

export interface ApiV1Options {
  baseUrl?: string;
  /** Telegram Mini App initData; omitted in the local dev-auth mode. Never log or persist it. */
  initData?: () => string;
  fetchImpl?: typeof fetch;
}

export function createApiV1Client({ baseUrl = "", initData = () => "", fetchImpl }: ApiV1Options = {}) {
  async function call<T>(method: string, path: string, body?: unknown): Promise<T> {
    const headers: Record<string, string> = {};
    const data = initData();
    if (data) headers["x-telegram-init-data"] = data;
    if (body !== undefined) headers["content-type"] = "application/json";
    let response: Response;
    try {
      response = await (fetchImpl ?? fetch)(`${baseUrl}/api/v1${path}`, { method, headers, body: body === undefined ? undefined : JSON.stringify(body), signal: AbortSignal.timeout(30_000) });
    } catch {
      throw new ApiV1Error(0, "OFFLINE");
    }
    const payload = await response.json().catch(() => null);
    if (!response.ok) throw new ApiV1Error(response.status, payload?.error?.code ?? "HTTP_ERROR", payload?.error?.requestId);
    return payload as T;
  }
  return {
    spaces: () => call<{ spaces: UniversitySpace[] }>("GET", "/spaces"),
    me: () => call<{ user: { id: string; displayName: string }; spaces: UniversitySpace[] }>("GET", "/me"),
    createSpace: (universityId: string, name: string) => call<{ space: UniversitySpace }>("POST", "/spaces", { universityId, name }),
    connections: (spaceId: string) => call<{ connections: Connection[] }>("GET", `/spaces/${spaceId}/connections`),
    createConnection: (spaceId: string, sourceUrl: string, kind: Connection["kind"], label?: string) =>
      call<{ connection: Connection; job: Job }>("POST", `/spaces/${spaceId}/connections`, { sourceUrl, kind, ...(label ? { label } : {}) }),
    connection: (id: string) => call<{ connection: Connection; authMethods: AuthMethod[]; login: LoginSession | null }>("GET", `/connections/${id}`),
    deleteConnection: (id: string) => call<{ deleted: true }>("DELETE", `/connections/${id}`),
    auth: (id: string, request: AuthRequest) => call<{ saved: true; job: Job }>("POST", `/connections/${id}/auth`, request),
    sync: (id: string) => call<{ job: Job }>("POST", `/connections/${id}/sync`, {}),
    job: (id: string) => call<{ job: Job }>("GET", `/jobs/${id}`),
    documents: (spaceId: string) => call<{ documents: SourceDocument[]; kind: "source_documents" }>("GET", `/spaces/${spaceId}/documents`),
    items: (spaceId: string, kind: "schedule" | "deadlines" | "courses") =>
      call<{ spaceId: string; items: SourceItem[]; sources: SourceFreshness[]; connections?: Connection[] }>("GET", `/spaces/${spaceId}/${kind}`),
    oauth: (connectionId: string, providerId: string) => call<{ authorizationUrl: string; expiresAt: string }>("POST", `/connections/${connectionId}/oauth`, { providerId }),
    // Remote-browser login (task A).
    startLogin: (connectionId: string, request: LoginStartRequest) => call<{ login: LoginSession }>("POST", `/connections/${connectionId}/login`, request),
    login: (id: string) => call<{ login: LoginSession }>("GET", `/login/${id}`),
    submitMfa: (id: string, request: LoginMfaRequest) => call<{ login: LoginSession }>("POST", `/login/${id}/mfa`, request),
    handoff: (id: string) => call<{ login: LoginSession }>("POST", `/login/${id}/handoff`, {}),
    cancelLogin: (id: string) => call<{ login: LoginSession }>("POST", `/login/${id}/cancel`, {}),
    loginTicket: (id: string) => call<LoginTicket>("POST", `/login/${id}/ticket`, {}),
  };
}
/** WebSocket address of a login stream: `path` comes from POST /login/:id/ticket and already carries the one-time ticket. */
export function loginStreamUrl(ticket: LoginTicket, location: Pick<Location, "protocol" | "host">): string {
  const path = ticket.path.includes("ticket=") ? ticket.path : `${ticket.path}${ticket.path.includes("?") ? "&" : "?"}ticket=${encodeURIComponent(ticket.ticket)}`;
  return `${location.protocol === "https:" ? "wss:" : "ws:"}//${location.host}${path.startsWith("/") ? path : `/${path}`}`;
}
export type ApiV1Client = ReturnType<typeof createApiV1Client>;
