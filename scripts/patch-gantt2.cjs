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

// 1) Ribbon: left/width theo % (đã làm) -> dùng track width chuẩn
rep(
  `              /*
               * \`.sch-gantt\` KHÔNG phải grid → \`gridColumn\` bị bỏ qua và mọi
               * ribbon dồn về góc trái (chồng lên nhau).
               *
               * Ta định vị bằng % theo ngày, tính trên vùng "track" (phần bảng
               * bên phải cột "Item"). Vùng track chiếm \`100% - 200px - 8px\`
               * (gap của grid head) → dùng biến CSS \`--sch-gantt-track-w\`.
               */
              left: \`calc(var(--sch-gantt-name-w) + var(--sch-gantt-gap) + \${(a / days.length) * 100}%)\`,
              width: \`calc(\${((b - a + 1) / days.length) * 100}% - var(--sch-gantt-gap))\`,`,
  `              /*
               * \`.sch-gantt__canvas\` KHÔNG phải grid → \`gridColumn\` bị bỏ qua
               * và mọi ribbon dồn về góc trái (chồng lên nhau).
               *
               * Ta định vị bằng % theo ngày, tính trên vùng "track" (phần bảng
               * bên phải cột "Item"): track = 100% - nameWidth - gap.
               */
              left: \`calc(var(--sch-gantt-name-w) + var(--sch-gantt-gap) + \${a / days.length} * (100% - var(--sch-gantt-name-w) - var(--sch-gantt-gap)))\`,
              width: \`calc(\${(b - a + 1) / days.length} * (100% - var(--sch-gantt-name-w) - var(--sch-gantt-gap)) - var(--sch-gantt-gap))\`,`,
  "ribbon left/width formula",
);

// 2) Bọc head + rows trong canvas (position: relative) để ribbon canh đúng
rep(
  `  return (
    <div className="sch-gantt">
      {/* Mỗi project 1 ribbon overlay (track between start & end col) */}`,
  `  return (
    <div className="sch-gantt">
     <div className="sch-gantt__canvas">
      {/* Mỗi project 1 ribbon overlay (track between start & end col) */}`,
  "open canvas",
);

rep(
  `      <div className="sch-gantt__rows">
        {allEvents.map((ev) => {`,
  `      <div className="sch-gantt__rows">
        {allEvents.map((ev) => {`,
  "noop rows",
);

// đóng canvas sau .sch-gantt__rows
rep(
  `        })}
      </div>
    </div>
  );
}

/* ===========================================================
 * TaskCard — card lớn cho tuần view (mở rộng giao diện lịch)`,
  `        })}
      </div>
     </div>
    </div>
  );
}

/* ===========================================================
 * TaskCard — card lớn cho tuần view (mở rộng giao diện lịch)`,
  "close canvas",
);

// 3) Header: tách phần "Item" + phần 7 cột ngày → khớp đúng grid của bar-wrap
rep(
  `      <div className="sch-gantt__head">
        <div className="sch-gantt__col sch-gantt__col--name">Item</div>
        {days.map((d, i) => (
          <div key={d.key} className="sch-gantt__col">
            <div className="sch-gantt__dow">{WEEKDAY_LABELS[i]}</div>
            <div className="sch-gantt__num">{d.date.getDate()}</div>
          </div>
        ))}
      </div>`,
  `      <div className="sch-gantt__head">
        <div className="sch-gantt__col sch-gantt__col--name">Item</div>
        {/*
          7 cột ngày nằm trong 1 grid RIÊNG (7 cột, gap 4px) → khớp đúng
          \`.sch-gantt__bar-wrap\`. Trước đây head là grid 8 cột (7 gaps) còn
          bar-wrap là grid 7 cột (6 gaps) → cột ngày lệch nhau, bar rơi
          lệch sang cột bên cạnh và chồng lên nhau.
        */}
        <div className="sch-gantt__days">
          {days.map((d, i) => (
            <div key={d.key} className="sch-gantt__col">
              <div className="sch-gantt__dow">{WEEKDAY_LABELS[i]}</div>
              <div className="sch-gantt__num">{d.date.getDate()}</div>
            </div>
          ))}
        </div>
      </div>`,
  "head days wrapper",
);

fs.writeFileSync(p, s);
console.log("done");
