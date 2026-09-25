import { requireSession } from "@/server/auth/session";
import { Panel, PanelHeader } from "@/components/ui/primitives";
import { ProfileForm } from "./profile-form";

export const metadata = { title: "Profile" };

export default async function AccountPage() {
  const { user } = await requireSession();
  return (
    <Panel>
      <PanelHeader title="Profile" />
      <ProfileForm name={user.name} email={user.email} />
    </Panel>
  );
}
