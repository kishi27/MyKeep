const LOGIN_ERROR = "ログインの確認が必要です。入力内容を残したまま、別タブでMyKeepを開いてログインを確認してください。";
const NETWORK_ERROR = "通信できませんでした。接続を確認して再試行してください。ログイン切れの可能性もあるため、続く場合は別タブでMyKeepを開いて確認してください。";
const SERVER_ERROR = "サーバーで処理できませんでした。入力内容はそのままで、時間を置いて再試行してください。";
const RESPONSE_ERROR = "応答の形式が正しくありません。入力内容を残したまま再試行してください。";

export async function api<T>(path: string, options?: RequestInit): Promise<T> {
  const headers = new Headers(options?.headers);
  if (options?.body && !headers.has("Content-Type")) headers.set("Content-Type", "application/json");
  let response: Response;
  try {
    response = await fetch(path, { ...options, headers });
  } catch (cause) {
    if (options?.signal?.aborted || cause instanceof DOMException && cause.name === "AbortError") throw cause;
    // Access redirects can be blocked by CORS and appear as a network error.
    // Do not claim that every fetch failure is an expired login.
    throw new Error(NETWORK_ERROR);
  }
  const url = new URL(response.url || path, window.location.origin);
  const accessRedirect = url.pathname.startsWith("/cdn-cgi/access/") || url.hostname.endsWith(".cloudflareaccess.com");
  if (response.status === 401 || accessRedirect) throw new Error(LOGIN_ERROR);
  if (response.status >= 500) throw new Error(SERVER_ERROR);
  const text = await response.text().catch((cause) => {
    if (options?.signal?.aborted || cause instanceof DOMException && cause.name === "AbortError") throw cause;
    throw new Error(NETWORK_ERROR);
  });
  if (/text\/html/i.test(response.headers.get("Content-Type") ?? "")
    && /Cloudflare Access|\/cdn-cgi\/access\//i.test(text)) throw new Error(LOGIN_ERROR);
  let data: T & { error?: string };
  try { data = JSON.parse(text); }
  catch {
    if (response.status === 403) throw new Error("アクセスが拒否されました。別タブでMyKeepを開き、ログイン状態とアクセス権を確認してください。");
    throw new Error(RESPONSE_ERROR);
  }
  if (!response.ok) throw new Error(data && typeof data.error === "string" ? data.error : "処理に失敗しました。");
  return data;
}
