import Link from "next/link";
import { AuthCard } from "@/components/auth-card";
import { FormAlert } from "@/components/ui/form";
import { LinkButton } from "@/components/ui/button";
import { getInvitation } from "@/server/modules/members/service";
import { getSession } from "@/server/auth/session";
import { AcceptInviteForm, NewUserInviteForm } from "./invite-forms";

export const metadata = { title: "Invitation" };

export default async function InvitePage({ params }: PageProps<"/invite/[token]">) {
  const { token } = await params;
  const invite = await getInvitation(token);
  if (!invite) {
    return (
      <AuthCard title="Invitation unavailable" footer={<Link href="/login" className="text-accent hover:underline">Go to sign in</Link>}>
        <FormAlert>This invitation is invalid, expired, revoked or already used. Ask the sender for a new one.</FormAlert>
      </AuthCard>
    );
  }
  const session = await getSession();
  const where = invite.propertyName ? ` at ${invite.propertyName}` : "";
  const description = <>You&apos;ve been invited to join <strong className="text-fg">{invite.orgName}</strong> as <strong className="text-fg">{invite.roleName}</strong>{where}.</>;

  if (session) {
    if (session.user.email !== invite.email) {
      return (
        <AuthCard title="Wrong account" description={description}>
          <FormAlert>This invitation was sent to {invite.email}, but you&apos;re signed in as {session.user.email}. Sign out and sign in with the invited email.</FormAlert>
        </AuthCard>
      );
    }
    return <AuthCard title="Join organization" description={description}><AcceptInviteForm token={token} /></AuthCard>;
  }
  if (invite.userExists) {
    return (
      <AuthCard title="Join organization" description={description}>
        <p className="mb-4 text-sm text-muted">Sign in as {invite.email} to accept.</p>
        <LinkButton href={`/login?next=${encodeURIComponent(`/invite/${token}`)}`} className="w-full">Sign in to accept</LinkButton>
      </AuthCard>
    );
  }
  return <AuthCard title="Create your account" description={description}><NewUserInviteForm token={token} email={invite.email} /></AuthCard>;
}
