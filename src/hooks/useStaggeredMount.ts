import { useEffect, useState } from "react";

/**
 * Staggered mount animation hook.
 *
 * Trả về:
 *  - `mounted`: true sau khi delay đầu tiên kết thúc (để trigger animation lần 1).
 *  - `bumpKey`: tăng mỗi khi `trigger` đổi -> dùng làm React `key` để
 *    buộc remount element -> animation chạy lại khi data thay đổi.
 *  - `getDelay(i)`: inline style `animation-delay` cho child thứ `i`.
 *
 * Ví dụ:
 *   const { mounted, getDelay } = useStaggeredMount(60);
 *   return (
 *     <ul className="list">
 *       {items.map((it, i) => (
 *         <li
 *           key={it.id}
 *           className={"list-item" + (mounted ? " list-item--in" : "")}
 *           style={getDelay(i)}
 *         >{it.label}</li>
 *       ))}
 *     </ul>
 *   );
 *
 * Animation thật sự định nghĩa trong CSS qua class modifier `--in`.
 * Khi `prefers-reduced-motion: reduce` thì user set mounted=true ngay
 * để không có hiệu ứng lúc load.
 */
export function useStaggeredMount(
  /** Delay giữa các phần tử (ms). */
  step: number = 60,
  /** Delay tổng trước khi item đầu tiên xuất hiện (ms). */
  initial: number = 40,
  /**
   * Giá trị thay đổi sẽ force animation chạy lại.
   * Ví dụ: độ dài danh sách, số task, ...
   */
  trigger?: unknown,
) {
  const [mounted, setMounted] = useState(false);
  const [bumpKey, setBumpKey] = useState(0);

  useEffect(() => {
    // Khi user bật reduced-motion, skip delay để nội dung hiện ngay.
    const reduce =
      typeof window !== "undefined" &&
      window.matchMedia?.("(prefers-reduced-motion: reduce)").matches;
    const t = window.setTimeout(
      () => setMounted(true),
      reduce ? 0 : initial,
    );
    return () => window.clearTimeout(t);
  }, [initial]);

  // Khi trigger đổi -> bump key -> các element dùng bumpKey làm React key
  // sẽ remount -> chạy lại animation ngay từ đầu.
  useEffect(() => {
    setBumpKey((k) => k + 1);
  }, [trigger]);

  function getDelay(index: number): { animationDelay: string } {
    return { animationDelay: `${index * step}ms` };
  }

  return { mounted, bumpKey, getDelay };
}
