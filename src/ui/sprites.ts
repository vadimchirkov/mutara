// Hand-drawn 8x8 pixel sprites, rendered with half-block characters: one cell
// carries two vertical pixels (fg = top, bg = bottom), so a sprite is 8 columns
// by 4 text rows. Truecolor only — checked at load, with a plain fallback.
//
// An autocomplete option is a single line, so sprites are for the combination
// result; the picker uses the one-cell colour chip from chip().
//
// Elements without a drawing get a deterministic identicon-style sprite seeded by
// their name, so all 720 have a stable icon without drawing 720 of them.

const PALETTE: Record<string, [number, number, number]> = {
  k: [26, 26, 32], d: [58, 58, 70], g: [110, 110, 125], l: [170, 170, 185], w: [242, 242, 248],
  b: [40, 96, 214], B: [96, 168, 255], c: [140, 226, 240],
  r: [208, 44, 44], o: [244, 132, 36], y: [250, 214, 78],
  n: [56, 148, 62], N: [124, 206, 86],
  m: [116, 76, 44], M: [176, 134, 88],
  p: [142, 74, 196], P: [238, 142, 196],
};

// "." is transparent. Rows are top to bottom, 8 chars each.
const SPRITES: Record<string, string[]> = {
  water: ["...bb...", "..bBBb..", "..bBBb..", ".bBBBBb.", ".bBwBBb.", "bBBBBBBb", "bBBBBBBb", ".bbBBbb."],
  fire: ["...r....", "..ro....", ".royr...", ".royyr..", "royyyor.", "royyyyor", "roywyyor", ".rooorr."],
  earth: ["..mmmm..", ".mnnNnm.", "mnNnnnNm", "mnnNnnnm", "mNnnnNnm", "mnnnNnnm", ".mnNnnm.", "..mmmm.."],
  air: ["........", "..llll..", ".l....l.", "....lll.", "..lll...", ".l....l.", "..llll..", "........"],
  steam: ["..l..l..", ".l.ll.l.", ".l.ll.l.", "..l..l..", "..w..w..", ".w.ww.w.", "..w..w..", "........"],
  energy: ["....yy..", "...yy...", "..yyyy..", ".yyyy...", "...yy...", "..yy....", ".yy.....", ".y......"],
  stone: ["........", "..gggg..", ".glgggg.", "gllggggg", "glgggggd", "gggggddd", ".gggddd.", "..dddd.."],
  sand: ["........", ".M.M..M.", "MMMMMMMM", "MMmMMMmM", "MMMMMMMM", "MmMMMmMM", "MMMMMMMM", "..MMMM.."],
  lava: ["..r..r..", ".ro..ro.", "royoroyo", "roooyooo", "ryooooyr", "rooyoroo", ".rooroo.", "..rrrr.."],
  mud: ["........", "...mm...", "..mMmm..", ".mmMmmm.", "mmmmMmmm", "mMmmmmMm", ".mmmmmm.", "..mmmm.."],
  mountain: ["........", "...ww...", "..wggw..", "..gggg..", ".gggggg.", ".gggdgg.", "gggdgddg", "gdggdggd"],
  sea: ["........", "........", ".bB..bB.", "bBBbbBBb", "BBBBBBBB", "bBBbbBBb", "BBBBBBBB", "bbBBBBbb"],
  cloud: ["........", "...ww...", "..wwww..", ".wwwwww.", "wwwwwwww", "wwwwwwww", ".wllllw.", "........"],
  rain: ["..wwww..", ".wwwwww.", "wwwwwwww", ".wllllw.", "........", ".B..B..B", "..B..B..", ".B..B..B"],
  metal: ["........", "gggggggg", "glllllgg", "gwwlllgg", "glllllgg", "gggggggg", "ddddddgg", "........"],
  glass: ["cccccccc", "cwwc...c", "cwc....c", "cc.....c", "c......c", "c.....wc", "c....wwc", "cccccccc"],
  salt: ["........", "...ww...", "..wwww..", ".ww..ww.", "ww....ww", ".ww..ww.", "..wwww..", "...ww..."],
  plant: ["........", "...N....", "..NN.NN.", ".NNNNNN.", "..nNNn..", "...n....", "...n....", "..mmmm.."],
  tree: ["..NNN...", ".NNNNN..", "NNnNNNN.", "NNNNnNN.", ".NNNNN..", "...mm...", "...mm...", "..mmmm.."],
  sun: ["..y..y..", "...yy...", ".yyyyyy.", "..ywyy..", "yyyyyyyy", ".yyyyyy.", "...yy...", "..y..y.."],
  life: ["...P....", "..PPP...", ".PPwPP..", "PPwwwPP.", ".PPwPP..", "..PPP...", "...P....", "........"],
  time: ["wwwwwwww", ".Mllllm.", "..Mllm..", "...MM...", "...MM...", "..MllM..", ".MllllM.", "wwwwwwww"],
};

