/**
 * Logo METANOIA — vẽ SVG inline để không phụ thuộc asset ngoài.
 *
 * Ý tưởng thị giác: vòng tròn "tiến hoá" với mũi tên chỉ lên trên,
 * gợi cảm giác self-evolving + thay đổi tư duy.
 */
interface MetanoiaLogoProps {
  size?: number;
  withWordmark?: boolean;
  className?: string;
}

export function MetanoiaLogo({
  size = 36,
  withWordmark = false,
  className = "",
}: MetanoiaLogoProps) {
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
          <linearGradient id="metanoia-gradient" x1="0" y1="0" x2="40" y2="40" gradientUnits="userSpaceOnUse">
            <stop offset="0%" stopColor="#a78bfa" />
            <stop offset="100%" stopColor="#7c3aed" />
          </linearGradient>
        </defs>
        <circle
          cx="18"
          cy="20"
          r="14"
          stroke="url(#metanoia-gradient)"
          strokeWidth="3"
          strokeLinecap="round"
          strokeDasharray="70 18"
          fill="none"
        />
        <path
          d="M30 14 L36 12 L34 18"
          stroke="url(#metanoia-gradient)"
          strokeWidth="3"
          strokeLinecap="round"
          strokeLinejoin="round"
          fill="none"
        />
        <circle cx="18" cy="20" r="3" fill="#7c3aed" />
      </svg>
      {withWordmark && (
        <span className="text-lg font-semibold tracking-tight text-slate-900">
          METANOIA
        </span>
      )}
    </div>
  );
}