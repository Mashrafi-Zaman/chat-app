const API = import.meta.env.VITE_API_URL || "http://localhost:3001";

export async function api(path, { method = "GET", body, token } = {}) {
  const headers = { "Content-Type": "application/json" };
  if (token) headers.Authorization = `Bearer ${token}`;
  const res = await fetch(`${API}${path}`, {
    method,
    headers,
    body: body ? JSON.stringify(body) : undefined,
  });
  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new Error(text || `HTTP ${res.status}`);
  }
  return res.json();
}

export const register = (email, password, displayName) =>
  api("/auth/register", { method: "POST", body: { email, password, displayName } });

export const login = (email, password) =>
  api("/auth/login", { method: "POST", body: { email, password } });

export const me = (token) => api("/me", { token });

export const searchUsers = (q, token) =>
  api(`/users/search?q=${encodeURIComponent(q)}`, { token });

export const listConversations = (token) =>
  api("/conversations", { token });

export const createConversation = (memberIds, isGroup, title, token) =>
  api("/conversations", { method: "POST", body: { memberIds, isGroup, title }, token });

export const listMessages = (cid, token) =>
  api(`/messages?cid=${encodeURIComponent(cid)}`, { token });

// NEW: upload a file (multipart/form-data)
export async function uploadFile(file, token) {
  const form = new FormData();
  form.append("file", file);
  const res = await fetch(`${API}/upload`, {
    method: "POST",
    headers: { Authorization: `Bearer ${token}` },
    body: form
  });
  if (!res.ok) throw new Error(await res.text().catch(()=>`HTTP ${res.status}`));
  return res.json(); // { fileUrl }
}
