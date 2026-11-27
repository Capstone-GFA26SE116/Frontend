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

// --- Ribbon: chuyển sang grid overlay 7 cột (khớp head + bar-wrap) ---
rep(
  `      {/* Mỗi project 1 ribbon overlay (track between start & end col) */}
      {spanCols.map((m) => {
        // Clip start/end vào range hiển thị
        const a = Math.max(0, m.startIdx < 0 ? 0 : m.startIdx);
        const b = Math.min(days.length - 1, m.endIdx < 0 ? days.length - 1 : m.endIdx);
        if (b < a) return null;
        return (
          <div
            key={m.sp.project.id}
            className="sch-gantt__ribbon"
            style={{
              /*
               * \`.sch-gantt__canvas\` KHÔNG phải grid → \`gridColumn\` bị bỏ qua
               * và mọi ribbon dồn về góc trái (chồng lên nhau).
               *
               * Ta định vị thủ công theo cột ngày:
               *   left  = nameWidth + colGap + a * (colWidth + gap)
               *   width = (b - a + 1) * colWidth + (b - a) * gap
               * với \`--sch-gantt-colw\` là bề rộng 1 cột ngày.
               */
              left: \`calc(var(--sch-gantt-name-w) + var(--sch-gantt-col-gap) + \${a} * (var(--sch-gantt-colw) + var(--sch-gantt-gap)))\`,
              width: \`calc(\${b - a + 1} * var(--sch-gantt-colw) + \${b - a} * var(--sch-gantt-gap))\`,
            }}
          >`,
  `      {/*
        * Ribbon overlay: 1 grid RIÊNG có cùng cấu trúc cột với
        * \`.sch-gantt__head\` (cột "Item" + vùng 7 cột ngày).
        *
        * Trước đây ribbon dùng \`gridColumn\` bên trong \`.sch-gantt\` — mà
        * \`.sch-gantt\` KHÔNG phải grid → \`gridColumn\` bị bỏ qua hoàn toàn →
        * mọi ribbon dồn về góc trái và CHỒNG LÊN NHAU.
        */}
      <div className="sch-gantt__ribbons">
        <div className="sch-gantt__ribbons-name" />
        <div className="sch-gantt__ribbons-track">
          {spanCols.map((m) => {
            // Clip start/end vào range hiển thị
            const a = Math.max(0, m.startIdx < 0 ? 0 : m.startIdx);
            const b = Math.min(days.length - 1, m.endIdx < 0 ? days.length - 1 : m.endIdx);
            if (b < a) return null;
            return (
          <div
            key={m.sp.project.id}
            className="sch-gantt__ribbon"
            style={{
              /* 7 cột ngày → chỉ số bắt đầu từ 1. */
              gridColumn: \`\${a + 1} / span \${b - a + 1}\`,
            }}
          >`,
  "ribbon open grid overlay",
);

rep(
  `            <div
              className="sch-gantt__ribbon-fill"
              style={{
                background: \`linear-gradient(90deg, \${m.sp.color}66 0%, \${m.sp.color}22 50%, \${m.sp.color}66 100%)\`,
                borderColor: m.sp.color,
              }}
            />
            <div
              className="sch-gantt__ribbon-label"
              style={{
                background: \`\${m.sp.color}1F\`,
                borderColor: m.sp.color,
                color: m.sp.color,
              }}
            >
              <span className="material-symbols-outlined sch-icon-14">date_range</span>
              {m.sp.project.name}
              <span className="sch-gantt__ribbon-dates">
                {m.sp.start.toLocaleDateString(undefined, { month: "short", day: "numeric" })}
                <span>→</span>
                {m.sp.end.toLocaleDateString(undefined, { month: "short", day: "numeric" })}
              </span>
            </div>
          </div>
        );
      })}`,
  `            <div
              className="sch-gantt__ribbon-fill"
              style={{
                background: \`linear-gradient(90deg, \${m.sp.color}66 0%, \${m.sp.color}22 50%, \${m.sp.color}66 100%)\`,
                borderColor: m.sp.color,
              }}
            />
            <div
              className="sch-gantt__ribbon-label"
              style={{
                background: \`\${m.sp.color}1F\`,
                borderColor: m.sp.color,
                color: m.sp.color,
              }}
            >
              <span className="material-symbols-outlined sch-icon-14">date_range</span>
              {m.sp.project.name}
              <span className="sch-gantt__ribbon-dates">
                {m.sp.start.toLocaleDateString(undefined, { month: "short", day: "numeric" })}
                <span>→</span>
                {m.sp.end.toLocaleDateString(undefined, { month: "short", day: "numeric" })}
              </span>
            </div>
          </div>
            );
          })}
        </div>
      </div>`,
  "ribbon close grid overlay",
);

// --- Marker: quay lại grid placement (abspos child of grid container được
//     position theo grid area → luôn khớp cột ngày) ---
rep(
  `                    style={{
                      left: \`calc(\${startCol} * (var(--sch-gantt-colw) + var(--sch-gantt-gap)))\`,
                      width: \`var(--sch-gantt-colw)\`,
                    }}`,
  `                    style={{ gridColumn: \`\${startCol + 1} / span 1\` }}`,
  "start marker back to grid",
);

rep(
  `                    style={{
                      left: \`calc(\${endCol} * (var(--sch-gantt-colw) + var(--sch-gantt-gap)))\`,
                      width: \`var(--sch-gantt-colw)\`,
                    }}`,
  `                    style={{ gridColumn: \`\${endCol + 1} / span 1\` }}`,
  "end marker back to grid",
);

fs.writeFileSync(p, s);
console.log("done");
