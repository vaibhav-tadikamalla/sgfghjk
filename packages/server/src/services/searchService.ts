import { query } from '../db/pool';

export interface SearchResult {
  id: string;
  name: string;
  folderId: string;
  folderName: string;
  lastEditedAt: string | null;
  updatedAt: string;
}

export const searchService = {
  /** Search files by name (partial match) that the user has access to. */
  async searchFiles(searchQuery: string, userId: string): Promise<SearchResult[]> {
    const sanitized = searchQuery.trim();
    if (!sanitized) return [];

    // Escape LIKE-special characters to prevent wildcard injection
    // (% matches any sequence, _ matches any single char, \ is the escape char)
    const escapedPattern = sanitized
      .replace(/\\/g, '\\\\')
      .replace(/%/g, '\\%')
      .replace(/_/g, '\\_');

    const result = await query<{
      id: string;
      name: string;
      folder_id: string;
      folder_name: string;
      last_edited_at: string | null;
      updated_at: string;
    }>(
      `SELECT f.id, f.name, f.folder_id, fld.name AS folder_name,
              f.last_edited_at, f.updated_at
       FROM files f
       JOIN folders fld ON fld.id = f.folder_id
       JOIN folder_permissions fp ON fp.folder_id = f.folder_id AND fp.user_id = $2
       WHERE f.deleted_at IS NULL
         AND f.name ILIKE '%' || $1 || '%'
       ORDER BY f.updated_at DESC
       LIMIT 50`,
      [escapedPattern, userId],
    );

    return result.rows.map((r) => ({
      id: r.id,
      name: r.name,
      folderId: r.folder_id,
      folderName: r.folder_name,
      lastEditedAt: r.last_edited_at,
      updatedAt: r.updated_at,
    }));
  },

  /** Full-text search on file names using PostgreSQL tsvector. */
  async fullTextSearch(searchQuery: string, userId: string): Promise<SearchResult[]> {
    const sanitized = searchQuery.trim().replace(/[^\w\s]/g, '');
    if (!sanitized) return [];

    const tsQuery = sanitized
      .split(/\s+/)
      .filter(Boolean)
      .map((term) => `${term}:*`)
      .join(' & ');

    if (!tsQuery) return [];

    const result = await query<{
      id: string;
      name: string;
      folder_id: string;
      folder_name: string;
      last_edited_at: string | null;
      updated_at: string;
    }>(
      `SELECT f.id, f.name, f.folder_id, fld.name AS folder_name,
              f.last_edited_at, f.updated_at
       FROM files f
       JOIN folders fld ON fld.id = f.folder_id
       JOIN folder_permissions fp ON fp.folder_id = f.folder_id AND fp.user_id = $2
       WHERE f.deleted_at IS NULL
         AND to_tsvector('english', f.name) @@ to_tsquery('english', $1)
       ORDER BY f.updated_at DESC
       LIMIT 50`,
      [tsQuery, userId],
    );

    return result.rows.map((r) => ({
      id: r.id,
      name: r.name,
      folderId: r.folder_id,
      folderName: r.folder_name,
      lastEditedAt: r.last_edited_at,
      updatedAt: r.updated_at,
    }));
  },
};
