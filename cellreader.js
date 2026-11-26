// 手書き時刻の読み取り(学習したモデル)。画像・計算はすべてブラウザ内で行い、外部へは送信しない。
//
// 流れ: 写真の上で時刻欄の枠(四隅)と各行の位置を合わせる → 1マスずつ 40x88 に切り出す
//       → モデル(model/cell_model.js)で各桁の確率を出す → 表の計算チェックで読み間違いを直す
// 切り出し・計算は Python 側(cnn/cells.py, cnn/train_cells.py, cnn/consistency.py)と同じ手順にしてある。
(function () {
    'use strict';

    const CLASSES = ' 0123456789';
    const N_POS = 4;
    const N_CLS = 11;
    const CELL_H = 40;
    const CELL_W = 88;
    const PAD_U = 0.10;    // 左右に広げる割合(マス幅に対して)
    const PAD_V = 0.18;    // 上下に広げる割合(行の高さに対して)
    const PENALTY = 2.0;   // 表の計算チェックの減点
    const TOPK = 40;
    const ROW_TOPK = 40;
    // 自信の目安: 選んだ読みが、そのマスの次の候補より何倍もっともらしいか(対数の差)。
    // 1.0 未満(約2.7倍未満)なら「自信がない」。学習に使っていない写真で、読み間違い43マスのうち30マスに印が付き、
    // 正しいのに印が付くのは約2割(以前の「確率60%未満」は7割に付いてしまい、目印にならなかった)。
    const LOW_MARGIN = 1.0;
    const BLANK_CONTRAST = 45;   // マスの中央の濃淡差(0〜255)がこれ未満なら空欄とみなす
    // 列ごとに各桁に入り得る文字(出発・到着: 時の十の位は 空/0/1/2、分の十の位は 0〜5 / 飛行時間: 時の十の位は空)
    const ALLOWED = {
        0: [' 012', '0123456789', '012345', '0123456789'],
        1: [' 012', '0123456789', '012345', '0123456789'],
        2: [' ', '0123456789', '012345', '0123456789'],
    };

    // ---------- モデル ----------
    let model = null;

    function halfToFloat(h) {
        const s = (h & 0x8000) ? -1 : 1;
        const e = (h >> 10) & 0x1f;
        const f = h & 0x3ff;
        if (e === 0) return s * Math.pow(2, -14) * (f / 1024);
        if (e === 31) return f ? NaN : s * Infinity;
        return s * Math.pow(2, e - 15) * (1 + f / 1024);
    }

    function loadModel() {
        if (model) return model;
        const src = window.CELL_MODEL;
        if (!src) throw new Error('モデル(model/cell_model.js)が読み込まれていません');
        const bin = atob(src.data);
        const u16 = new Uint16Array(bin.length / 2);
        for (let i = 0; i < u16.length; i++) u16[i] = bin.charCodeAt(2 * i) | (bin.charCodeAt(2 * i + 1) << 8);
        const table = new Float32Array(65536);
        for (let i = 0; i < 65536; i++) table[i] = halfToFloat(i);
        const layers = {};
        src.layers.forEach((l) => {
            const a = new Float32Array(l.size);
            for (let i = 0; i < l.size; i++) a[i] = table[u16[l.offset + i]];
            layers[l.name] = { data: a, shape: l.shape };
        });
        model = layers;
        return model;
    }

    // 3x3 の畳み込み(余白1)+ ReLU。BatchNorm は書き出し時に重みへ畳み込み済み
    function conv3(inp, C, H, W, w, b, O) {
        const HW = H * W;
        const out = new Float32Array(O * HW);
        for (let o = 0; o < O; o++) {
            const ob = o * HW;
            out.fill(b[o], ob, ob + HW);
            for (let i = 0; i < C; i++) {
                const ib = i * HW;
                for (let ky = -1; ky <= 1; ky++) {
                    const y0 = Math.max(0, -ky);
                    const y1 = Math.min(H, H - ky);
                    for (let kx = -1; kx <= 1; kx++) {
                        const wv = w[((o * C + i) * 3 + (ky + 1)) * 3 + (kx + 1)];
                        if (wv === 0) continue;
                        const x0 = Math.max(0, -kx);
                        const x1 = Math.min(W, W - kx);
                        for (let y = y0; y < y1; y++) {
                            const orow = ob + y * W;
                            const irow = ib + (y + ky) * W + kx;
                            for (let x = x0; x < x1; x++) out[orow + x] += wv * inp[irow + x];
                        }
                    }
                }
            }
        }
        for (let k = 0; k < out.length; k++) if (out[k] < 0) out[k] = 0;
        return out;
    }

    function pool2(inp, C, H, W) {
        const h = H >> 1;
        const w = W >> 1;
        const out = new Float32Array(C * h * w);
        for (let c = 0; c < C; c++) {
            for (let y = 0; y < h; y++) {
                for (let x = 0; x < w; x++) {
                    const i = c * H * W + 2 * y * W + 2 * x;
                    out[(c * h + y) * w + x] = Math.max(inp[i], inp[i + 1], inp[i + W], inp[i + W + 1]);
                }
            }
        }
        return out;
    }

    // 1マス(40x88、インク=1・紙=0)→ 各桁の対数確率 [4][11](入り得ない文字は -Infinity)
    function forward(img, col) {
        const m = loadModel();
        let x = img;
        let C = 1;
        let H = CELL_H;
        let W = CELL_W;
        [['b1', 32], ['b2', 64], ['b3', 96]].forEach(([blk, O]) => {
            x = conv3(x, C, H, W, m[`${blk}.0.w`].data, m[`${blk}.0.b`].data, O);
            x = conv3(x, O, H, W, m[`${blk}.3.w`].data, m[`${blk}.3.b`].data, O);
            x = pool2(x, O, H, W);
            C = O;
            H >>= 1;
            W >>= 1;
        });
        const emb = m.col_emb.data.subarray(col * 16, col * 16 + 16);
        const feat = new Float32Array(x.length + 16);
        feat.set(x);
        feat.set(emb, x.length);
        const fw = m['fc.w'].data;
        const fb = m['fc.b'].data;
        const nIn = feat.length;
        const hidden = new Float32Array(256);
        for (let o = 0; o < 256; o++) {
            let s = fb[o];
            const base = o * nIn;
            for (let i = 0; i < nIn; i++) s += fw[base + i] * feat[i];
            hidden[o] = s > 0 ? s : 0;
        }
        const hw = m['heads.w'].data;
        const hb = m['heads.b'].data;
        const logp = [];
        for (let p = 0; p < N_POS; p++) {
            const z = [];
            for (let k = 0; k < N_CLS; k++) {
                const o = p * N_CLS + k;
                let s = hb[o];
                for (let i = 0; i < 256; i++) s += hw[o * 256 + i] * hidden[i];
                z.push(s);
            }
            const mx = Math.max(...z);
            const lse = mx + Math.log(z.reduce((a, v) => a + Math.exp(v - mx), 0));
            const allowed = ALLOWED[col][p];
            logp.push(z.map((v, k) => (allowed.includes(CLASSES[k]) ? v - lse : -Infinity)));
        }
        return logp;
    }

    // ---------- 切り出し ----------
    function percentile(arr, q) {
        const s = Float32Array.from(arr).sort();
        const pos = (s.length - 1) * q / 100;
        const lo = Math.floor(pos);
        const hi = Math.min(lo + 1, s.length - 1);
        return s[lo] + (s[hi] - s[lo]) * (pos - lo);
    }

    function bilerp(c, u, v) {
        const [tl, tr, bl, br] = c;
        const tx = tl[0] * (1 - u) + tr[0] * u;
        const ty = tl[1] * (1 - u) + tr[1] * u;
        const bx = bl[0] * (1 - u) + br[0] * u;
        const by = bl[1] * (1 - u) + br[1] * u;
        return [tx * (1 - v) + bx * v, ty * (1 - v) + by * v];
    }

    function sampleGray(st, x, y) {
        const w = st.w;
        const h = st.h;
        x = Math.min(Math.max(x, 0), w - 1.001);
        y = Math.min(Math.max(y, 0), h - 1.001);
        const x0 = Math.floor(x);
        const y0 = Math.floor(y);
        const fx = x - x0;
        const fy = y - y0;
        const g = st.gray;
        const i = y0 * w + x0;
        return g[i] * (1 - fx) * (1 - fy) + g[i + 1] * fx * (1 - fy) + g[i + w] * (1 - fx) * fy + g[i + w + 1] * fx * fy;
    }

    // 行 r・列 c のマスを 40x88 で切り出す。戻り値 { img(0〜1、インク=1), blank }
    function extractCell(st, r, c) {
        const n = st.nRows;
        const u0 = c / 3;
        const u1 = (c + 1) / 3;
        const v0 = r / n;
        const v1 = (r + 1) / n;
        const du = (u1 - u0) * PAD_U;
        const dv = (v1 - v0) * PAD_V;
        const sh = st.shift[r];
        const raw = new Float32Array(CELL_H * CELL_W);
        for (let yy = 0; yy < CELL_H; yy++) {
            const v = (v0 - dv) + ((v1 + dv) - (v0 - dv)) * yy / (CELL_H - 1);
            for (let xx = 0; xx < CELL_W; xx++) {
                const u = (u0 - du) + ((u1 + du) - (u0 - du)) * xx / (CELL_W - 1);
                const p = bilerp(st.corners, u, v);
                raw[yy * CELL_W + xx] = sampleGray(st, p[0] + sh.dx, p[1] + sh.dy);
            }
        }
        const bg = percentile(raw, 90);
        const ink = percentile(raw, 2);
        const img = new Float32Array(raw.length);
        const den = Math.max(bg - ink, 1e-3);
        for (let i = 0; i < raw.length; i++) img[i] = Math.min(Math.max((bg - raw[i]) / den, 0), 1);
        // 空欄の判定: 罫線の入りにくいマスの中央だけで濃淡差を見る
        const center = [];
        for (let yy = Math.round(CELL_H * 0.3); yy < Math.round(CELL_H * 0.7); yy++) {
            for (let xx = Math.round(CELL_W * 0.15); xx < Math.round(CELL_W * 0.85); xx++) center.push(raw[yy * CELL_W + xx]);
        }
        const blank = percentile(center, 90) - percentile(center, 1) < BLANK_CONTRAST;
        return { img, blank };
    }

    // ---------- 表の計算チェック(cnn/consistency.py と同じ) ----------
    function toValue(idx, col) {
        const s = idx.map((i) => CLASSES[i]).join('');
        const hh = s.slice(0, 2).trim();
        const mm = s.slice(2);
        if (mm.includes(' ') || (col < 2 && hh === '') || hh.includes(' ')) return null;
        const h = Number(hh || 0);
        const m = Number(mm);
        if (m > 59 || (col < 2 && h > 23)) return null;
        return h * 60 + m;
    }

    function toText(idx, col) {
        const s = idx.map((i) => CLASSES[i]).join('').trim();
        return col === 2 ? `${s.slice(0, -2) || '0'}+${s.slice(-2)}` : `${s.slice(0, -2)}:${s.slice(-2)}`;
    }

    function candidates(logp, col, k = TOPK) {
        const all = [];
        for (let a = 0; a < N_CLS; a++) {
            if (!isFinite(logp[0][a])) continue;
            for (let b = 0; b < N_CLS; b++) {
                if (!isFinite(logp[1][b])) continue;
                for (let c = 0; c < N_CLS; c++) {
                    if (!isFinite(logp[2][c])) continue;
                    for (let d = 0; d < N_CLS; d++) {
                        if (!isFinite(logp[3][d])) continue;
                        all.push([logp[0][a] + logp[1][b] + logp[2][c] + logp[3][d], a, b, c, d]);
                    }
                }
            }
        }
        all.sort((p, q) => q[0] - p[0]);
        const out = [];
        for (const e of all) {
            const idx = e.slice(1);
            const v = toValue(idx, col);
            if (v === null) continue;
            out.push({ score: e[0], value: v, text: toText(idx, col) });
            if (out.length >= k) break;
        }
        return out;
    }

    function rowCandidates(cells) {
        const keys = Object.keys(cells).map(Number).sort();
        const cand = keys.map((c) => candidates(cells[c], c));
        if (cand.some((l) => l.length === 0)) return [];
        const out = [];
        const rec = (d, pick, score) => {
            if (d === keys.length) {
                const p = {};
                keys.forEach((c, i) => { p[c] = pick[i]; });
                let s = score;
                if (p[0] && p[1]) {
                    if (p[1].value < p[0].value) s -= PENALTY;
                    if (p[2] && p[1].value - p[0].value !== p[2].value) s -= PENALTY;
                }
                out.push({ score: s, pick: p });
                return;
            }
            cand[d].forEach((x) => rec(d + 1, pick.concat([x]), score + x.score));
        };
        rec(0, [], 0);
        out.sort((a, b) => b.score - a.score);
        return out.slice(0, ROW_TOPK);
    }

    // rows: [{ r, cells: {列: logp} }] → 行ごとの選ばれた読み {列: {text, score}}
    function decodePhoto(rows) {
        const per = rows.map((row) => rowCandidates(row.cells));
        const ok = per.map((l) => l.length > 0);
        const idx = per.map((_, i) => i).filter((i) => ok[i]);
        const result = rows.map(() => null);
        if (!idx.length) return result;
        let best = per[idx[0]].map((c, j) => ({ s: c.score, path: [j] }));
        for (let k = 1; k < idx.length; k++) {
            const prev = per[idx[k - 1]];
            const cur = per[idx[k]];
            best = cur.map((c) => {
                let top = null;
                best.forEach((b) => {
                    const pp = prev[b.path[b.path.length - 1]].pick;
                    let t = b.s + c.score;
                    if (c.pick[0] && pp[0] && c.pick[0].value < pp[0].value) t -= PENALTY;
                    if (!top || t > top.s) top = { s: t, path: b.path.concat([cur.indexOf(c)]) };
                });
                return top;
            });
        }
        const win = best.reduce((a, b) => (b.s > a.s ? b : a));
        idx.forEach((ri, k) => { result[ri] = per[ri][win.path[k]].pick; });
        return result;
    }

    // ---------- 行の位置を字に合わせる(自動) ----------
    function snapRows(st) {
        const n = st.nRows;
        const [tl, tr, bl, br] = st.corners;
        const pitchPx = ((bl[1] - tl[1]) + (br[1] - tr[1])) / 2 / n;
        const S = 8;   // 1行あたりの縦の見本数
        const vsN = (n + 2) * S;
        const offsets = [];
        for (let c = 0; c < 3; c++) {
            const prof = new Float32Array(vsN);
            const dark = [];
            const grid = [];
            for (let j = 0; j < vsN; j++) {
                const v = (j / S - 1) / n;
                const r = Math.min(Math.max(Math.floor(j / S - 1), 0), n - 1);
                const rowVals = [];
                for (let k = 0; k < 48; k++) {
                    const u = (c + 0.15 + 0.7 * k / 47) / 3;
                    const p = bilerp(st.corners, u, v);
                    const g = 255 - sampleGray(st, p[0] + st.shift[r].dx, p[1]);
                    rowVals.push(g);
                    dark.push(g);
                }
                grid.push(rowVals);
            }
            const base = percentile(dark, 60);
            for (let j = 0; j < vsN; j++) {
                const ink = grid[j].map((g) => Math.min(Math.max((g - base) / 80, 0), 1));
                const lineLike = ink.filter((v) => v > 0.4).length / ink.length > 0.6;
                prof[j] = lineLike ? 0 : ink.reduce((a, v) => a + v, 0) / ink.length;
            }
            // なめらかにして最大を1に
            const sm = new Float32Array(vsN);
            for (let j = 0; j < vsN; j++) {
                let s = 0;
                let cnt = 0;
                for (let d = -2; d <= 2; d++) if (j + d >= 0 && j + d < vsN) { s += prof[j + d]; cnt++; }
                sm[j] = s / cnt;
            }
            const mx = Math.max(...sm, 1e-6);
            for (let j = 0; j < vsN; j++) sm[j] /= mx;
            // 動的計画法: i 行目の字の中心を j に置く。枠から計算した位置から離れるほど減点
            const lo = Math.round(0.6 * S);
            const hi = Math.round(1.6 * S);
            const best = Array.from({ length: n }, () => new Float32Array(vsN).fill(-Infinity));
            const back = Array.from({ length: n }, () => new Int32Array(vsN));
            const gain = (i, j) => {
                const dev = (j - (i + 1.5) * S) / S;
                return Math.abs(dev) <= 0.8 ? sm[j] - 1.0 * dev * dev : -Infinity;
            };
            for (let j = 0; j < vsN; j++) best[0][j] = gain(0, j);
            for (let i = 1; i < n; i++) {
                for (let j = 0; j < vsN; j++) {
                    const g = gain(i, j);
                    if (!isFinite(g)) continue;
                    let bv = -Infinity;
                    let bj = 0;
                    for (let q = Math.max(j - hi, 0); q <= j - lo; q++) {
                        if (best[i - 1][q] > bv) { bv = best[i - 1][q]; bj = q; }
                    }
                    if (isFinite(bv)) { best[i][j] = bv + g; back[i][j] = bj; }
                }
            }
            let j = 0;
            for (let q = 1; q < vsN; q++) if (best[n - 1][q] > best[n - 1][j]) j = q;
            const off = new Array(n);
            for (let i = n - 1; i >= 0; i--) { off[i] = (j - (i + 1.5) * S) / S; j = back[i][j]; }
            offsets.push(off);
        }
        for (let i = 0; i < n; i++) {
            const o = [offsets[0][i], offsets[1][i], offsets[2][i]].sort((a, b) => a - b)[1];   // 3列の中央値
            st.shift[i].dy = o * pitchPx;
        }
    }

    // ---------- 位置合わせ画面 ----------
    const states = [];
    let locked = false;   // true の間は位置合わせを変更できない(読み取り中)

    function setLocked(v) {
        locked = v;
        states.forEach((st) => {
            if (st.controls) st.controls.forEach((el) => { el.disabled = v; });
            if (st.card) st.card.classList.toggle('aligner-locked', v);
            if (st.canvas) st.canvas.style.pointerEvents = v ? 'none' : '';
        });
    }

    function defaultCorners(w, h) {
        // これまでの写真での時刻欄のおおよその位置(画像の幅・高さに対する割合)
        const L = 0.58 * w;
        const R = 0.72 * w;
        const T = 0.20 * h;
        const B = 0.80 * h;
        return [[L, T], [R, T], [L, B], [R, B]];
    }

    function resetShift(st) {
        st.shift = Array.from({ length: st.nRows }, () => ({ dx: 0, dy: 0 }));
    }

    // 写真の罫線から見つけた位置(autogrid.js)を、行数 n で当てはめる
    function applyAuto(st, n) {
        const lay = window.AutoGrid.layout(st.auto.lines, n);
        st.nRows = lay.shift.length;
        st.corners = lay.corners;
        st.shift = lay.shift;
    }

    function runAuto(st) {
        st.auto = null;
        if (!window.AutoGrid) return '自動の位置合わせ(autogrid.js)が読み込まれていません。四隅と行数を手で合わせてください。';
        try {
            const a = window.AutoGrid.detect(st.gray, st.w, st.h);
            if (!a.ok) return `自動で位置を合わせられませんでした(${a.reason})。四隅と行数を手で合わせてください。`;
            st.auto = a;
            applyAuto(st, a.nRows);
            return `自動で位置を合わせました: 記入されている行は ${a.nRows} 行(印刷された行 ${a.lines.length - 1} 行のうち)。ずれている所があれば直してください。`;
        } catch (err) {
            console.error(err);
            return '自動の位置合わせでエラーが起きました。四隅と行数を手で合わせてください。';
        }
    }

    function loadImage(file) {
        return new Promise((resolve, reject) => {
            const url = URL.createObjectURL(file);
            const img = new Image();
            img.onload = () => resolve({ img, url });
            img.onerror = () => reject(new Error(`画像を読み込めません: ${file.name}`));
            img.src = url;
        });
    }

    // ---------- 写真の向き ----------
    // スマホで貼った写真などは横向き(90度)や逆さ(180度)のことがある。表の線が見つかる向きを自動で選ぶ。
    const ORIENT_CONF_CELLS = 4;   // 向きを比べる時にモデルで読むマスの数(多いほど確かだが遅い)
    const ORIENT_OK = 0.78;        // 元の向きでこれ以上の自信なら、ほかの向きは試さない(正しい向き 0.83〜0.94、逆さ 0.50〜0.70 だった)

    // 元の写真を deg 度(時計回り)回した canvas
    function rotatedCanvas(src, deg) {
        const w0 = src.naturalWidth || src.width;
        const h0 = src.naturalHeight || src.height;
        const side = deg % 180 !== 0;
        const cv = document.createElement('canvas');
        cv.width = side ? h0 : w0;
        cv.height = side ? w0 : h0;
        const ctx = cv.getContext('2d');
        ctx.translate(cv.width / 2, cv.height / 2);
        ctx.rotate(deg * Math.PI / 180);
        ctx.drawImage(src, -w0 / 2, -h0 / 2);
        return cv;
    }

    function grayOf(src) {
        const w = src.naturalWidth || src.width;
        const h = src.naturalHeight || src.height;
        let cv = src;
        if (!(src instanceof HTMLCanvasElement)) {
            cv = document.createElement('canvas');
            cv.width = w;
            cv.height = h;
            cv.getContext('2d').drawImage(src, 0, 0);
        }
        const data = cv.getContext('2d').getImageData(0, 0, w, h).data;
        const gray = new Float32Array(w * h);
        for (let k = 0; k < w * h; k++) {
            gray[k] = Math.round((data[4 * k] * 299 + data[4 * k + 1] * 587 + data[4 * k + 2] * 114) / 1000);
        }
        return gray;
    }

    // 明るさの配列を deg 度(時計回り)回す(向きを探す時だけに使う。canvas を4回作るより軽い)
    function rotateGray(g, w, h, deg) {
        if (!deg) return { gray: g, w, h };
        const side = deg % 180 !== 0;
        const W = side ? h : w;
        const H = side ? w : h;
        const out = new Float32Array(W * H);
        for (let y = 0; y < H; y++) {
            for (let x = 0; x < W; x++) {
                let sx;
                let sy;
                if (deg === 90) { sx = y; sy = h - 1 - x; }
                else if (deg === 180) { sx = w - 1 - x; sy = h - 1 - y; }
                else { sx = w - 1 - y; sy = x; }
                out[y * W + x] = g[sy * w + sx];
            }
        }
        return { gray: out, w: W, h: H };
    }

    // st を deg 度の向きにする(表示用の画像・明るさ・大きさを作り直し、枠は初期の位置に戻す)
    function setOrientation(st, deg) {
        st.rot = deg;
        st.img = deg ? rotatedCanvas(st.orig, deg) : st.orig;
        st.w = st.img.naturalWidth || st.img.width;
        st.h = st.img.naturalHeight || st.img.height;
        st.gray = grayOf(st.img);
        st.corners = defaultCorners(st.w, st.h);
        st.nRows = 20;
        st.auto = null;
        resetShift(st);
        // 小さい見本(app.js の写真の一覧)も同じ向きにする
        let thumb = null;
        if (deg) {
            const k = 160 / Math.max(st.w, st.h);
            const cv = document.createElement('canvas');
            cv.width = Math.max(1, Math.round(st.w * k));
            cv.height = Math.max(1, Math.round(st.h * k));
            cv.getContext('2d').drawImage(st.img, 0, 0, cv.width, cv.height);
            thumb = cv.toDataURL('image/jpeg', 0.8);
        }
        document.dispatchEvent(new CustomEvent('cellreader-rotate', { detail: { file: st.file, rot: deg, thumb } }));
    }

    // 自動で合わせた枠の、最初の数マスをモデルで読んだ時の自信(0〜1)。逆さの写真だと低くなる
    function orientConfidence(st) {
        let sum = 0;
        let cnt = 0;
        let cells = 0;
        for (let r = 0; r < st.nRows && cells < ORIENT_CONF_CELLS; r++) {
            for (let c = 0; c < 3 && cells < ORIENT_CONF_CELLS; c++) {
                const { img, blank } = extractCell(st, r, c);
                if (blank) continue;
                cells++;
                forward(img, c).forEach((p) => {
                    const m = Math.max(...p);
                    if (Number.isFinite(m)) { sum += Math.exp(m); cnt++; }
                });
            }
        }
        return cnt ? sum / cnt : 0;
    }

    // 4つの向きで表の線を探し、見つかった向きが2つ以上なら、モデルの自信が高い向きを選ぶ
    async function autoOrient(st) {
        const g0 = grayOf(st.orig);
        const w0 = st.orig.naturalWidth;
        const h0 = st.orig.naturalHeight;
        const confOf = (f) => orientConfidence({ gray: f.gray, w: f.w, h: f.h, nRows: f.a.nRows, corners: f.a.corners, shift: f.a.shift });
        const found = [];
        let pick = null;
        for (const deg of [0, 90, 180, 270]) {
            await nextFrame();
            const r = rotateGray(g0, w0, h0, deg);
            let a = null;
            try { a = window.AutoGrid ? window.AutoGrid.detect(r.gray, r.w, r.h) : null; } catch (err) { console.warn(err); }
            if (!(a && a.ok)) continue;
            const f = { deg, a, ...r };
            if (deg === 0) {
                // ふつうの写真は元の向きで読めるので、ここで決める(ほかの向きを試す時間を省く)
                f.conf = confOf(f);
                if (f.conf >= ORIENT_OK) { pick = f; break; }
            }
            found.push(f);
        }
        if (!pick && found.length === 1) pick = found[0];
        if (!pick && found.length > 1) {
            let best = -Infinity;
            for (const f of found) {
                await nextFrame();
                const conf = (f.conf !== undefined ? f.conf : confOf(f)) + (f.deg === 0 ? 0.03 : 0);   // 同じくらいなら、元の向きを選ぶ
                if (conf > best) { best = conf; pick = f; }
            }
        }
        setOrientation(st, pick ? pick.deg : 0);
        const msg = runAuto(st);
        const turned = st.rot === 90 ? '写真が横向きだったので、右に90度回しました。'
            : st.rot === 180 ? '写真が逆さだったので、180度回しました。'
                : st.rot === 270 ? '写真が横向きだったので、左に90度回しました。' : '';
        return turned + msg;
    }

    function draw(st) {
        const cv = st.canvas;
        const ctx = cv.getContext('2d');
        const s = st.scale;
        cv.width = Math.round(st.w * s);
        cv.height = Math.round(st.h * s);
        ctx.drawImage(st.img, 0, 0, cv.width, cv.height);
        const n = st.nRows;
        const P = (u, v, r) => {
            const p = bilerp(st.corners, u, v);
            const sh = r === undefined ? { dx: 0, dy: 0 } : st.shift[r];
            return [(p[0] + sh.dx) * s, (p[1] + sh.dy) * s];
        };
        // 各行の枠(赤)と列の境(青)
        for (let r = 0; r < n; r++) {
            const a = P(0, r / n, r);
            const b = P(1, r / n, r);
            const c2 = P(0, (r + 1) / n, r);
            const d = P(1, (r + 1) / n, r);
            ctx.strokeStyle = 'rgba(220,0,0,0.85)';
            ctx.lineWidth = 1;
            ctx.beginPath();
            ctx.moveTo(...a); ctx.lineTo(...b); ctx.lineTo(...d); ctx.lineTo(...c2); ctx.closePath();
            ctx.stroke();
            ctx.strokeStyle = 'rgba(0,70,230,0.85)';
            [1 / 3, 2 / 3].forEach((u) => {
                ctx.beginPath();
                ctx.moveTo(...P(u, r / n, r));
                ctx.lineTo(...P(u, (r + 1) / n, r));
                ctx.stroke();
            });
            // 行のつまみ(左端の四角)と行番号
            const h = P(0, (r + 0.5) / n, r);
            ctx.fillStyle = st.drag && st.drag.type === 'row' && st.drag.r === r ? '#ff9800' : '#e65100';
            ctx.fillRect(h[0] - 18, h[1] - 6, 12, 12);
            ctx.fillStyle = '#e65100';
            ctx.font = '11px sans-serif';
            ctx.fillText(String(r + 1), h[0] - 34, h[1] + 4);
        }
        // 四隅のつまみ(緑の丸)
        st.corners.forEach((p) => {
            ctx.beginPath();
            ctx.arc(p[0] * s, p[1] * s, 8, 0, Math.PI * 2);
            ctx.fillStyle = 'rgba(0,160,60,0.6)';
            ctx.fill();
            ctx.strokeStyle = '#006b2b';
            ctx.lineWidth = 2;
            ctx.stroke();
        });
    }

    function handleAt(st, x, y) {
        const s = st.scale;
        for (let k = 0; k < 4; k++) {
            const p = st.corners[k];
            if (Math.hypot(p[0] * s - x, p[1] * s - y) <= 12) return { type: 'corner', k };
        }
        for (let r = 0; r < st.nRows; r++) {
            const p = bilerp(st.corners, 0, (r + 0.5) / st.nRows);
            const hx = (p[0] + st.shift[r].dx) * s - 12;
            const hy = (p[1] + st.shift[r].dy) * s;
            if (Math.abs(hx - x) <= 10 && Math.abs(hy - y) <= 9) return { type: 'row', r };
        }
        return null;
    }

    function attachDrag(st) {
        const cv = st.canvas;
        const pos = (e) => {
            const rect = cv.getBoundingClientRect();
            return [(e.clientX - rect.left) * cv.width / rect.width, (e.clientY - rect.top) * cv.height / rect.height];
        };
        cv.addEventListener('pointerdown', (e) => {
            const [x, y] = pos(e);
            const h = handleAt(st, x, y);
            if (!h) return;
            st.drag = { ...h, x, y };
            cv.setPointerCapture(e.pointerId);
            e.preventDefault();
        });
        cv.addEventListener('pointermove', (e) => {
            const [x, y] = pos(e);
            if (!st.drag) {
                cv.style.cursor = handleAt(st, x, y) ? 'grab' : 'default';
                return;
            }
            const dx = (x - st.drag.x) / st.scale;
            const dy = (y - st.drag.y) / st.scale;
            st.drag.x = x;
            st.drag.y = y;
            if (st.drag.type === 'corner') {
                st.corners[st.drag.k][0] += dx;
                st.corners[st.drag.k][1] += dy;
            } else {
                st.shift[st.drag.r].dx += dx;
                st.shift[st.drag.r].dy += dy;
            }
            st.dirty = true;
            draw(st);
        });
        const end = () => { if (st.drag) { st.drag = null; draw(st); } };
        cv.addEventListener('pointerup', end);
        cv.addEventListener('pointercancel', end);
    }

    function setZoom(st, z) {
        st.zoom = z;
        st.scale = (st.wrap.clientWidth || 700) / st.w * z;
        draw(st);
    }

    // files の位置合わせ画面を作る。opts.append = true なら、今ある写真の後ろに足す(前の写真の位置合わせは残す)
    async function prepare(files, container, opts) {
        if (!(opts && opts.append)) {
            states.forEach((st) => URL.revokeObjectURL(st.url));
            states.length = 0;
            container.innerHTML = '';
        }
        const base = states.length;
        for (let i = 0; i < files.length; i++) {
            const { img, url } = await loadImage(files[i]);
            const st = { file: files[i], orig: img, url, zoom: 1 };
            const autoMsg = await autoOrient(st);   // 向きを決めて、自動で位置を合わせる

            const card = document.createElement('div');
            card.className = 'aligner-card';
            card.innerHTML = '<h3></h3>';
            card.firstChild.textContent = `${base + i + 1}枚目「${files[i].name}」`;
            const ctrl = document.createElement('div');
            ctrl.className = 'aligner-ctrl';
            const rowsLabel = document.createElement('label');
            rowsLabel.textContent = '記入されている行数 ';
            const rowsInput = document.createElement('input');
            rowsInput.type = 'number';
            rowsInput.min = '1';
            rowsInput.max = '40';
            rowsInput.value = String(st.nRows);
            rowsInput.className = 'rows-input';
            rowsLabel.appendChild(rowsInput);
            const autoBtn = document.createElement('button');
            autoBtn.type = 'button';
            autoBtn.textContent = '自動で合わせ直す';
            const rotBtn = document.createElement('button');
            rotBtn.type = 'button';
            rotBtn.textContent = '↻ 90度回す';
            rotBtn.title = '写真の向きが違う時に押します(右に90度ずつ回ります)';
            const zoomLabel = document.createElement('label');
            zoomLabel.textContent = '拡大 ';
            const zoomInput = document.createElement('input');
            zoomInput.type = 'range';
            zoomInput.min = '1';
            zoomInput.max = '3';
            zoomInput.step = '0.25';
            zoomInput.value = '1';
            zoomLabel.appendChild(zoomInput);
            ctrl.append(rowsLabel, autoBtn, rotBtn, zoomLabel);
            const status = document.createElement('p');
            status.className = 'aligner-status' + (st.auto ? '' : ' aligner-status-warn');
            status.textContent = autoMsg;
            const wrap = document.createElement('div');
            wrap.className = 'aligner-wrap';
            const canvas = document.createElement('canvas');
            canvas.className = 'aligner-canvas';
            wrap.appendChild(canvas);
            card.append(status, ctrl, wrap);
            container.appendChild(card);
            Object.assign(st, { canvas, wrap, card, titleEl: card.firstChild, controls: [rowsInput, autoBtn, rotBtn, zoomInput] });
            attachDrag(st);
            rowsInput.addEventListener('change', () => {
                const n = Math.max(1, Math.min(40, Number(rowsInput.value) || 20));
                if (st.auto && n <= st.auto.lines.length - 1) {
                    applyAuto(st, n);   // 見つけた行の線に合わせて枠を伸び縮みさせる
                } else {
                    st.nRows = n;
                    resetShift(st);
                }
                rowsInput.value = String(st.nRows);
                draw(st);
            });
            autoBtn.addEventListener('click', () => {
                status.textContent = runAuto(st);
                status.className = 'aligner-status' + (st.auto ? '' : ' aligner-status-warn');
                rowsInput.value = String(st.nRows);
                draw(st);
            });
            rotBtn.addEventListener('click', () => {
                setOrientation(st, (st.rot + 90) % 360);
                status.textContent = (st.rot ? `写真を回しました(元の写真から右に${st.rot}度)。` : '写真を元の向きに戻しました。') + runAuto(st);
                status.className = 'aligner-status' + (st.auto ? '' : ' aligner-status-warn');
                rowsInput.value = String(st.nRows);
                setZoom(st, st.zoom || 1);
            });
            zoomInput.addEventListener('input', () => setZoom(st, Number(zoomInput.value)));
            states.push(st);
            setZoom(st, 1);
            setLocked(locked);   // 読み取り中に新しい写真を選び直した場合でも鍵をかけたままにする
        }
    }

    // k 枚目の写真を位置合わせ画面から消す(ほかの写真の位置合わせは残し、「○枚目」の番号を付け直す)
    function remove(k) {
        const st = states[k];
        if (!st) return;
        URL.revokeObjectURL(st.url);
        if (st.card) st.card.remove();
        states.splice(k, 1);
        states.forEach((s, i) => { if (s.titleEl) s.titleEl.textContent = `${i + 1}枚目「${s.file.name}」`; });
    }

    // 行 r の3マス(出発〜飛行時間)の範囲を写真から切り取り、小さな画像(data URL)にする。照合結果の表に出す
    function rowImage(st, r) {
        const n = st.nRows;
        const sh = st.shift[r];
        const pad = 0.25 / n;
        const pts = [[0, r / n - pad], [1, r / n - pad], [0, (r + 1) / n + pad], [1, (r + 1) / n + pad]]
            .map(([u, v]) => { const p = bilerp(st.corners, u, v); return [p[0] + sh.dx, p[1] + sh.dy]; });
        const x0 = Math.max(0, Math.min(...pts.map((p) => p[0])) - 4);
        const x1 = Math.min(st.w, Math.max(...pts.map((p) => p[0])) + 4);
        const y0 = Math.max(0, Math.min(...pts.map((p) => p[1])));
        const y1 = Math.min(st.h, Math.max(...pts.map((p) => p[1])));
        if (x1 <= x0 || y1 <= y0) return null;
        const H = 48;
        const W = Math.round((x1 - x0) * H / (y1 - y0));
        const cv = document.createElement('canvas');
        cv.width = W;
        cv.height = H;
        cv.getContext('2d').drawImage(st.img, x0, y0, x1 - x0, y1 - y0, 0, 0, W, H);
        return cv.toDataURL('image/jpeg', 0.85);
    }

    // ---------- 読み取り ----------
    const nextFrame = () => new Promise((r) => setTimeout(r, 0));

    // i 枚目を読む。app.js の parseImage と同じ形({ rows: [...] })で返す
    async function read(i, onProgress) {
        const st = states[i];
        if (!st) throw new Error('位置合わせの画面が準備できていません');
        loadModel();
        const n = st.nRows;
        const rows = [];
        const raw = [];
        for (let r = 0; r < n; r++) {
            const cells = {};
            const rawRow = {};
            for (let c = 0; c < 3; c++) {
                const { img, blank } = extractCell(st, r, c);
                if (blank) continue;
                const lp = forward(img, c);
                cells[c] = lp;
                rawRow[c] = toText(lp.map((p) => p.indexOf(Math.max(...p))), c);
            }
            rows.push({ r, cells });
            raw.push(rawRow);
            if (onProgress) onProgress(r + 1, n);
            await nextFrame();   // 画面が固まらないように
        }
        const picked = decodePhoto(rows);
        const out = [];
        rows.forEach((row, k) => {
            const p = picked[k];
            if (!p) return;
            // 読み取りが怪しいマス(黄色で表示): 表の計算チェックで書き換えたマスと、自信が低いマス
            const uncertain = {};
            const val = (c) => (p[c] ? p[c].text : '');
            [0, 1, 2].forEach((c) => {
                if (!p[c]) return;
                const key = ['dep', 'arr', 'flt'][c];
                if (raw[k][c] !== p[c].text) {
                    uncertain[key] = `表の計算チェックで直した値(モデルの読み取りは ${raw[k][c]})`;
                    return;
                }
                const alt = candidates(row.cells[c], c).find((x) => x.text !== p[c].text);
                if (alt && p[c].score - alt.score < LOW_MARGIN) {
                    uncertain[key] = `読み取りに自信がない(次の候補は ${alt.text})`;
                }
            });
            const dep = val(0);
            const arr = val(1);
            const flt = val(2);
            let arithHint = 'unknown';
            if (p[0] && p[1] && p[2]) arithHint = p[1].value - p[0].value === p[2].value ? 'consistent' : 'inconsistent';
            out.push({
                row: row.r + 1,
                departure: dep || null,
                arrival: arr || null,
                flight_time: flt || null,
                reviewReasons: [],
                uncertain,
                needsReview: Object.keys(uncertain).length > 0,
                rowImage: rowImage(st, row.r),
                arithHint,
            });
        });
        return { rows: out, nRows: n };
    }

    window.CellReader = { prepare, remove, read, forward, extractCell, decodePhoto, snapRows, rowImage, setLocked, states, _toText: toText };
})();
