// 時刻欄の位置と記入されている行数を、写真の罫線から自動で見つける。
// 画像の処理はすべてブラウザ内で行い、外部へは送信しない。
//
// 手順:
//   1. 写真を縮小し、紙より暗い所(インク)を取り出す
//   2. 長くまっすぐ続くインク = 印刷された罫線 として、縦線・横線を見つける
//   3. 縦線の並びから「出発・到着・飛行時間(ほぼ同じ幅)→ 離脱高度(細い)→ 備考(広い)」の並びを探す
//   4. その3列の範囲で横線(行の線)を拾い、見出しの下から始まる等間隔の行を見つける
//   5. 各行の3マスに字があるかを見て、記入されている行数を決める
//   6. 四隅と各行のずれ(cellreader.js の corners / shift)を返す
// ブラウザでは window.AutoGrid、Node では module.exports で使える(テスト用)。
(function (root) {
    'use strict';

    const WORK_MAX = 1600;   // 処理する画像の長辺(これより大きい写真は縮小)

    // ---------- 基本の画像処理 ----------
    function downscale(gray, w, h) {
        const k = Math.max(1, Math.ceil(Math.max(w, h) / WORK_MAX));
        if (k === 1) return { g: Float32Array.from(gray), w, h, k: 1 };
        const W = Math.floor(w / k);
        const H = Math.floor(h / k);
        const g = new Float32Array(W * H);
        for (let y = 0; y < H; y++) {
            for (let x = 0; x < W; x++) {
                let s = 0;
                for (let dy = 0; dy < k; dy++) {
                    const row = (y * k + dy) * w + x * k;
                    for (let dx = 0; dx < k; dx++) s += gray[row + dx];
                }
                g[y * W + x] = s / (k * k);
            }
        }
        return { g, w: W, h: H, k };
    }

    // 箱形の平均(積分画像)
    function boxMean(src, w, h, r) {
        const W1 = w + 1;
        const ii = new Float64Array(W1 * (h + 1));
        for (let y = 0; y < h; y++) {
            let rs = 0;
            for (let x = 0; x < w; x++) {
                rs += src[y * w + x];
                ii[(y + 1) * W1 + x + 1] = ii[y * W1 + x + 1] + rs;
            }
        }
        const out = new Float32Array(w * h);
        for (let y = 0; y < h; y++) {
            const y0 = Math.max(0, y - r);
            const y1 = Math.min(h, y + r + 1);
            for (let x = 0; x < w; x++) {
                const x0 = Math.max(0, x - r);
                const x1 = Math.min(w, x + r + 1);
                const s = ii[y1 * W1 + x1] - ii[y0 * W1 + x1] - ii[y1 * W1 + x0] + ii[y0 * W1 + x0];
                out[y * w + x] = s / ((y1 - y0) * (x1 - x0));
            }
        }
        return out;
    }

    // 紙より暗い所 = インク(1)。黒塗りや机などの暗い背景はインクにしない
    function inkMask(g, w, h) {
        const bg = boxMean(g, w, h, 20);
        const ink = new Uint8Array(w * h);
        for (let i = 0; i < w * h; i++) {
            const b = bg[i];
            if (b > 70 && b - g[i] > Math.max(18, 0.12 * b)) ink[i] = 1;
        }
        return ink;
    }

    // 横(または縦)に長く続くインクだけを残す。線が少し傾いていても拾えるよう、直交方向に1画素ふくらませてから数える
    function runMask(ink, w, h, horizontal, half, ratio) {
        const fat = new Uint8Array(w * h);
        for (let y = 0; y < h; y++) {
            for (let x = 0; x < w; x++) {
                const i = y * w + x;
                if (ink[i]) { fat[i] = 1; continue; }
                if (horizontal) {
                    if ((y > 0 && ink[i - w]) || (y < h - 1 && ink[i + w])) fat[i] = 1;
                } else if ((x > 0 && ink[i - 1]) || (x < w - 1 && ink[i + 1])) fat[i] = 1;
            }
        }
        const out = new Uint8Array(w * h);
        const need = Math.round((2 * half + 1) * ratio);
        if (horizontal) {
            for (let y = 0; y < h; y++) {
                let s = 0;
                const row = y * w;
                for (let x = 0; x < Math.min(w, half); x++) s += fat[row + x];
                for (let x = 0; x < w; x++) {
                    if (x + half < w) s += fat[row + x + half];
                    if (x - half - 1 >= 0) s -= fat[row + x - half - 1];
                    if (s >= need && fat[row + x]) out[row + x] = 1;
                }
            }
        } else {
            for (let x = 0; x < w; x++) {
                let s = 0;
                for (let y = 0; y < Math.min(h, half); y++) s += fat[y * w + x];
                for (let y = 0; y < h; y++) {
                    if (y + half < h) s += fat[(y + half) * w + x];
                    if (y - half - 1 >= 0) s -= fat[(y - half - 1) * w + x];
                    if (s >= need && fat[y * w + x]) out[y * w + x] = 1;
                }
            }
        }
        return out;
    }

    // つながった線の塊ごとに、直線を当てはめる。
    // 横線: y = a + b*x(x0〜x1)、縦線: x = a + b*y(y0〜y1)
    function segments(mask, w, h, horizontal, minLen) {
        const label = new Int32Array(w * h).fill(-1);
        const segs = [];
        const stack = [];
        for (let start = 0; start < w * h; start++) {
            if (!mask[start] || label[start] >= 0) continue;
            const id = segs.length;
            let n = 0, su = 0, sv = 0, suu = 0, suv = 0, umin = Infinity, umax = -Infinity;
            label[start] = id;
            stack.push(start);
            while (stack.length) {
                const i = stack.pop();
                const x = i % w;
                const y = (i - x) / w;
                const u = horizontal ? x : y;   // 線に沿った向き
                const v = horizontal ? y : x;   // 線に直交する向き
                n++; su += u; sv += v; suu += u * u; suv += u * v;
                if (u < umin) umin = u;
                if (u > umax) umax = u;
                for (let dy = -1; dy <= 1; dy++) {
                    const yy = y + dy;
                    if (yy < 0 || yy >= h) continue;
                    for (let dx = -1; dx <= 1; dx++) {
                        const xx = x + dx;
                        if (xx < 0 || xx >= w) continue;
                        const j = yy * w + xx;
                        if (mask[j] && label[j] < 0) { label[j] = id; stack.push(j); }
                    }
                }
            }
            const len = umax - umin;
            const den = n * suu - su * su;
            const b = den > 0 ? (n * suv - su * sv) / den : 0;
            const a = (sv - b * su) / n;
            segs.push({ a, b, u0: umin, u1: umax, len, n });
        }
        return segs.filter((s) => s.len >= minLen && Math.abs(s.b) < 0.15);
    }

    // 同じ直線に乗る線の切れ端をまとめる
    function mergeLines(segs, refU) {
        const at = (s, u) => s.a + s.b * u;
        const sorted = segs.slice().sort((p, q) => at(p, refU) - at(q, refU));
        const lines = [];
        sorted.forEach((s) => {
            const last = lines[lines.length - 1];
            if (last) {
                // 重なっている所(なければ近い端)で位置を比べる
                const u = Math.min(Math.max(refU, Math.max(s.u0, last.u0)), Math.min(s.u1, last.u1));
                const uu = isFinite(u) ? u : (s.u0 + s.u1) / 2;
                if (Math.abs(at(s, uu) - at(last, uu)) <= 4 && Math.abs(s.b - last.b) < 0.03) {
                    last.parts.push(s);
                    return;
                }
            }
            lines.push({ parts: [s], a: s.a, b: s.b, u0: s.u0, u1: s.u1 });
        });
        // 2回目: 傾いた写真では切れ端どうしの位置が少しずれるので、互いの中ほどの高さで比べてつなぐ
        for (let changed = true; changed;) {
            changed = false;
            for (let i = 0; i < lines.length && !changed; i++) {
                for (let j = i + 1; j < lines.length && !changed; j++) {
                    const A = lines[i];
                    const B = lines[j];
                    const fitA = (u) => A.parts.reduce((s, p) => s + (p.a + p.b * u) * p.len, 0) / A.parts.reduce((s, p) => s + p.len, 0);
                    const fitB = (u) => B.parts.reduce((s, p) => s + (p.a + p.b * u) * p.len, 0) / B.parts.reduce((s, p) => s + p.len, 0);
                    const mA = (A.u0 + A.u1) / 2;
                    const mB = (B.u0 + B.u1) / 2;
                    if (Math.abs(fitA(mA) - fitB(mA)) <= 5 && Math.abs(fitA(mB) - fitB(mB)) <= 5) {
                        A.parts.push(...B.parts);
                        A.u0 = Math.min(A.u0, B.u0);
                        A.u1 = Math.max(A.u1, B.u1);
                        lines.splice(j, 1);
                        changed = true;
                    }
                }
            }
        }
        lines.forEach((L) => {
            // 長い切れ端ほど重く見て傾きと位置を決め直す
            let wsum = 0, bsum = 0;
            L.parts.forEach((p) => { wsum += p.len; bsum += p.b * p.len; });
            L.b = bsum / wsum;
            let asum = 0;
            L.parts.forEach((p) => { asum += (p.a + p.b * refU - L.b * refU) * p.len; });
            L.a = asum / wsum;
            L.u0 = Math.min(...L.parts.map((p) => p.u0));
            L.u1 = Math.max(...L.parts.map((p) => p.u1));
            L.cover = L.parts.reduce((s, p) => s + p.len, 0);
        });
        return lines;
    }

    const median = (arr) => {
        const s = arr.slice().sort((p, q) => p - q);
        return s.length ? s[Math.floor(s.length / 2)] : NaN;
    };

    // ---------- 3. 時刻の3列を探す ----------
    function findTimeColumns(vlines, yRef) {
        if (vlines.length < 4) return null;
        const maxCover = Math.max(...vlines.map((L) => L.cover));
        const long = vlines.filter((L) => L.cover >= 0.3 * maxCover)
            .map((L) => ({ L, x: L.a + L.b * yRef }))
            .sort((p, q) => p.x - q.x);
        // 近すぎる線(二重線・字の縦棒)はまとめる
        const xs = [];
        long.forEach((c) => {
            const last = xs[xs.length - 1];
            if (last && c.x - last.x < 8) {
                if (c.L.cover > last.L.cover) xs[xs.length - 1] = c;
            } else xs.push(c);
        });
        let best = null;
        for (let i = 0; i + 4 < xs.length; i++) {
            const w = [0, 1, 2, 3, 4].map((k) => (xs[i + k + 1] ? xs[i + k + 1].x - xs[i + k].x : null));
            const mean3 = (w[0] + w[1] + w[2]) / 3;
            if (mean3 < 15) continue;
            const spread = Math.max(w[0], w[1], w[2]) / Math.min(w[0], w[1], w[2]);
            if (spread > 1.45) continue;
            const alt = w[3] / mean3;                 // 離脱高度の列: 時刻の列より細い
            if (alt < 0.3 || alt > 0.9) continue;
            const note = w[4] === null ? null : w[4] / mean3;   // 備考の列: 広い(写真から切れていてもよい)
            let score = 3 - (spread - 1) * 4 - Math.abs(alt - 0.6) * 2;
            if (note !== null) score += note >= 1.8 ? 2 : -2;
            // 3列の線が長いほどよい
            score += [0, 1, 2, 3].reduce((s, k) => s + xs[i + k].L.cover / maxCover, 0);
            if (!best || score > best.score) best = { score, i, lines: [0, 1, 2, 3].map((k) => xs[i + k].L) };
        }
        return best;
    }

    // ---------- 4. 行の線 ----------
    // 時刻欄の中の行の線は点線のことが多いので、「長くつながった線」ではなく、
    // 3列の幅いっぱいに少し傾けた直線を引いて、その上にインクがどれだけ乗るか(上下より多いか)で探す。
    function findRowLines(ink, vm, w, h, colL, colR, hlines) {
        // 横線のおおよその傾き: 見つかった長い横線の傾きの中央値
        const longH = hlines.filter((L) => L.cover > 0.08 * w);
        const slope0 = longH.length ? median(longH.map((L) => L.b)) : 0;
        const xAt = (V, y) => V.a + V.b * y;
        // 探す範囲: 縦線の上端〜下端を、列の幅の4倍ずつ上下に広げる(縦線が途中で切れていても見出しまで入るように)
        const colW = (xAt(colR, h / 2) - xAt(colL, h / 2)) / 3;
        const yTop = Math.max(0, Math.floor(Math.min(colL.u0, colR.u0) - 4 * colW));
        const yBot = Math.min(h - 1, Math.ceil(Math.max(colL.u1, colR.u1) + 4 * colW));
        const slopes = [];
        for (let d = -0.012; d <= 0.0121; d += 0.004) slopes.push(slope0 + d);
        // y0(左端での高さ)ごとに、線の上のインクの割合
        const cover = (y0, sl) => {
            const xl = xAt(colL, y0);
            const xr = xAt(colR, y0 + sl * (xAt(colR, y0) - xl));
            let n = 0;
            let hit = 0;
            for (let x = Math.ceil(xl + 3); x <= xr - 3; x++) {
                const y = Math.round(y0 + sl * (x - xl));
                if (y < 0 || y >= h) continue;
                const i = y * w + x;
                if (vm[i]) continue;   // 縦線の所は数えない
                n++;
                if (ink[i]) hit++;
            }
            return n ? hit / n : 0;
        };
        const prof = [];
        for (let y0 = yTop; y0 <= yBot; y0++) {
            let best = { c: -1, sl: slope0 };
            slopes.forEach((sl) => {
                const c = cover(y0, sl) - 0.5 * (cover(y0 - 3, sl) + cover(y0 + 3, sl));
                if (c > best.c) best = { c, sl };
            });
            prof.push({ y0, c: best.c, sl: best.sl });
        }
        // 山(線)を拾う: 周り±4画素で一番高く、十分に高い所
        const peaks = [];
        for (let i = 0; i < prof.length; i++) {
            const p = prof[i];
            if (p.c < 0.08) continue;
            let isMax = true;
            for (let j = Math.max(0, i - 4); j <= Math.min(prof.length - 1, i + 4); j++) {
                if (prof[j].c > p.c || (prof[j].c === p.c && j < i)) { isMax = false; break; }
            }
            if (isMax) peaks.push(p);
        }
        const toLine = (y0, sl) => {
            const xl = xAt(colL, y0);
            const yR0 = y0 + sl * (xAt(colR, y0) - xl);
            const xr = xAt(colR, yR0);
            const yR = y0 + sl * (xr - xl);
            return { yL: y0, yR, pL: [xl, y0], pR: [xr, yR] };
        };
        // 実線の横線(見出しの下の線・表の一番下の線など): 3列の幅の6割以上を通る長い線
        const solid = [];
        hlines.forEach((H) => {
            const y = (H.a + H.b * colL.a) / (1 - H.b * colL.b);
            const xl = xAt(colL, y);
            const xr = xAt(colR, y);
            let covered = 0;
            H.parts.forEach((p) => { covered += Math.max(0, Math.min(p.u1, xr) - Math.max(p.u0, xl)); });
            if (covered / Math.max(1, xr - xl) >= 0.6 && y >= yTop && y <= yBot) solid.push(Math.round(y));
        });
        return { prof, yTop, peaks, toLine, solid };
    }

    // 表は20行で印刷されているので、「1行目の上の線 y0 から20行分」を当てはめる。
    // 写真の遠近で下ほど行が高く(低く)なるので、行の高さが上から下へ少しずつ変わるのも許す。
    // 線の上のインクの割合(prof)が一番多く乗る当てはめを選び、最後に各線を近くの山に寄せる。
    const PRINTED_ROWS = 20;
    function fitTable(R) {
        const { prof, yTop, peaks, toLine } = R;
        const N = PRINTED_ROWS;
        const cAt = (y) => {
            const i = Math.round(y) - yTop;
            return i >= 0 && i < prof.length ? Math.max(prof[i].c, 0) : 0;
        };
        const near = (y, r) => {
            let best = 0;
            for (let d = -r; d <= r; d++) best = Math.max(best, cAt(y + d));
            return best;
        };
        const isSolid = (y) => R.solid.some((v) => Math.abs(v - y) <= 3);
        const ratios = [];
        for (let r = 0.7; r <= 1.45; r += 0.05) ratios.push(r);
        const search = (tops, bots, bonus) => {
            let best = null;
            tops.forEach((y0) => bots.forEach((yN) => {
                const mean = (yN - y0) / N;
                if (mean < 10 || mean > 90) return;
                ratios.forEach((ratio) => {
                    // 行 k の高さ ∝ 1 + (ratio-1)*k/(N-1)、合計が yN-y0 になるように
                    const hs = [];
                    let tot = 0;
                    for (let k = 0; k < N; k++) { const hk = 1 + (ratio - 1) * k / (N - 1); hs.push(hk); tot += hk; }
                    const ys = [y0];
                    for (let k = 0; k < N; k++) ys.push(ys[k] + hs[k] * (yN - y0) / tot);
                    const snap = Math.max(1, Math.round(mean * 0.08));
                    let inner = 0;
                    for (let k = 1; k < N; k++) inner += near(ys[k], snap);
                    let score = inner + near(y0, snap) + near(yN, snap);
                    // 1行目の上には背の高い見出し欄があるので、1行分上に線があれば表の始まりではない
                    score -= 2 * near(y0 - (ys[1] - ys[0]), snap);
                    // 1行目の上と20行目の下は実線のはず
                    if (bonus) {
                        if (isSolid(y0)) score += 1.5;
                        if (isSolid(yN)) score += 1.5;
                    }
                    if (!best || score > best.score) best = { score, ys, mean, inner: inner / (N - 1) };
                });
            }));
            return best;
        };
        // まず「1行目の上も20行目の下も実線」の組で当てはめ、うまく合わなければ山の位置も使う
        const solid = Array.from(new Set(R.solid)).sort((p, q) => p - q);
        let best = solid.length >= 2 ? search(solid, solid, false) : null;
        if (!best || best.inner < 0.12) {
            const cand = Array.from(new Set(peaks.slice().sort((p, q) => q.c - p.c).slice(0, 60).map((p) => p.y0)
                .concat(solid))).sort((p, q) => p - q);
            const alt = search(cand, cand, true);
            if (alt && (!best || alt.inner > best.inner + 0.05)) best = alt;
        }
        if (!best) return null;
        // 各線を近くの山に寄せる(山が無ければ当てはめた位置のまま)
        const lines = best.ys.map((y) => {
            const r = Math.max(2, Math.round(best.mean * 0.2));
            let by = y;
            let bc = 0.1;
            for (let d = -r; d <= r; d++) {
                const c = cAt(y + d) - 0.004 * Math.abs(d);
                if (c > bc) { bc = c; by = y + d; }
            }
            const i = Math.min(Math.max(Math.round(by) - yTop, 0), prof.length - 1);
            const ln = toLine(by, prof[i].sl);
            ln.filled = bc <= 0.1;
            return ln;
        });
        return { lines, pitch: best.mean, score: best.score / (N + 1) };
    }

    // ---------- 5. 記入されている行 ----------
    function cellHasInk(ink, lineMask, w, h, quad) {
        // quad: [左上, 右上, 左下, 右下] の内側(縁を除く)にインクがどれだけあるか
        const [tl, tr, bl, br] = quad;
        let total = 0;
        let hit = 0;
        const NU = 24;
        const NV = 10;
        for (let j = 0; j < NV; j++) {
            const v = 0.22 + 0.56 * j / (NV - 1);
            for (let i = 0; i < NU; i++) {
                const u = 0.12 + 0.76 * i / (NU - 1);
                const x = Math.round((tl[0] * (1 - u) + tr[0] * u) * (1 - v) + (bl[0] * (1 - u) + br[0] * u) * v);
                const y = Math.round((tl[1] * (1 - u) + tr[1] * u) * (1 - v) + (bl[1] * (1 - u) + br[1] * u) * v);
                if (x < 0 || y < 0 || x >= w || y >= h) continue;
                total++;
                const k = y * w + x;
                if (ink[k] && !lineMask[k]) hit++;
            }
        }
        return total ? hit / total : 0;
    }

    // ---------- まとめ ----------
    // gray: 0〜255 の明るさ(長さ w*h)。戻り値は元の写真の座標
    function detect(gray, w, h, opts = {}) {
        const S = downscale(gray, w, h);
        const ink = inkMask(S.g, S.w, S.h);
        const hm = runMask(ink, S.w, S.h, true, 15, 0.9);
        const vm = runMask(ink, S.w, S.h, false, 15, 0.9);
        const minLen = Math.max(40, Math.round(Math.min(S.w, S.h) * 0.04));
        const hseg = segments(hm, S.w, S.h, true, minLen);
        const vseg = segments(vm, S.w, S.h, false, minLen);
        const yRef = median(vseg.map((s) => (s.u0 + s.u1) / 2)) || S.h / 2;   // 縦線の中ほどの高さ
        const xRef = S.w / 2;
        const hlines = mergeLines(hseg, xRef);
        const vlines = mergeLines(vseg, yRef);

        if (opts.masks) opts.masks.push({ w: S.w, h: S.h, ink, hm, vm });
        const cols = findTimeColumns(vlines, yRef);
        if (!cols) return { ok: false, reason: '時刻欄の縦線が見つかりませんでした' };
        const [c0, c1, c2, c3] = cols.lines;
        const rowProf = findRowLines(ink, vm, S.w, S.h, c0, c3, hlines);
        const rowLines = rowProf.peaks.map((p) => rowProf.toLine(p.y0, p.sl));
        const k0 = S.k;
        const dbgCols = cols.lines.map((V) => ({ a: V.a * k0, b: V.b }));
        const dbgRows = rowLines.map((l) => ({ pL: [l.pL[0] * k0, l.pL[1] * k0], pR: [l.pR[0] * k0, l.pR[1] * k0], filled: false }));
        const data = fitTable(rowProf);
        if (!data) return { ok: false, reason: '行の線が見つかりませんでした', debug: { cols: dbgCols, rowLines: dbgRows, peaks: rowProf.peaks.length, solid: rowProf.solid } };

        // 各行の3マスに字があるか
        const lineMask = new Uint8Array(S.w * S.h);
        for (let i = 0; i < lineMask.length; i++) lineMask[i] = hm[i] | vm[i];
        const xOn = (V, y) => V.a + V.b * y;
        const L = data.lines;
        const filled = [];
        for (let r = 0; r + 1 < L.length; r++) {
            const top = L[r];
            const bot = L[r + 1];
            const yAt = (line, x) => line.pL[1] + (line.pR[1] - line.pL[1]) * (x - line.pL[0]) / ((line.pR[0] - line.pL[0]) || 1);
            const inks = [[c0, c1], [c1, c2], [c2, c3]].map(([A, B]) => {
                const xa = xOn(A, (top.yL + bot.yL) / 2);
                const xb = xOn(B, (top.yL + bot.yL) / 2);
                return cellHasInk(ink, lineMask, S.w, S.h, [
                    [xa, yAt(top, xa)], [xb, yAt(top, xb)], [xa, yAt(bot, xa)], [xb, yAt(bot, xb)],
                ]);
            });
            filled.push(inks);
        }
        const written = filled.map((f) => Math.max(...f) > 0.03);
        let nRows = 0;
        written.forEach((on, r) => { if (on) nRows = r + 1; });
        if (nRows === 0) return { ok: false, reason: '記入されている行が見つかりませんでした' };

        const k = S.k;
        const lines = L.map((l) => ({ pL: [l.pL[0] * k, l.pL[1] * k], pR: [l.pR[0] * k, l.pR[1] * k], filled: !!l.filled }));
        return {
            ok: true,
            nRows,
            lines,                      // 印刷された行の線(1行目の上〜20行目の下、元の写真の座標)
            ...layout(lines, nRows),    // corners, shift
            printedRows: L.length - 1,
            pitch: data.pitch * k,
            debug: {
                k,
                cols: cols.lines.map((V) => ({ a: V.a * k, b: V.b })),
                rowLines: lines,
                inks: filled.map((f) => f.map((v) => Math.round(v * 1000) / 1000)),
            },
        };
    }

    // 行の線(lines)と行数 n から、cellreader.js の四隅(corners)と行ごとのずれ(shift)を作る。
    // 四隅は 1行目の上の線 と n行目の下の線 の両端。四隅から等間隔に割った位置と線の位置の差を、行ごとのずれにする。
    function layout(lines, n) {
        n = Math.max(1, Math.min(n, lines.length - 1));
        const top = lines[0];
        const bot = lines[n];
        const corners = [top.pL.slice(), top.pR.slice(), bot.pL.slice(), bot.pR.slice()];
        const shift = [];
        for (let r = 0; r < n; r++) {
            const f0 = r / n;
            const f1 = (r + 1) / n;
            const ev = (f, side) => top[side][1] + (bot[side][1] - top[side][1]) * f;
            const dy = ((lines[r].pL[1] - ev(f0, 'pL')) + (lines[r].pR[1] - ev(f0, 'pR'))
                + (lines[r + 1].pL[1] - ev(f1, 'pL')) + (lines[r + 1].pR[1] - ev(f1, 'pR'))) / 4;
            shift.push({ dx: 0, dy });
        }
        return { corners, shift };
    }

    const api = { detect, layout };
    if (typeof module !== 'undefined' && module.exports) module.exports = api;
    else root.AutoGrid = api;
})(typeof window !== 'undefined' ? window : this);
