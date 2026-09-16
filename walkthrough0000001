# PeerGrid — Complete Project Walkthrough

## What Is PeerGrid?

**PeerGrid** is a **real-time collaborative workspace** — think of it as a simplified Google Docs with a file/folder system. Multiple users can simultaneously create folders, manage files, and co-edit rich-text documents with **zero merge conflicts**. Every edit is automatically resolved using **CRDTs** (Conflict-free Replicated Data Types), making collaboration seamless regardless of network conditions.

---

## High-Level Architecture

```mermaid
flowchart TB
    subgraph Browser["Browser (React 18 SPA)"]
        UI["UI Layer<br/>Login · Sidebar · Editor · Toolbar"]
        YDoc["Y.Doc (local CRDT state)"]
        WS["WebSocket Client"]
    end

    subgraph Server["Fastify Server (:4850)"]
        REST["REST API Layer<br/>/api/auth · /api/folders · /api/files<br/>/api/permissions · /api/search"]
        CollabSrv["Collaboration Server<br/>Per-file Y.Doc rooms<br/>Sync + Awareness protocol"]
        RoomStore["RoomStore<br/>(In-Memory or Redis)"]
    end

    subgraph Infra["Infrastructure"]
        PG["PostgreSQL 16<br/>Users · Folders · Files<br/>Y.Doc state (BYTEA)"]
        Prom["Prometheus"]
        Graf["Grafana"]
    end

    UI --> REST
    UI --> WS
    WS --> CollabSrv
    REST --> PG
    CollabSrv --> RoomStore
    RoomStore --> PG
    Server --> Prom --> Graf
```

---

## Monorepo Structure (pnpm Workspaces)

The project is organized as a **pnpm monorepo** with 6 packages:

