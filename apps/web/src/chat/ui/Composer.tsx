import { ArrowUp, ChevronDown, FileText, Linkedin, Mail, Mic, NotebookPen, Plus, Square } from 'lucide-react';
import { type KeyboardEvent, useEffect, useId, useLayoutEffect, useRef, useState } from 'react';
import { Link } from 'react-router-dom';
import { cx } from '../../ui';
import { type ChatMode, getChatMode, MODE_LABEL, setChatMode } from './prefs';

type AttachKind = 'note' | 'resume' | 'linkedin' | 'email';
const ATTACH: { kind: AttachKind; label: string; accept: string; icon: typeof Plus }[] = [
  { kind: 'note', label: 'Add a note', accept: '.txt,.md,text/plain,text/markdown', icon: NotebookPen },
  { kind: 'resume', label: 'Upload resume', accept: '.pdf,.docx,.txt,application/pdf', icon: FileText },
  { kind: 'linkedin', label: 'Import LinkedIn connections', accept: '.csv,.zip,text/csv', icon: Linkedin },
  { kind: 'email', label: 'Paste an email', accept: '.eml,.txt,message/rfc822,text/plain', icon: Mail },
];

interface Recognition extends EventTarget {
  lang: string;
  interimResults: boolean;
  continuous: boolean;
  start(): void;
  stop(): void;
  onresult:
    | ((e: {
        resultIndex: number;
        results: ArrayLike<ArrayLike<{ transcript: string }> & { isFinal: boolean }>;
      }) => void)
    | null;
  onend: (() => void) | null;
  onerror: (() => void) | null;
}
function speechApi(): (new () => Recognition) | undefined {
  const w = window as unknown as {
    SpeechRecognition?: new () => Recognition;
    webkitSpeechRecognition?: new () => Recognition;
  };
  return w.SpeechRecognition ?? w.webkitSpeechRecognition;
}

