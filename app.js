document.addEventListener('DOMContentLoaded', () => {
    const imageInput = document.getElementById('imageInput');
    const imageStatus = document.getElementById('imageStatus');

    const excelInput = document.getElementById('excelInput');
    const excelStatus = document.getElementById('excelStatus');

    const compareBtn = document.getElementById('compareBtn');
    const globalStatus = document.getElementById('globalStatus');

    const resultSection = document.getElementById('resultSection');
    const resultSummary = document.getElementById('resultSummary');
    const resultGroups = document.getElementById('resultGroups');

    let imageFiles = [];
    let excelFiles = [];

    excelInput.addEventListener('change', (e) => {
        const files = Array.from(e.target.files);
        if (files.length === 0) {
            excelStatus.textContent = '未選択';
            excelFiles = [];
            checkReady();
            return;
        }
        excelFiles = files;
        excelStatus.textContent = `${files.length} 個のファイルを選択中`;
        excelStatus.classList.remove('status-error');
        checkReady();
    });

    // ---- Excel をリンクから読む(Google ドライブ / Google スプレッドシートの共有リンク) ----
    // (1) まずログイン無しで試す(「リンクを知っている全員」で共有されたファイルはこれで読める)
    // (2) だめなら Google にログインして読む(共有が「制限付き」のファイル。google_config.js の設定が要る)
    // どちらも、このブラウザが Google から直接受け取る。Excel の中身をほかへ送ることはない。
    const excelLinkInput = document.getElementById('excelLinkInput');
    const excelLinkBtn = document.getElementById('excelLinkBtn');
    const excelLinkNote = document.getElementById('excelLinkNote');

    const isExcelBytes = (buf) => {
        const head = new Uint8Array(buf.slice(0, 4));
        const isXlsx = head[0] === 0x50 && head[1] === 0x4B;                       // .xlsx(中身は zip)
        const isXls = head[0] === 0xD0 && head[1] === 0xCF && head[2] === 0x11;    // 古い .xls
        return isXlsx || isXls;
    };

    // 貼られたリンク → ファイルの番号(id)と、ログイン無しで取りに行く先(順に試す)
    const parseExcelLink = (text) => {
        let url;
        try { url = new URL(text); } catch (err) { throw new Error('リンクの形になっていません(https:// から始まるリンクを貼ってください)'); }
        if (!/^https?:$/.test(url.protocol)) throw new Error('https:// から始まるリンクを貼ってください');
        const isGoogle = /(^|\.)google\.com$/.test(url.hostname);
        if (!isGoogle) return { id: null, targets: [url.href] };   // Google 以外: そのまま取りに行ってみる
        if (/\/folders\//.test(url.pathname)) {
            throw new Error('これはフォルダのリンクです。Excel のファイルを右クリック →「共有」→「リンクをコピー」したものを貼ってください');
        }
        const pub = url.pathname.match(/\/spreadsheets\/d\/e\/([\w-]+)/);   // 「ウェブに公開」のリンク
        if (pub) return { id: null, targets: [`https://docs.google.com/spreadsheets/d/e/${pub[1]}/pub?output=xlsx`] };
        const m = url.pathname.match(/\/d\/([\w-]{15,})/);
        const id = m ? m[1] : url.searchParams.get('id');
        if (!id || !/^[\w-]{15,}$/.test(id)) throw new Error('リンクからファイルを特定できませんでした');
        return {
            id,
            targets: [
                `https://docs.google.com/spreadsheets/d/${id}/export?format=xlsx`,
                `https://drive.google.com/uc?export=download&id=${id}`,
            ],
        };
    };

    // ログイン無しで受け取る。受け取れなければ null
    const fetchExcelBytes = async (targets) => {
        for (const target of targets) {
            try {
                const res = await fetch(target, { credentials: 'omit' });
                if (!res.ok) { console.warn('Excelのリンク:', target, res.status); continue; }
                const buf = await res.arrayBuffer();
                if (isExcelBytes(buf)) return buf;
                console.warn('Excelのリンク: Excel ではない内容が返ってきました', target);
            } catch (err) {
                console.warn('Excelのリンク:', target, err);
            }
        }
        return null;
    };

    // ---- Google にログインして読む ----
    // 許可の種類は drive.file(このアプリで本人が選んだファイルだけを読める)。ログインの合い言葉(トークン)はこのページの中にだけ持ち、保存しない。
    const DRIVE_SCOPE = 'https://www.googleapis.com/auth/drive.file';
    const SHEET_MIME = 'application/vnd.google-apps.spreadsheet';
    const XLSX_MIME = 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet';
    const googleConfig = () => window.GOOGLE_CONFIG || {};
    const googleConfigured = () => !!(googleConfig().clientId && googleConfig().apiKey);
    const googleUsable = () => googleConfigured() && location.protocol !== 'file:';
    let googleToken = null;
    let googleTokenUntil = 0;
    let googleAskAccount = false;          // 次のログインでアカウントを選び直してもらう(違うアカウントで入った時)
    const loginNeededIds = new Set();      // ログイン無しでは読めなかったファイル(次からはすぐログインへ進む)
    const scriptLoads = new Map();

    const loadScript = (src) => {
        if (!scriptLoads.has(src)) {
            scriptLoads.set(src, new Promise((resolve, reject) => {
                const s = document.createElement('script');
                s.src = src;
                s.onload = resolve;
                s.onerror = () => {
                    scriptLoads.delete(src);
                    reject(new Error('Google の部品を受け取れませんでした(インターネットの接続を確かめてください)'));
                };
                document.head.appendChild(s);
            }));
        }
        return scriptLoads.get(src);
    };
    const gisLoaded = () => !!(window.google && google.accounts && google.accounts.oauth2);
    const ensureGis = async () => { if (!gisLoaded()) await loadScript('https://accounts.google.com/gsi/client'); };
    const ensurePicker = async () => {
        if (window.google && google.picker) return;
        if (!window.gapi) await loadScript('https://apis.google.com/js/api.js');
        await new Promise((resolve, reject) => gapi.load('picker', {
            callback: resolve,
            onerror: () => reject(new Error('Google のファイル選択の部品を受け取れませんでした')),
            timeout: 15000,
            ontimeout: () => reject(new Error('Google のファイル選択の部品を受け取れませんでした(時間切れ)')),
        }));
    };

    // Google の小さな画面を出して、許可をもらう
    const requestGoogleToken = () => new Promise((resolve, reject) => {
        const client = google.accounts.oauth2.initTokenClient({
            client_id: googleConfig().clientId,
            scope: DRIVE_SCOPE,
            prompt: googleAskAccount ? 'select_account' : '',
            callback: (res) => {
                if (!res || res.error || !res.access_token) {
                    return reject(new Error(res && res.error === 'access_denied' ? 'Google の許可が取り消されました' : 'Google のログインに失敗しました'));
                }
                if (!google.accounts.oauth2.hasGrantedAllScopes(res, DRIVE_SCOPE)) {
                    return reject(new Error('Google ドライブのファイルを読む許可がありませんでした(許可の画面でチェックを入れてください)'));
                }
                googleAskAccount = false;
                googleToken = res.access_token;
                googleTokenUntil = Date.now() + (Number(res.expires_in) || 3600) * 1000 - 60000;
                resolve(googleToken);
            },
            error_callback: (err) => {
                const type = err && err.type;
                reject(new Error(
                    type === 'popup_failed_to_open' ? 'Google のログイン画面を開けませんでした。もう一度「読み込む」を押してください(出ない時は、ブラウザのポップアップ禁止を外してください)'
                        : type === 'popup_closed' ? 'Google のログイン画面が閉じられました。もう一度「読み込む」を押してください'
                            : 'Google のログインに失敗しました'));
            },
        });
        client.requestAccessToken();
    });

    const getGoogleToken = async () => {
        if (googleToken && Date.now() < googleTokenUntil) return googleToken;
        googleToken = null;
        if (!gisLoaded()) await ensureGis();
        return requestGoogleToken();
    };

    const driveGet = (path, token) => fetch(`https://www.googleapis.com/drive/v3/files/${path}`, { headers: { Authorization: `Bearer ${token}` } });

    const driveProblem = async (res) => {
        let reason = '';
        let message = '';
        try {
            const body = await res.json();
            message = (body.error && body.error.message) || '';
            reason = (body.error && body.error.errors && body.error.errors[0] && body.error.errors[0].reason) || '';
        } catch (err) { /* 読めなくてもよい */ }
        console.warn('Google ドライブ:', res.status, reason, message);
        if (res.status === 401) {
            googleToken = null;
            return new Error('Google のログインの期限が切れました。もう一度「読み込む」を押してください');
        }
        if (res.status === 403 && /accessNotConfigured|SERVICE_DISABLED/i.test(reason + message)) {
            return new Error('アプリ側の Google の設定が足りません(Google Drive API が有効になっていません)');
        }
        if (res.status === 403 && /cannotDownload|exportSizeLimit/i.test(reason + message)) {
            return new Error('このファイルはダウンロードが禁止されているか、大きすぎます');
        }
        return new Error(`Google ドライブから受け取れませんでした(${res.status})`);
    };

    // ファイルの名前と種類。このアプリにまだ選んでもらっていないファイルは null
    const driveMeta = async (id, token) => {
        const res = await driveGet(`${id}?fields=id,name,mimeType&supportsAllDrives=true`, token);
        if (res.status === 404) return null;
        if (!res.ok) throw await driveProblem(res);
        return res.json();
    };

    const driveDownload = async (meta, token) => {
        const isSheet = meta.mimeType === SHEET_MIME;
        if (!isSheet && /^application\/vnd\.google-apps\./.test(meta.mimeType || '')) {
            throw new Error(`「${meta.name}」は Excel でもスプレッドシートでもありません`);
        }
        const path = isSheet
            ? `${meta.id}/export?mimeType=${encodeURIComponent(XLSX_MIME)}`
            : `${meta.id}?alt=media&supportsAllDrives=true`;
        const res = await driveGet(path, token);
        if (!res.ok) throw await driveProblem(res);
        const buf = await res.arrayBuffer();
        if (!isExcelBytes(buf)) throw new Error(`「${meta.name}」は Excel のファイルではありません`);
        return buf;
    };

    // Google のファイル選択の画面に、貼られたリンクのファイルだけを出す。本人が「選択」を押すと、このアプリがそのファイルを読めるようになる
    const pickGoogleFile = async (id, token) => {
        await ensurePicker();
        return new Promise((resolve, reject) => {
            const view = new google.picker.DocsView(google.picker.ViewId.DOCS).setFileIds(id);
            if (google.picker.DocsViewMode) view.setMode(google.picker.DocsViewMode.LIST);
            const picker = new google.picker.PickerBuilder()
                .setDeveloperKey(googleConfig().apiKey)
                .setAppId(String(googleConfig().clientId).split('-')[0])   // プロジェクトの番号(クライアントIDの先頭の数字)
                .setOAuthToken(token)
                .addView(view)
                .setLocale('ja')
                .setTitle('この Excel を選んで「選択」を押してください')
                .setCallback((data) => {
                    if (data.action === google.picker.Action.PICKED) {
                        const doc = (data[google.picker.Response.DOCUMENTS] || [])[0];
                        resolve(doc ? doc[google.picker.Document.ID] : id);
                    } else if (data.action === google.picker.Action.CANCEL) {
                        googleAskAccount = true;   // 次は、アカウントを選ぶ画面からやり直す
                        googleToken = null;
                        reject(new Error('ファイルが選ばれませんでした。画面にファイルが出なかった時は、そのファイルを見られる Google アカウントでログインし直してください(もう一度「読み込む」)'));
                    }
                })
                .build();
            picker.setVisible(true);
        });
    };

    const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

    // ログインして Excel を受け取る → { buf, name }
    const fetchExcelViaGoogle = async (id, say) => {
        say('Google にログイン中...(Google の小さな画面が出たら、進めてください)');
        const token = await getGoogleToken();
        say('Google ドライブから読み込み中...');
        let meta = await driveMeta(id, token);
        if (!meta) {
            say('Google の画面で、ファイルを選んで「選択」を押してください');
            const picked = await pickGoogleFile(id, token);
            say('Google ドライブから読み込み中...');
            meta = await driveMeta(picked, token);
            if (!meta) { await wait(1200); meta = await driveMeta(picked, token); }
            if (!meta) throw new Error('選んだファイルを読めませんでした。もう一度「読み込む」を押してください');
        }
        const buf = await driveDownload(meta, token);
        return { buf, name: meta.name || 'リンクのExcel' };
    };

    const loadExcelLink = async () => {
        if (busy || !excelLinkInput) return;
        const text = excelLinkInput.value.trim();
        if (!text) return;
        const say = (msg) => { excelStatus.textContent = msg; };
        const fail = (msg) => {
            excelStatus.textContent = `⚠️ リンクから読めませんでした: ${msg}` + (excelFiles.length ? '(前に選んだ Excel をそのまま使います)' : '');
            excelStatus.classList.add('status-error');
        };
        excelStatus.classList.remove('status-error');
        say('リンクから読み込み中...');
        excelLinkBtn.disabled = true;
        try {
            const { id, targets } = parseExcelLink(text);
            const canLogin = !!id && googleUsable();
            let got = null;
            if (!(canLogin && loginNeededIds.has(id))) {
                const buf = await fetchExcelBytes(targets);
                if (buf) got = { buf, name: 'リンクのExcel' };
            }
            if (!got) {
                if (!canLogin) {
                    throw new Error(!id ? 'ファイルを受け取れませんでした。リンクとインターネットの接続を確かめてください'
                        : !googleConfigured() ? 'ファイルを受け取れませんでした。共有が「制限付き」のファイルは、Google ログインの設定(google_config.js)が済むと読めるようになります'
                            : 'ファイルを受け取れませんでした。共有が「制限付き」のファイルは、Web で公開したページ(https://…)から開いた時だけ読めます');
                }
                loginNeededIds.add(id);
                got = await fetchExcelViaGoogle(id, say);
            }
            const fileName = /\.xlsx?$/i.test(got.name) ? got.name : `${got.name}.xlsx`;
            const file = new File([got.buf], fileName);
            const parsed = await parseExcel(file, '');   // 読めるか確かめる(どのシートに何行あるか)
            const found = parsed.sheets.filter((s) => !s.generic && s.count > 0);
            if (!found.length) throw new Error(`「${got.name}」は受け取れましたが、「離陸・着陸・飛行時間」の見出しがあるシートが見つかりません`);
            excelFiles = [file];
            excelInput.value = '';
            excelStatus.textContent = `✔ リンクから読み込みました(${got.name}): ${found.map((s) => `${s.name} ${s.count}行`).join('、')}`;
        } catch (err) {
            console.error(err);
            fail(err.message);
        } finally {
            excelLinkBtn.disabled = busy;
            checkReady();
        }
    };

    if (excelLinkInput && excelLinkBtn) {
        excelLinkBtn.addEventListener('click', loadExcelLink);
        excelLinkInput.addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); loadExcelLink(); } });
        // リンクを貼り付けたら、すぐ読み込む
        excelLinkInput.addEventListener('paste', () => setTimeout(loadExcelLink, 0));
        if (googleUsable()) {
            // ログインの部品は、リンク欄を使おうとした時にだけ Google から受け取る(ファイルを選ぶだけの人は Google につながない)
            excelLinkInput.addEventListener('focus', () => { ensureGis().catch(() => { }); }, { once: true });
            if (excelLinkNote) excelLinkNote.textContent = '共有が「制限付き」のファイルは、Googleのログイン画面が出ます';
        }
    }

    // ---- 写真の選択(ファイルを選ぶ / コピーして貼り付け)と、手書きモデル(cellreader.js)の位置合わせ画面 ----
    const alignSection = document.getElementById('alignSection');
    const alignContainer = document.getElementById('alignContainer');
    const imageThumbs = document.getElementById('imageThumbs');
    const pasteZone = document.getElementById('pasteZone');
    let busy = false;                      // 照合の実行中(この間は写真を変えられない)
    let alignQueue = Promise.resolve();    // 位置合わせ画面の準備は、1つずつ順番に行う
    let pasteCount = 0;
    const thumbUrls = new Map();           // 写真 → 小さい見本に使うURL

    const setBusy = (v) => {
        busy = v;
        imageInput.disabled = v;
        imageThumbs.classList.toggle('locked', v);
        if (pasteZone) pasteZone.classList.toggle('locked', v);
        excelInput.disabled = v;
        if (excelLinkInput) excelLinkInput.disabled = v;
        if (excelLinkBtn) excelLinkBtn.disabled = v;
    };

    // 貼り付け欄に短いお知らせを出す(少ししたら元の案内に戻す)
    let zoneTimer = null;
    const zoneMessage = (text, warn) => {
        if (!pasteZone) return;
        pasteZone.dataset.msg = text;
        pasteZone.classList.toggle('paste-zone-warn', !!warn);
        clearTimeout(zoneTimer);
        zoneTimer = setTimeout(() => {
            delete pasteZone.dataset.msg;
            pasteZone.classList.remove('paste-zone-warn');
        }, 2500);
    };

    // 位置合わせの画面で写真を回した時は、小さい見本も回した画像にする
    const thumbRotated = new Map();
    document.addEventListener('cellreader-rotate', (e) => {
        const { file, thumb } = e.detail || {};
        if (!file) return;
        if (thumb) thumbRotated.set(file, thumb);
        else thumbRotated.delete(file);
        const i = imageFiles.indexOf(file);
        const el = i >= 0 ? imageThumbs.querySelectorAll('.thumb img')[i] : null;
        if (el) el.src = thumbRotated.get(file) || thumbUrls.get(file);
    });

    const updateImageUi = (note) => {
        // 選んだ写真の小さい見本を並べる。隅の ✖ で1枚ずつ消せる
        thumbUrls.forEach((url, f) => {
            if (!imageFiles.includes(f)) { URL.revokeObjectURL(url); thumbUrls.delete(f); thumbRotated.delete(f); }
        });
        imageThumbs.innerHTML = '';
        imageFiles.forEach((f, i) => {
            if (!thumbUrls.has(f)) thumbUrls.set(f, URL.createObjectURL(f));
            const box = document.createElement('div');
            box.className = 'thumb';
            const img = document.createElement('img');
            img.src = thumbRotated.get(f) || thumbUrls.get(f);
            img.alt = `${i + 1}枚目`;
            const no = document.createElement('span');
            no.className = 'thumb-no';
            no.textContent = `${i + 1}枚目`;
            const del = document.createElement('button');
            del.type = 'button';
            del.className = 'thumb-del';
            del.textContent = '✖';
            del.title = `${i + 1}枚目「${f.name}」を消す`;
            del.setAttribute('aria-label', del.title);
            del.addEventListener('click', () => removeImageFile(f));
            box.append(img, no, del);
            imageThumbs.appendChild(box);
        });
        imageThumbs.style.display = imageFiles.length ? 'flex' : 'none';
        imageStatus.textContent = (imageFiles.length ? `${imageFiles.length} 枚の画像を選択中` : '未選択') + (note ? ` ${note}` : '');
        alignSection.style.display = imageFiles.length ? 'block' : 'none';
        checkReady();
    };

    // files を位置合わせ画面に出す。append = true なら今ある写真の後ろに足す(前の写真の位置合わせは残す)
    const prepareAligner = (files, append) => {
        alignQueue = alignQueue.then(async () => {
            if (!window.CellReader) return;
            try {
                await window.CellReader.prepare(files, alignContainer, { append });
            } catch (err) {
                console.error(err);
                // 読み込めなかった画像は外す(位置合わせ画面にある写真と、同じ並びにそろえる)
                const done = new Set(window.CellReader.states.map((st) => st.file));
                imageFiles = imageFiles.filter((f) => !files.includes(f) || done.has(f));
                updateImageUi(`⚠️ ${err.message}`);
            }
        });
        return alignQueue;
    };

    // 写真を選び直す(今までの写真は消える)
    const setImageFiles = (files) => {
        imageFiles = files;
        updateImageUi();
        prepareAligner(files, false);
    };

    // 写真を足す(貼り付け)
    const addImageFiles = (files) => {
        imageFiles = imageFiles.concat(files);
        updateImageUi();
        prepareAligner(files, true);
    };

    // 写真を1枚だけ消す(ほかの写真の位置合わせは残す)
    const removeImageFile = (file) => {
        if (busy) return;
        imageFiles = imageFiles.filter((f) => f !== file);
        imageInput.value = '';   // 「ファイルを選択」の横の表示(○個のファイル)が、実際の枚数とずれないように
        updateImageUi();
        alignQueue = alignQueue.then(() => {
            if (!window.CellReader) return;
            const k = window.CellReader.states.findIndex((st) => st.file === file);
            if (k >= 0) window.CellReader.remove(k);
        });
    };

    imageInput.addEventListener('change', (e) => setImageFiles(Array.from(e.target.files)));

    // 貼り付け欄: 貼り付け専用なので、文字は入らないようにする
    if (pasteZone) {
        pasteZone.addEventListener('beforeinput', (e) => e.preventDefault());
        pasteZone.addEventListener('input', () => { pasteZone.textContent = ''; });
        pasteZone.addEventListener('drop', (e) => e.preventDefault());
    }

    // 画像をコピーして Ctrl+V(貼り付け)で読み込む。貼り付け欄の上でも、ページのほかの場所でもよい。続けて貼ると枚数が増える
    document.addEventListener('paste', (e) => {
        const items = Array.from((e.clipboardData && e.clipboardData.items) || []);
        const got = items.filter((it) => it.kind === 'file' && it.type.startsWith('image/'))
            .map((it) => it.getAsFile()).filter(Boolean);
        const inZone = pasteZone && pasteZone.contains(e.target);
        if (!got.length) {
            // 画像でない貼り付け: 貼り付け欄ならお知らせを出す。ほかの場所(リンクの欄など)はそのまま
            if (inZone) { e.preventDefault(); zoneMessage('⚠️ 画像ではありません。画像をコピーしてから貼り付けてください', true); }
            return;
        }
        e.preventDefault();
        if (busy) {
            zoneMessage('⚠️ 読み取り中は画像を追加できません', true);
            return;
        }
        const files = got.map((f) => {
            // 画面の切り取りなどは全部「image.png」という名前で来るので、区別できる名前を付ける
            if (f.name && !/^image\.\w+$/i.test(f.name)) return f;
            pasteCount++;
            const ext = (f.type.split('/')[1] || 'png').replace('jpeg', 'jpg');
            return new File([f], `貼り付け画像${pasteCount}.${ext}`, { type: f.type });
        });
        addImageFiles(files);
        zoneMessage(`✔ 貼り付けました(${imageFiles.length}枚目)`);
    });

    function checkReady() {
        compareBtn.disabled = !(imageFiles.length > 0 && excelFiles.length > 0);
    }

    const normalizeString = (str) => {
        if (!str) return '';
        return str.replace(/[Ａ-Ｚａ-ｚ０-９：＋]/g, function (s) {
            if (s === '：') return ':';
            if (s === '＋') return '+';
            return String.fromCharCode(s.charCodeAt(0) - 0xFEE0);
        }).replace(/\s+/g, '');
    };

    // "9:24" / "0+06" / "-1:23" → 分(読めなければ null)
    const parseTimeToMinutes = (t) => {
        if (!t) return null;
        const m = String(t).match(/^(-?)(\d{1,3})[:+](\d{2})/);
        if (!m) return null;
        const v = parseInt(m[2], 10) * 60 + parseInt(m[3], 10);
        return m[1] ? -v : v;
    };

    const formatMinutes = (mins) => {
        const sign = mins < 0 ? '-' : '';
        const a = Math.abs(mins);
        return `${sign}${Math.floor(a / 60)}:${String(a % 60).padStart(2, '0')}`;
    };

    const formatHm = (text) => {
        const m = String(text).match(/^(\d{1,2})[:+](\d{2})$/);
        if (!m) return text;
        return `${parseInt(m[1], 10)}:${m[2]}`;
    };

    // ---- Excel の読み込み ----
    // 「離陸(出発)・着陸(到着)・飛行時間」の見出しがあるシートを探し、その列の時刻を読む。
    // 見出しが見つからないとき(CSV など)は、1行の中の時刻らしい値を左から3つ使う(以前の方式)。
    const HEADER_PATTERNS = {
        dep: /^(出発|離陸)(時刻|時間)?$/,
        arr: /^(到着|着陸)(時刻|時間)?$/,
        flt: /^飛行時間$/,
    };

    // セル1つ → 分。Excel の時刻は「1日 = 1」の数値で入っているので 1440 倍する
    const cellToMinutes = (cell) => {
        if (!cell || cell.v === undefined || cell.v === null || cell.v === '') return null;
        if (cell.t === 'n') return Math.round(cell.v * 1440);
        const m = normalizeString(String(cell.v)).match(/^(-?)(\d{1,2})[:+](\d{2})/);
        if (!m) return null;
        const v = parseInt(m[2], 10) * 60 + parseInt(m[3], 10);
        return m[1] ? -v : v;
    };

    const findHeader = (sheet) => {
        if (!sheet['!ref']) return null;
        const range = XLSX.utils.decode_range(sheet['!ref']);
        const lastHeaderRow = Math.min(range.e.r, range.s.r + 30);
        for (let r = range.s.r; r <= lastHeaderRow; r++) {
            const cols = {};
            for (let c = range.s.c; c <= range.e.c; c++) {
                const cell = sheet[XLSX.utils.encode_cell({ r, c })];
                if (!cell || cell.t !== 's') continue;
                const text = String(cell.v).replace(/\s+/g, '');
                Object.entries(HEADER_PATTERNS).forEach(([key, re]) => {
                    if (cols[key] === undefined && re.test(text)) cols[key] = c;
                });
            }
            if (cols.dep !== undefined && cols.arr !== undefined && cols.flt !== undefined) {
                return { row: r, cols, lastRow: range.e.r };
            }
        }
        return null;
    };

    const readSheetByHeader = (sheet, header) => {
        const rows = [];
        for (let r = header.row + 1; r <= header.lastRow; r++) {
            const get = (key) => cellToMinutes(sheet[XLSX.utils.encode_cell({ r, c: header.cols[key] })]);
            const d = get('dep');
            const a = get('arr');
            const f = get('flt');
            // 何も入っていない行・使っていない行(0:00 だけの行)は飛ばす
            if (!d && !a && !f) continue;
            rows.push({
                departure: d === null ? null : formatMinutes(d),
                arrival: a === null ? null : formatMinutes(a),
                flight_time: f === null ? null : formatMinutes(f).replace(':', '+'),   // 紙と同じ「0+06」の書き方
            });
        }
        return rows;
    };

    const readSheetGeneric = (sheet) => {
        const json = XLSX.utils.sheet_to_json(sheet, { header: 1, raw: false, dateNF: 'h:mm' });
        const timeRegex = /^\d{1,2}[:+]\d{2}(:\d{2})?$/;
        const results = [];
        json.forEach((row) => {
            const times = [];
            row.forEach((cell) => {
                if (cell === undefined || cell === null) return;
                const str = normalizeString(String(cell).trim());
                if (str.match(timeRegex)) times.push(formatHm(str.replace('+', ':')));
            });
            if (times.length < 3) return;
            const item = { departure: times[0], arrival: times[1], flight_time: times[2] };
            if (!parseTimeToMinutes(item.departure) && !parseTimeToMinutes(item.arrival)
                && !parseTimeToMinutes(item.flight_time)) return;
            results.push(item);
        });
        return results;
    };

    const parseExcel = (file, targetSheetName) => {
        return new Promise((resolve, reject) => {
            const reader = new FileReader();
            reader.onload = (e) => {
                try {
                    const data = new Uint8Array(e.target.result);
                    const workbook = XLSX.read(data, { type: 'array', cellDates: false });
                    const wanted = (targetSheetName || '').trim();
                    let names = workbook.SheetNames;
                    if (wanted) {
                        if (!names.includes(wanted)) throw new Error(`シート「${wanted}」が見つかりませんでした。`);
                        names = [wanted];
                    }
                    // 指定がなければ、日ごとの記録のシート(Day1, Day2 …)があればそれだけを読む。
                    // (「個人記録検索」のように同じ見出しで記録を写したシートもあり、全部読むと二重になるため)
                    if (!wanted) {
                        const days = names.filter((n) => /^day\s*\d+$/i.test(n.trim()) && findHeader(workbook.Sheets[n]));
                        if (days.length) names = days;
                    }
                    const rows = [];
                    const sheets = [];
                    names.forEach((name) => {
                        const header = findHeader(workbook.Sheets[name]);
                        if (!header) return;
                        const got = readSheetByHeader(workbook.Sheets[name], header);
                        if (!got.length) return;
                        got.forEach((row) => { row.sheet = name; });
                        rows.push(...got);
                        sheets.push({ name, count: got.length });
                    });
                    if (!sheets.length) {
                        // 見出しが見つからない: 指定のシート(なければ1枚目)を以前の方式で読む
                        const name = wanted || workbook.SheetNames[0];
                        const got = readSheetGeneric(workbook.Sheets[name]);
                        got.forEach((row) => { row.sheet = name; });
                        rows.push(...got);
                        sheets.push({ name, count: got.length, generic: true });
                    }
                    resolve({ rows, sheets, fileName: file.name });
                } catch (err) {
                    reject(err);
                }
            };
            reader.onerror = reject;
            reader.readAsArrayBuffer(file);
        });
    };

    // ---- 照合 ----
    // 写真ごとに、紙の行の並び(上から順)を、Excel の Day ごとの行(書いてある順)に順番どおり当てはめる。
    // 紙の読み間違いで出発時刻がずれても、前後の行の並びから正しい相手が見つかる。
    // どの Day に当てはめるかは、一番よく合う Day を自動で選ぶ。
    const digitsOf = (t) => {
        const m = parseTimeToMinutes(t);
        if (m === null) return null;
        const a = Math.abs(m);
        return `${Math.floor(a / 60)}${String(a % 60).padStart(2, '0')}`.padStart(4, ' ');
    };
    const FIELD_WEIGHT = { departure: 1.5, arrival: 1.0, flight_time: 0.7 };
    // 2つの時刻がどれだけ似ているか(0〜1)
    const fieldSim = (a, b) => {
        const pa = parseTimeToMinutes(a);
        const pb = parseTimeToMinutes(b);
        if (pa === null || pb === null) return 0.3;   // 片方が空欄: どちらとも言えない
        if (pa === pb) return 1;
        if (Math.abs(pa - pb) <= 1) return 0.6;
        const da = digitsOf(a);
        const db = digitsOf(b);
        let same = 0;
        for (let k = 0; k < 4; k++) if (da[k] === db[k] && da[k] !== ' ') same++;
        return 0.5 * same / Math.max(da.trim().length, db.trim().length);
    };
    const rowSim = (p, e) => Object.entries(FIELD_WEIGHT).reduce((s, [k, w]) => s + w * fieldSim(p[k], e[k]), 0);
    const PAIR_BASE = 1.4;   // 似ている度合いがこれを超えると、対にした方が得(最大 3.2)
    const GAP = 0.5;         // 紙だけ・Excel だけの行を作る減点

    // 紙の行 P と Excel の行 E を順番どおりに対応付ける(E の最初と最後は飛ばしてよい = 写真は Day の一部のページ)。
    // 戻り値 { score, steps: [{ p, e }] }(p・e は添字、片方だけの行は null)
    const alignRows = (P, E) => {
        const n = P.length;
        const m = E.length;
        const D = Array.from({ length: n + 1 }, () => new Float64Array(m + 1));
        const B = Array.from({ length: n + 1 }, () => new Int8Array(m + 1));   // 1=対 2=紙だけ 3=Excelだけ
        for (let i = 1; i <= n; i++) { D[i][0] = D[i - 1][0] - GAP; B[i][0] = 2; }
        for (let j = 1; j <= m; j++) { D[0][j] = 0; B[0][j] = 3; }   // 写真より前の Excel の行は減点なし
        for (let i = 1; i <= n; i++) {
            for (let j = 1; j <= m; j++) {
                const pair = D[i - 1][j - 1] + rowSim(P[i - 1], E[j - 1]) - PAIR_BASE;
                const paperOnly = D[i - 1][j] - GAP;
                const excelOnly = D[i][j - 1] - GAP;
                if (pair >= paperOnly && pair >= excelOnly) { D[i][j] = pair; B[i][j] = 1; }
                else if (paperOnly >= excelOnly) { D[i][j] = paperOnly; B[i][j] = 2; }
                else { D[i][j] = excelOnly; B[i][j] = 3; }
            }
        }
        let bj = 0;   // 写真より後の Excel の行も減点なし
        for (let j = 1; j <= m; j++) if (D[n][j] > D[n][bj]) bj = j;
        const steps = [];
        let i = n;
        let j = bj;
        while (i > 0) {
            const b = B[i][j];
            if (b === 1) { steps.push({ p: i - 1, e: j - 1 }); i--; j--; }
            else if (b === 2) { steps.push({ p: i - 1, e: null }); i--; }
            else { steps.push({ p: null, e: j - 1 }); j--; }
        }
        return { score: D[n][bj], steps: steps.reverse() };
    };

    // 紙に「-」(空欄)のマスがある行。Excel ではこの行を飛ばして書いているので、照合しない
    const hasDash = (p) => !p.departure || !p.arrival || !p.flight_time;

    const makeItem = (paper, excel, extra) => {
        const item = {
            paper,
            excel,
            paper_dep: paper ? paper.departure || '-' : '-',
            paper_arr: paper ? paper.arrival || '-' : '-',
            paper_flt: paper ? paper.flight_time || '-' : '-',
            excel_dep: excel ? excel.departure || '-' : '-',
            excel_arr: excel ? excel.arrival || '-' : '-',
            excel_flt: excel ? excel.flight_time || '-' : '-',
            excelSheet: excel ? excel.sheet : null,
            uncertain: (paper && paper.uncertain) || {},
            arithHint: (paper && paper.arithHint) || 'unknown',
            rowImage: paper ? paper.rowImage : null,
            ...extra,
        };
        if (paper && excel) {
            item.mismatchDep = parseTimeToMinutes(paper.departure) !== parseTimeToMinutes(excel.departure);
            item.mismatchArr = parseTimeToMinutes(paper.arrival) !== parseTimeToMinutes(excel.arrival);
            // 飛行時間は Excel で出発・到着から計算されるので、比べない(表には出す)。紙の飛行時間は読み取りの計算チェックにだけ使う
            item.mismatchFlt = false;
            const mismatch = item.mismatchDep || item.mismatchArr || item.mismatchFlt;
            item.status = mismatch ? 'Mismatch' : 'Match';
            item.statusText = mismatch ? '不一致' : '一致';
        } else if (paper && hasDash(paper)) {
            item.status = 'Skipped';
            item.statusText = '照合しない(紙に「-」)';
        } else if (paper) {
            item.status = 'Missing in Excel';
            item.statusText = 'Excelに無し';
        } else {
            item.status = 'Missing in Paper';
            item.statusText = '紙に無し';
        }
        return item;
    };

    // photos: [{ index, name, rows }]、excelRows: Excel の行(sheet・fileName 付き)
    const compareData = (photos, excelRows) => {
        // Day(ファイル+シート)ごとに分ける
        const multiFile = new Set(excelRows.map((r) => r.fileName)).size > 1;
        const days = [];
        const byKey = new Map();
        excelRows.forEach((r) => {
            const key = `${r.fileName}|${r.sheet}`;
            if (!byKey.has(key)) {
                const day = { key, label: multiFile ? `${r.sheet}(${r.fileName})` : r.sheet, rows: [] };
                byKey.set(key, day);
                days.push(day);
            }
            byKey.get(key).rows.push(r);
        });
        // Excel の行は書いてある順(= 時間の順)のまま使う。出発時刻で並べ替えると、Excel 側の時刻の書き間違いで
        // 行の位置まで動いてしまい、「不一致」ではなく「Excelに無し」「紙に無し」の2行になってしまうため。
        days.forEach((day) => {
            day.used = new Array(day.rows.length).fill(false);
            day.photos = [];
        });

        // 「-」の行(照合しない)を、紙の行の順番どおりの位置に差し込む
        const withSkipped = (items, skipped) => {
            const out = items.slice();
            skipped.forEach((p) => {
                const at = out.findIndex((x) => x.paper && x.paper.row > p.row);
                const item = makeItem(p, null, {});
                if (at < 0) out.push(item);
                else out.splice(at, 0, item);
            });
            return out;
        };

        const unmatchedPhotos = [];
        photos.forEach((photo) => {
            const rows = photo.rows.filter((p) => !hasDash(p));
            const skipped = photo.rows.filter((p) => hasDash(p));
            let best = null;
            days.forEach((day) => {
                const idx = day.rows.map((_, k) => k).filter((k) => !day.used[k]);
                const al = alignRows(rows, idx.map((k) => day.rows[k]));
                if (!best || al.score > best.al.score) best = { day, idx, al };
            });
            if (!best || best.al.score <= 0) {
                unmatchedPhotos.push({ ...photo, items: photo.rows.map((p) => makeItem(p, null, {})) });
                return;
            }
            const { day, idx, al } = best;
            const items = withSkipped(al.steps.map((s) => {
                const p = s.p === null ? null : rows[s.p];
                const e = s.e === null ? null : day.rows[idx[s.e]];
                if (s.e !== null) day.used[idx[s.e]] = true;
                return makeItem(p, e, {});
            }), skipped);
            photo.day = day.label;
            day.photos.push({ ...photo, items, score: al.score });
        });
        days.forEach((day) => {
            day.rest = day.rows.filter((_, k) => !day.used[k]).map((e) => makeItem(null, e, { outside: true }));
        });
        return { days, unmatchedPhotos };
    };

    const escapeHtml = (s) => String(s).replace(/[&<>"']/g, (ch) => ({
        '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'
    }[ch]));

    const renderDiagnostics = (imageInfos, excelInfos, photos) => {
        const diag = document.getElementById('diagnostics');
        if (!diag) return;

        const imageHtml = imageInfos.map((info, idx) => {
            const warn = info.rows === 0 ? ' diag-warn' : '';
            const day = photos[idx] && photos[idx].day ? ` → Excelの「${escapeHtml(photos[idx].day)}」に対応` : ' → どのDayとも対応しませんでした';
            return `<li class="diag-item${warn}">${idx + 1}枚目「${escapeHtml(info.name)}」: <strong>${info.rows}行</strong>(記入されている行数 ${info.nRows})${day}${info.rows === 0 ? ' ⚠️ 1行も読めていません' : ''}</li>`;
        }).join('');

        const excelHtml = excelInfos.map((info) => {
            const sheets = info.sheets.map((s) => `「${escapeHtml(s.name)}」${s.count}行${s.generic ? '(見出しが見つからず、時刻らしい値を左から読んだ)' : ''}`).join('、');
            return `<li class="diag-item">${escapeHtml(info.fileName)}: ${sheets}</li>`;
        }).join('');

        diag.innerHTML = `
            <h3>読み取り診断</h3>
            <p>紙の時刻は、写真から切り出したマスを手書きの数字を学習したモデルで読み、表の計算チェックで読み間違いを直しています。
            照合は、写真ごとに紙の行の並びを、Excel の Day ごとの行(書いてある順)に順番どおり当てはめて行います。</p>
            <ul class="diag-list">${imageHtml}</ul>
            <ul class="diag-list">${excelHtml}</ul>
        `;
        // 読み取り診断は画面には出さない(開発確認用。コンソールで見られるように計算だけはしておく)
        diag.style.display = 'none';
    };

    const FIELD_LABELS = { dep: '出発', arr: '着陸', flt: '飛行時間' };
    const NEEDS_CHECK = (item) => item.status === 'Mismatch'
        || ((item.status === 'Missing in Excel' || item.status === 'Missing in Paper') && !item.outside);

    // 結果の表(紙の行と Excel の行を上下に並べる)。groups: [{ title, items }]
    const buildTable = (groups, withImage) => {
        const table = document.createElement('table');
        table.className = 'result-table';
        table.innerHTML = `<thead><tr>
            ${withImage ? '<th class="col-image">紙の画像(出発・到着・飛行時間)</th>' : ''}
            <th class="col-source">資料</th><th>出発 (離陸)</th><th>着陸</th><th>飛行時間</th><th>判定</th>
        </tr></thead>`;
        const tbody = document.createElement('tbody');
        const nCols = withImage ? 6 : 5;
        let idx = 0;
        groups.forEach((g) => {
            if (g.title) {
                const tr = document.createElement('tr');
                tr.className = 'group-row';
                tr.innerHTML = `<td colspan="${nCols}">${g.title}</td>`;
                tbody.appendChild(tr);
            }
            g.items.forEach((row) => {
                const statusClass = { Match: 'status-match', Mismatch: 'status-mismatch' }[row.status] || 'status-missing';
                const fields = [];
                if (row.mismatchDep) fields.push(FIELD_LABELS.dep);
                if (row.mismatchArr) fields.push(FIELD_LABELS.arr);
                if (row.mismatchFlt) fields.push(FIELD_LABELS.flt);
                const badge = row.status === 'Mismatch' ? `不一致：${fields.join('・')}` : row.statusText;
                const chips = [];
                if (row.arithHint === 'consistent') chips.push('<span class="chip chip-hint-ok" title="紙の行で 出発+飛行時間=到着 が成り立つ">計算チェック：✔</span>');
                else if (row.arithHint === 'inconsistent') chips.push('<span class="chip chip-hint" title="紙の行で 出発+飛行時間=到着 が成り立たない(読み間違いか、紙の書き間違い)">計算チェック：✖</span>');
                const statusHtml = `<div class="judgment"><span class="status-badge ${statusClass}">${badge}</span>${chips.length ? `<div class="mismatch-chips">${chips.join('')}</div>` : ''}</div>`;

                // マスの色: 不一致=赤、読み取りに自信がない=黄色(Excel と一致したマスは確かめられたので色なし)
                const uncertain = row.uncertain || {};
                const confirmed = !!(row.paper && row.excel);
                const paperCell = (value, mismatched, key) => {
                    const why = uncertain[key];
                    let cls = '';
                    if (mismatched) cls = why ? 'cell-mismatch cell-mismatch-uncertain' : 'cell-mismatch';
                    else if (why && !confirmed) cls = 'cell-uncertain';
                    return `<td${cls ? ` class="${cls}"` : ''}>${escapeHtml(value)}</td>`;
                };
                const excelCell = (value, mismatched) => `<td${mismatched ? ' class="cell-mismatch"' : ''}>${escapeHtml(value)}</td>`;
                const groupCls = idx % 2 === 0 ? 'pair-even' : 'pair-odd';
                idx++;
                const img = withImage
                    ? `<td class="image-cell" rowspan="2">${row.rowImage ? `<img src="${row.rowImage}" alt="紙の行の画像">` : '<span class="no-image">(紙に無い行)</span>'}</td>`
                    : '';
                const where = row.paper && withImage ? `<div class="src-sheet">${escapeHtml(`${row.paper.row}行目`)}</div>` : '';
                const trP = document.createElement('tr');
                trP.className = `pair-row pair-row-paper ${groupCls}`;
                trP.innerHTML = `${img}
                    <td class="src-label src-paper">紙${where}</td>
                    ${paperCell(row.paper_dep, row.mismatchDep, 'dep')}
                    ${paperCell(row.paper_arr, row.mismatchArr, 'arr')}
                    ${paperCell(row.paper_flt, row.mismatchFlt, 'flt')}
                    <td class="judgment-cell" rowspan="2">${statusHtml}</td>`;
                tbody.appendChild(trP);
                const trE = document.createElement('tr');
                trE.className = `pair-row pair-row-excel ${groupCls}`;
                trE.innerHTML = `
                    <td class="src-label src-excel">Excel${row.excelSheet ? `<div class="src-sheet">${escapeHtml(row.excelSheet)}</div>` : ''}</td>
                    ${excelCell(row.excel_dep, row.mismatchDep)}
                    ${excelCell(row.excel_arr, row.mismatchArr)}
                    ${excelCell(row.excel_flt, row.mismatchFlt)}`;
                tbody.appendChild(trE);
            });
        });
        table.appendChild(tbody);
        const wrap = document.createElement('div');
        wrap.className = 'table-responsive';
        wrap.appendChild(table);
        return wrap;
    };

    const renderResults = ({ days, unmatchedPhotos }) => {
        resultGroups.innerHTML = '';
        const all = [];
        days.forEach((d) => d.photos.forEach((p) => all.push(...p.items)));
        unmatchedPhotos.forEach((p) => all.push(...p.items));
        const count = (st) => all.filter((x) => x.status === st).length;
        const mismatchKey = { dep: 'mismatchDep', arr: 'mismatchArr', flt: 'mismatchFlt' };
        const uncertainCells = all.reduce((n, x) => {
            const u = x.uncertain || {};
            const confirmed = !!(x.paper && x.excel);
            return n + ['dep', 'arr', 'flt'].filter((k) => u[k] && (!confirmed || x[mismatchKey[k]])).length;
        }, 0);
        const outside = days.reduce((n, d) => n + d.rest.length, 0);

        // Excel のシートのように、Day ごとのタブで切り替えて表示する。
        // 各タブの中: 上に「確認が必要な行」(手書きの行の画像付き)、下にその Day の全部の行。
        const tabs = days.map((d) => ({
            label: d.label,
            photos: d.photos,
            rest: d.rest,
        }));
        if (unmatchedPhotos.length) tabs.push({ label: 'どのDayとも対応しない写真', photos: unmatchedPhotos, rest: [], unmatched: true });

        const view = document.createElement('div');
        view.className = 'sheet-view';
        const bar = document.createElement('div');
        bar.className = 'sheet-tabs';
        bar.setAttribute('role', 'tablist');
        view.appendChild(bar);
        resultGroups.appendChild(view);

        const box = (parent, title, cls, note) => {
            const el = document.createElement('div');
            el.className = `result-box ${cls || ''}`;
            el.innerHTML = `<h3>${title}</h3>${note ? `<p class="box-note">${note}</p>` : ''}`;
            parent.appendChild(el);
            return el;
        };

        const panels = tabs.map((t) => {
            const panel = document.createElement('div');
            panel.className = 'sheet-panel';
            panel.setAttribute('role', 'tabpanel');
            const photoTitle = (p) => `${p.index + 1}枚目「${escapeHtml(p.name)}」`;

            // 確認が必要な行(不一致・Excelに無し・紙に無し)
            const checkGroups = t.photos
                .map((p) => ({ title: photoTitle(p), items: t.unmatched ? p.items : p.items.filter(NEEDS_CHECK) }))
                .filter((g) => g.items.length);
            const nCheck = checkGroups.reduce((n, g) => n + g.items.length, 0);
            const top = box(panel, `確認が必要な行(不一致・Excelに無し・紙に無し)`, 'result-box-check',
                nCheck ? '左の画像は、写真から切り出した手書きの行です。' : '');
            if (nCheck) top.appendChild(buildTable(checkGroups, true));
            else if (t.photos.length) top.insertAdjacentHTML('beforeend', '<p class="box-ok">✅ 確認が必要な行はありません。</p>');
            else top.insertAdjacentHTML('beforeend', '<p class="box-note">このDayに対応する写真はありません。</p>');

            // その Day の全部の行
            const allBox = box(panel, `${escapeHtml(t.label)} の全部の行`, 'result-box-day');
            if (t.photos.length) allBox.appendChild(buildTable(t.photos.map((p) => ({ title: photoTitle(p), items: p.items })), false));
            else allBox.insertAdjacentHTML('beforeend', '<p class="box-note">このDayに対応する写真はありません。</p>');
            if (t.rest.length) {
                const det = document.createElement('details');
                det.innerHTML = `<summary>写真に無いExcelの行(${t.rest.length}行)… 撮っていないページの行など</summary>`;
                det.appendChild(buildTable([{ items: t.rest }], false));
                allBox.appendChild(det);
            }
            view.appendChild(panel);

            // タブ(シート名と、確認が必要な行の数)
            const tab = document.createElement('button');
            tab.type = 'button';
            tab.className = 'sheet-tab';
            tab.setAttribute('role', 'tab');
            const badge = !t.photos.length ? '<span class="tab-badge tab-badge-none">写真なし</span>'
                : nCheck ? `<span class="tab-badge tab-badge-check">要確認 ${nCheck}</span>`
                    : '<span class="tab-badge tab-badge-ok">✔</span>';
            tab.innerHTML = `${escapeHtml(t.label)} ${badge}`;
            bar.appendChild(tab);
            return { tab, panel, hasPhotos: t.photos.length > 0 };
        });

        const select = (k) => panels.forEach((p, i) => {
            p.tab.classList.toggle('active', i === k);
            p.tab.setAttribute('aria-selected', String(i === k));
            p.panel.style.display = i === k ? 'block' : 'none';
        });
        panels.forEach((p, i) => p.tab.addEventListener('click', () => select(i)));
        // 最初は、写真のある最初の Day を開く
        const first = panels.findIndex((p) => p.hasPhotos);
        if (panels.length) select(first >= 0 ? first : 0);

        resultSummary.innerHTML = `
            <span class="summary-item">発航回数 ${all.filter((x) => x.paper).length} 件</span>
            <span class="summary-item status-match">一致: ${count('Match')}件</span>
            <span class="summary-item status-mismatch">不一致: ${count('Mismatch')}件</span>
            ${count('Skipped') ? `<span class="summary-item">照合しない(紙に「-」): ${count('Skipped')}件</span>` : ''}
            <span class="summary-item status-uncertain">自信がないマス: ${uncertainCells}個</span>
            ${outside ? `<span class="summary-item">写真に無いExcelの行: ${outside}件</span>` : ''}
        `;
        resultSection.style.display = 'block';
    };

    compareBtn.addEventListener('click', async () => {
        compareBtn.disabled = true;
        setBusy(true);
        resultSection.style.display = 'none';
        globalStatus.style.color = '#555';
        globalStatus.textContent = '準備中...';
        await alignQueue;   // 貼り付けた写真の位置合わせ画面ができるのを待つ
        if (window.CellReader && window.CellReader.setLocked) window.CellReader.setLocked(true);

        const targetSheetName = '';   // シート名の欄は無くした。Day1・Day2… のシートを自動で全部読む

        try {
            let allExcelData = [];
            const excelInfos = [];
            for (let i = 0; i < excelFiles.length; i++) {
                globalStatus.textContent = `Excelデータを解析中... (${i + 1}/${excelFiles.length})`;
                const parsed = await parseExcel(excelFiles[i], targetSheetName);
                parsed.rows.forEach((row) => { row.fileName = parsed.fileName; });
                excelInfos.push(parsed);
                allExcelData = allExcelData.concat(parsed.rows);
            }

            if (!window.CellReader) throw new Error('手書きモデル(cellreader.js)が読み込まれていません');
            const photos = [];
            const imageInfos = [];
            // 位置合わせ画面で合わせた枠からマスを切り出して、手書きモデルで読む
            for (let i = 0; i < imageFiles.length; i++) {
                const parsed = await window.CellReader.read(i, (done, total) => {
                    globalStatus.textContent = `読み取り中... (${i + 1}/${imageFiles.length} 枚目、${done}/${total} 行)`;
                });
                parsed.rows.forEach((row) => {
                    row.imageIndex = i;
                    row.imageName = imageFiles[i].name;
                });
                imageInfos.push({ name: imageFiles[i].name, rows: parsed.rows.length, nRows: parsed.nRows });
                photos.push({ index: i, name: imageFiles[i].name, rows: parsed.rows });
            }

            globalStatus.textContent = 'データの照合中...';
            const result = compareData(photos, allExcelData);
            renderDiagnostics(imageInfos, excelInfos, photos);
            renderResults(result);
            globalStatus.textContent = '照合完了！';
        } catch (error) {
            console.error(error);
            globalStatus.textContent = 'エラーが発生しました: ' + error.message;
            globalStatus.style.color = '#c62828';
        } finally {
            setBusy(false);
            checkReady();
            if (window.CellReader && window.CellReader.setLocked) window.CellReader.setLocked(false);
        }
    });
});
