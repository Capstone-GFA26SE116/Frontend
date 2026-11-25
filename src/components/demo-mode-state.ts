import { createContext, useContext } from "react";

/**
 * Context trạng thái demo — tách riêng file để react-refresh không báo lỗi
 * "file export cả component và function" (giống `notifications-context-state.ts`).
 *
 * Provider nằm ở `DemoModeContext.tsx`.
 */

export interface DemoModeValue {
  /** `true` = đang ở chế độ demo. */
  active: boolean;
}

export const DemoModeContext = createContext<DemoModeValue>({ active: false });

/** Đọc trạng thái demo. */
export function useDemoMode(): DemoModeValue {
  return useContext(DemoModeContext);
}
