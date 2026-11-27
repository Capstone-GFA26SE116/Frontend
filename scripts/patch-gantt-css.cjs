const fs = require("fs");
const p = "src/pages/schedule/schedule.css";
let s = fs.readFileSync(p, "utf8");

function rep(oldStr, newStr, label) {
  const o = oldStr.replace(/\n/g, "\r\n");
  const n = newStr.replace(/\n/g, "\r\n");
  if (!s.includes(o)) {
    console.log("NOT FOUND: " + label);
    process.exitCode = 1;
    return;
  }
  s = s.replace(o, n);
  console.log("ok: " + label);
}

// Ribbon label: không được tràn ra ngoài ribbon (dải project).
rep(
  `.sch-gantt__ribbon-label {
  position: relative;
  z-index: 1;
  display: flex;
  align-items: center;
  gap: 6px;
  height: 100%;
  width: fit-content;
  margin: 0 auto;
  padding: 4px 10px;
  border-radius: var(--sch-r-pill);
  background: var(--sch-low);
  border: 1px solid currentColor;
  font-size: 12px;
  font-weight: 600;
  line-height: 16px;
  letter-spacing: 0.5px;
  text-transform: uppercase;
  white-space: nowrap;
}`,
  `.sch-gantt__ribbon-label {
  position: relative;
  z-index: 1;
  display: flex;
  align-items: center;
  gap: 6px;
  /* Giới hạn theo chiều cao ribbon (28px) */
  height: 28px;
  max-height: 100%;
  /* \`max-width: 100%\` để KHÔNG tràn ra ngoài dải ribbon khi project
     dài hơn số cột ngày nó chiếm. */
  max-width: 100%;
  min-width: 0;
  width: fit-content;
  margin: 0 auto;
  padding: 4px 10px;
  border-radius: var(--sch-r-pill);
  background: var(--sch-low);
  border: 1px solid currentColor;
  font-size: 12px;
  font-weight: 600;
  line-height: 16px;
  letter-spacing: 0.5px;
  text-transform: uppercase;
  white-space: nowrap;
  overflow: hidden;
}
/* Tên project / ngày bị cắt → ellipsis thay vì tràn ra ngoài. */
.sch-gantt__ribbon-label > .material-symbols-outlined {
  flex-shrink: 0;
}
.sch-gantt__ribbon-dates {
  flex-shrink: 0;
}`,
  "ribbon label overflow",
);

fs.writeFileSync(p, s);
console.log("done");
