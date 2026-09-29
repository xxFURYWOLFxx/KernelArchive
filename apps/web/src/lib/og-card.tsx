import { ImageResponse } from "next/og";
import { site } from "./site";

export const og_size = { width: 1200, height: 630 };
export const og_content_type = "image/png";

// One static card used to represent every page on the site, so a shared link to a
// structure layout previewed the same as a link to the front page. This builds a
// card per record instead. Satori lays out a strict subset of CSS, so every
// container here declares display flex explicitly.
export function og_card({ chips, eyebrow, subtitle, title }: {
  chips: string[];
  eyebrow: string;
  subtitle: string;
  title: string;
}) {
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
          <div style={{ display: "flex", color: "#67e8f9", fontSize: 24, letterSpacing: 2, textTransform: "uppercase" }}>
            {eyebrow}
          </div>
          <div
            style={{
              display: "flex",
              color: "#f4f4f5",
              fontSize: title.length > 42 ? 52 : 66,
              fontWeight: 700,
              marginTop: 22,
              maxWidth: 1040,
              lineHeight: 1.1,
            }}
          >
            {title}
          </div>
          <div style={{ display: "flex", color: "#a1a1aa", fontSize: 28, marginTop: 26, maxWidth: 1000, lineHeight: 1.35 }}>
            {subtitle}
          </div>
        </div>

        <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between" }}>
          <div style={{ display: "flex", gap: 12 }}>
            {chips.filter(Boolean).slice(0, 3).map((chip) => (
              <div
                key={chip}
                style={{
                  display: "flex",
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
          <div style={{ display: "flex", color: "#52525b", fontSize: 24 }}>{site.name}</div>
        </div>
      </div>
    ),
    og_size,
  );
}
