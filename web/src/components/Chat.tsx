import { useEffect, useRef, useState } from "react";
import type { ToolUi, TranscriptMessage } from "../../../shared/types";
import { Markdown } from "./Markdown";
import { ToolCard } from "./ToolCard";

export type LiveSegment = { kind: "text"; text: string } | { kind: "tool"; id: string; name: string; args?: Record<string, unknown>; ui?: ToolUi };

export function Chat(props: {
  transcript: TranscriptMessage[];
  live: LiveSegment[] | null;
  pendingUser: string | null;
  streaming: boolean;
  error: string | null;
  disabled: boolean;
  onSend: (text: string) => void;
  onStop: () => void;
}) {
  const scrollRef = useRef<HTMLDivElement>(null);
  const [text, setText] = useState("");
  const taRef = useRef<HTMLTextAreaElement>(null);
  const stick = useRef(true);

  useEffect(() => {
    const el = scrollRef.current;
    if (!el) return;
    const onScroll = () => { stick.current = el.scrollHeight - el.scrollTop - el.clientHeight < 80; };
    el.addEventListener("scroll", onScroll, { passive: true });
    return () => el.removeEventListener("scroll", onScroll);
  }, []);
  useEffect(() => {
    const el = scrollRef.current;
    if (el && stick.current) el.scrollTop = el.scrollHeight;
  }, [props.transcript, props.live, props.pendingUser]);
  useEffect(() => {
    const ta = taRef.current;
    if (!ta) return;
    ta.style.height = "auto";
    ta.style.height = Math.min(200, ta.scrollHeight) + "px";
  }, [text]);

  const send = () => {
    const t = text.trim();
    if (!t || props.streaming || props.disabled) return;
    props.onSend(t);
    setText("");
  };

  const visible = props.transcript.filter((m) => !(m.role === "user" && m.hidden));
  const empty = visible.length === 0 && !props.live && !props.pendingUser;

  return (
    <section className="chat">
      <div className="scroll" ref={scrollRef}>
        <div className="thread">
          {empty && !props.streaming && <div className="empty">The audit starts as soon as the guide has read your site.</div>}
          {visible.map((m, i) => <MessageView key={i} m={m} />)}
          {props.pendingUser && <div className="msg user">{props.pendingUser}</div>}
          {props.live && props.live.map((seg, i) =>
            seg.kind === "text"
              ? <div className="msg assistant" key={i}><Markdown text={seg.text} />{i === props.live!.length - 1 && props.streaming && <span className="cursor" />}</div>
              : <ToolCard key={seg.id} name={seg.name} ui={seg.ui} pending={!seg.ui} args={seg.args} />,
          )}
          {props.streaming && props.live && props.live.length === 0 && <div className="msg assistant muted ui small"><span className="spin" /> &nbsp;thinking…</div>}
          {props.error && <div className="banner error ui">{props.error}</div>}
        </div>
      </div>
      <div className="composer">
        <div className="box">
          <textarea
            ref={taRef}
            rows={1}
            value={text}
            disabled={props.disabled}
            placeholder={props.disabled ? "The conversation model is not configured on this server." : "Answer, ask, push back…"}
            onChange={(e) => setText(e.target.value)}
            onKeyDown={(e) => { if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); send(); } }}
          />
          {props.streaming
            ? <button className="btn sm" onClick={props.onStop}>Stop</button>
            : <button className="btn primary sm" onClick={send} disabled={!text.trim() || props.disabled}>Send</button>}
        </div>
        <div className="hint"><span>Enter to send · Shift+Enter for a new line</span><span>Read-only on your data. Nothing is stored server-side.</span></div>
      </div>
    </section>
  );
}

function MessageView({ m }: { m: TranscriptMessage }) {
  if (m.role === "user") return <div className="msg user">{m.content}</div>;
  if (m.role === "assistant") return m.content ? <div className="msg assistant"><Markdown text={m.content} /></div> : null;
  return <ToolCard name={m.name} ui={m.ui} />;
}
