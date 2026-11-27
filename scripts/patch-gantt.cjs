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

// Ribbon: dùng % theo ngày, canh theo vùng bảng (từ sau cột "Item").
rep(
  `              /*
               * \`.sch-gantt\` KHÔNG phải grid → \`gridColumn\` bị bỏ qua và mọi
               * ribbon dồn về góc trái (chồng lên nhau). Ta định vị bằng
               * % theo ngày: cột ngày thứ i chiếm \`i / days.length\`.
               *
               * Vùng tính % là phần bảng (từ mép trái sau cột "Item" 200px
               * + gap 8px) → dùng biến CSS để canh khớp với \`.sch-gantt__head\`.
               */
              left: \`calc(var(--sch-gantt-name-w) + var(--sch-gantt-gap) + \${(a / days.length) * 100}% * var(--sch-gantt-track-ratio, 1))\`,
            }}`,
  `              /*
               * \`.sch-gantt\` KHÔNG phải grid → \`gridColumn\` bị bỏ qua và mọi
               * ribbon dồn về góc trái (chồng lên nhau).
               *
               * Ta định vị bằng % theo ngày, tính trên vùng "track" (phần bảng
               * bên phải cột "Item"). Vùng track chiếm \`100% - 200px - 8px\`
               * (gap của grid head) → dùng biến CSS \`--sch-gantt-track-w\`.
               */
              left: \`calc(var(--sch-gantt-name-w) + var(--sch-gantt-gap) + \${(a / days.length) * 100}%)\`,
              width: \`calc(\${((b - a + 1) / days.length) * 100}% - var(--sch-gantt-gap))\`,
            }}`,
  "ribbon left/width %",
);

// Bar + marker: bỏ off-by-one (grid 7 cột → chỉ số bắt đầu từ 1, không phải 2).
rep(
  `                    gridColumn: \`\${colStart + 2} / span \${Math.min(span, days.length - colStart)}\`,`,
  `                    gridColumn: \`\${colStart + 1} / span \${Math.min(span, days.length - colStart)}\`,`,
  "bar gridColumn off-by-one",
);

rep(
  `                    style={{ gridColumn: \`\${startCol + 2} / span 1\` }}`,
  `                    style={{ gridColumn: \`\${startCol + 1} / span 1\` }}`,
  "start marker gridColumn off-by-one",
);

rep(
  `                    style={{ gridColumn: \`\${endCol + 2} / span 1\` }}`,
  `                    style={{ gridColumn: \`\${endCol + 1} / span 1\` }}`,
  "end marker gridColumn off-by-one",
);

fs.writeFileSync(p, s);
console.log("done");
