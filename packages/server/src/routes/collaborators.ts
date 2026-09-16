/**
 * ⚠️  DEPRECATED / DISABLED
 *
 * This module implements document-level collaboration sharing (OTP-based invites).
 * It is NOT registered in server.ts and references services/tables that no longer
 * exist in the current codebase:
 *   - `../services/permissionService` → DOES NOT EXIST (now `workspacePermissionService`)
 *   - `../auth/otp` (generateOTP, verifyAndRedeemOTP) → DOES NOT EXIST
 *   - `document_permissions` table → replaced by folder-level `folder_permissions`
 *   - `share_tokens` table → no migration exists for this table
 *
 * DO NOT register this route without first:
 *   1. Creating the missing `permissionService` and `auth/otp` modules
 *   2. Adding a migration for `share_tokens`
 *   3. Updating all permission checks from document→folder model
 *   4. Conducting a security review of the OTP flow
 */

import { FastifyInstance } from 'fastify';

export async function registerCollaboratorRoutes(_app: FastifyInstance): Promise<void> {
  // Route registration intentionally disabled — see module-level comment.
}