export function Composer({
  onSend,
  onStop,
  onAttach,
  running,
  mode,
  modeNote,
  autoFocus,
  size = 'home',
  temporary = false,
}: {
  onSend: (text: string) => void;
  onStop: () => void;
  onAttach: (file: File, kind: AttachKind) => void;
  running: boolean;
  mode: 'llm' | 'router';
  modeNote?: { text: string; href?: string };
  autoFocus?: boolean;
  size?: 'home' | 'thread';
  /** a temporary chat's composer has a dashed edge, like the pill's icon */
  temporary?: boolean;
}) {
  const [text, setText] = useState('');
  const [menu, setMenu] = useState<'attach' | 'mode' | undefined>();
  const [chatMode, setMode] = useState<ChatMode>(() => getChatMode());
  const [listening, setListening] = useState(false);
  const [canDictate] = useState(() => !!speechApi());
  const ref = useRef<HTMLTextAreaElement>(null);
  const fileRef = useRef<HTMLInputElement>(null);
  const pendingKind = useRef<AttachKind>('note');
  const recog = useRef<Recognition>(null);
  const rootRef = useRef<HTMLDivElement>(null);
  const menuId = useId();
  // grows with the message up to a few lines, then scrolls inside
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    el.style.height = 'auto';
    el.style.height = `${Math.min(el.scrollHeight, 200)}px`;
  }, [text]);
  useEffect(() => {
    if (autoFocus) ref.current?.focus({ preventScroll: true });
  }, [autoFocus]);
  // a click outside closes the open menu
  useEffect(() => {
    if (!menu) return;
    const onDown = (e: PointerEvent) => {
      if (!rootRef.current?.contains(e.target as Node)) setMenu(undefined);
    };
    const onKey = (e: globalThis.KeyboardEvent) => e.key === 'Escape' && setMenu(undefined);
    window.addEventListener('pointerdown', onDown);
    window.addEventListener('keydown', onKey);
    return () => {
      window.removeEventListener('pointerdown', onDown);
      window.removeEventListener('keydown', onKey);
    };
  }, [menu]);
  useEffect(() => () => recog.current?.stop(), []);
  const send = () => {
    const t = text.trim();
    if (!t || running) return;
    recog.current?.stop();
    setText('');
    onSend(t);
  };
  const onKeyDown = (e: KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing) {
      e.preventDefault();
      send();
    }
  };
  const dictate = () => {
    if (listening) {
      recog.current?.stop();
      return;
    }
    const Api = speechApi();
    if (!Api) return;
    const r = new Api();
    r.lang = navigator.language || 'en-US';
    r.interimResults = true;
    r.continuous = true;
    const base = text ? `${text.replace(/\s+$/, '')} ` : '';
    r.onresult = (e) => {
      let finals = '';
      let interim = '';
      for (let i = 0; i < e.results.length; i++) {
        const res = e.results[i]!;
        const t = res[0]?.transcript ?? '';
        if (res.isFinal) finals += t;
        else interim += t;
      }
      setText(`${base}${finals}${interim}`.replace(/\s+/g, ' '));
    };
    r.onend = () => {
      setListening(false);
      recog.current = null;
      ref.current?.focus({ preventScroll: true });
    };
    r.onerror = () => setListening(false);
    recog.current = r;
    setListening(true);
    r.start();
  };
  const pickFile = (kind: AttachKind) => {
    pendingKind.current = kind;
    setMenu(undefined);
    const input = fileRef.current;
    if (!input) return;
    input.accept = ATTACH.find((a) => a.kind === kind)?.accept ?? '';
    input.value = '';
    input.click();
  };
  return (
    <div
      ref={rootRef}
      className={cx(
        'glass glass-lift rounded-[28px] w-full mx-auto',
        size === 'home' ? 'max-w-[980px]' : 'max-w-[800px]',
        temporary && 'border-dashed border-[#b9b5ae]',
      )}
      style={{ padding: '14px 18px 12px' }}
      data-testid="composer"
    >
      <label htmlFor={`${menuId}-input`} className="sr-only">
        Message Orbi
      </label>
      <textarea
        id={`${menuId}-input`}
        ref={ref}
        value={text}
        onChange={(e) => setText(e.target.value)}
        onKeyDown={onKeyDown}
        rows={1}
        placeholder="Message Orbi"
        className="block w-full resize-none bg-transparent border-0 outline-none text-[16px] leading-[1.5] placeholder:text-ink-3 px-1 py-1 max-h-[200px] overflow-y-auto scroll-thin"
        data-testid="composer-input"
        aria-label="Message Orbi"
        enterKeyHint="send"
      />
      <div className="mt-2 flex items-center gap-2 relative">
        <button
          type="button"
          className={cx(
            'w-11 h-11 sm:w-10 sm:h-10 rounded-full border border-line bg-canvas/70 inline-flex items-center justify-center text-ink-2 hover:bg-canvas hover:text-ink focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/40',
            menu === 'attach' && 'bg-canvas text-ink',
          )}
          aria-label="Add"
          aria-haspopup="menu"
          aria-expanded={menu === 'attach'}
          onClick={() => setMenu((m) => (m === 'attach' ? undefined : 'attach'))}
          data-testid="composer-add"
        >
          <Plus size={18} aria-hidden />
        </button>
        <button
          type="button"
          className={cx(
            'h-11 sm:h-10 px-3.5 rounded-full border border-line bg-canvas/70 inline-flex items-center gap-1.5 text-[14px] font-medium text-ink hover:bg-canvas focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/40',
            menu === 'mode' && 'bg-canvas',
          )}
          aria-haspopup="menu"
          aria-expanded={menu === 'mode'}
          onClick={() => setMenu((m) => (m === 'mode' ? undefined : 'mode'))}
          data-testid="composer-mode"
        >
          {mode === 'llm' ? MODE_LABEL[chatMode].label : 'Templates'} <ChevronDown size={14} aria-hidden />
        </button>
        {menu === 'attach' && (
          <div
            role="menu"
            className="glass glass-strong absolute left-0 bottom-[calc(100%+8px)] z-20 min-w-[260px] p-1.5 rounded-[14px] fade-up"
            data-testid="attach-menu"
          >
            {ATTACH.map(({ kind, label, icon: Icon }) => (
              <button
                key={kind}
                role="menuitem"
                type="button"
                className="w-full h-11 sm:h-10 px-2.5 rounded-[10px] flex items-center gap-2.5 text-[14px] hover:bg-canvas-2 focus-visible:outline-none focus-visible:bg-accent-soft"
                onClick={() => pickFile(kind)}
              >
                <Icon size={16} className="text-ink-3" aria-hidden /> {label}
              </button>
            ))}
          </div>
        )}
        {menu === 'mode' && (
          <div
            role="menu"
            className="glass glass-strong absolute left-0 bottom-[calc(100%+8px)] z-20 w-[300px] max-w-[calc(100vw-48px)] p-1.5 rounded-[14px] fade-up"
            data-testid="mode-menu"
          >
            {mode === 'llm' ? (
              (Object.keys(MODE_LABEL) as ChatMode[]).map((m) => (
                <button
                  key={m}
                  role="menuitemradio"
                  aria-checked={chatMode === m}
                  type="button"
                  className={cx(
                    'w-full px-2.5 py-2 rounded-[10px] text-left hover:bg-canvas-2 focus-visible:outline-none focus-visible:bg-canvas-2',
                    chatMode === m && 'bg-canvas-2',
                  )}
                  onClick={() => {
                    setMode(m);
                    setChatMode(m);
                    setMenu(undefined);
                  }}
                >
                  <div className="text-[14px] font-medium">{MODE_LABEL[m].label}</div>
                  <div className="text-[12.5px] text-ink-3">{MODE_LABEL[m].hint}</div>
                </button>
              ))
            ) : (
              <div className="px-2.5 py-2 text-[13px] text-ink-2" data-testid="mode-explainer">
                <div className="font-medium text-ink">Templates</div>
                <p className="mt-0.5">
                  {modeNote?.text ??
                    'Without a Claude key, Orbit answers from templates: the chips and common commands work, and drafts come from the drafting engine.'}
                </p>
                <Link
                  to={modeNote?.href ?? '/settings/integrations'}
                  className="inline-block mt-1.5 font-medium text-ink underline decoration-[#cfcdc9] underline-offset-4 hover:decoration-ink"
                >
                  Add a key in Settings
                </Link>
              </div>
            )}
          </div>
        )}
        <span className="ml-auto flex items-center gap-1.5">
          {text.trim() && !running && (
            <button
              type="button"
              onClick={send}
              className="w-11 h-11 sm:w-10 sm:h-10 rounded-full bg-ink text-white inline-flex items-center justify-center hover:bg-[#262626] transition-transform active:scale-95 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/40 fade-up"
              aria-label="Send"
              data-testid="composer-send"
            >
              <ArrowUp size={18} aria-hidden />
            </button>
          )}
          {running ? (
            <button
              type="button"
              onClick={onStop}
              className="w-11 h-11 sm:w-10 sm:h-10 rounded-full bg-accent-soft text-accent inline-flex items-center justify-center hover:bg-accent/20 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/40"
              aria-label="Stop"
              data-testid="composer-stop"
            >
              <Square size={14} fill="currentColor" aria-hidden />
            </button>
          ) : (
            canDictate && (
              <button
                type="button"
                onClick={dictate}
                className={cx(
                  'w-11 h-11 sm:w-10 sm:h-10 rounded-full inline-flex items-center justify-center focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/40',
                  listening ? 'bg-bad-soft text-bad' : 'text-ink-2 hover:bg-canvas hover:text-ink',
                )}
                aria-label={listening ? 'Stop dictation' : 'Dictate'}
                aria-pressed={listening}
                data-testid="composer-mic"
              >
                <Mic size={18} aria-hidden />
              </button>
            )
          )}
        </span>
      </div>
      <input
        ref={fileRef}
        type="file"
        className="sr-only"
        tabIndex={-1}
        aria-hidden
        data-testid="composer-file"
        onChange={(e) => {
          const f = e.target.files?.[0];
          if (f) onAttach(f, pendingKind.current);
        }}
      />
    </div>
  );
}
