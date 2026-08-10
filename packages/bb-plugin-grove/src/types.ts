export type DocumentSourceKind = "workspace" | "host" | "thread-storage";

export interface DocumentSource {
  kind: DocumentSourceKind;
  threadId: string | null;
  environmentId: string | null;
  projectId: string | null;
  hostId: string | null;
}

export type BindingStatus = "ready" | "working" | "error" | "orphaned";

export interface BindingRecord {
  id: string;
  path: string;
  title: string;
  source: DocumentSource;
  ownerThreadId: string;
  status: BindingStatus;
  lastSha256: string | null;
  lastError: string | null;
  createdAt: number;
  updatedAt: number;
}

export interface DocumentRecord {
  path: string;
  content: string;
  sha256: string;
  sizeBytes: number;
}

export interface ResolvedDocumentTarget {
  filePath: string;
  rootPath: string;
  displayPath: string;
  hostId?: string;
}
