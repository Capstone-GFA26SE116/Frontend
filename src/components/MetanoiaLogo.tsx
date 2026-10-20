/**
 * Logo METANOIA — vẽ SVG inline để không phụ thuộc asset ngoài.
 *
 * Ý tưởng thị giác: vòng tròn "tiến hoá" với mũi tên chỉ lên trên,
 * gợi cảm giác self-evolving + thay đổi tư duy.
 *
 * Palette (theo DESIGN.md — Voltagent tokens):
 *   - glyph fill    : var(--voltagent-primary) #00d992 → primary-deep #10b981
 *                     (electric-green gradient — single brand accent,
 *                      DESIGN.md: "Reserve primary cho CTA, status pills,
 *                      và lightning logo glyph".)
 *   - wordmark ink  : var(--voltagent-ink-strong) #ffffff
 *                     để đọc rõ trên dark canvas #101010.
 *
 * Cả hai đều nhận qua prop `tone="dark"|"light"` để dùng được trên cả
 * landing (dark) và login (sáng sau này).
 */
interface MetanoiaLogoProps {
  size?: number;
  withWordmark?: boolean;
  className?: string;
  /** "dark" landing/canvas (default) | "light" nền sáng */
  tone?: "dark" | "light";
}

// 3 stop gradient theo token Voltagent — brand voice: single electric-green.
const LOGO_GRADIENT_DARK = "voltagent-logo-gradient";
const LOGO_GRADIENT_LIGHT = "voltagent-logo-gradient-light";

const RING_COLOR_DARK = "#00d992";
const RING_COLOR_LIGHT = "#10b981"; // primary-deep — đậm hơn để đọc trên nền trắng
const DOT_COLOR_DARK = "#00d992"; // primary
const DOT_COLOR_LIGHT = "#10b981";
const WORDMARK_COLOR_DARK = "#ffffff"; // ink-strong
const WORDMARK_COLOR_LIGHT = "#0f172a"; // slate-900 cho polar opposite (khi trên light)

export function MetanoiaLogo({
  size = 36,
  withWordmark = false,
  className = "",
  tone = "dark",
}: MetanoiaLogoProps) {
  const gradId =
    tone === "dark" ? LOGO_GRADIENT_DARK : LOGO_GRADIENT_LIGHT;
  const ringColor =
    tone === "dark" ? RING_COLOR_DARK : RING_COLOR_LIGHT;
  const dotColor =
    tone === "dark" ? DOT_COLOR_DARK : DOT_COLOR_LIGHT;
  const wordmarkColor =
    tone === "dark" ? WORDMARK_COLOR_DARK : WORDMARK_COLOR_LIGHT;

  return (
    <div className={`flex items-center gap-2 ${className}`}>
      <svg
        width={size}
        height={size}
        viewBox="0 0 40 40"
        fill="none"
        xmlns="http://www.w3.org/2000/svg"
        aria-hidden="true"
      >
        <defs>
          {/* Brand single-accent gradient: primary → primary-soft → primary-deep.
              Dùng đúng 3 mức xanh của token — không pha màu khác. */}
          <linearGradient
            id={gradId}
            x1="0"
            y1="0"
            x2="40"
            y2="40"
            gradientUnits="userSpaceOnUse"
          >
            <stop offset="0%" stopColor="#00d992" />
            <stop offset="50%" stopColor="#2fd6a1" />
            <stop offset="100%" stopColor="#10b981" />
          </linearGradient>
        </defs>
        <circle
          cx="18"
          cy="20"
          r="14"
          stroke={`url(#${gradId})`}
          strokeWidth="3"
          strokeLinecap="round"
          strokeDasharray="70 18"
          fill="none"
        />
        <path
          d="M30 14 L36 12 L34 18"
          stroke={ringColor}
          strokeWidth="3"
          strokeLinecap="round"
          strokeLinejoin="round"
          fill="none"
        />
        <circle cx="18" cy="20" r="3" fill={dotColor} />
      </svg>
      {withWordmark && (
        <span
          className="text-lg font-semibold tracking-tight"
          style={{ color: wordmarkColor }}
        >
          METANOIA
        </span>
      )}
    </div>
  );
}