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

// Bọc tên project trong span để cắt bằng ellipsis khi dải ribbon hẹp.
rep(
  `              <span className="material-symbols-outlined sch-icon-14">date_range</span>
              {m.sp.project.name}
              <span className="sch-gantt__ribbon-dates">`,
  `              <span className="material-symbols-outlined sch-icon-14">date_range</span>
              <span className="sch-gantt__ribbon-name">{m.sp.project.name}</span>
              <span className="sch-gantt__ribbon-dates">`,
  "ribbon name span",
);

fs.writeFileSync(p, s);
console.log("done");
