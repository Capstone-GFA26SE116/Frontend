import { useEffect, useState } from "react";

/**
 * ============================================================
 * useDemoSections — danh sách section của trang demo + section đang active
 * ============================================================
 *
 * Trang demo là 1 trang dài; header dùng hook này để:
 * - Render nav jump tới từng mục (Today, Schedule, ...).
 * - Highlight mục đang xem khi cuộn (IntersectionObserver).
 */

/** Một section của trang demo. */
export interface DemoSectionMeta {
  /** Id của element trong DOM (dùng cho `href="#id"`). */
  id: string;
  /** Nhãn hiển thị. */
  label: string;
  /** Icon Material Symbols. */
  icon: string;
}

/** Các section theo thứ tự xuất hiện trên trang. */
export const DEMO_SECTIONS: DemoSectionMeta[] = [
  { id: "today", label: "Today", icon: "today" },
  { id: "schedule", label: "Schedule", icon: "event" },
  { id: "projects", label: "Projects", icon: "space_dashboard" },
  { id: "groups", label: "Groups", icon: "groups" },
  { id: "pricing", label: "Pricing", icon: "workspace_premium" },
];

export interface UseDemoSectionsResult {
  /** Danh sách section (dùng render nav + footer). */
  sections: DemoSectionMeta[];
  /** Id của section đang hiện trên màn hình. */
  activeId: string;
}

export function useDemoSections(): UseDemoSectionsResult {
  const [activeId, setActiveId] = useState<string>(DEMO_SECTIONS[0].id);

  useEffect(() => {
    const els = DEMO_SECTIONS.map((s) =>
      document.getElementById(s.id),
    ).filter((el): el is HTMLElement => Boolean(el));

    if (els.length === 0) return;

    const observer = new IntersectionObserver(
      (entries) => {
        const visible = entries
          .filter((e) => e.isIntersecting)
          .sort((a, b) => b.intersectionRatio - a.intersectionRatio);
        if (visible[0]) setActiveId(visible[0].target.id);
      },
      { rootMargin: "-25% 0px -60% 0px", threshold: [0.05, 0.3, 0.6] },
    );

    els.forEach((el) => observer.observe(el));
    return () => observer.disconnect();
  }, []);

  /*
   * Offset cho `scroll-margin-top` — phải BẰNG chiều cao header thực tế.
   *
   * Header đổi chiều cao theo viewport (desktop 1 dòng ~57px, màn hẹp
   * 2 dòng ~106px). Hard-code trong CSS dễ lệch → bấm nav sẽ bị header
   * che mất tiêu đề mục. Đo bằng ResizeObserver rồi set CSS variable.
   */
  useEffect(() => {
    const header = document.querySelector<HTMLElement>(".demo-header");
    if (!header) return;

    const apply = () => {
      const h = header.offsetHeight;
      document.documentElement.style.setProperty(
        "--demo-header-h",
        `${h + 16}px`,
      );
    };

    apply();
    const ro = new ResizeObserver(apply);
    ro.observe(header);
    window.addEventListener("resize", apply);
    return () => {
      ro.disconnect();
      window.removeEventListener("resize", apply);
    };
  }, []);

  return { sections: DEMO_SECTIONS, activeId };
}
