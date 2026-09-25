import Link from "next/link";
import { Logo } from "@/components/brand/logo";

export default function AuthLayout({ children }: { children: React.ReactNode }) {
  return (
    <div className="flex min-h-dvh flex-col items-center px-4 py-10 sm:justify-center">
      <Link href="/" className="mb-8">
        <Logo />
      </Link>
      <main className="w-full max-w-[400px]">{children}</main>
    </div>
  );
}
