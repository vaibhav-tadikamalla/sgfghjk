export interface VersionMeta {
  id: string;
  fileId: string;
  versionNum: number;
  label: string | null;
  source: 'auto' | 'manual' | 'restore';
  byteSize: number;
  createdBy: string | null;
  createdAt: string;
  snapshotHash: string;
}

export interface VersionDetail extends VersionMeta {
  snapshotBase64: string;
}

export interface VersionListResponse {
  versions: VersionMeta[];
  total: number;
  limit: number;
  offset: number;
}

export interface RestoreResponse {
  status: string;
  restoredVersionId: string;
  newVersionId: string;
  walSeq: number;
  bytesApplied: number;
}
