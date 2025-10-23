import React from "react";
import {
  register, login, me, searchUsers,
  listConversations, createConversation, listMessages, uploadFile
} from "./api";
import { makeSocket } from "./socket";

function useAuth() {
  const [token, setToken] = React.useState(localStorage.getItem("token") || "");
  const [user, setUser] = React.useState(null);

  React.useEffect(() => {
    if (!token) return;
    me(token).then(setUser).catch(() => {
      setUser(null);
      setToken("");
      localStorage.removeItem("token");
    });
  }, [token]);

  function saveToken(t) {
    setToken(t);
    localStorage.setItem("token", t);
  }

  function logout() {
    setUser(null);
    setToken("");
    localStorage.removeItem("token");
    window.location.reload();
  }

  return { token, user, setToken: saveToken, logout };
}

function AuthScreen({ onAuthed }) {
  const [mode, setMode] = React.useState("login"); // login | register
  const [email, setEmail] = React.useState("");
  const [password, setPassword] = React.useState("");
  const [name, setName] = React.useState("");
  const [err, setErr] = React.useState("");

  async function submit(e) {
    e.preventDefault();
    setErr("");
    try {
      let resp;
      if (mode === "register") {
        resp = await register(email, password, name);
      } else {
        resp = await login(email, password);
      }
      onAuthed(resp.token);
    } catch (e) {
      setErr("Failed: " + (e.message || "error"));
    }
  }

  return (
    <div className="container">
      <div className="card" style={{ maxWidth: 420, margin: "40px auto" }}>
        <h2 className="title">CN Chat — {mode === "login" ? "Login" : "Register"}</h2>
        <form className="col" onSubmit={submit}>
          <input placeholder="Email" value={email} onChange={e=>setEmail(e.target.value)} required />
          <input type="password" placeholder="Password" value={password} onChange={e=>setPassword(e.target.value)} required />
          {mode === "register" && (
            <input placeholder="Display name" value={name} onChange={e=>setName(e.target.value)} required />
          )}
          {err && <div className="muted">{err}</div>}
          <div className="row">
            <button type="submit">{mode === "login" ? "Login" : "Create account"}</button>
            <button type="button" onClick={()=>setMode(mode==="login"?"register":"login")}>
              {mode === "login" ? "Switch to Register" : "Switch to Login"}
            </button>
          </div>
        </form>
        <p className="muted" style={{marginTop:8}}>
          Demo users you created via PowerShell will also work here.
        </p>
      </div>
    </div>
  );
}

