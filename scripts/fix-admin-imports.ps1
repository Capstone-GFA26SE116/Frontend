$files = Get-ChildItem "d:\METANOIA\src\pages\admin\*.tsx"
foreach ($f in $files) {
  $t = [System.IO.File]::ReadAllText($f.FullName)
  $orig = $t

  # 1) Remove EMPTY_TOAST from the admin-shared import block
  $t = $t.Replace("  AdminToast,`r`n  EMPTY_TOAST,`r`n} from `"./admin-shared`";", "  AdminToast,`r`n} from `"./admin-shared`";")
  $t = $t.Replace("  AdminToast,`n  EMPTY_TOAST,`n} from `"./admin-shared`";", "  AdminToast,`n} from `"./admin-shared`";")

  # 2) Point AdminToastState import to admin-constants
  $t = $t.Replace('import type { AdminToastState } from "./admin-shared";', 'import { EMPTY_TOAST } from "./admin-constants";' + "`r`n" + 'import type { AdminToastState } from "./admin-constants";')

  if ($t -ne $orig) {
    [System.IO.File]::WriteAllText($f.FullName, $t, (New-Object System.Text.UTF8Encoding $false))
    Write-Output ("patched: " + $f.Name)
  }
}
