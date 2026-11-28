const fs = require("fs");
const p = "src/pages/schedule/Schedule.tsx";
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

// Ribbon: ghim grid-row 1 để các ribbon overlap nhau (thiết kế dải project),
// tránh auto-placement đẩy xuống hàng khác khi 2 project cùng cột.
rep(
  `            style={{
              /* 7 cột ngày → chỉ số bắt đầu từ 1. */
              gridColumn: \`\${a + 1} / span \${b - a + 1}\`,
            }}`,
  `            style={{
              /*
               * 7 cột ngày → chỉ số bắt đầu từ 1.
               *
               * \`gridRow: 1\` ghim tất cả ribbon vào CÙNG 1 hàng để chúng
               * overlap nhau (dải project). Nếu không, auto-placement sẽ đẩy
               * ribbon thứ 2 xuống hàng 2 khi 2 project cùng cột.
               */
              gridColumn: \`\${a + 1} / span \${b - a + 1}\`,
              gridRow: 1,
            }}`,
  "ribbon gridRow",
);

// Canvas: truyền số cột ngày cho CSS (mặc định 7).
rep(
  `     <div className="sch-gantt__canvas">`,
  `     <div
      className="sch-gantt__canvas"
      style={{ ["--sch-gantt-cols" as string]: days.length }}
    >`,
  "canvas cols var",
);

fs.writeFileSync(p, s);
console.log("done");
