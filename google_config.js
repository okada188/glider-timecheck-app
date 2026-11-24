// Google ログインの設定。
// 共有が「制限付き」の Excel を、リンクから読むために使う。
// Google Cloud で作った2つの値を、'' の中に貼り付ける。空のままなら、ログインの機能は働かない(今まで通り動く)。
// どちらも「ページを見た人に見えてよい値」で、パスワードではない。
// (使える場所は Google Cloud 側で、このアプリの URL だけに限定しておく)
window.GOOGLE_CONFIG = {
    clientId: '629007267613-954v2jhhfah10bq18jj6q9mi1h61uge6.apps.googleusercontent.com',   // OAuth クライアントID(数字-英数字.apps.googleusercontent.com)
    apiKey: 'AIzaSyDj2aW8hCPMcq2Fhm7b4jt9AoqaRVZ7V68',     // API キー(AIza… で始まる)
};
