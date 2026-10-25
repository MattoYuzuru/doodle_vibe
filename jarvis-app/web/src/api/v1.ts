// Typed client of /api/v1 (docs/backend-api.md). Types come from the backend contract so the two cannot drift.
// Task C owns this file; login methods are planned (docs/architecture/auth-sessions-contract.md) and may answer 404/409 until task A lands.
import type {
  AuthMethod, AuthRequest, Connection, Job, LoginMfaRequest, LoginSession, LoginStartRequest, LoginTicket, SourceItem, UniversitySpace,
} from "../../../../backend/contracts";

export type { AuthMethod, AuthRequest, Connection, Job, LoginSession, LoginStartRequest, LoginTicket, SourceItem, UniversitySpace };
export type {
  StreamClientMessage, StreamServerMessage, StoredSession, LearnedRecipe, SourceErrorCode,
} from "../../../../backend/contracts";

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
    const response = await (fetchImpl ?? fetch)(`${baseUrl}/api/v1${path}`, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) });
    const payload = await response.json().catch(() => null);
    if (!response.ok) throw new ApiV1Error(response.status, payload?.error?.code ?? "HTTP_ERROR", payload?.error?.requestId);
    return payload as T;
  }
  return {
    me: () => call<{ user: { id: string; displayName: string }; spaces: UniversitySpace[] }>("GET", "/me"),
    createSpace: (universityId: string, name: string) => call<{ space: UniversitySpace }>("POST", "/spaces", { universityId, name }),
    createConnection: (spaceId: string, sourceUrl: string, kind: Connection["kind"], label?: string) =>
      call<{ connection: Connection; job: Job }>("POST", `/spaces/${spaceId}/connections`, { sourceUrl, kind, ...(label ? { label } : {}) }),
    connection: (id: string) => call<{ connection: Connection; authMethods: AuthMethod[]; login: LoginSession | null }>("GET", `/connections/${id}`),
    deleteConnection: (id: string) => call<{ deleted: true }>("DELETE", `/connections/${id}`),
    auth: (id: string, request: AuthRequest) => call<{ saved: true; job: Job }>("POST", `/connections/${id}/auth`, request),
    sync: (id: string) => call<{ job: Job }>("POST", `/connections/${id}/sync`, {}),
    job: (id: string) => call<{ job: Job }>("GET", `/jobs/${id}`),
    items: (spaceId: string, kind: "schedule" | "deadlines" | "courses") =>
      call<{ spaceId: string; items: SourceItem[]; sources: Array<{ connectionId: string; fetchedAt: string; stale: boolean }> }>("GET", `/spaces/${spaceId}/${kind}`),
    // Planned (task A): remote-browser login.
    startLogin: (connectionId: string, request: LoginStartRequest) => call<{ login: LoginSession }>("POST", `/connections/${connectionId}/login`, request),
    login: (id: string) => call<{ login: LoginSession }>("GET", `/login/${id}`),
    submitMfa: (id: string, request: LoginMfaRequest) => call<{ login: LoginSession }>("POST", `/login/${id}/mfa`, request),
    handoff: (id: string) => call<{ login: LoginSession }>("POST", `/login/${id}/handoff`, {}),
    cancelLogin: (id: string) => call<{ login: LoginSession }>("POST", `/login/${id}/cancel`, {}),
    loginTicket: (id: string) => call<LoginTicket>("POST", `/login/${id}/ticket`, {}),
  };
}
export type ApiV1Client = ReturnType<typeof createApiV1Client>;
