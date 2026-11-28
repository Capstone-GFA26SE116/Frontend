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

// Ribbon: dùng biến layout (--sch-gantt-colw) để canh đúng cột ngày.
rep(
  `              /*
               * \`.sch-gantt__canvas\` KHÔNG phải grid → \`gridColumn\` bị bỏ qua
               * và mọi ribbon dồn về góc trái (chồng lên nhau).
               *
               * Ta định vị bằng % theo ngày, tính trên vùng "track" (phần bảng
               * bên phải cột "Item"): track = 100% - nameWidth - gap.
               */
              left: \`calc(var(--sch-gantt-name-w) + var(--sch-gantt-gap) + \${a / days.length} * (100% - var(--sch-gantt-name-w) - var(--sch-gantt-gap)))\`,
              width: \`calc(\${(b - a + 1) / days.length} * (100% - var(--sch-gantt-name-w) - var(--sch-gantt-gap)) - var(--sch-gantt-gap))\`,`,
  `              /*
               * \`.sch-gantt__canvas\` KHÔNG phải grid → \`gridColumn\` bị bỏ qua
               * và mọi ribbon dồn về góc trái (chồng lên nhau).
               *
               * Ta định vị thủ công theo cột ngày:
               *   left  = nameWidth + colGap + a * (colWidth + gap)
               *   width = (b - a + 1) * colWidth + (b - a) * gap
               * với \`--sch-gantt-colw\` là bề rộng 1 cột ngày.
               */
              left: \`calc(var(--sch-gantt-name-w) + var(--sch-gantt-col-gap) + \${a} * (var(--sch-gantt-colw) + var(--sch-gantt-gap)))\`,
              width: \`calc(\${b - a + 1} * var(--sch-gantt-colw) + \${b - a} * var(--sch-gantt-gap))\`,`,
  "ribbon left/width by col",
);

// Marker start: position absolute -> canh bằng % cột ngày (bar-wrap là grid 7 cột,
// nên gridColumn + position:absolute không đáng tin cậy).
rep(
  `                    style={{ gridColumn: \`\${startCol + 1} / span 1\` }}`,
  `                    style={{
                      left: \`calc(\${startCol} * (var(--sch-gantt-colw) + var(--sch-gantt-gap)))\`,
                      width: \`var(--sch-gantt-colw)\`,
                    }}`,
  "start marker pos",
);

rep(
  `                    style={{ gridColumn: \`\${endCol + 1} / span 1\` }}`,
  `                    style={{
                      left: \`calc(\${endCol} * (var(--sch-gantt-colw) + var(--sch-gantt-gap)))\`,
                      width: \`var(--sch-gantt-colw)\`,
                    }}`,
  "end marker pos",
);

fs.writeFileSync(p, s);
console.log("done");
