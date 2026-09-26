import type { Metadata } from "next";
import { page_metadata } from "@/lib/seo";

// The build list is a client component and cannot export metadata itself, so the
// segment layout carries it. A build detail page overrides this with its own.
export const metadata: Metadata = page_metadata({
  title: "Windows builds",
  description: "Every Windows build indexed here, from Windows 10 1709 through Windows 11 25H2, x86 and x64. Pick a build to browse its kernel modules, exported functions and struct layouts at the offsets that build actually shipped.",
  path: "/builds",
  keywords: ["Windows build list", "Windows 11 kernel versions", "ntoskrnl versions", "Windows 10 build symbols"],
});

export default function BuildsLayout({ children }: { children: React.ReactNode }) {
  return children;
}