function ChatApp({ token, onLogout }) {
  const [socket, setSocket] = React.useState(null);
  const [meUser, setMeUser] = React.useState(null);
  const [convos, setConvos] = React.useState([]);
  const [cid, setCid] = React.useState(null);
  const [msgs, setMsgs] = React.useState([]);
  const [text, setText] = React.useState("");
  const [search, setSearch] = React.useState("");
  const [searchResults, setSearchResults] = React.useState([]);
  const [title, setTitle] = React.useState("");
  const fileInputRef = React.useRef(null);

  // Load profile + conversations
  React.useEffect(() => {
    let mounted = true;
    me(token).then(u => mounted && setMeUser(u)).catch(()=>{});
    listConversations(token).then(c => mounted && setConvos(c)).catch(()=>{});
    return () => { mounted = false; };
  }, [token]);

  // Create socket ONCE for this token
  React.useEffect(() => {
    if (!token) return;
    const s = makeSocket(token);
    setSocket(s);

    // New message arrives
    s.on("message_created", (m) => {
      if (m.conversationId === cid) {
        setMsgs(prev => [...prev, m]);
        // If message is from someone else, acknowledge delivered immediately
        if (m.authorId !== meUser?.id) {
          s.emit("ack_delivered", { cid: m.conversationId, msgId: m.id });
          // Mark as read shortly after (simulating that we viewed it)
          setTimeout(() => {
            s.emit("ack_read", { cid: m.conversationId, msgId: m.id });
          }, 500);
        }
      }
    });

    // Delivery/read updates
    s.on("message_updated", (u) => {
      setMsgs(prev =>
        prev.map(m => m.id === u.msgId
          ? { ...m,
              deliveredTo: u.deliveredTo ?? m.deliveredTo,
              readBy: u.readBy ?? m.readBy
            }
          : m)
      );
    });

    s.on("typing", ({ cid: tcid, isTyping }) => {
      if (tcid === cid) document.title = isTyping ? "Someone is typing..." : "CN Chat";
    });

    return () => { s.disconnect(); setSocket(null); };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [token, cid, meUser?.id]);

  // Join/leave conversation rooms when cid changes
  React.useEffect(() => {
    if (!socket) return;
    if (cid) socket.emit("join_conversation", { cid });
    return () => { if (socket && cid) socket.emit("leave_conversation", { cid }); };
  }, [socket, cid]);

  async function openConversation(id) {
    setCid(id);
    setMsgs([]);
    const history = await listMessages(id, token);
    setMsgs(history);

    // When opening, mark all existing messages from others as delivered/read
    setTimeout(() => {
      history.forEach(m => {
        if (m.authorId !== meUser?.id) {
          socket?.emit("ack_delivered", { cid: id, msgId: m.id });
          socket?.emit("ack_read", { cid: id, msgId: m.id });
        }
      });
    }, 200);
  }

  async function create1to1(userId) {
    try {
      if (!userId) return alert("No user selected.");
      const c = await createConversation([userId], false, null, token);
      setConvos(prev => [c, ...prev.filter(x => x.id !== c.id)]);
      await openConversation(c.id);
    } catch (e) {
      console.error("create1to1 error:", e);
      alert("Could not start chat. Details: " + (e.message || "unknown"));
    }
  }

  async function createGroup() {
    try {
      const c = await createConversation([], true, title || "Group", token);
      setConvos(prev => [c, ...prev.filter(x => x.id !== c.id)]);
      setTitle("");
      await openConversation(c.id);
    } catch (e) {
      console.error("createGroup error:", e);
      alert("Could not create group: " + (e.message || "network error"));
    }
  }

  // Send text
  async function send() {
    if (!cid) { alert("Open a conversation first (click Open)."); return; }
    const content = text.trim();
    if (!content || !socket) return;

    // Optimistic UI
    setMsgs(prev => [
      ...prev,
      {
        id: "local-" + Math.random().toString(36).slice(2),
        conversationId: cid,
        authorId: meUser?.id,
        kind: "text",
        text: content,
        createdAt: new Date().toISOString(),
        deliveredTo: [],
        readBy: []
      }
    ]);

    socket.emit("send_message", { cid, kind: "text", text: content });
    setText("");
    socket.emit("typing", { cid, isTyping: false });
  }

  // Send file
  async function sendFile(file) {
    if (!cid) { alert("Open a conversation first (click Open)."); return; }
    if (!file || !socket) return;
    try {
      const { fileUrl } = await uploadFile(file, token);

      // Optimistic UI (file)
      setMsgs(prev => [
        ...prev,
        {
          id: "local-" + Math.random().toString(36).slice(2),
          conversationId: cid,
          authorId: meUser?.id,
          kind: "file",
          fileUrl,
          createdAt: new Date().toISOString(),
          deliveredTo: [],
          readBy: []
        }
      ]);

      socket.emit("send_message", { cid, kind: "file", fileUrl });
    } catch (e) {
      alert("Upload failed: " + (e.message || "error"));
    } finally {
      if (fileInputRef.current) fileInputRef.current.value = "";
    }
  }

  async function findUsers() {
    try {
      if (!search.trim()) { setSearchResults([]); return; }
      const res = await searchUsers(search.trim(), token);
      setSearchResults(res);
    } catch (e) {
      console.error("searchUsers error:", e);
      alert("User search failed: " + (e.message || "network error"));
    }
  }

  // Utility: render ticks for my messages
  function renderTicks(m) {
    if (m.authorId !== meUser?.id) return null; // only show for my own messages
    const read = Array.isArray(m.readBy) && m.readBy.length > 0;
    const delivered = Array.isArray(m.deliveredTo) && m.deliveredTo.length > 0;
    return (
      <span className="muted">
        {read ? "✓✓✓ read" : delivered ? "✓✓ delivered" : "✓ sent"}
      </span>
    );
  }

  return (
    <div className="container">
      <div className="row" style={{ justifyContent: "space-between" }}>
        <h2 className="title">CN Chat</h2>
        <div className="row">
          <span className="badge">{meUser?.displayName || meUser?.email}</span>
          <button onClick={onLogout}>Logout</button>
        </div>
      </div>

      <div className="layout">
        {/* Left column */}
        <div className="col">
          <div className="card">
            <div className="title">Start a chat</div>
            <div className="row">
              <input placeholder="Search users (email or name)" value={search} onChange={e=>setSearch(e.target.value)} />
              <button onClick={findUsers}>Search</button>
            </div>
            <div className="list" style={{ padding: 8, marginTop: 8 }}>
              {searchResults.map(u => (
                <div className="row" key={u.id} style={{ justifyContent:"space-between", borderBottom:"1px solid #eee", padding:"6px 0" }}>
                  <div>{u.displayName} <span className="muted">({u.email})</span></div>
                  <button onClick={()=>create1to1(u.id)}>Chat</button>
                </div>
              ))}
              {searchResults.length === 0 && <div className="muted">No search yet.</div>}
            </div>
          </div>

          <div className="card">
            <div className="title">Create a group</div>
            <div className="row">
              <input placeholder="Group title" value={title} onChange={e=>setTitle(e.target.value)} />
              <button onClick={createGroup}>Create</button>
            </div>
          </div>

          <div className="card">
            <div className="title">Your conversations</div>
            <div className="list" style={{ padding: 8 }}>
              {convos.map(c => (
                <div key={c.id} className="row" style={{ justifyContent:"space-between", borderBottom:"1px solid #eee", padding:"8px 0" }}>
                  <div>
                    <div><b>{c.title || (c.isGroup ? "Group" : "Direct chat")}</b></div>
                    <div className="muted">id: {c.id.slice(0,8)}…</div>
                  </div>
                  <button onClick={()=>openConversation(c.id)}>Open</button>
                </div>
              ))}
              {convos.length === 0 && <div className="muted">No conversations yet.</div>}
            </div>
          </div>
        </div>

        {/* Right column: chat */}
        <div className="card chat">
          <div className="row" style={{ justifyContent:"space-between" }}>
            <div>Conversation: <span className="badge">{cid ? cid.slice(0,8) + "…" : "none"}</span></div>
          </div>

          <div className="msgs" id="messages">
            {msgs.map(m => (
              <div key={m.id} className={`msg ${m.authorId === meUser?.id ? "mine" : ""}`}>
                <div>
                  <div><b>{m.authorId === meUser?.id ? "You" : m.authorId.slice(0,6)}</b> {renderTicks(m)}</div>
                  {m.kind === "text" && m.text && <div>{m.text}</div>}
                  {m.kind === "file" && m.fileUrl && (
                    <div>
                      {/* If it looks like an image, show preview */}
                      {(m.fileUrl.match(/\.(png|jpg|jpeg|gif|webp)$/i)) ? (
                        <img src={m.fileUrl} alt="attachment" style={{ maxWidth:"60%", borderRadius:8, border:"1px solid #eee" }} />
                      ) : (
                        <a className="link" href={m.fileUrl} target="_blank" rel="noreferrer">Download file</a>
                      )}
                    </div>
                  )}
                  <div className="muted">{new Date(m.createdAt).toLocaleString()}</div>
                </div>
              </div>
            ))}
            {msgs.length === 0 && <div className="muted">No messages yet. Select a conversation.</div>}
          </div>

          <div className="toolbar">
            <input
              value={text}
              onChange={e=>setText(e.target.value)}
              onKeyDown={e=>{
                if(e.key==="Enter") send();
                if (cid && e.key) socket?.emit("typing",{ cid, isTyping:true });
              }}
              placeholder="Type a message and press Enter"
            />
            <button onClick={send}>Send</button>
            <input type="file" ref={fileInputRef} onChange={e=>e.target.files && e.target.files[0] && sendFile(e.target.files[0])} />
          </div>
        </div>
      </div>
    </div>
  );
}

export default function App() {
  const { token, user, setToken, logout } = useAuth();
  if (!token || !user) return <AuthScreen onAuthed={setToken} />;
  return <ChatApp token={token} onLogout={logout} />;
}