| Package | Purpose | Key Technologies |
|---------|---------|------------------|
| [packages/server](file:///c:/Users/Vaibhav%20Tadikamalla/Desktop/2PeerGrid/packages/server) | REST API + WebSocket server | Fastify 4, ws 8.16, Yjs, PostgreSQL |
| [packages/client](file:///c:/Users/Vaibhav%20Tadikamalla/Desktop/2PeerGrid/packages/client) | React SPA | React 18, Vite 5, TipTap, Tailwind CSS |
| [packages/shared](file:///c:/Users/Vaibhav%20Tadikamalla/Desktop/2PeerGrid/packages/shared) | Shared types & protocol constants | TypeScript |
| [packages/landing](file:///c:/Users/Vaibhav%20Tadikamalla/Desktop/2PeerGrid/packages/landing) | Marketing landing page | - |
| [packages/sdk](file:///c:/Users/Vaibhav%20Tadikamalla/Desktop/2PeerGrid/packages/sdk) | Client SDK | - |
| [packages/tests](file:///c:/Users/Vaibhav%20Tadikamalla/Desktop/2PeerGrid/packages/tests) | Integration tests | - |

---

## 1. Server Package — The Backend Brain

### Entry Point & Boot Sequence

[index.ts](file:///c:/Users/Vaibhav%20Tadikamalla/Desktop/2PeerGrid/packages/server/src/index.ts) orchestrates startup in this exact order:

1. **Load config** → Validates all env vars via Zod schema ([config.ts](file:///c:/Users/Vaibhav%20Tadikamalla/Desktop/2PeerGrid/packages/server/src/config.ts))
2. **Create logger** → Pino structured logging (JSON in prod, pretty in dev)
3. **Initialize JWT keys** → RS256 asymmetric key pair loaded from env
4. **Create DB pool** → PostgreSQL connection pool (2–10 connections)
5. **Wait for database** → Retries `SELECT 1` up to 20 times
6. **Create HTTP server** → Fastify with all plugins and routes
7. **Start WebSocket server** → CollaborationServer attached to Fastify's HTTP server
8. **Register shutdown handlers** → Graceful SIGTERM/SIGINT handling
9. **Listen** → Binds to `0.0.0.0:4850`

### REST API Routes

[server.ts](file:///c:/Users/Vaibhav%20Tadikamalla/Desktop/2PeerGrid/packages/server/src/server.ts) registers **15 route modules**:

| Route File | Endpoints | Purpose |
|-----------|-----------|---------|
| [auth.ts](file:///c:/Users/Vaibhav%20Tadikamalla/Desktop/2PeerGrid/packages/server/src/routes/auth.ts) | `POST /api/auth/register`, `POST /api/auth/login`, `POST /api/auth/refresh`, `POST /api/auth/logout`, `DELETE /api/auth/account`, `GET /api/auth/me` | User registration, login, JWT token management, account deletion |
| [folders.ts](file:///c:/Users/Vaibhav%20Tadikamalla/Desktop/2PeerGrid/packages/server/src/routes/folders.ts) | CRUD for `/api/folders` | Create, list, rename, delete folders |
| [files.ts](file:///c:/Users/Vaibhav%20Tadikamalla/Desktop/2PeerGrid/packages/server/src/routes/files.ts) | CRUD for `/api/files` | Create, list, rename, soft-delete, restore files |
| [permissions.ts](file:///c:/Users/Vaibhav%20Tadikamalla/Desktop/2PeerGrid/packages/server/src/routes/permissions.ts) | `/api/folders/:id/permissions` | Share folders with users (grant/revoke roles) |
| [activity.ts](file:///c:/Users/Vaibhav%20Tadikamalla/Desktop/2PeerGrid/packages/server/src/routes/activity.ts) | `/api/activity/folder/:id` | Activity audit log |
| [search.ts](file:///c:/Users/Vaibhav%20Tadikamalla/Desktop/2PeerGrid/packages/server/src/routes/search.ts) | `GET /api/search?q=` | Full-text + prefix search across files |
| [versions.ts](file:///c:/Users/Vaibhav%20Tadikamalla/Desktop/2PeerGrid/packages/server/src/routes/versions.ts) | `/api/files/:id/versions` | Document version history |
| [health.ts](file:///c:/Users/Vaibhav%20Tadikamalla/Desktop/2PeerGrid/packages/server/src/routes/health.ts) | `GET /health`, `GET /health/ready` | Liveness & readiness probes |
| [dashboard.ts](file:///c:/Users/Vaibhav%20Tadikamalla/Desktop/2PeerGrid/packages/server/src/routes/dashboard.ts) | Dashboard data endpoints | Workspace statistics |
| [admin.ts](file:///c:/Users/Vaibhav%20Tadikamalla/Desktop/2PeerGrid/packages/server/src/routes/admin.ts) | Admin management routes | System administration |
| [admin-dashboard.ts](file:///c:/Users/Vaibhav%20Tadikamalla/Desktop/2PeerGrid/packages/server/src/routes/admin-dashboard.ts) | Admin dashboard | Admin analytics & monitoring |
| [simulation.ts](file:///c:/Users/Vaibhav%20Tadikamalla/Desktop/2PeerGrid/packages/server/src/routes/simulation.ts) | Simulation endpoints | Load testing & demos |
| [debug.ts](file:///c:/Users/Vaibhav%20Tadikamalla/Desktop/2PeerGrid/packages/server/src/routes/debug.ts) | Debug endpoints (dev only) | Development debugging |

### Authentication System

```mermaid
sequenceDiagram
    participant C as Client
    participant S as Server
    participant DB as PostgreSQL

    Note over C,DB: Registration Flow
    C->>S: POST /api/auth/register {email, password, name}
    S->>S: Zod validate + bcrypt hash (12 rounds)
    S->>DB: INSERT INTO users
    S->>S: Sign JWT (RS256) + Generate refresh token
    S->>DB: INSERT INTO refresh_tokens (hashed)
    S->>C: {accessToken, user} + Set-Cookie: refresh_token (httpOnly)

    Note over C,DB: Token Refresh (with reuse detection)
    C->>S: POST /api/auth/refresh (cookie)
    S->>DB: SELECT + FOR UPDATE (atomic)
    alt Token already revoked
        S->>DB: Revoke ALL tokens for user (stolen token protection)
        S->>C: 401 Unauthorized
    else Valid token
        S->>DB: Rotate: revoke old, insert new, link via replaced_by
        S->>C: New accessToken + new refresh cookie
    end
```

**Key security features:**
- **JWT RS256** — Asymmetric keys (private key signs, public key verifies)
- **Refresh token rotation** — Each refresh token is single-use; reuse triggers family revocation
- **Rate limiting** — Login: 5 req/15min per IP, 8 req/15min per email; Register: 3 req/5min
- **bcrypt** — Password hashing with 12 salt rounds
- **httpOnly cookies** — Refresh tokens never exposed to JavaScript

### Business Logic Services

| Service | File | Responsibility |
|---------|------|---------------|
| Workspace Permissions | [workspacePermissionService.ts](file:///c:/Users/Vaibhav%20Tadikamalla/Desktop/2PeerGrid/packages/server/src/services/workspacePermissionService.ts) | RBAC enforcement (owner/editor/viewer) at folder level |
| File Service | [fileService.ts](file:///c:/Users/Vaibhav%20Tadikamalla/Desktop/2PeerGrid/packages/server/src/services/fileService.ts) | CRUD, soft-delete, restore |
| Folder Service | [folderService.ts](file:///c:/Users/Vaibhav%20Tadikamalla/Desktop/2PeerGrid/packages/server/src/services/folderService.ts) | CRUD, cascade operations |
| Edit Tracking | [editTrackingService.ts](file:///c:/Users/Vaibhav%20Tadikamalla/Desktop/2PeerGrid/packages/server/src/services/editTrackingService.ts) | In-memory edit batching → DB flush every 5s |
| Search | [searchService.ts](file:///c:/Users/Vaibhav%20Tadikamalla/Desktop/2PeerGrid/packages/server/src/services/searchService.ts) | PostgreSQL full-text search (GIN index) + ILIKE prefix matching |
| Activity | [activityService.ts](file:///c:/Users/Vaibhav%20Tadikamalla/Desktop/2PeerGrid/packages/server/src/services/activityService.ts) | Audit log for all workspace actions |
| Versioning | [versionService.ts](file:///c:/Users/Vaibhav%20Tadikamalla/Desktop/2PeerGrid/packages/server/src/services/versionService.ts) | Document version snapshots & restoration |

### WebSocket / Collaboration Engine

This is the **heart of PeerGrid**. The main file is the massive [websocket.ts](file:///c:/Users/Vaibhav%20Tadikamalla/Desktop/2PeerGrid/packages/server/src/websocket.ts) (89KB, ~2000+ lines) which implements `CollaborationServer`.

```mermaid
sequenceDiagram
    participant C1 as Client A
    participant WS as WebSocket Server
    participant Doc as Y.Doc (server)
    participant DB as PostgreSQL
    participant C2 as Client B

    C1->>WS: ws://server/ws (upgrade)
    C1->>WS: {type:"auth", accessToken, fileId}
    WS->>WS: Verify JWT, check file permissions
    WS->>C1: {type:"auth_success", color, role}

    Note over WS,Doc: Room created (or joined) for fileId
    WS->>DB: Load ydoc_state (BYTEA)
    WS->>Doc: Y.applyUpdate(savedState)

    C1->>WS: SyncStep1 (state vector)
    WS->>C1: SyncStep2 (missing updates)

    Note over C1,C2: Real-Time Editing
    C1->>WS: CRDT update (binary Yjs)
    WS->>Doc: Y.applyUpdate(update)
    WS->>C2: Broadcast CRDT update
    WS->>C2: Awareness update (cursor position)

    Note over WS,DB: Auto-save every 10s
    WS->>DB: UPDATE files SET ydoc_state = Y.encodeStateAsUpdate(doc)
```

**The WebSocket subsystem** (`packages/server/src/ws/`) contains 20 specialized files:

| File | Lines | Purpose |
|------|-------|---------|
| [Room.ts](file:///c:/Users/Vaibhav%20Tadikamalla/Desktop/2PeerGrid/packages/server/src/ws/Room.ts) | 750+ | Per-document room managing Y.Doc instance, connected clients, and sync |
| [RedisRoomStore.ts](file:///c:/Users/Vaibhav%20Tadikamalla/Desktop/2PeerGrid/packages/server/src/ws/RedisRoomStore.ts) | 1200+ | Distributed room storage via Redis pub/sub for multi-node deployment |
| [RoomStore.ts](file:///c:/Users/Vaibhav%20Tadikamalla/Desktop/2PeerGrid/packages/server/src/ws/RoomStore.ts) | 140 | In-memory room store (single-node) |
| [consistentHash.ts](file:///c:/Users/Vaibhav%20Tadikamalla/Desktop/2PeerGrid/packages/server/src/ws/consistentHash.ts) | 527 | CRC32 hash ring for deterministic room ownership across cluster nodes |
| [redisStreams.ts](file:///c:/Users/Vaibhav%20Tadikamalla/Desktop/2PeerGrid/packages/server/src/ws/redisStreams.ts) | 750+ | Durable CRDT event log via Redis Streams (crash recovery) |
| [presenceService.ts](file:///c:/Users/Vaibhav%20Tadikamalla/Desktop/2PeerGrid/packages/server/src/ws/presenceService.ts) | 500+ | Global presence with 20Hz rate limiting + viewport-based throttling |
| [byzantineGuard.ts](file:///c:/Users/Vaibhav%20Tadikamalla/Desktop/2PeerGrid/packages/server/src/ws/byzantineGuard.ts) | 200 | Malicious payload validation for CRDT updates |
| [backpressure.ts](file:///c:/Users/Vaibhav%20Tadikamalla/Desktop/2PeerGrid/packages/server/src/ws/backpressure.ts) | 180 | WebSocket write buffer pressure management |
| [ConnectionGuards.ts](file:///c:/Users/Vaibhav%20Tadikamalla/Desktop/2PeerGrid/packages/server/src/ws/ConnectionGuards.ts) | 200 | Connection admission control and limits |
| [PermissionGateway.ts](file:///c:/Users/Vaibhav%20Tadikamalla/Desktop/2PeerGrid/packages/server/src/ws/PermissionGateway.ts) | 100 | WebSocket-level permission enforcement |
| [roomEvictor.ts](file:///c:/Users/Vaibhav%20Tadikamalla/Desktop/2PeerGrid/packages/server/src/ws/roomEvictor.ts) | 190 | LRU eviction of idle rooms from memory |
| [reconnectAdmission.ts](file:///c:/Users/Vaibhav%20Tadikamalla/Desktop/2PeerGrid/packages/server/src/ws/reconnectAdmission.ts) | 160 | Reconnection handling and admission control |
| [redisReconciliation.ts](file:///c:/Users/Vaibhav%20Tadikamalla/Desktop/2PeerGrid/packages/server/src/ws/redisReconciliation.ts) | 250 | Cross-node Y.Doc reconciliation protocol |
| [streamIdempotency.ts](file:///c:/Users/Vaibhav%20Tadikamalla/Desktop/2PeerGrid/packages/server/src/ws/streamIdempotency.ts) | 420 | Exactly-once delivery for Redis Stream messages |
| [clusterClock.ts](file:///c:/Users/Vaibhav%20Tadikamalla/Desktop/2PeerGrid/packages/server/src/ws/clusterClock.ts) | 300 | Hybrid logical clock for distributed ordering |
| [SessionTrackingService.ts](file:///c:/Users/Vaibhav%20Tadikamalla/Desktop/2PeerGrid/packages/server/src/ws/SessionTrackingService.ts) | 160 | Edit session lifecycle tracking |

### How CRDTs Work (The Core Innovation)

> [!IMPORTANT]
> CRDTs are what make PeerGrid special. Unlike Google Docs (which uses Operational Transformation), CRDTs are **mathematically proven** to converge — no central coordinator needed.

**Yjs** (the CRDT library used) works like this:

1. **Every character gets a unique ID** — based on a logical clock + client ID
2. **Merge is commutative** — `merge(A,B) = merge(B,A)` always
3. **Merge is idempotent** — applying the same update twice has no effect
4. **No coordination needed** — clients can edit offline and sync later

The Y.Doc binary state is stored in PostgreSQL as `BYTEA` — compact but not SQL-queryable. This is an intentional tradeoff for portability and size.

### Persistence Layer

| File | Purpose |
|------|---------|
| [snapshotStore.ts](file:///c:/Users/Vaibhav%20Tadikamalla/Desktop/2PeerGrid/packages/server/src/persistence/snapshotStore.ts) | Y.Doc snapshot read/write to PostgreSQL |
| [snapshotQueue.ts](file:///c:/Users/Vaibhav%20Tadikamalla/Desktop/2PeerGrid/packages/server/src/persistence/snapshotQueue.ts) | Async queue for batching snapshot writes |
| [updateLog.ts](file:///c:/Users/Vaibhav%20Tadikamalla/Desktop/2PeerGrid/packages/server/src/persistence/updateLog.ts) | Write-ahead log for incremental CRDT updates |
| [compactionService.ts](file:///c:/Users/Vaibhav%20Tadikamalla/Desktop/2PeerGrid/packages/server/src/persistence/compactionService.ts) | Compacts WAL entries into snapshots periodically |
| [versionStore.ts](file:///c:/Users/Vaibhav%20Tadikamalla/Desktop/2PeerGrid/packages/server/src/persistence/versionStore.ts) | Document version management |

### Database Schema (10 Migrations)

The schema evolved across [10 migration files](file:///c:/Users/Vaibhav%20Tadikamalla/Desktop/2PeerGrid/packages/server/src/db/migrations):

```mermaid
erDiagram
    users {
        UUID id PK
        TEXT email UK
        TEXT password_hash
        TEXT display_name
        TEXT avatar_url
        BOOLEAN email_verified
    }

    folders {
        UUID id PK
        TEXT name
        UUID owner_id FK
    }

    folder_permissions {
        UUID folder_id FK
        UUID user_id FK
        TEXT role "owner|editor|viewer"
    }

    files {
        UUID id PK
        TEXT name
        UUID folder_id FK
        BYTEA ydoc_state
        TIMESTAMPTZ deleted_at
    }

    refresh_tokens {
        UUID id PK
        UUID user_id FK
        TEXT token_hash UK
        TIMESTAMPTZ expires_at
        UUID replaced_by FK
    }

    edit_sessions {
        UUID id PK
        UUID file_id FK
        UUID user_id FK
        INT edit_count
    }

    activity_logs {
        UUID id PK
        UUID folder_id FK
        TEXT action_type
        TEXT entity_type
    }

    document_snapshots {
        UUID id PK
        UUID document_id FK
        BYTEA ydoc_state
        INT operation_count
    }

    document_versions {
        UUID id PK
        UUID file_id FK
        BYTEA ydoc_state
        TEXT label
    }

    users ||--o{ folders : owns
    users ||--o{ folder_permissions : has
    folders ||--o{ folder_permissions : grants
    folders ||--o{ files : contains
    files ||--o{ edit_sessions : tracks
    files ||--o{ document_snapshots : snapshots
    files ||--o{ document_versions : versions
    users ||--o{ refresh_tokens : has
    folders ||--o{ activity_logs : logs
```

### Metrics & Observability

The server exposes **50+ Prometheus metrics** across 16 groups:

| Group | Examples |
|-------|---------|
| HTTP | Request count, latency histograms, error rates |
| WebSocket | Active connections, messages/sec, room count |
| Database | Query latency, pool utilization, migration status |
| CRDT | Document size, update frequency, sync duration |
| Rooms | Active rooms, evictions, memory usage |
| Presence | Rate limit drops, viewport throttle events |
| Streams | Published/consumed messages, consumer lag |
| Topology | Cluster size, ownership transfers, rebalance time |

These are scraped by **Prometheus** (port 9090) and visualized in **Grafana** (port 3005).

---

## 2. Client Package — The React Frontend

### App Structure

[App.tsx](file:///c:/Users/Vaibhav%20Tadikamalla/Desktop/2PeerGrid/packages/client/src/App.tsx) sets up the SPA:

```
ErrorBoundary
  └─ QueryClientProvider (TanStack React Query)
       └─ BrowserRouter
            └─ AuthProvider (JWT context)
                 └─ Routes
                      ├─ /login     → LoginPage        (PublicRoute)
                      ├─ /register  → LoginPage         (PublicRoute)
                      ├─ /          → WorkspacePage      (ProtectedRoute)
                      └─ /admin     → AdminDashboardPage
```

### Key UI Components

| Component | File | What It Does |
|-----------|------|-------------|
| LoginPage | [features/auth/](file:///c:/Users/Vaibhav%20Tadikamalla/Desktop/2PeerGrid/packages/client/src/features/auth) | Email/password sign-in/up with toggle tabs |
| WorkspacePage | [WorkspacePage.tsx](file:///c:/Users/Vaibhav%20Tadikamalla/Desktop/2PeerGrid/packages/client/src/features/workspace/WorkspacePage.tsx) | Main workspace layout with sidebar + editor |
| Sidebar | [Sidebar.tsx](file:///c:/Users/Vaibhav%20Tadikamalla/Desktop/2PeerGrid/packages/client/src/features/workspace/Sidebar.tsx) | Folder/file tree, create/rename/delete, user profile, logout |
| FileEditor | [FileEditor.tsx](file:///c:/Users/Vaibhav%20Tadikamalla/Desktop/2PeerGrid/packages/client/src/features/workspace/FileEditor.tsx) | TipTap rich-text editor with CRDT collaboration |
| EditorToolbar | [EditorToolbar.tsx](file:///c:/Users/Vaibhav%20Tadikamalla/Desktop/2PeerGrid/packages/client/src/features/workspace/EditorToolbar.tsx) | Bold, italic, underline, headings, lists, alignment, etc. |
| ActiveUsers | [ActiveUsers.tsx](file:///c:/Users/Vaibhav%20Tadikamalla/Desktop/2PeerGrid/packages/client/src/features/workspace/ActiveUsers.tsx) | Live user avatars in editor header |
| PermissionsModal | [PermissionsModal.tsx](file:///c:/Users/Vaibhav%20Tadikamalla/Desktop/2PeerGrid/packages/client/src/features/workspace/PermissionsModal.tsx) | Share folders, manage roles |
| ActivityDrawer | [ActivityDrawer.tsx](file:///c:/Users/Vaibhav%20Tadikamalla/Desktop/2PeerGrid/packages/client/src/features/workspace/ActivityDrawer.tsx) | Timeline of workspace actions |
| TrashDrawer | [TrashDrawer.tsx](file:///c:/Users/Vaibhav%20Tadikamalla/Desktop/2PeerGrid/packages/client/src/features/workspace/TrashDrawer.tsx) | Soft-deleted files with restore |
| HistoryPanel | [history/](file:///c:/Users/Vaibhav%20Tadikamalla/Desktop/2PeerGrid/packages/client/src/features/workspace/history) | Document version history with diff view |
| CommentSidebar | [comments/](file:///c:/Users/Vaibhav%20Tadikamalla/Desktop/2PeerGrid/packages/client/src/features/workspace/comments) | Threaded comments on document selections |

### The Collaboration Hook

[useCollaboration.ts](file:///c:/Users/Vaibhav%20Tadikamalla/Desktop/2PeerGrid/packages/client/src/hooks/useCollaboration.ts) is the **bridge between the UI and the CRDT engine**. It:

1. **Creates a Y.Doc** — the local CRDT document
2. **Opens a WebSocket** to the server
3. **Authenticates** — sends `{type: "auth", accessToken, fileId}`
4. **Performs Yjs sync** — SyncStep1 (state vector) → SyncStep2 (missing updates)
5. **Listens for local edits** → encodes as binary Yjs messages → sends to server
6. **Listens for remote edits** → applies to local Y.Doc (origin: 'remote')
7. **Manages awareness** — broadcasts cursor position/selection/user info
8. **Handles disconnection** — exponential backoff reconnect (2s → 4s → 8s → … → 10s max)
9. **Cleans up listeners** — prevents memory leaks and stale closure bugs

### State Management

| Store | File | What It Manages |
|-------|------|----------------|
| Workspace Store | [workspaceStore.ts](file:///c:/Users/Vaibhav%20Tadikamalla/Desktop/2PeerGrid/packages/client/src/stores/workspaceStore.ts) | Folders, files, active selections, UI drawer state |
| Comment Store | [commentStore.ts](file:///c:/Users/Vaibhav%20Tadikamalla/Desktop/2PeerGrid/packages/client/src/stores) | Comment thread state, sidebar toggle |
| Auth Context | [lib/auth/](file:///c:/Users/Vaibhav%20Tadikamalla/Desktop/2PeerGrid/packages/client/src/lib/auth) | User session, token management, login/logout |

### Rich-Text Editor (TipTap)

The editor uses **TipTap** (built on ProseMirror) with these extensions:

- **StarterKit** — Basic formatting (bold, italic, code, blockquotes, lists)
- **Collaboration** — Connects TipTap to the Y.Doc for live sync
- **CollaborationCursor** — Shows other users' cursor positions with colors
- **Placeholder** — "Start writing…" placeholder
- **Highlight** — Multi-color text highlighting
- **TaskList / TaskItem** — Checkbox task lists
- **TextAlign** — Left/center/right/justify alignment
- **Underline** — Underline text
- **CommentMark** — Inline comment annotations

---

## 3. Shared Package — The Contract

[packages/shared](file:///c:/Users/Vaibhav%20Tadikamalla/Desktop/2PeerGrid/packages/shared/src) provides the **type-safe contract** between server and client:

- **[types.ts](file:///c:/Users/Vaibhav%20Tadikamalla/Desktop/2PeerGrid/packages/shared/src/types.ts)** — `User`, `Folder`, `WorkspaceFile`, `FolderPermission`, `ActivityEntry`, `Contributor`, `SearchResult`
- **[protocol.ts](file:///c:/Users/Vaibhav%20Tadikamalla/Desktop/2PeerGrid/packages/shared/src/protocol.ts)** — WebSocket binary message types (`MSG_SYNC=0`, `MSG_AWARENESS=1`, `MSG_AUTH=2`, `MSG_CONTROL=3`) and control subtypes (lock, join, leave, access revoked, error)
- **[constants.ts](file:///c:/Users/Vaibhav%20Tadikamalla/Desktop/2PeerGrid/packages/shared/src/constants.ts)** — Shared constants

---

## 4. Permission System (RBAC)

PeerGrid uses **folder-level Role-Based Access Control**:

| Role | REST API | WebSocket | UI |
|------|----------|-----------|-----|
| **Owner** | Full CRUD + manage permissions + permanent delete | Read + Write | All controls, Share button |
| **Editor** | Create/rename/delete files, edit content | Read + Write | File CRUD, no share |
| **Viewer** | Read-only access | Read only (writes rejected) | Read-only badge, no toolbar |

**Enforcement points:**
- Every REST endpoint calls `workspacePermissionService` before executing
- WebSocket `handleSyncMessage()` rejects CRDT updates from viewers
- Permission revocation → in-memory role downgrade → WebSocket disconnect
- Folder deletion → force-closes all WebSocket rooms for contained files

---

## 5. Production Architecture (Scaling Design)

The codebase includes a full **production-grade scaling architecture** designed for **100k concurrent users, 10k documents, 5–10 nodes**:

### Consistent Hash Ring
[consistentHash.ts](file:///c:/Users/Vaibhav%20Tadikamalla/Desktop/2PeerGrid/packages/server/src/ws/consistentHash.ts) — CRC32 hash ring with 150 virtual nodes per physical node. Each document room is deterministically assigned to exactly one owner node. When nodes join/leave, only ~1/N of rooms rebalance.

### Redis Streams
[redisStreams.ts](file:///c:/Users/Vaibhav%20Tadikamalla/Desktop/2PeerGrid/packages/server/src/ws/redisStreams.ts) — Durable CRDT update log per room. Unlike pub/sub (fire-and-forget), Streams provide crash recovery via replay from the last acknowledged position.

### Presence Service
[presenceService.ts](file:///c:/Users/Vaibhav%20Tadikamalla/Desktop/2PeerGrid/packages/server/src/ws/presenceService.ts) — Dedicated pipeline for cursor/selection updates with:
- **Token bucket rate limiter** — 20Hz max per connection
- **Viewport-based throttling** — NEAR (full rate) / MID (50%) / FAR (25%)
- **TTL expiry** — Stale cursors auto-removed after 30s

---

## 6. Infrastructure

### Docker Services

| Service | Port | Purpose |
|---------|------|---------|
| PostgreSQL 16 | 5433 | Primary data store |
| Prometheus | 9090 | Metrics collection |
| Grafana | 3005 | Dashboards & alerting |

### Security Hardening

| Feature | Implementation |
|---------|---------------|
| CORS | Restricted to `APP_URL` in production |
| Secure cookies | `httpOnly`, `secure`, `sameSite: lax` |
| Security headers | `X-Content-Type-Options`, `X-Frame-Options`, `Referrer-Policy`, `CSP`, `HSTS` |
| Rate limiting | Global 120 req/min + per-endpoint limits |
| Input validation | Zod schemas on every endpoint |
| SQL injection | Parameterized queries everywhere |
| WebSocket auth | Token verified before room join, 5s timeout |
| Graceful shutdown | SIGTERM → flush edits → save docs → close connections → drain pool |

---

## Summary Statistics

| Metric | Value |
|--------|-------|
| **Total packages** | 6 |
| **Server source files** | 50+ |
| **Client components** | 15+ React components |
| **Database tables** | 15+ |
| **Database migrations** | 10 |
| **REST API endpoints** | 30+ |
| **Prometheus metrics** | 50+ |
| **WebSocket subsystem files** | 20 |
| **Stress test scenarios** | 28 |

> [!TIP]
> The project runs locally with just 3 commands: `docker compose up -d` → `pnpm db:migrate` → `pnpm dev:app`
