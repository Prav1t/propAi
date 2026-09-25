// human-readable verbs for audit actions
const LABELS: Record<string, string> = {
  "org.created": "created the organization",
  "org.settings.updated": "updated organization settings",
  "org.suspended": "suspended the organization",
  "org.reactivated": "reactivated the organization",
  "member.added": "added a member",
  "member.invited": "invited a member",
  "member.invitation_revoked": "revoked an invitation",
  "member.joined": "joined the organization",
  "member.role_changed": "changed a member's role",
  "member.deactivated": "deactivated a member",
  "member.reactivated": "reactivated a member",
};

export const describeAudit = (action: string) => LABELS[action] ?? action.replace(/[._]/g, " ");
