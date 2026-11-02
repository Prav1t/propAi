import "server-only";
import type { Principal } from "@/server/authz/authorize";
import { PERMISSIONS, type Permission } from "@/server/authz/permissions";
import { STAFF_PERMISSIONS } from "@/server/modules/members/roles";

// the permission list for the role form, marking which ones this editor may give
export function permissionChoices(p: Principal) {
  return STAFF_PERMISSIONS.map((k: Permission) => ({ key: k, module: PERMISSIONS[k].module, description: PERMISSIONS[k].description, held: p.permissions.has(k) }));
}
