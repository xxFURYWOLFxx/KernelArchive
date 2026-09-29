import type { WindowsBuild } from "./types";

export type BuildFamily = "Windows 10" | "Windows 11" | "Windows Server" | "Manual Review";

export const build_family_order: BuildFamily[] = ["Windows 11", "Windows 10", "Windows Server", "Manual Review"];

function build_number_value(build: Pick<WindowsBuild, "build_number">) {
  const value = Number.parseInt(build.build_number, 10);
  return Number.isFinite(value) ? value : 0;
}

function product_hint(build: Pick<WindowsBuild, "product_name" | "version">) {
  return `${build.product_name} ${build.version}`.toLowerCase();
}

export function build_family(build: WindowsBuild): BuildFamily {
  const hint = product_hint(build);
  const build_number = build_number_value(build);

  if (hint.includes("server")) {
    return "Windows Server";
  }

  if (build_number > 19045) {
    return "Windows 11";
  }

  if (build_number >= 10240) {
    return "Windows 10";
  }

  if (hint.includes("windows 11")) {
    return "Windows 11";
  }

  if (hint.includes("windows 10")) {
    return "Windows 10";
  }

  return "Manual Review";
}

export function is_supported_kernel_build(build: WindowsBuild) {
  return !(build_family(build) === "Windows 11" && build.architecture === "x86");
}

export function windows_product_label(build: WindowsBuild) {
  const family = build_family(build);
  return family === "Manual Review" ? "Windows" : family;
}

// Release names stopped tracking build numbers in order. 26H2 ships on 26300
// while 26H1 ships on 28000, so the later name sits on the lower build and any
// ladder of >= comparisons labels both of them wrongly. Known releases are matched
// exactly; the comparisons below still hold for the older lines.
const windows_11_releases = new Map<number, string>([
  [22000, "21H2"],
  [22621, "22H2"],
  [22631, "23H2"],
  [26100, "24H2"],
  [26200, "25H2"],
  [26300, "26H2"],
  [28000, "26H1"],
]);

export function windows_release_label(build: WindowsBuild) {
  const build_number = build_number_value(build);
  const family = build_family(build);

  if (family === "Windows 11") {
    const named = windows_11_releases.get(build_number);
    if (named) { return named; }
    if (build_number >= 26200) { return "25H2"; }
    if (build_number >= 26100) { return "24H2"; }
    if (build_number >= 22631) { return "23H2"; }
    if (build_number >= 22621) { return "22H2"; }
    if (build_number >= 22000) { return "21H2"; }
  }

  if (family === "Windows 10") {
    if (build_number >= 19045) { return "22H2"; }
    if (build_number >= 19044) { return "21H2"; }
    if (build_number >= 19043) { return "21H1"; }
    if (build_number >= 19042) { return "20H2"; }
    if (build_number >= 19041) { return "2004"; }
    if (build_number >= 18363) { return "1909"; }
    if (build_number >= 18362) { return "1903"; }
    if (build_number >= 17763) { return "1809"; }
    if (build_number >= 17134) { return "1803"; }
    if (build_number >= 16299) { return "1709"; }
    if (build_number >= 15063) { return "1703"; }
    if (build_number >= 14393) { return "1607"; }
    if (build_number >= 10586) { return "1511"; }
    if (build_number >= 10240) { return "1507"; }
  }

  const parsed = `${build.product_name} ${build.version}`.match(/\b\d{2}h\d\b/i)?.[0];
  return parsed ? parsed.toUpperCase() : build.version || "Detection required";
}

export function normalize_windows_build(build: WindowsBuild): WindowsBuild {
  const family = build_family(build);
  if (family === "Manual Review") {
    return build;
  }

  return {
    ...build,
    product_name: windows_product_label(build),
    version: windows_release_label(build),
  };
}

export function grouped_builds(builds: WindowsBuild[]): Array<{ family: BuildFamily; builds: WindowsBuild[] }> {
  return build_family_order
    .map((family) => ({ family, builds: builds.filter((build) => build_family(build) === family).sort((left, right) => build_number_value(right) - build_number_value(left)) }))
    .filter((group) => group.builds.length > 0);
}

export function build_label(build: WindowsBuild) {
  return `${build.build_number}.${build.revision} ${build.architecture}`;
}

export function build_display_label(build: WindowsBuild) {
  return `${windows_product_label(build)} ${windows_release_label(build)} ${build_label(build)}`;
}

export function build_version_title(build: WindowsBuild) {
  return windows_release_label(build);
}

export function product_label(build: WindowsBuild) {
  return `${windows_product_label(build)} ${windows_release_label(build)}`;
}

export function detection_label(value: string | undefined) {
  if (!value || value === "unknown" || value === "undetected" || value.startsWith("timestamp_")) {
    return "Detection required";
  }
  return value;
}