const SUPPORTS_TRUECOLOR = /truecolor|24bit/i.test(process.env.COLORTERM ?? "");

const fg = ([r, g, b]: [number, number, number]) => `\x1b[38;2;${r};${g};${b}m`;
const bg = ([r, g, b]: [number, number, number]) => `\x1b[48;2;${r};${g};${b}m`;
const RESET = "\x1b[0m";

// Deterministic 32-bit hash, so an element's generated sprite never changes.
function hash(s: string): number {
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) h = Math.imul(h ^ s.charCodeAt(i), 16777619);
  return h >>> 0;
}

/** Symmetric identicon-style sprite for elements without a drawing. */
function generate(name: string): string[] {
  const h = hash(name);
  const keys = Object.keys(PALETTE);
  const a = keys[h % keys.length];
  const b = keys[(h >>> 8) % keys.length];
  const rows: string[] = [];
  for (let y = 0; y < 8; y++) {
    let half = "";
    for (let x = 0; x < 4; x++) {
      const bit = (hash(`${name}:${x}:${y}`) >>> (x + y)) & 3;
      half += bit === 0 ? "." : bit === 1 ? a : b;
    }
    rows.push(half + [...half].reverse().join(""));
  }
  return rows;
}

const pixels = (name: string): string[] => SPRITES[name.toLowerCase()] ?? generate(name.toLowerCase());

/** The sprite's dominant colour, used for the one-cell chip in lists. */
function dominant(name: string): [number, number, number] {
  const counts = new Map<string, number>();
  for (const row of pixels(name)) {
    for (const ch of row) if (ch !== ".") counts.set(ch, (counts.get(ch) ?? 0) + 1);
  }
  const best = [...counts].sort((x, y) => y[1] - x[1])[0];
  return PALETTE[best?.[0]] ?? PALETTE.g;
}

export function chip(name: string): string {
  return SUPPORTS_TRUECOLOR ? `${fg(dominant(name))}█${RESET}` : "•";
}

/** Render a sprite as 4 text rows of 8 columns. */
export function sprite(name: string): string[] {
  const rows = pixels(name);
  if (!SUPPORTS_TRUECOLOR) return ["", `  ${name}`, "", ""];
  const out: string[] = [];
  for (let y = 0; y < 8; y += 2) {
    let line = "";
    for (let x = 0; x < 8; x++) {
      const top = PALETTE[rows[y][x]];
      const bottom = PALETTE[rows[y + 1][x]];
      if (top && bottom) line += `${fg(top)}${bg(bottom)}▀${RESET}`;
      else if (top) line += `${fg(top)}▀${RESET}`;
      else if (bottom) line += `${fg(bottom)}▄${RESET}`;
      else line += " ";
    }
    out.push(line);
  }
  return out;
}

const centre = (text: string, width: number, len = text.length): string => {
  const pad = width - len;
  return " ".repeat(pad >> 1) + text + " ".repeat(pad - (pad >> 1));
};

/**
 * Sprites side by side with separators between them, plus a caption row in which
 * each name is centred under its own sprite. Columns widen for long names so the
 * two rows stay aligned. Returns 5 lines: 4 of art, then the caption.
 */
export function row(names: string[], separators: string[]): string[] {
  const blocks = names.map(sprite);
  const widths = names.map((n) => Math.max(8, n.length));
  const lines = ["", "", "", "", ""];

  for (let i = 0; i < blocks.length; i++) {
    if (i > 0) {
      const sep = ` ${separators[i - 1]} `;
      for (let y = 0; y < 5; y++) lines[y] += y === 1 ? sep : " ".repeat(sep.length);
    }
    for (let y = 0; y < 4; y++) lines[y] += centre(blocks[i][y], widths[i], 8);
    lines[4] += centre(names[i], widths[i]);
  }
  return lines;
}
