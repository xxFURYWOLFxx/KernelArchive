import { ImageResponse } from "next/og";
import { site } from "@/lib/site";

export const alt = `${site.name}: ${site.tagline}`;
export const size = { width: 1200, height: 630 };
export const contentType = "image/png";

export default function OpengraphImage() {
  return new ImageResponse(
    (
      <div
        style={{
          width: "100%",
          height: "100%",
          display: "flex",
          flexDirection: "column",
          justifyContent: "space-between",
          padding: "72px",
          background: "linear-gradient(135deg, #04070d 0%, #061220 55%, #03060b 100%)",
        }}
      >
        <div style={{ display: "flex", flexDirection: "column" }}>
          <div style={{ display: "flex", alignItems: "center", gap: 16 }}>
            <div
              style={{
                width: 56,
                height: 56,
                borderRadius: 12,
                background: "rgba(34,211,238,0.14)",
                border: "1px solid rgba(34,211,238,0.45)",
                display: "flex",
                alignItems: "center",
                justifyContent: "center",
                fontSize: 30,
              }}
            >
              🗄
            </div>
            <div style={{ color: "#f4f4f5", fontSize: 40, fontWeight: 700 }}>{site.name}</div>
          </div>
          <div style={{ color: "#a1a1aa", fontSize: 30, marginTop: 34, maxWidth: 900, lineHeight: 1.35 }}>
            Windows kernel symbols, type layouts and byte patterns, pinned to an exact build.
          </div>
        </div>

        <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between" }}>
          <div style={{ display: "flex", gap: 12 }}>
            {["ntoskrnl.exe", "_EPROCESS", "PDB indexed"].map((chip) => (
              <div
                key={chip}
                style={{
                  color: "#67e8f9",
                  fontSize: 22,
                  padding: "10px 18px",
                  borderRadius: 8,
                  background: "rgba(34,211,238,0.10)",
                  border: "1px solid rgba(34,211,238,0.28)",
                }}
              >
                {chip}
              </div>
            ))}
          </div>
          {/* Satori requires a single child here, or an explicit display on the parent. */}
          <div style={{ color: "#52525b", fontSize: 24 }}>{`Built by ${site.author}`}</div>
        </div>
      </div>
    ),
    size,
  );
}
