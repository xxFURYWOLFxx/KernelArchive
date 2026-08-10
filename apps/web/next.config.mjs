import process from "node:process";

const internalApiBase = (process.env.KERNELARCHIVE_API_INTERNAL_URL || process.env.NEXT_PUBLIC_API_BASE_URL || "http://127.0.0.1:4002").replace(/\/$/, "");

// Next.js emits no security headers of its own. Without these the admin panel can be
// framed by any origin, responses are content-sniffable, and full URLs leak to third
// parties through the Referer header.
const securityHeaders = [
  { key: "X-Frame-Options", value: "DENY" },
  { key: "X-Content-Type-Options", value: "nosniff" },
  { key: "Referrer-Policy", value: "strict-origin-when-cross-origin" },
  { key: "Permissions-Policy", value: "camera=(), microphone=(), geolocation=(), interest-cohort=()" },
  { key: "Cross-Origin-Opener-Policy", value: "same-origin" },
  {
    key: "Content-Security-Policy",
    value: [
      "default-src 'self'",
      // Next.js injects inline bootstrap scripts and styles; unsafe-eval is required
      // by the dev-mode React refresh runtime only.
      process.env.NODE_ENV === "production"
        ? "script-src 'self' 'unsafe-inline'"
        : "script-src 'self' 'unsafe-inline' 'unsafe-eval'",
      "style-src 'self' 'unsafe-inline'",
      "img-src 'self' data: blob:",
      "font-src 'self' data:",
      "connect-src 'self'",
      "object-src 'none'",
      "base-uri 'self'",
      "form-action 'self'",
      "frame-ancestors 'none'",
    ].join("; "),
  },
];

const nextConfig = {
  transpilePackages: ["@kernelarchive/shared", "@kernelarchive/ui"],
  poweredByHeader: false,
  async headers() {
    return [{ source: "/:path*", headers: securityHeaders }];
  },
  async rewrites() {
    return [
      {
        source: "/api/v1/:path*",
        destination: `${internalApiBase}/api/v1/:path*`,
      },
      {
        source: "/api/docs/:path*",
        destination: `${internalApiBase}/api/docs/:path*`,
      },
      {
        source: "/llms.txt",
        destination: `${internalApiBase}/llms.txt`,
      },
    ];
  },
};

export default nextConfig;
